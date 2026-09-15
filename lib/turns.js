'use strict';
// Headless turns: attachments, the per-session queue, detached spawn, log tailing, error classification, reattach on boot.
// Part of ClaudeNav's server (see server.js for the routes).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { QUEUE_FILE, RUNS_FILE, TURNS_DIR, UPLOADS_DIR } = require('./config');
const { CLAUDE_BIN, MISSING_BIN_MSG } = require('./bins');
const { clip, findSessionFile, parseSessionFile, readRange, toolBody, toolDetail } = require('./transcripts');
const { SKIP_PERMS, effectiveMode, effectiveModel } = require('./state');
const { usageState } = require('./account');

const TURN_TIMEOUT_MS = Number(process.env.CLAUDE_TURN_TIMEOUT_MS) || 15 * 60 * 1000;

const runningChats = new Map(); // sessionId -> turn entry (see spawnTurn / reattachTurn)
const chatQueues = new Map();   // sessionId -> [{text, cwd}, ...] turns waiting their turn

// A live turn: SIGTERM the child if we spawned it this process, else (a turn we
// reattached to after a restart) signal its pid directly.

// A live turn: SIGTERM the child if we spawned it this process, else (a turn we
// reattached to after a restart) signal its pid directly.
function killEntry(e, sig = 'SIGTERM') {
  try { if (e && e.child) e.child.kill(sig); else if (e && e.pid) process.kill(e.pid, sig); } catch {}
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// Persist just enough to rediscover in-flight turns and the queue after a
// restart. Written on every start/finish and queue change; small and frequent,
// so best-effort (a failed write just means a turn we can't reattach to — it
// still runs to completion and lands in the transcript).

// Persist just enough to rediscover in-flight turns and the queue after a
// restart. Written on every start/finish and queue change; small and frequent,
// so best-effort (a failed write just means a turn we can't reattach to — it
// still runs to completion and lands in the transcript).
function persistRuns() {
  const obj = {};
  for (const [id, e] of runningChats) {
    if (!e.pid) continue;
    obj[id] = { pid: e.pid, startedAt: e.startedAt, cwd: e.cwd,
      outFile: e.outFile, errFile: e.errFile, mode: e.mode, model: e.model };
  }
  try { fs.writeFileSync(RUNS_FILE, JSON.stringify(obj)); } catch {}
}
function persistQueue() {
  const obj = {};
  for (const [id, q] of chatQueues) if (q && q.length) obj[id] = q;
  try {
    if (Object.keys(obj).length) fs.writeFileSync(QUEUE_FILE, JSON.stringify(obj));
    else fs.rmSync(QUEUE_FILE, { force: true });
  } catch {}
}
const lastChatError = new Map(); // sessionId -> error string
const lastChatErrorKind = new Map(); // sessionId -> 'auth' | 'usage' | null (for structured UI flags)
// Live (in-flight) assistant output for a running turn, surfaced via chat-status
// so the browser can show progress before the transcript file is finalized.
// Live (in-flight) assistant output for a running turn, surfaced via chat-status
// so the browser can show progress before the transcript file is finalized.
const livePartial = new Map();  // sessionId -> { text, tools, updatedAt }

// Attachments are classified by the file's extension (browser MIME types are
// unreliable for source files and Office docs), which also decides how the CLI
// consumes them: images/PDFs are Read directly; HEIC is transcoded to JPEG;
// Office docs are extracted to text; plain text/source files are Read as-is.

// Attachments are classified by the file's extension (browser MIME types are
// unreliable for source files and Office docs), which also decides how the CLI
// consumes them: images/PDFs are Read directly; HEIC is transcoded to JPEG;
// Office docs are extracted to text; plain text/source files are Read as-is.
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif']);
const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx']);
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'mjs', 'cjs', 'ts',
  'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cc', 'hpp',
  'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'sql', 'toml', 'ini', 'cfg',
  'conf', 'env', 'properties', 'gradle', 'r', 'lua', 'pl', 'dart', 'ex', 'exs',
  'vue', 'svelte', 'make', 'mk', 'dockerfile', 'gitignore',
]);

function extOf(name) { const m = /\.([A-Za-z0-9]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }

// image | pdf | file (text/office/zip) | null (unsupported).

// image | pdf | file (text/office/zip) | null (unsupported).
function attachKind(name) {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (OFFICE_EXTS.has(ext) || TEXT_EXTS.has(ext) || ext === 'zip') return 'file';
  return null;
}

const decodeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');

// Extract readable text from an OOXML file. docx via macOS `textutil`; xlsx/pptx
// are zip archives — pull the text nodes out of the relevant XML members with
// `unzip -p`. Best-effort: layout/formulas are dropped, cell/slide text is kept.

// Extract readable text from an OOXML file. docx via macOS `textutil`; xlsx/pptx
// are zip archives — pull the text nodes out of the relevant XML members with
// `unzip -p`. Best-effort: layout/formulas are dropped, cell/slide text is kept.
function officeToText(fp, ext) {
  const BUF = { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 };
  if (ext === 'docx') return execFileSync('textutil', ['-convert', 'txt', '-stdout', fp], BUF);
  const members = ext === 'xlsx' ? ['xl/sharedStrings.xml'] : ['ppt/slides/slide*.xml'];
  let xml = '';
  for (const mem of members) { try { xml += execFileSync('unzip', ['-p', fp, mem], BUF); } catch {} }
  const nodes = [...xml.matchAll(/<(?:a:)?t\b[^>]*>([\s\S]*?)<\/(?:a:)?t>/g)].map(m => decodeXml(m[1]));
  return nodes.join('\n').trim();
}

// Extract a readable digest from a .zip so the CLI's Read tool can consume it:
// a full file listing, then the contents of each text/source member inlined
// (binary members — images, PDFs, nested archives — are listed but not read).
// Best-effort and bounded: skips huge members and stops at a total size cap so a
// pathological archive can't blow up the prompt.

// Extract a readable digest from a .zip so the CLI's Read tool can consume it:
// a full file listing, then the contents of each text/source member inlined
// (binary members — images, PDFs, nested archives — are listed but not read).
// Best-effort and bounded: skips huge members and stops at a total size cap so a
// pathological archive can't blow up the prompt.
function zipToText(fp, origName) {
  const BUF = { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 };
  let listing = '';
  try { listing = execFileSync('unzip', ['-Z1', fp], BUF); } catch {}
  const members = listing.split('\n').map(s => s.trim()).filter(Boolean);
  const out = [`Archive: ${origName}`, `${members.length} entr${members.length === 1 ? 'y' : 'ies'}:`, ...members.map(m => `  ${m}`), ''];
  const MEMBER_CAP = 256 * 1024;  // per-file read cap
  const TOTAL_CAP = 4 * 1024 * 1024; // stop inlining past this
  let total = 0, inlined = 0, skipped = 0;
  for (const mem of members) {
    if (mem.endsWith('/')) continue; // directory entry
    const kind = attachKind(mem); // reuse text/office/etc. classification
    const isText = TEXT_EXTS.has(extOf(mem)) || extOf(mem) === '';
    if (!isText) { skipped++; continue; }
    if (total >= TOTAL_CAP) { skipped++; continue; }
    let body = '';
    try { body = execFileSync('unzip', ['-p', fp, mem], { ...BUF, maxBuffer: MEMBER_CAP + 4096 }); } catch { skipped++; continue; }
    if (body.length > MEMBER_CAP) body = body.slice(0, MEMBER_CAP) + '\n… (truncated)';
    total += body.length; inlined++;
    out.push(`\n===== ${mem} =====\n${body}`);
    void kind;
  }
  out.push(`\n(inlined ${inlined} text file${inlined === 1 ? '' : 's'}; ${skipped} binary/oversized/other member${skipped === 1 ? '' : 's'} listed but not read)`);
  return out.join('\n').trim();
}

// Decode a data URL to a file in UPLOADS_DIR, converting as needed. `name` is the
// original filename (drives type detection and the readable disk name). Returns
// { path, kind } or null. The disk name is `<ts>-<rand>-<sanitized original>` so
// the UI can strip the prefix and show the real filename.

// Decode a data URL to a file in UPLOADS_DIR, converting as needed. `name` is the
// original filename (drives type detection and the readable disk name). Returns
// { path, kind } or null. The disk name is `<ts>-<rand>-<sanitized original>` so
// the UI can strip the prefix and show the real filename.
function saveAttachment(att) {
  // Back-compat: older clients (notably the bundled desktop app) send a bare
  // base64 data-URL string instead of { data, name }. Synthesize a filename
  // from the data-URL's MIME so their image/PDF attachments still work.
  if (typeof att === 'string') {
    const mt = /^data:([\w.+-]+\/[\w.+-]+)/.exec(att);
    const sub = mt ? mt[1].split('/')[1].toLowerCase() : 'bin';
    const ext = ({ jpeg: 'jpg', 'svg+xml': 'svg', pdf: 'pdf' })[sub] || sub;
    att = { data: att, name: `pasted.${ext}` };
  }
  const dataUrl = att && att.data, origName = (att && att.name) || 'file';
  const kind = attachKind(origName);
  if (!kind) return null;
  const m = /^data:[^;,]*;base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > 20 * 1024 * 1024) return null; // 20MB cap

  const ext = extOf(origName);
  const safe = origName.replace(/[^\w.-]+/g, '_').replace(/^_+/, '').slice(-80) || 'file';
  const prefix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-`;
  const write = (diskName, contents) => {
    const fp = path.join(UPLOADS_DIR, prefix + diskName);
    fs.writeFileSync(fp, contents);
    return fp;
  };

  try {
    if (ext === 'heic' || ext === 'heif') {
      // Browsers can't display HEIC and Read expects a common format — transcode.
      const src = write(safe, buf);
      const out = src.replace(/\.(heic|heif)$/i, '') + '.jpg';
      execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', out]);
      fs.unlinkSync(src);
      return { path: out, kind: 'image' };
    }
    if (OFFICE_EXTS.has(ext)) {
      const src = write(safe, buf);
      let text = '';
      try { text = officeToText(src, ext); } catch {}
      fs.unlinkSync(src);
      return { path: write(`${safe}.txt`, text || `(could not extract text from ${origName})`), kind: 'file' };
    }
    if (ext === 'zip') {
      const src = write(safe, buf);
      let text = '';
      try { text = zipToText(src, origName); } catch {}
      fs.unlinkSync(src);
      return { path: write(`${safe}.txt`, text || `(could not read archive ${origName})`), kind: 'file' };
    }
    return { path: write(safe, buf), kind };
  } catch { return null; }
}

// Enqueue a turn. Turns for one session always run one-at-a-time, in order, so
// the on-disk transcript never has two of *our* writers at once. (A terminal
// can still write independently; each browser turn re-reads the latest file, so
// it always continues from the newest state.)

// Enqueue a turn. Turns for one session always run one-at-a-time, in order, so
// the on-disk transcript never has two of *our* writers at once. (A terminal
// can still write independently; each browser turn re-reads the latest file, so
// it always continues from the newest state.)
function chatTurn(sessionId, text, images, newCwd, cb) {
  if (!/^[\w-]+$/.test(sessionId || '')) return cb(new Error('bad session id'));
  const attachments = (Array.isArray(images) ? images : []).map(saveAttachment).filter(Boolean);
  if ((!text || !text.trim()) && !attachments.length) return cb(new Error('empty message'));

  // Existing session: resume from its *launch* dir (firstCwd), not the last cwd
  // recorded in the transcript. `claude --resume` scopes its session lookup to
  // the project slug of the cwd it runs in, and the CLI filed this transcript
  // under the dir the session started in. If the conversation later cd'd into a
  // subfolder, the last-seen cwd points at a different (empty) project slug and
  // resume fails with "No conversation found with session ID". New session (no
  // file yet): use the cwd the caller passed — drainQueue creates it via
  // --session-id.
  const fp = findSessionFile(sessionId);
  let cwd = '';
  if (fp) {
    try {
      const d = parseSessionFile(fp, fs.statSync(fp));
      cwd = d.firstCwd || d.cwd;
    } catch {}
  }
  else { cwd = newCwd || ''; }
  if (!cwd || !fs.existsSync(cwd)) return cb(new Error('working directory is missing'));

  // Reference each attachment by absolute path; Claude reads it with the Read tool.
  const MARKER = { image: 'image', pdf: 'PDF', file: 'file' };
  let prompt = (text || '').trim();
  if (attachments.length) {
    prompt += (prompt ? '\n\n' : '') + attachments.map(a =>
      `[Attached ${MARKER[a.kind]}: ${a.path}]`).join('\n');
  }

  if (!chatQueues.has(sessionId)) chatQueues.set(sessionId, []);
  const q = chatQueues.get(sessionId);
  q.push({ text: prompt, cwd });
  persistQueue();
  const position = (runningChats.has(sessionId) ? 1 : 0) + q.length - 1;
  drainQueue(sessionId);
  cb(null, { running: true, queued: position });
}

// Parse one line of `--output-format stream-json` and fold any assistant text /
// tool-use blocks into the session's live partial. Best-effort: the on-disk
// transcript remains the source of truth, so a parse miss just dims the preview.

// Parse one line of `--output-format stream-json` and fold any assistant text /
// tool-use blocks into the session's live partial. Best-effort: the on-disk
// transcript remains the source of truth, so a parse miss just dims the preview.
function ingestStreamLine(sessionId, line) {
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o.type !== 'assistant' || !o.message) return;
  const lp = livePartial.get(sessionId);
  if (!lp) return;
  for (const b of (o.message.content || [])) {
    if (b.type === 'text' && b.text) lp.text = (lp.text + b.text).slice(-8000);
    else if (b.type === 'tool_use' && b.name) {
      lp.tools.push({ name: b.name, detail: clip(toolDetail(b.name, b.input)), body: clip(toolBody(b.name, b.input)) });
      // Surface an interactive question the moment it streams in — otherwise it
      // stays hidden until the turn finalizes (AskUserQuestion is filtered out of
      // the tool list), and a headless turn ends right after asking.
      if (b.name === 'AskUserQuestion' && b.input && Array.isArray(b.input.questions)) {
        lp.ask = { questions: b.input.questions };
        // A headless `-p` turn can't pause for input: AskUserQuestion returns
        // "no answer captured" and the model barrels ahead on an assumption.
        // Stop the turn here instead — the question becomes the terminal state
        // and the user's pick (sent as the next turn) carries it forward. This
        // mirrors interactive Ctrl+C mid-tool; the session stays resumable.
        pauseForQuestion(sessionId);
      }
    }
  }
  lp.updatedAt = Date.now();
}

// Stop a running turn the moment it asks a question (see ingestStreamLine).
// SIGTERM (not cancel) so finalizeTurn doesn't log it as an error and Claude
// Code flushes the question to the transcript; the UI renders it from there.

// Stop a running turn the moment it asks a question (see ingestStreamLine).
// SIGTERM (not cancel) so finalizeTurn doesn't log it as an error and Claude
// Code flushes the question to the transcript; the UI renders it from there.
function pauseForQuestion(sessionId) {
  const entry = runningChats.get(sessionId);
  if (!entry || entry.killed) return;
  entry.killed = true;          // graceful: not an error, not a user cancel
  if (entry.timer) clearTimeout(entry.timer);
  killEntry(entry);             // a spawned turn finalizes via 'exit'; a reattached one via tick
}

// Auth failures don't crash the CLI cleanly — they surface as API 401 text in
// the stream (and sometimes exit 0 with the failure written to the transcript).
// Match those so the UI can say "re-login" instead of a bare exit code. Only
// matched against an error result's message / stderr (see errorSignalText) so a
// turn that merely *quotes* "/login" in its output doesn't false-flag.

// Auth failures don't crash the CLI cleanly — they surface as API 401 text in
// the stream (and sometimes exit 0 with the failure written to the transcript).
// Match those so the UI can say "re-login" instead of a bare exit code. Only
// matched against an error result's message / stderr (see errorSignalText) so a
// turn that merely *quotes* "/login" in its output doesn't false-flag.
const AUTH_ERR_RE = /API Error: 401|invalid authentication|invalid api key|authentication_error|OAuth token (?:has )?(?:expired|been revoked)|please run \/login/i;
const AUTH_ERR_MSG = 'Claude CLI authentication failed (401) — open a terminal, run `claude`, then `/login` to re-authenticate, and retry';

// Usage/rate limits are the other "not your fault, and a bare exit code is
// useless" failure. The CLI reports them as a 429 or a "usage limit reached"
// line (sometimes exiting 0 after writing it to the transcript). Match those so
// the UI can say "you're out of tokens, resets <when>" instead of "exited 1".

// Usage/rate limits are the other "not your fault, and a bare exit code is
// useless" failure. The CLI reports them as a 429 or a "usage limit reached"
// line (sometimes exiting 0 after writing it to the transcript). Match those so
// the UI can say "you're out of tokens, resets <when>" instead of "exited 1".
const USAGE_ERR_RE = /usage limit reached|rate.?limit|rate_limit_error|API Error: 429|too many requests|quota (?:exceeded|reached)|\b\d+-hour limit reached|weekly limit reached/i;

// The ONLY stdout content that may carry a genuine auth/usage failure: an
// *error* result's own message text. Everything the CLI streams — `assistant`
// prose, `user` (tool_result) output, a *successful* `result` line (whose
// `result` field just echoes the assistant's final text), `system` init lines,
// and stray non-JSON diagnostics — routinely quotes "please run /login",
// "usage limit reached", "429" etc. without being a real failure. Real
// transcripts bear this out: every historical match was discussion, zero were
// actual limits. So we scan nothing but the error-result message here (stderr,
// the CLI's dedicated error channel, is scanned separately). Returns the text
// to match against, or '' if this line can't be a signal.

// The ONLY stdout content that may carry a genuine auth/usage failure: an
// *error* result's own message text. Everything the CLI streams — `assistant`
// prose, `user` (tool_result) output, a *successful* `result` line (whose
// `result` field just echoes the assistant's final text), `system` init lines,
// and stray non-JSON diagnostics — routinely quotes "please run /login",
// "usage limit reached", "429" etc. without being a real failure. Real
// transcripts bear this out: every historical match was discussion, zero were
// actual limits. So we scan nothing but the error-result message here (stderr,
// the CLI's dedicated error channel, is scanned separately). Returns the text
// to match against, or '' if this line can't be a signal.
function errorSignalText(line) {
  let o; try { o = JSON.parse(line); } catch { return ''; }    // non-JSON → ignore
  if (o.type === 'result' && o.is_error) {
    return typeof o.result === 'string' ? o.result : JSON.stringify(o);
  }
  return '';
}

// Render an epoch (seconds or ms) as a friendly local time, or null if unusable.

// Render an epoch (seconds or ms) as a friendly local time, or null if unusable.
function formatResetTime(epochLike) {
  let ms = Number(epochLike);
  if (!isFinite(ms) || ms <= 0) return null;
  if (ms < 1e12) ms *= 1000;                // seconds -> ms
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// Friendly, actionable message for a usage-limit hit. Prefers a reset time
// parsed from the CLI's "…reached|<epoch>" form, else the soonest reset from
// the cached /usage bars.

// Friendly, actionable message for a usage-limit hit. Prefers a reset time
// parsed from the CLI's "…reached|<epoch>" form, else the soonest reset from
// the cached /usage bars.
function usageErrorMessage(line) {
  let reset = null;
  const m = /\|(\d{9,13})\b/.exec(line || '');
  if (m) reset = formatResetTime(m[1]);
  if (!reset && usageState.data) {
    const soonest = [usageState.data.session, usageState.data.weeklyAll, usageState.data.weeklyScoped]
      .filter((b) => b && b.resets_at)
      .map((b) => Date.parse(b.resets_at))
      .filter((t) => isFinite(t))
      .sort((a, b) => a - b)[0];
    if (soonest) reset = formatResetTime(soonest);
  }
  const tail = 'This turn didn’t run. Retry after it resets, or switch this session to a lighter model.';
  return reset
    ? `You’ve reached your Claude usage limit — it resets ${reset}. ${tail}`
    : `You’ve reached your Claude usage limit (see the usage bars up top). ${tail}`;
}

const TAIL_MS = Number(process.env.CLAUDENAV_TAIL_MS) || 400; // log-tail poll interval
const INTERRUPTED_MSG = 'This turn was interrupted before it finished (the server restarted). '
  + 'Any progress it made was saved to the transcript — send your message again to continue where it left off.';

// A fresh turn entry. All the streaming/finalize bookkeeping lives here so a
// turn can be driven identically whether we spawned it this process (has a
// `child`) or reattached to it after a restart (has only a `pid`).

// A fresh turn entry. All the streaming/finalize bookkeeping lives here so a
// turn can be driven identically whether we spawned it this process (has a
// `child`) or reattached to it after a restart (has only a `pid`).
function mkEntry(sessionId, base) {
  return {
    startedAt: Date.now(), killed: false, finalizing: false, reattached: false,
    outOff: 0, errOff: 0,           // bytes of each log already folded
    sawAuth: false, sawUsage: false, usageErrLine: '', stderrTail: '',
    sawResult: false, sawErrResult: false,
    ...base,
  };
}

// Read whatever's new in a turn's stdout/stderr logs and fold it in: update the
// live preview, and watch for auth/usage failures. This is the single reader
// for both live and reattached turns — the logs on disk are the source of
// truth, so a restart loses no output. `flush` also folds a trailing partial
// line (used once at finalize, when no more will be written).

// Read whatever's new in a turn's stdout/stderr logs and fold it in: update the
// live preview, and watch for auth/usage failures. This is the single reader
// for both live and reattached turns — the logs on disk are the source of
// truth, so a restart loses no output. `flush` also folds a trailing partial
// line (used once at finalize, when no more will be written).
function pumpLogs(sessionId, flush) {
  const e = runningChats.get(sessionId);
  if (!e) return;
  // stdout — newline-delimited stream-json. Only fold complete lines unless
  // flushing, so a record still mid-write isn't parsed half-formed.
  try {
    const size = fs.statSync(e.outFile).size;
    if (size > e.outOff) {
      const chunk = readRange(e.outFile, e.outOff, size);
      let upto = chunk.length;
      if (!flush) { const nl = chunk.lastIndexOf(0x0a); upto = nl >= 0 ? nl + 1 : 0; }
      if (upto > 0) {
        e.outOff += upto;
        for (const line of chunk.subarray(0, upto).toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          // Auth/usage phrases appear constantly in normal output — match only
          // an error result's own message (see errorSignalText), never raw text.
          const sig = errorSignalText(line);
          if (sig) {
            if (!e.sawAuth && AUTH_ERR_RE.test(sig)) e.sawAuth = true;
            if (!e.sawUsage && USAGE_ERR_RE.test(sig)) { e.sawUsage = true; e.usageErrLine = sig; }
          }
          // A terminal `result` line means the turn actually finished — that's
          // how we tell "done" from "interrupted" when reattaching to a pid.
          try { const o = JSON.parse(line); if (o.type === 'result') { e.sawResult = true; if (o.is_error) e.sawErrResult = true; } } catch {}
          ingestStreamLine(sessionId, line);
        }
      }
    }
  } catch { /* log not created yet / vanished — ignore */ }
  // stderr — the CLI's dedicated error channel; scan a rolling tail raw.
  try {
    const size = fs.statSync(e.errFile).size;
    if (size > e.errOff) {
      const chunk = readRange(e.errFile, e.errOff, size);
      e.errOff += chunk.length;
      e.stderrTail = (e.stderrTail + chunk.toString('utf8')).slice(-2000);
      if (!e.sawAuth && AUTH_ERR_RE.test(e.stderrTail)) e.sawAuth = true;
      if (!e.sawUsage && USAGE_ERR_RE.test(e.stderrTail)) { e.sawUsage = true; e.usageErrLine = e.stderrTail; }
    }
  } catch { /* ignore */ }
}

// One periodic pump. For a turn we reattached to (no child handle), also detect
// the process finishing by watching its pid — that's our only completion signal.

// One periodic pump. For a turn we reattached to (no child handle), also detect
// the process finishing by watching its pid — that's our only completion signal.
function tick(sessionId) {
  const e = runningChats.get(sessionId);
  if (!e) return;
  pumpLogs(sessionId, false);
  // A reattached turn (no child handle) is done when it either produced its
  // terminal result — the authoritative "finished" signal, robust to pid reuse —
  // or its pid is gone. sawResult ⇒ a clean finish; pid gone without it ⇒ interrupted.
  if (e.reattached && (e.sawResult || (e.pid && !isAlive(e.pid)))) {
    finalizeTurn(sessionId, null, { interrupted: true });
  }
}

// Wind a turn down exactly once: final flush, translate any failure into
// actionable guidance, drop live state + logs, then start the next queued turn.
// Called whenever the server goes fully idle (no running turns). version.js
// registers the deferred-relaunch check here so turns.js needn't depend on it.
const idleHooks = [];
function onIdle(fn) { idleHooks.push(fn); }

// Wind a turn down exactly once: final flush, translate any failure into
// actionable guidance, drop live state + logs, then start the next queued turn.
function finalizeTurn(sessionId, err, opts = {}) {
  const e = runningChats.get(sessionId);
  if (!e || e.finalizing) return;
  e.finalizing = true;
  if (e.timer) clearTimeout(e.timer);
  if (e.tailTimer) clearInterval(e.tailTimer);
  pumpLogs(sessionId, true);                   // fold the tail before deciding
  runningChats.delete(sessionId);
  livePartial.delete(sessionId);

  // "Interrupted" only counts if the turn never produced its terminal result —
  // a turn that finished cleanly just before we noticed the pid is gone is done,
  // not interrupted.
  const interrupted = !!opts.interrupted && !e.sawResult;
  if (!e.killed && (err || e.sawAuth || e.sawUsage || interrupted)) {
    // Precedence: auth (401) > usage (429/limit) > missing binary > interrupted
    // > generic. Auth/usage surface even on exit 0, so they win over a code.
    let msg, kind = null;
    const spawnFailed = err && (err.code === 'ENOENT' || err.code === 'EINVAL');
    if (e.sawAuth) { msg = AUTH_ERR_MSG; kind = 'auth'; }
    else if (e.sawUsage) { msg = usageErrorMessage(e.usageErrLine); kind = 'usage'; }
    else if (spawnFailed) { msg = MISSING_BIN_MSG; kind = 'missing'; }
    else if (interrupted) { msg = INTERRUPTED_MSG; kind = 'interrupted'; }
    else { msg = e.stderrTail || (err && err.message) || 'turn failed'; }
    lastChatError.set(sessionId, msg.trim().slice(0, 500));
    if (kind) lastChatErrorKind.set(sessionId, kind); else lastChatErrorKind.delete(sessionId);
  }
  try { fs.rmSync(e.outFile, { force: true }); fs.rmSync(e.errFile, { force: true }); } catch {}
  persistRuns();
  drainQueue(sessionId); // start the next queued turn, if any
  for (const fn of idleHooks) fn(); // e.g. a deferred relaunch (see version.js)
}

// Spawn one turn, DETACHED, with stdout/stderr redirected to per-turn log files.
// Detaching (new process group) + redirecting to files (not parent-owned pipes)
// is what lets the turn outlive a server restart, the way a terminal session
// would: the CLI keeps running and keeps writing here, and the next boot
// reattaches via the persisted pid (see reconcileOnBoot).

// Spawn one turn, DETACHED, with stdout/stderr redirected to per-turn log files.
// Detaching (new process group) + redirecting to files (not parent-owned pipes)
// is what lets the turn outlive a server restart, the way a terminal session
// would: the CLI keeps running and keeps writing here, and the next boot
// reattaches via the persisted pid (see reconcileOnBoot).
function spawnTurn(sessionId, text, cwd, mode, model) {
  // First turn of a brand-new session creates it at our chosen id; later turns
  // (and all turns of existing sessions) resume it. stream-json + --verbose lets
  // us read assistant blocks as they land.
  const exists = findSessionFile(sessionId);
  const base = exists ? ['--resume', sessionId] : ['--session-id', sessionId];
  const args = [...base, '-p', text, '--output-format', 'stream-json', '--verbose'];
  // bypassPermissions keeps the historical skip-flag behavior (honoring
  // CLAUDE_SAFE); any other mode is passed straight through to the CLI.
  if (mode === 'bypassPermissions') {
    if (SKIP_PERMS) args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', 'default');
  } else {
    args.push('--permission-mode', mode);
  }
  if (model) args.push('--model', model);

  const outFile = path.join(TURNS_DIR, sessionId + '.out');
  const errFile = path.join(TURNS_DIR, sessionId + '.err');
  let outFd = null, errFd = null, child;
  try {
    outFd = fs.openSync(outFile, 'w');         // truncate any prior turn's logs
    errFd = fs.openSync(errFile, 'w');
    // stdin ignored: a -p turn reads none, and an open stdin pipe makes the CLI
    // warn ("no stdin data received in 3s") and stall. detached:true makes the
    // child its own process-group leader so it survives our restart.
    child = spawn(CLAUDE_BIN, args, { cwd, stdio: ['ignore', outFd, errFd], detached: true });
  } catch (err) {
    try { if (outFd != null) fs.closeSync(outFd); } catch {}
    try { if (errFd != null) fs.closeSync(errFd); } catch {}
    // Couldn't even spawn (missing binary) — record a stub so finalizeTurn can
    // turn ENOENT/EINVAL into the "Fix setup" guidance, then wind down.
    runningChats.set(sessionId, mkEntry(sessionId, { pid: null, child: null, cwd, mode, model, outFile, errFile }));
    return finalizeTurn(sessionId, err);
  }
  try { fs.closeSync(outFd); fs.closeSync(errFd); } catch {} // the child holds its own dups
  child.unref();

  const e = mkEntry(sessionId, { pid: child.pid, child, cwd, mode, model, outFile, errFile });
  livePartial.set(sessionId, { text: '', tools: [], ask: null, updatedAt: Date.now() });
  runningChats.set(sessionId, e);
  persistRuns();

  child.on('error', err => finalizeTurn(sessionId, err));
  child.on('exit', code => finalizeTurn(sessionId, code === 0 ? null : new Error('claude exited with code ' + code)));
  e.tailTimer = setInterval(() => tick(sessionId), TAIL_MS);
  e.timer = setTimeout(() => {
    e.killed = true;
    lastChatError.set(sessionId, 'turn timed out and was stopped');
    lastChatErrorKind.delete(sessionId);
    killEntry(e);
  }, TURN_TIMEOUT_MS);
}

function drainQueue(sessionId) {
  if (runningChats.has(sessionId)) return;
  const q = chatQueues.get(sessionId);
  if (!q || !q.length) return;
  const { text, cwd } = q.shift();
  persistQueue();
  lastChatError.delete(sessionId);
  lastChatErrorKind.delete(sessionId);
  spawnTurn(sessionId, text, cwd, effectiveMode(sessionId), effectiveModel(sessionId));
}

// Reattach to a turn that was still running when a previous server process
// exited: no child handle, so we tail its logs and watch its pid for
// completion. Replays the log already on disk so the live view isn't blank.

// Reattach to a turn that was still running when a previous server process
// exited: no child handle, so we tail its logs and watch its pid for
// completion. Replays the log already on disk so the live view isn't blank.
function reattachTurn(sessionId, r) {
  const e = mkEntry(sessionId, {
    pid: r.pid, child: null, cwd: r.cwd, mode: r.mode, model: r.model,
    outFile: r.outFile, errFile: r.errFile,
  });
  e.startedAt = r.startedAt || Date.now();
  e.reattached = true;
  livePartial.set(sessionId, { text: '', tools: [], ask: null, updatedAt: Date.now() });
  runningChats.set(sessionId, e);
  pumpLogs(sessionId, false);                  // catch up on output written before this boot
  // Already finished before we got here (result in the log)? Finalize now
  // rather than waiting on a pid that may have been recycled.
  if (e.sawResult) return finalizeTurn(sessionId, null, { interrupted: true });
  e.tailTimer = setInterval(() => tick(sessionId), TAIL_MS);
  const left = Math.max(30 * 1000, TURN_TIMEOUT_MS - (Date.now() - e.startedAt));
  e.timer = setTimeout(() => {
    e.killed = true;
    lastChatError.set(sessionId, 'turn timed out and was stopped');
    lastChatErrorKind.delete(sessionId);
    killEntry(e);
    finalizeTurn(sessionId, null);
  }, left);
}

// On boot, rediscover in-flight turns and the queue a previous process left
// behind, so a restart mid-turn is invisible: a turn still running is reattached
// and finishes normally; one that died in the gap is finalized from its logs
// (surfacing an "interrupted" notice only if it never produced a result).

// On boot, rediscover in-flight turns and the queue a previous process left
// behind, so a restart mid-turn is invisible: a turn still running is reattached
// and finishes normally; one that died in the gap is finalized from its logs
// (surfacing an "interrupted" notice only if it never produced a result).
function reconcileOnBoot() {
  let runs = {}, queue = {};
  try { runs = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8')) || {}; } catch {}
  try { queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) || {}; } catch {}
  for (const [id, r] of Object.entries(runs)) {
    if (!/^[\w-]+$/.test(id) || !r || !r.outFile) continue;
    if (r.pid && isAlive(r.pid)) {
      reattachTurn(id, r);
    } else {
      // Died before we could reattach — set up a transient entry and finalize
      // from whatever its logs captured.
      runningChats.set(id, mkEntry(id, {
        pid: r.pid, child: null, cwd: r.cwd, mode: r.mode, model: r.model,
        outFile: r.outFile, errFile: r.errFile,
      }));
      finalizeTurn(id, null, { interrupted: true });
    }
  }
  persistRuns();
  for (const [id, q] of Object.entries(queue)) {
    if (/^[\w-]+$/.test(id) && Array.isArray(q) && q.length) chatQueues.set(id, q);
  }
  persistQueue();
  for (const id of chatQueues.keys()) drainQueue(id);
}

// Stop the running turn for a session and discard anything queued behind it.

// Stop the running turn for a session and discard anything queued behind it.
function chatCancel(sessionId, cb) {
  if (!/^[\w-]+$/.test(sessionId || '')) return cb(new Error('bad session id'));
  const q = chatQueues.get(sessionId);
  const dropped = q ? q.length : 0;
  if (q) q.length = 0;
  persistQueue();
  const entry = runningChats.get(sessionId);
  if (!entry && !dropped) return cb(new Error('nothing running to stop'));
  if (entry) {
    entry.killed = true;                      // so finalizeTurn doesn't log it as an error
    killEntry(entry);
    // A spawned turn finalizes via its 'exit' handler; a reattached turn has
    // none, so finalize it here (SIGTERM is on its way regardless).
    if (entry.reattached) finalizeTurn(sessionId, null);
  }
  lastChatError.delete(sessionId);
  lastChatErrorKind.delete(sessionId);
  cb(null, { stopped: !!entry, dropped });
}

// The server stopping must NOT take running turns with it: they're detached and
// keep running (and writing their transcript + logs) across our restart, the
// way a terminal session would. We persist their pids/logs so the next boot
// reattaches (see reconcileOnBoot). Queued turns are persisted too.

// The server stopping must NOT take running turns with it: they're detached and
// keep running (and writing their transcript + logs) across our restart, the
// way a terminal session would. We persist their pids/logs so the next boot
// reattaches (see reconcileOnBoot). Queued turns are persisted too.
function shutdown() {
  persistRuns();
  persistQueue();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Housekeeping — git state per repo + wrap-readiness verdict
// ---------------------------------------------------------------------------

module.exports = { TURN_TIMEOUT_MS, runningChats, chatQueues, killEntry, isAlive, persistRuns, persistQueue, lastChatError, lastChatErrorKind, livePartial, IMAGE_EXTS, OFFICE_EXTS, TEXT_EXTS, extOf, attachKind, decodeXml, officeToText, zipToText, saveAttachment, chatTurn, ingestStreamLine, pauseForQuestion, AUTH_ERR_RE, AUTH_ERR_MSG, USAGE_ERR_RE, errorSignalText, formatResetTime, usageErrorMessage, TAIL_MS, INTERRUPTED_MSG, mkEntry, pumpLogs, tick, idleHooks, onIdle, finalizeTurn, spawnTurn, drainQueue, reattachTurn, reconcileOnBoot, chatCancel, shutdown };
