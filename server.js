#!/usr/bin/env node
'use strict';

/*
 * ClaudeNav — a local navigator for your Claude Code sessions.
 *
 * Reads ~/.claude/projects, groups sessions by project, marks which ones are
 * backed by a currently-running `claude` terminal, and can open a terminal to
 * resume a session or start a new one.
 *
 * No dependencies. Binds to 127.0.0.1 only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 4317;
const HOST = '127.0.0.1';
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(os.homedir(), '.claude', 'claudenav-uploads');
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

// ---------------------------------------------------------------------------
// Session parsing (with mtime-keyed cache so repeat scans are cheap)
// ---------------------------------------------------------------------------

const cache = new Map(); // filePath -> { mtimeMs, data }

function parseSessionFile(filePath, stat) {
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;

  let title = null;
  let lastPrompt = null;
  let firstUserPrompt = null;
  let firstTs = null;
  let lastTs = null;
  let cwd = null;
  let gitBranch = null;
  let version = null;
  let sessionId = null;
  let userMsgCount = 0;
  let assistantTurns = 0;
  const models = new Set();
  const tokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  let contextTokens = 0; // size of the most recent turn's context window
  let lastEventType = null; // 'user' | 'assistant' — last conversational record
  let lastStopReason = null; // stop_reason of the most recent assistant turn

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }

    if (o.sessionId && !sessionId) sessionId = o.sessionId;
    if (o.cwd) cwd = o.cwd;
    if (o.gitBranch) gitBranch = o.gitBranch;
    if (o.version) version = o.version;
    if (o.timestamp) {
      if (!firstTs) firstTs = o.timestamp;
      lastTs = o.timestamp;
    }

    switch (o.type) {
      case 'ai-title':
        if (o.aiTitle) title = o.aiTitle;
        break;
      case 'last-prompt':
        if (o.lastPrompt) lastPrompt = o.lastPrompt;
        break;
      case 'user': {
        userMsgCount++;
        lastEventType = 'user';
        const c = o.message && o.message.content;
        const text = typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.filter(p => p && p.type === 'text').map(p => p.text).join(' ')
            : null;
        if (text && !firstUserPrompt) firstUserPrompt = text.trim();
        break;
      }
      case 'assistant': {
        lastEventType = 'assistant';
        const m = o.message || {};
        if (m.model && m.model !== '<synthetic>') models.add(m.model);
        if (m.stop_reason !== undefined) lastStopReason = m.stop_reason;
        const u = m.usage;
        if (u) {
          assistantTurns++;
          tokens.input += u.input_tokens || 0;
          tokens.output += u.output_tokens || 0;
          tokens.cacheCreation += u.cache_creation_input_tokens || 0;
          tokens.cacheRead += u.cache_read_input_tokens || 0;
          // Most recent turn's context = everything fed in for that turn.
          contextTokens = (u.input_tokens || 0)
            + (u.cache_read_input_tokens || 0)
            + (u.cache_creation_input_tokens || 0);
        }
        break;
      }
    }
  }

  const data = {
    sessionId: sessionId || path.basename(filePath, '.jsonl'),
    title: title || firstUserPrompt || '(untitled)',
    lastPrompt: lastPrompt || firstUserPrompt || '',
    firstUserPrompt: firstUserPrompt || '',
    cwd: cwd || '',
    gitBranch: gitBranch || '',
    version: version || '',
    userMsgCount,
    assistantTurns,
    models: [...models],
    tokens,
    contextTokens,
    lastEventType,
    lastStopReason,
    firstTs,
    lastTs,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    filePath,
  };
  cache.set(filePath, { mtimeMs: stat.mtimeMs, data });
  return data;
}

// ---------------------------------------------------------------------------
// Live terminal detection — running `claude` CLI processes and their cwds
// ---------------------------------------------------------------------------

// Returns { byCwd: Map<cwd, [tty,...]>, ttys: Set<tty> } for running claude CLIs.
function getLiveTerminals() {
  const byCwd = new Map();
  const pidsByCwd = new Map();
  const ttys = new Set();
  let psOut = '';
  try {
    psOut = execFileSync('ps', ['-axo', 'pid=,tty=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch { return { byCwd, ttys, pidsByCwd }; }

  const procs = [];
  for (const line of psOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, tty, cmd] = m;
    const isCli = /(^|\/)claude(\s|$)/.test(cmd)
      && !cmd.includes('Claude.app')
      && !cmd.includes('chrome-native-host')
      && !cmd.includes('shell-snapshots');
    if (isCli && tty && tty !== '??') procs.push({ pid, tty });
  }

  for (const { pid, tty } of procs) {
    try {
      const out = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
      const nline = out.split('\n').find(l => l.startsWith('n'));
      if (!nline) continue;
      const cwd = nline.slice(1);
      const devTty = '/dev/' + tty;
      if (!byCwd.has(cwd)) byCwd.set(cwd, []);
      byCwd.get(cwd).push(devTty);
      if (!pidsByCwd.has(cwd)) pidsByCwd.set(cwd, []);
      pidsByCwd.get(cwd).push(Number(pid));
      ttys.add(devTty);
    } catch { /* process may have exited */ }
  }
  return { byCwd, ttys, pidsByCwd };
}

// ---------------------------------------------------------------------------
// Build the full session list grouped by project
// ---------------------------------------------------------------------------

// Classify a session's state from its tail records + liveness.
//   working      — mid-turn and actively producing output: the transcript was
//                  written to in the last 90s, or the server is running a headless
//                  turn for it. NOT based on terminal liveness — that's detected
//                  per-directory and can't tell an exited session from a sibling.
//   waiting      — last assistant turn ended (end_turn) and it's live/recent:
//                  your turn, waiting for input.
//   idle         — parked: nothing running. Includes mid-turn sessions that are
//                  merely paused or running headless somewhere we can't detect —
//                  we do NOT cry "interrupted" for those.
//   interrupted  — mid-turn and untouched for 30+ min: genuinely left half-done.
function computeStatus(s) {
  // A turn this server is running (or has queued) for the session counts as live,
  // even when ps+lsof can't see a terminal for it (headless / IDE / remote).
  const serverActive = runningChats.has(s.sessionId)
    || (chatQueues.get(s.sessionId) || []).length > 0;
  if (serverActive) return 'working';

  const recentMs = Date.now() - (s.mtimeMs || 0);
  const activelyWriting = recentMs < 90 * 1000;     // transcript written in last 90s
  const recent = recentMs < 5 * 60 * 1000;          // touched in last 5 min
  const longAbandoned = recentMs > 30 * 60 * 1000;  // mid-turn, untouched 30 min+
  const ended = s.lastStopReason === 'end_turn';
  const midTurn = s.lastEventType === 'user' || (s.lastStopReason && !ended);

  if (midTurn) {
    // "working" must mean actually producing output. We deliberately do NOT trust
    // s.likelyLive here: liveness is detected per working-directory, so a session
    // you've exited still looks "live" whenever a sibling terminal runs in the same
    // dir — which made exited mid-turn sessions show amber "working" indefinitely.
    // A real in-progress turn writes blocks continuously, so a recent transcript
    // write is the only trustworthy signal; everything else mid-turn is paused or
    // abandoned. (serverActive, handled above, covers headless turns we run.)
    if (activelyWriting) return 'working';
    if (longAbandoned) return 'interrupted';  // really left half-done → needs you
    return 'idle';                            // paused / exited / headless — don't alarm
  }
  if (ended && (s.likelyLive || recent)) return 'waiting';
  return 'idle';
}

function buildData() {
  const { byCwd: liveByCwd } = getLiveTerminals();
  const projects = new Map(); // cwd -> { cwd, name, liveTerminals, liveTtys, sessions: [] }

  let projectDirs = [];
  try { projectDirs = fs.readdirSync(PROJECTS_DIR); } catch { projectDirs = []; }

  for (const dir of projectDirs) {
    const dirPath = path.join(PROJECTS_DIR, dir);
    let dirStat;
    try { dirStat = fs.statSync(dirPath); } catch { continue; }
    if (!dirStat.isDirectory()) continue;

    let files = [];
    try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }

    for (const file of files) {
      const fp = path.join(dirPath, file);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      let s;
      try { s = parseSessionFile(fp, st); } catch { continue; }

      const sessionCwd = s.cwd || dir;
      // Worktree sessions live at <parent>/.claude/worktrees/<leaf>. Fold them
      // back under their parent project so they appear at the top of that
      // project's session list rather than as a separate top-level folder.
      const wt = sessionCwd.match(/^(.*)\/\.claude\/worktrees\/[^/]+$/);
      const projCwd = wt ? wt[1] : sessionCwd;
      s.isWorktree = !!wt;
      if (!projects.has(projCwd)) {
        const ttys = liveByCwd.get(projCwd) || [];
        projects.set(projCwd, {
          cwd: projCwd,
          name: projCwd.split('/').filter(Boolean).slice(-2).join('/') || projCwd,
          liveTerminals: ttys.length,
          liveTtys: ttys,
          sessions: [],
        });
      }
      projects.get(projCwd).sessions.push(s);
    }
  }

  // Sort sessions within each project (newest first) and flag the live one.
  const result = [];
  for (const p of projects.values()) {
    p.sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    // Heuristic: if the project has live terminals, the most-recently-touched
    // sessions are the ones likely open right now.
    p.sessions.forEach((s, i) => {
      s.likelyLive = p.liveTerminals > 0 && i < p.liveTerminals;
      s.status = computeStatus(s);
      // Confident tab mapping only when the folder has a single live terminal.
      s.inputTty = (p.liveTerminals === 1 && i === 0) ? p.liveTtys[0] : null;
    });
    p.lastActivity = p.sessions.length ? p.sessions[0].mtimeMs : 0;
    result.push(p);
  }
  // Projects with live terminals first, then by most recent activity.
  result.sort((a, b) => (b.liveTerminals - a.liveTerminals) || (b.lastActivity - a.lastActivity));
  return { projects: result, generatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Opening terminals via AppleScript
// ---------------------------------------------------------------------------

function shQuote(str) {
  return "'" + String(str).replace(/'/g, `'\\''`) + "'";
}

function osaQuote(str) {
  return '"' + String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function buildShellCommand({ cwd, sessionId }) {
  let cmd = `cd ${shQuote(cwd)} && claude`;
  if (sessionId) cmd += ` --resume ${shQuote(sessionId)}`;
  return cmd;
}

function appleScriptFor(appName, shellCmd) {
  const q = osaQuote(shellCmd);
  if (appName === 'iTerm') {
    return [
      'tell application "iTerm"',
      '  activate',
      '  create window with default profile',
      `  tell current session of current window to write text ${q}`,
      'end tell',
    ].join('\n');
  }
  // Default: Terminal.app
  return [
    'tell application "Terminal"',
    '  activate',
    `  do script ${q}`,
    'end tell',
  ].join('\n');
}

function openTerminal({ cwd, sessionId, app }, cb) {
  if (!cwd) return cb(new Error('missing cwd'));
  const shellCmd = buildShellCommand({ cwd, sessionId });
  const script = appleScriptFor(app === 'iTerm' ? 'iTerm' : 'Terminal', shellCmd);
  execFile('osascript', ['-e', script], (err, stdout, stderr) => {
    if (err) return cb(new Error(stderr || err.message));
    cb(null, { ran: shellCmd });
  });
}

// ---------------------------------------------------------------------------
// Transcript reading (for the in-browser conversation view)
// ---------------------------------------------------------------------------

function findSessionFile(sessionId) {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const dir of dirs) {
    const fp = path.join(PROJECTS_DIR, dir, sessionId + '.jsonl');
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

// Tool detail/output strings are folded into the transcript payload so the UI
// can expand each tool call. Cap them so a huge file read or `find /` dump can't
// bloat the JSON (and the browser) — the on-disk transcript stays authoritative.
const TOOL_CAP = 6000;
function clip(s) {
  s = typeof s === 'string' ? s : (s == null ? '' : String(s));
  return s.length > TOOL_CAP ? s.slice(0, TOOL_CAP) + `\n… (${s.length - TOOL_CAP} more chars)` : s;
}

// One-line summary shown on the collapsed tool row (command, path, pattern…).
function toolDetail(name, input) {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'Bash': return input.command || input.description || '';
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return input.file_path || input.notebook_path || '';
    case 'Grep': return input.pattern || '';
    case 'Glob': return input.pattern || '';
    case 'Task': case 'Agent': return input.description || '';
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return input.query || '';
    case 'Skill': return input.skill || '';
    default: {
      const v = Object.values(input).find(x => typeof x === 'string');
      return v || '';
    }
  }
}

// Full input rendering for the expanded view.
function toolBody(name, input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (name === 'Bash') return String(input.command || '');
  if (name === 'Edit') return `${input.file_path || ''}\n\n--- replace ---\n${input.old_string || ''}\n\n--- with ---\n${input.new_string || ''}`;
  if (name === 'Write') return `${input.file_path || ''}\n\n${input.content || ''}`;
  try { return JSON.stringify(input, null, 2); } catch { return ''; }
}

// tool_result content is a string or an array of {type:'text',text} blocks.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p && p.type === 'text').map(p => p.text).join('\n');
  return '';
}

function parseTranscript(filePath) {
  const messages = [];
  const toolUseById = new Map(); // tool_use id -> tool object, so results can attach
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue; // skip subagent chatter
    const m = o.message;
    if (o.type === 'user' && m) {
      const c = m.content;
      let text = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.filter(p => p && p.type === 'text').map(p => p.text).join('\n')
          : '';
      // Tool results ride in on (otherwise skipped) user messages — attach each
      // back to the tool_use that produced it so the UI can show the output.
      if (Array.isArray(c)) {
        for (const p of c) {
          if (p && p.type === 'tool_result' && p.tool_use_id) {
            const tool = toolUseById.get(p.tool_use_id);
            if (tool) {
              tool.output = clip(resultText(p.content));
              if (p.is_error) tool.error = true;
            }
          }
        }
      }
      // Skip messages that are purely tool results (no human text).
      const onlyToolResult = Array.isArray(c) && c.every(p => p && p.type === 'tool_result');
      if (text.trim() && !onlyToolResult) {
        messages.push({ role: 'user', text: text.trim(), ts: o.timestamp || null });
      }
    } else if (o.type === 'assistant' && m) {
      const c = m.content;
      let text = '';
      const tools = [];
      let ask = null;
      if (Array.isArray(c)) {
        for (const p of c) {
          if (!p) continue;
          if (p.type === 'text') text += (text ? '\n' : '') + p.text;
          else if (p.type === 'tool_use') {
            const tool = { name: p.name, detail: clip(toolDetail(p.name, p.input)), body: clip(toolBody(p.name, p.input)) };
            tools.push(tool);
            if (p.id) toolUseById.set(p.id, tool);
            // Surface the structured choices behind an interactive question so the
            // browser can render clickable options. Headless turns auto-dismiss the
            // prompt (the user never sees it), but the questions+options live right
            // here — the UI turns them into buttons and a click becomes the next
            // resumed turn. (See README/CLAUDE notes on headless AskUserQuestion.)
            if (p.name === 'AskUserQuestion' && p.input && Array.isArray(p.input.questions)) {
              ask = { questions: p.input.questions };
            }
          }
        }
      } else if (typeof c === 'string') text = c;
      if (text.trim() || tools.length) {
        const msg = { role: 'assistant', text: text.trim(), tools, ts: o.timestamp || null };
        if (ask) msg.ask = ask;
        messages.push(msg);
      }
    }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Browser-driven chat — run a turn headlessly against an existing session.
// `claude --resume <id> -p "<text>"` continues the same session and appends to
// the same transcript, which the /api/transcript tailer then surfaces.
// ---------------------------------------------------------------------------

// Resolve the `claude` binary robustly. Under a bare shell it's on PATH, but
// when ClaudeNav is launched by launchd / systemd / a double-click the inherited
// PATH is minimal and a plain 'claude' spawn fails with ENOENT. So: honor an
// explicit CLAUDE_BIN, else trust PATH if it resolves, else probe the known
// install locations before giving up.
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  // Trust PATH first (respects nvm / custom installs) — `command -v` via the shell.
  try {
    const onPath = execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim();
    if (onPath) return onPath;
  } catch { /* not on PATH; fall through to probing */ }
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  console.warn('[claudenav] WARNING: could not locate the `claude` binary — headless turns will fail with ENOENT. Set CLAUDE_BIN to its path.');
  return 'claude'; // last resort; will ENOENT, but with the warning above to explain it
}
const CLAUDE_BIN = resolveClaudeBin();
console.log(`[claudenav] using claude binary: ${CLAUDE_BIN}`);
// Sessions run with skipped permissions so the assistant can actually use tools
// (matches how these terminal sessions were started). Set CLAUDE_SAFE=1 to omit.
const SKIP_PERMS = process.env.CLAUDE_SAFE !== '1';

const TURN_TIMEOUT_MS = Number(process.env.CLAUDE_TURN_TIMEOUT_MS) || 15 * 60 * 1000;

const runningChats = new Map(); // sessionId -> { child, startedAt, timer, killed }
const chatQueues = new Map();   // sessionId -> [text, ...] turns waiting their turn
const lastChatError = new Map(); // sessionId -> error string
// Live (in-flight) assistant output for a running turn, surfaced via chat-status
// so the browser can show progress before the transcript file is finalized.
const livePartial = new Map();  // sessionId -> { text, tools, updatedAt }

const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

// Decode a base64 data URL to a file in UPLOADS_DIR; returns its absolute path.
function saveImage(dataUrl) {
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const ext = IMG_EXT[m[1]] || 'png';
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 20 * 1024 * 1024) return null; // 20MB cap
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const fp = path.join(UPLOADS_DIR, name);
  fs.writeFileSync(fp, buf);
  return fp;
}

// Enqueue a turn. Turns for one session always run one-at-a-time, in order, so
// the on-disk transcript never has two of *our* writers at once. (A terminal
// can still write independently; each browser turn re-reads the latest file, so
// it always continues from the newest state.)
function chatTurn(sessionId, text, images, newCwd, cb) {
  if (!/^[\w-]+$/.test(sessionId || '')) return cb(new Error('bad session id'));
  const imgPaths = (Array.isArray(images) ? images : []).map(saveImage).filter(Boolean);
  if ((!text || !text.trim()) && !imgPaths.length) return cb(new Error('empty message'));

  // Existing session: use its recorded cwd. New session (no file yet): use the
  // cwd the caller passed — drainQueue will create it with --session-id.
  const fp = findSessionFile(sessionId);
  let cwd = '';
  if (fp) { try { cwd = parseSessionFile(fp, fs.statSync(fp)).cwd; } catch {} }
  else { cwd = newCwd || ''; }
  if (!cwd || !fs.existsSync(cwd)) return cb(new Error('working directory is missing'));

  // Reference each image by absolute path; Claude reads it with the Read tool.
  let prompt = (text || '').trim();
  if (imgPaths.length) {
    prompt += (prompt ? '\n\n' : '') + imgPaths.map(p => `[Attached image: ${p}]`).join('\n');
  }

  if (!chatQueues.has(sessionId)) chatQueues.set(sessionId, []);
  const q = chatQueues.get(sessionId);
  q.push({ text: prompt, cwd });
  const position = (runningChats.has(sessionId) ? 1 : 0) + q.length - 1;
  drainQueue(sessionId);
  cb(null, { running: true, queued: position });
}

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
    }
  }
  lp.updatedAt = Date.now();
}

function drainQueue(sessionId) {
  if (runningChats.has(sessionId)) return;
  const q = chatQueues.get(sessionId);
  if (!q || !q.length) return;
  const { text, cwd } = q.shift();
  lastChatError.delete(sessionId);

  // First turn of a brand-new session creates it at our chosen id; later turns
  // (and all turns of existing sessions) continue it. stream-json + --verbose
  // lets us read assistant blocks as they land (claude still writes the
  // transcript file regardless of output format).
  const exists = findSessionFile(sessionId);
  const base = exists ? ['--resume', sessionId] : ['--session-id', sessionId];
  const args = [...base, '-p', text, '--output-format', 'stream-json', '--verbose'];
  if (SKIP_PERMS) args.push('--dangerously-skip-permissions');

  const child = spawn(CLAUDE_BIN, args, { cwd });
  livePartial.set(sessionId, { text: '', tools: [], updatedAt: Date.now() });

  let buf = '';
  let stderrTail = '';
  child.stdout.on('data', chunk => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.trim()) ingestStreamLine(sessionId, line);
    }
    if (buf.length > (1 << 20)) buf = buf.slice(-(1 << 16)); // guard a pathological no-newline line
  });
  child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-2000); });

  const finish = (err) => {
    const entry = runningChats.get(sessionId);
    if (!entry) return;                       // already finalized (close + error both fired)
    if (entry.timer) clearTimeout(entry.timer);
    runningChats.delete(sessionId);
    livePartial.delete(sessionId);
    if (err && !entry.killed) {
      lastChatError.set(sessionId, (stderrTail || err.message || 'turn failed').trim().slice(0, 500));
    }
    drainQueue(sessionId); // start the next queued turn, if any
  };
  child.on('error', err => finish(err));
  child.on('close', code => finish(code === 0 ? null : new Error('claude exited with code ' + code)));

  const entry = { child, startedAt: Date.now(), killed: false };
  entry.timer = setTimeout(() => {
    entry.killed = true;
    lastChatError.set(sessionId, 'turn timed out and was stopped');
    try { child.kill('SIGTERM'); } catch {}
  }, TURN_TIMEOUT_MS);
  runningChats.set(sessionId, entry);
}

// Stop the running turn for a session and discard anything queued behind it.
function chatCancel(sessionId, cb) {
  if (!/^[\w-]+$/.test(sessionId || '')) return cb(new Error('bad session id'));
  const q = chatQueues.get(sessionId);
  const dropped = q ? q.length : 0;
  if (q) q.length = 0;
  const entry = runningChats.get(sessionId);
  if (!entry && !dropped) return cb(new Error('nothing running to stop'));
  if (entry) {
    entry.killed = true;                      // so finish() doesn't log it as an error
    if (entry.timer) clearTimeout(entry.timer);
    try { entry.child.kill('SIGTERM'); } catch {}
  }
  lastChatError.delete(sessionId);
  cb(null, { stopped: !!entry, dropped });
}

// Kill any in-flight headless turns when the server stops.
function shutdown() {
  for (const { child, timer } of runningChats.values()) {
    if (timer) clearTimeout(timer);
    try { child.kill('SIGTERM'); } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Housekeeping — git state per repo + wrap-readiness verdict
// ---------------------------------------------------------------------------

function git(cwd, args) {
  // stdio[2]='pipe' captures git's stderr onto the thrown error instead of
  // letting it leak to our stdout/stderr (which the LaunchAgent tees to the
  // log). Expected failures here — a branch with no upstream (`@{u}`), a
  // non-repo dir — are caught by callers, so without this they'd spam the log.
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// ---------------------------------------------------------------------------
// Self-version + update/relaunch — lets the browser notice new code and apply it
// ---------------------------------------------------------------------------

const REPO_DIR = __dirname;            // server.js lives at the repo root
const BOOT_ID = Date.now();            // unique per process — changes on restart
function gitRepo(args) { try { return git(REPO_DIR, args); } catch { return ''; } }
const BOOT_HEAD = gitRepo(['rev-parse', '--short', 'HEAD']);  // code this process started on

// `git fetch` is networked and can stall, so we run it in the background at most
// once per TTL and serve the last-known "commits behind" count to callers.
let fetchState = { at: 0, running: false, behind: 0 };
const FETCH_TTL = 5 * 60 * 1000;
function maybeFetch() {
  const now = Date.now();
  if (fetchState.running || (fetchState.at && now - fetchState.at < FETCH_TTL)) return;
  if (!BOOT_HEAD) return;                                 // not a git checkout
  fetchState.running = true;
  execFile('git', ['-C', REPO_DIR, 'fetch', '--quiet'], { timeout: 20000 }, () => {
    fetchState.running = false;
    fetchState.at = Date.now();
    fetchState.behind = Number(gitRepo(['rev-list', '--count', 'HEAD..@{u}'])) || 0;
  });
}

// What the running process is, what's on disk now, and what's upstream.
function versionInfo() {
  maybeFetch();
  const head = gitRepo(['rev-parse', '--short', 'HEAD']) || BOOT_HEAD;
  const branch = gitRepo(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = gitRepo(['status', '--porcelain']).split('\n').filter(Boolean).length;
  const hasRemote = !!gitRepo(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  return {
    bootId: BOOT_ID,        // changes when the server restarts
    bootHead: BOOT_HEAD,    // commit the process is running
    head,                   // commit currently checked out on disk
    branch,
    dirty,
    behind: fetchState.behind,
    hasRemote,
    // Safe to fast-forward only when clean and actually behind.
    canUpdate: hasRemote && fetchState.behind > 0 && dirty === 0,
  };
}

// Pull (optional) then ask run-server.sh to relaunch us via the dedicated exit
// code 42. Responds first, then exits a beat later so the HTTP reply lands.
function selfUpdate({ pull }, cb) {
  if (!BOOT_HEAD) return cb(new Error('not a git checkout — cannot self-update'));
  if (pull) {
    try { git(REPO_DIR, ['pull', '--ff-only']); }
    catch (e) {
      const msg = (e.stderr || e.stdout || e.message || '').toString().trim().slice(0, 300);
      return cb(new Error('git pull --ff-only failed: ' + (msg || 'unknown error')));
    }
  }
  cb(null, { relaunching: true, head: gitRepo(['rev-parse', '--short', 'HEAD']) });
  setTimeout(() => {
    for (const { child, timer } of runningChats.values()) {
      if (timer) clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
    }
    process.exit(42); // run-server.sh treats 42 as "relaunch now"
  }, 300);
}

function gitInfo(cwd) {
  try { if (git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return { isRepo: false }; }
  catch { return { isRepo: false }; }
  const info = { isRepo: true, branch: '', dirty: 0, files: [], ahead: 0, behind: 0, hasRemote: false };
  try { info.branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch {}
  try {
    const lines = git(cwd, ['status', '--porcelain']).split('\n').filter(Boolean);
    info.dirty = lines.length;
    info.files = lines.slice(0, 50);
  } catch {}
  try {
    const c = git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD']).split(/\s+/).map(Number);
    info.behind = c[0] || 0; info.ahead = c[1] || 0; info.hasRemote = true;
  } catch { info.hasRemote = false; }
  return info;
}

// Set of working directories that belong to a known session (guards git writes).
function knownCwds() {
  return new Set(buildData().projects.map(p => p.cwd).filter(Boolean));
}

function housekeeping() {
  const { projects } = buildData();
  const repos = projects.map(p => {
    const busy = p.sessions.some(s => s.status === 'working');
    let gi = { isRepo: false };
    try { gi = gitInfo(p.cwd); } catch {}
    let verdict;
    if (busy) verdict = 'busy';
    else if (!gi.isRepo) verdict = 'clean';     // nothing to save
    else if (gi.dirty > 0) verdict = 'dirty';   // uncommitted work
    else if (gi.ahead > 0) verdict = 'unpushed'; // committed but not pushed
    else verdict = 'clean';
    return {
      cwd: p.cwd,
      name: p.name,
      liveTerminals: p.liveTerminals,
      verdict,
      git: gi,
      sessions: p.sessions.map(s => ({ sessionId: s.sessionId, title: s.title, status: s.status })),
    };
  });
  const order = { busy: 0, dirty: 1, unpushed: 2, clean: 3 };
  repos.sort((a, b) => (order[a.verdict] - order[b.verdict]) || a.name.localeCompare(b.name));
  return { repos, generatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Repo history — local git stats for the in-browser visualiser
// ---------------------------------------------------------------------------

// Like git() but tolerates the large output of a full `git log` (the default
// 1MB execFileSync buffer overflows on big repos).
function gitOut(cwd, args, maxBuffer = 64 * 1024 * 1024) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer });
}

// Build a full history snapshot for one repo from local git, entirely offline:
// overview, weekly commit volume, top contributors, a weekday×hour punch-card,
// a by-extension byte breakdown, and the most recent commits. Restricted to
// known-session directories (same guard as the git write endpoints).
function repoHistory(cwd) {
  if (!knownCwds().has(cwd)) { const e = new Error('unknown working directory'); e.status = 403; throw e; }
  try {
    if (git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') throw new Error('x');
  } catch { const e = new Error('not a git repository'); e.status = 400; throw e; }

  const US = '\x1f'; // unit separator — safe field delimiter inside git formats
  let branch = '', head = '', remoteUrl = '';
  try { branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch {}
  try { head = git(cwd, ['rev-parse', '--short', 'HEAD']); } catch {}
  try { remoteUrl = git(cwd, ['remote', 'get-url', 'origin']); } catch {}

  // One pass over every commit: author name, email, ISO author date.
  let raw = '';
  try { raw = gitOut(cwd, ['log', `--format=%an${US}%ae${US}%aI`]); } catch {}
  const lines = raw.split('\n').filter(Boolean);

  const WEEKS = 52;
  const MS_WEEK = 7 * 24 * 3600 * 1000;
  const now = Date.now();
  const weekly = new Array(WEEKS).fill(0);
  const punchCard = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const contribMap = new Map(); // name<email> -> { name, count }
  let firstDate = null, lastDate = null;

  for (const line of lines) {
    const [name, email, iso] = line.split(US);
    const key = (name || '') + '<' + (email || '') + '>';
    const c = contribMap.get(key) || { name: name || 'unknown', count: 0 };
    c.count++; contribMap.set(key, c);
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    if (firstDate === null || t < firstDate) firstDate = t;
    if (lastDate === null || t > lastDate) lastDate = t;
    const d = new Date(t);
    punchCard[d.getDay()][d.getHours()]++;
    const weeksAgo = Math.floor((now - t) / MS_WEEK);
    if (weeksAgo >= 0 && weeksAgo < WEEKS) weekly[WEEKS - 1 - weeksAgo]++;
  }

  // Byte share by file extension across tracked files (a rough "languages").
  const languages = {};
  try {
    const files = gitOut(cwd, ['ls-files']).split('\n').filter(Boolean);
    for (const f of files.slice(0, 50000)) {
      const base = f.slice(f.lastIndexOf('/') + 1);
      const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '(none)';
      let size = 0;
      try { size = fs.statSync(path.join(cwd, f)).size; } catch {}
      languages[ext] = (languages[ext] || 0) + size;
    }
  } catch {}

  // Latest commits with subject lines (separate, small query).
  let recentCommits = [];
  try {
    recentCommits = gitOut(cwd, ['log', '-20', `--format=%h${US}%an${US}%aI${US}%s`])
      .split('\n').filter(Boolean)
      .map(l => { const [sha, author, date, message] = l.split(US); return { sha, author, date, message }; });
  } catch {}

  return {
    repo: {
      name: cwd.split('/').filter(Boolean).slice(-1)[0] || cwd,
      cwd, branch, head, remoteUrl,
      totalCommits: lines.length,
      contributors: contribMap.size,
      firstDate, lastDate,
    },
    weekly,
    punchCard,
    contributors: [...contribMap.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    languages,
    recentCommits,
  };
}

function gitCommit(cwd, message, cb) {
  if (!knownCwds().has(cwd)) return cb(new Error('unknown working directory'));
  const msg = (message || '').trim() || 'checkpoint (ClaudeNav wrap-up)';
  try {
    git(cwd, ['add', '-A']);
    const out = execFileSync('git', ['-C', cwd, 'commit', '-m', msg], { encoding: 'utf8' });
    cb(null, { committed: true, output: out.trim().split('\n').slice(-1)[0] });
  } catch (e) {
    cb(new Error((e.stderr || e.stdout || e.message || 'commit failed').toString().trim().slice(0, 300)));
  }
}

function gitPush(cwd, cb) {
  if (!knownCwds().has(cwd)) return cb(new Error('unknown working directory'));
  try {
    const out = execFileSync('git', ['-C', cwd, 'push'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    cb(null, { pushed: true, output: (out || 'pushed').trim().split('\n').slice(-1)[0] });
  } catch (e) {
    cb(new Error((e.stderr || e.stdout || e.message || 'push failed').toString().trim().slice(0, 300)));
  }
}

// ---------------------------------------------------------------------------
// Per-session git worktrees — each session gets its own isolated clone so
// parallel sessions never edit the same working tree.
// ---------------------------------------------------------------------------

function sanitizeLeaf(name) {
  return (name || 'session').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
}

// Create a worktree on a fresh branch off HEAD; returns its path + branch.
function gitWorktreeAdd(cwd, name, cb) {
  if (!knownCwds().has(cwd)) return cb(new Error('unknown working directory'));
  try { if (git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return cb(new Error('not a git repo')); }
  catch { return cb(new Error('not a git repo')); }
  const leaf = sanitizeLeaf(name) + '-' + crypto.randomBytes(3).toString('hex');
  const branch = 'session/' + leaf;
  const wtPath = path.join(cwd, '.claude', 'worktrees', leaf);
  try {
    execFileSync('git', ['-C', cwd, 'worktree', 'add', '-b', branch, wtPath, 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    cb(null, { path: wtPath, branch });
  } catch (e) {
    cb(new Error((e.stderr || e.message || 'worktree add failed').toString().trim().slice(0, 300)));
  }
}

// Merge a session worktree's branch back into the repo's main checkout, then
// remove the worktree. Refuses if the main checkout has uncommitted changes
// (so we never clobber another session's in-flight work).
function gitWorktreeMerge(wtPath, cb) {
  try {
    const branch = git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const list = git(wtPath, ['worktree', 'list', '--porcelain']);
    const main = (list.split('\n').find(l => l.startsWith('worktree ')) || '').slice('worktree '.length);
    if (!main) return cb(new Error('could not locate main worktree'));
    if (path.resolve(main) === path.resolve(wtPath)) return cb(new Error('this is the main worktree'));
    if (git(main, ['status', '--porcelain'])) {
      return cb(new Error('main checkout has uncommitted changes — commit or stash them first'));
    }
    // Commit anything pending in the session worktree, then merge into main.
    if (git(wtPath, ['status', '--porcelain'])) {
      git(wtPath, ['add', '-A']);
      execFileSync('git', ['-C', wtPath, 'commit', '-m', 'session changes (ClaudeNav)'], { encoding: 'utf8' });
    }
    try {
      execFileSync('git', ['-C', main, 'merge', '--no-edit', branch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      try { git(main, ['merge', '--abort']); } catch {}
      return cb(new Error('merge conflict — resolve manually: ' + (e.stderr || e.message || '').toString().trim().slice(0, 200)));
    }
    try {
      execFileSync('git', ['-C', main, 'worktree', 'remove', '--force', wtPath], { encoding: 'utf8' });
      git(main, ['branch', '-D', branch]);
    } catch { /* merged fine; cleanup is best-effort */ }
    cb(null, { merged: true, branch, into: git(main, ['rev-parse', '--abbrev-ref', 'HEAD']) });
  } catch (e) {
    cb(new Error((e.stderr || e.message || 'merge error').toString().trim().slice(0, 300)));
  }
}

// ---------------------------------------------------------------------------
// Wrap-up: AI "is it safe to wrap?" enquiry + graceful exit
// ---------------------------------------------------------------------------

// Ask the session itself, headlessly, whether it's safe to close. Returns a
// structured verdict. This adds one turn to the transcript (it's an enquiry).
function assessSession(sessionId, cb) {
  if (!/^[\w-]+$/.test(sessionId || '')) return cb(new Error('bad session id'));
  if (runningChats.has(sessionId)) return cb(new Error('session is busy'));
  const fp = findSessionFile(sessionId);
  if (!fp) return cb(new Error('session not found'));
  let cwd = '';
  try { cwd = parseSessionFile(fp, fs.statSync(fp)).cwd; } catch {}
  if (!cwd || !fs.existsSync(cwd)) return cb(new Error('working directory is missing'));

  const prompt = 'WRAP-UP CHECK. Do not modify any files. Assess whether this session is safe to wrap up and close. '
    + 'Reply with ONLY a single-line JSON object and nothing else: '
    + '{"safe": true|false, "reason": "<=12 words", "commitMessage": "<concise message for any uncommitted work, else empty>"}. '
    + 'safe must be false if you are mid-task or have unfinished work in progress.';
  const args = ['--resume', sessionId, '-p', prompt, '--output-format', 'json'];
  if (SKIP_PERMS) args.push('--dangerously-skip-permissions');

  const child = execFile(CLAUDE_BIN, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
    const e = runningChats.get(sessionId); if (e && e.timer) clearTimeout(e.timer);
    runningChats.delete(sessionId);
    if (err && !(e && e.killed)) return cb(new Error('assessment failed'));
    let verdict;
    try {
      const result = (JSON.parse(stdout).result || '').trim();
      const j = result.match(/\{[\s\S]*\}/);
      verdict = JSON.parse(j ? j[0] : result);
    } catch { verdict = { safe: false, reason: 'could not parse assessment', commitMessage: '' }; }
    cb(null, {
      safe: !!verdict.safe,
      reason: String(verdict.reason || '').slice(0, 120),
      commitMessage: String(verdict.commitMessage || '').slice(0, 200),
    });
  });
  const entry = { child, startedAt: Date.now(), killed: false };
  entry.timer = setTimeout(() => { entry.killed = true; try { child.kill('SIGTERM'); } catch {} }, TURN_TIMEOUT_MS);
  runningChats.set(sessionId, entry);
}

// Gracefully exit the live Claude process(es) in this session's directory.
// SIGTERM lets Claude Code flush the transcript, so the session stays resumable.
function closeSession(sessionId, cb) {
  const fp = findSessionFile(sessionId);
  if (!fp) return cb(new Error('session not found'));
  let cwd = '';
  try { cwd = parseSessionFile(fp, fs.statSync(fp)).cwd; } catch {}
  const { pidsByCwd } = getLiveTerminals();
  const pids = pidsByCwd.get(cwd) || [];
  if (!pids.length) return cb(new Error('no live terminal to close'));
  let killed = 0;
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); killed++; } catch {} }
  cb(null, { killed });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const fp = path.join(PUBLIC_DIR, rel);
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(fp);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

function readBody(req, cb, maxBytes = 1e6) {
  let data = '';
  req.on('data', c => { data += c; if (data.length > maxBytes) req.destroy(); });
  req.on('end', () => { try { cb(null, data ? JSON.parse(data) : {}); } catch (e) { cb(e); } });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);

  if (url.pathname === '/api/sessions') {
    try {
      const data = buildData();
      try { data.version = versionInfo(); } catch {}
      return sendJSON(res, 200, data);
    }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/version') {
    try { return sendJSON(res, 200, versionInfo()); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/update' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      selfUpdate({ pull: body.pull !== false }, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/transcript') {
    const id = url.searchParams.get('session') || '';
    const after = Number(url.searchParams.get('after')) || 0;
    const fp = findSessionFile(id);
    if (!fp) return sendJSON(res, 404, { error: 'session not found' });
    try {
      const all = parseTranscript(fp);
      return sendJSON(res, 200, { total: all.length, messages: all.slice(after) });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      chatTurn(body.session, body.text, body.images, body.cwd, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    }, 80 * 1024 * 1024); // allow pasted images
  }

  if (url.pathname.startsWith('/uploads/')) {
    const name = path.basename(url.pathname);
    const fp = path.join(UPLOADS_DIR, name);
    if (!fp.startsWith(UPLOADS_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    return fs.readFile(fp, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(fp).slice(1).toLowerCase();
      const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
      res.end(buf);
    });
  }

  if (url.pathname === '/api/housekeeping') {
    try { return sendJSON(res, 200, housekeeping()); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/repo-history') {
    const cwd = url.searchParams.get('cwd') || '';
    try { return sendJSON(res, 200, repoHistory(cwd)); }
    catch (e) { return sendJSON(res, e.status || 500, { error: e.message }); }
  }

  if (url.pathname === '/api/commit' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      gitCommit(body.cwd, body.message, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/push' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      gitPush(body.cwd, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/worktree' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      gitWorktreeAdd(body.cwd, body.name, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/worktree-merge' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      gitWorktreeMerge(body.path, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/assess' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      assessSession(body.session, (e, verdict) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...verdict });
      });
    });
  }

  if (url.pathname === '/api/close' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      closeSession(body.session, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/chat-status') {
    const id = url.searchParams.get('session') || '';
    const queued = (chatQueues.get(id) || []).length;
    const lp = livePartial.get(id);
    return sendJSON(res, 200, {
      running: runningChats.has(id) || queued > 0,
      queued,
      error: lastChatError.get(id) || null,
      partial: lp ? { text: lp.text, tools: lp.tools } : null,
    });
  }

  if (url.pathname === '/api/chat-cancel' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      chatCancel(body.session, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/open' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      openTerminal(body, (e, info) => {
        if (e) return sendJSON(res, 500, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  serveStatic(res, url.pathname);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — ClaudeNav may already be running.`);
    console.error(`Open http://${HOST}:${PORT} or set PORT=<other> to run a second instance.`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`ClaudeNav running at http://${HOST}:${PORT}`);
  console.log(`Reading sessions from ${PROJECTS_DIR}`);
});
