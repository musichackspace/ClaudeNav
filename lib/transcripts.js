'use strict';
// Transcript parsing: incremental session summaries and the conversation view.
// Part of ClaudeNav's server (see server.js for the routes).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { PROJECTS_DIR } = require('./config');
const { modelChoice } = require('./account');

// ---------------------------------------------------------------------------
// Context window resolution
//
// The 1M window is a request-time choice — the model variant `…[1m]`. Transcripts
// DON'T persist it: they log the plain model id (`claude-opus-4-8`) whether the
// turn ran on a 200K or 1M window. So we infer each session's window from two
// real signals, never a guess:
//   1. Proof — any turn whose context exceeded 200K could only have fit in a 1M
//      window (output isn't counted, so the input side is a true lower bound on
//      capacity). This pins heavy sessions exactly.
//   2. The configured default model variant, for sessions that never crossed
//      200K (where #1 can't decide). Precedence mirrors the CLI: ANTHROPIC_MODEL
//      env, then project `.claude/settings.json`, then `~/.claude/settings.json`.
// The only residual blind spot: a 1M session still under 200K whose config we
// can't see (e.g. picked via `/model` mid-session) — it reads as 200K until it
// grows past 200K, then #1 corrects it. Acceptable: it's low-usage either way.
const STD_WINDOW = 200000, BIG_WINDOW = 1000000;

// Generic mtime-keyed JSON loader (settings files).

// Generic mtime-keyed JSON loader (settings files).
const _jsonCache = new Map(); // path -> { mtimeMs, json }
function readJson(file) {
  try {
    const st = fs.statSync(file);
    const c = _jsonCache.get(file);
    if (c && c.mtimeMs === st.mtimeMs) return c.json;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    _jsonCache.set(file, { mtimeMs: st.mtimeMs, json });
    return json;
  } catch { return null; }
}
function settingsModel(file) {
  const j = readJson(file);
  return (j && j.model) || '';
}
function defaultWindowFor(cwd) {
  // Configured default model variant. We deliberately DON'T read Claude Code's
  // internal `~/.claude.json` (lastModelUsage) here — its schema isn't a public
  // contract. The cost is mild: a 1M session still under 200K reads as 200K and
  // nudges a little early, then proof-by-usage (see contextWindowFor) corrects it
  // the instant it crosses 200K. The dangerous direction is never config-dependent.
  const model = process.env.ANTHROPIC_MODEL
    || (cwd && settingsModel(path.join(cwd, '.claude', 'settings.json')))
    || settingsModel(path.join(os.homedir(), '.claude', 'settings.json'));
  return /\[1m\]/.test(model || '') ? BIG_WINDOW : STD_WINDOW;
}
// A session's effective window: proven-1M if any turn exceeded 200K, else the
// configured default for its repo (try the session's own cwd first — a worktree
// may carry its own .claude/settings.json — then the folded parent project).
// A session's effective window: proven-1M if any turn exceeded 200K, else the
// configured default for its repo (try the session's own cwd first — a worktree
// may carry its own .claude/settings.json — then the folded parent project).
function contextWindowFor(s, parentCwd) {
  if ((s.peakContextTokens || 0) > STD_WINDOW) return BIG_WINDOW;
  if (s.cwd && defaultWindowFor(s.cwd) === BIG_WINDOW) return BIG_WINDOW;
  return defaultWindowFor(parentCwd);
}

// ---------------------------------------------------------------------------
// Session parsing (with mtime-keyed cache so repeat scans are cheap)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session parsing (with mtime-keyed cache so repeat scans are cheap)
// ---------------------------------------------------------------------------

const cache = new Map(); // filePath -> { mtimeMs, size, offset, acc, data }

// A fresh, empty parse accumulator. Everything parseSessionFile derives lives
// here so a growing transcript can be folded incrementally (see below) rather
// than re-read whole on every poll.

// A fresh, empty parse accumulator. Everything parseSessionFile derives lives
// here so a growing transcript can be folded incrementally (see below) rather
// than re-read whole on every poll.
function freshAcc() {
  return {
    title: null, lastPrompt: null, firstUserPrompt: null,
    firstTs: null, lastTs: null, cwd: null, firstCwd: null,
    gitBranch: null, version: null, sessionId: null,
    userMsgCount: 0, assistantTurns: 0, models: new Set(),
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    contextTokens: 0, peakContextTokens: 0,
    lastEventType: null, lastStopReason: null, permissionMode: null,
    lastModel: null, lastUserText: null, lastAssistantText: null,
  };
}

// Fold one transcript line into the accumulator. Order-dependent (later records
// overwrite earlier ones), which is exactly why the incremental path may only
// append newer lines — never re-fold or skip out of order.

// Fold one transcript line into the accumulator. Order-dependent (later records
// overwrite earlier ones), which is exactly why the incremental path may only
// append newer lines — never re-fold or skip out of order.
function foldLine(a, line) {
  if (!line) return;
  let o;
  try { o = JSON.parse(line); } catch { return; }

  if (o.sessionId && !a.sessionId) a.sessionId = o.sessionId;
  if (o.permissionMode) a.permissionMode = o.permissionMode;
  if (o.cwd) { a.cwd = o.cwd; if (!a.firstCwd) a.firstCwd = o.cwd; }
  if (o.gitBranch) a.gitBranch = o.gitBranch;
  if (o.version) a.version = o.version;
  if (o.timestamp) {
    if (!a.firstTs) a.firstTs = o.timestamp;
    a.lastTs = o.timestamp;
  }

  switch (o.type) {
    case 'ai-title':
      if (o.aiTitle) a.title = o.aiTitle;
      break;
    case 'last-prompt':
      if (o.lastPrompt) a.lastPrompt = o.lastPrompt;
      break;
    case 'user': {
      a.userMsgCount++;
      const c = o.message && o.message.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.filter(p => p && p.type === 'text').map(p => p.text).join(' ')
          : null;
      const isToolResult = Array.isArray(c) && c.length
        && c.every(p => p && p.type === 'tool_result');
      // Many "user" records aren't a human taking a turn: tool results, hook
      // output, and slash-command machinery (`<local-command-stdout>Bye!`,
      // `<task-notification>…`, `<command-name>…`). Counting these as the last
      // conversational event makes a wrapped session look mid-turn ("you said
      // bye" → flagged interrupted). Only genuine prose moves the turn pointer.
      const synthetic = o.isMeta || isToolResult || !text || !text.trim()
        || /^<\/?(local-command-stdout|local-command-stderr|command-name|command-message|command-args|task-notification|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)\b/.test(text.trim());
      if (synthetic) break;
      a.lastEventType = 'user';
      if (!a.firstUserPrompt) a.firstUserPrompt = text.trim();
      a.lastUserText = text.trim(); // latest real user message — for the sign-off ack check
      break;
    }
    case 'assistant': {
      a.lastEventType = 'assistant';
      const m = o.message || {};
      if (m.model && m.model !== '<synthetic>') { a.models.add(m.model); a.lastModel = m.model; }
      if (m.stop_reason !== undefined) a.lastStopReason = m.stop_reason;
      // Keep the text of the latest assistant message that actually said
      // something (tool-only turns carry no text) — used to tell "I'm asking
      // you something" apart from "work delivered, nothing pending".
      const at = Array.isArray(m.content)
        ? m.content.filter(p => p && p.type === 'text').map(p => p.text).join('\n')
        : (typeof m.content === 'string' ? m.content : '');
      if (at && at.trim()) a.lastAssistantText = at.trim();
      const u = m.usage;
      if (u) {
        a.assistantTurns++;
        a.tokens.input += u.input_tokens || 0;
        a.tokens.output += u.output_tokens || 0;
        a.tokens.cacheCreation += u.cache_creation_input_tokens || 0;
        a.tokens.cacheRead += u.cache_read_input_tokens || 0;
        // Most recent turn's context = everything fed in for that turn.
        a.contextTokens = (u.input_tokens || 0)
          + (u.cache_read_input_tokens || 0)
          + (u.cache_creation_input_tokens || 0);
        if (a.contextTokens > a.peakContextTokens) a.peakContextTokens = a.contextTokens;
      }
      break;
    }
  }
}

// Project the accumulator into the shape callers consume.

// Project the accumulator into the shape callers consume.
function accToData(a, stat, filePath) {
  return {
    sessionId: a.sessionId || path.basename(filePath, '.jsonl'),
    title: a.title || a.firstUserPrompt || '(untitled)',
    lastPrompt: a.lastPrompt || a.firstUserPrompt || '',
    firstUserPrompt: a.firstUserPrompt || '',
    cwd: a.cwd || '',
    firstCwd: a.firstCwd || a.cwd || '',
    gitBranch: a.gitBranch || '',
    version: a.version || '',
    userMsgCount: a.userMsgCount,
    assistantTurns: a.assistantTurns,
    models: [...a.models],
    lastModel: a.lastModel,
    lastModelChoice: modelChoice(a.lastModel),
    tokens: a.tokens,
    contextTokens: a.contextTokens,
    peakContextTokens: a.peakContextTokens,
    lastEventType: a.lastEventType,
    lastStopReason: a.lastStopReason,
    permissionMode: a.permissionMode,
    lastUserText: a.lastUserText,
    lastAssistantText: a.lastAssistantText,
    firstTs: a.firstTs,
    lastTs: a.lastTs,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    filePath,
  };
}

// Read a byte range [start, end) from a file without slurping the whole thing —
// the incremental path reads only the bytes appended since the last parse.

// Read a byte range [start, end) from a file without slurping the whole thing —
// the incremental path reads only the bytes appended since the last parse.
function readRange(filePath, start, end) {
  const len = end - start;
  if (len <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(filePath, 'r');
  try {
    const out = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, out, got, len - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return got === len ? out : out.subarray(0, got);
  } finally { fs.closeSync(fd); }
}

function parseSessionFile(filePath, stat) {
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;

  // Incremental append: transcripts only ever grow (Claude Code appends
  // newline-delimited records). When we've parsed this file before and it has
  // only grown, fold just the new bytes into the cached accumulator instead of
  // re-reading megabytes on every poll. Anything else (first sight, file
  // shrank/rewound, or a torn read last time) falls back to a full parse.
  let acc, offset;
  if (cached && cached.acc && stat.size > cached.size) {
    acc = cached.acc;
    // Only fold complete lines; stop at the last newline so a record still
    // being written isn't parsed half-formed. Bytes after it are re-read next
    // time (offset advances only past the final newline).
    const chunk = readRange(filePath, cached.offset, stat.size);
    const nl = chunk.lastIndexOf(0x0a);
    if (nl >= 0) {
      const text = chunk.subarray(0, nl).toString('utf8');
      for (const line of text.split('\n')) foldLine(acc, line);
      offset = cached.offset + nl + 1;
    } else {
      offset = cached.offset; // no complete line yet — leave the tail for later
    }
  } else {
    acc = freshAcc();
    const content = fs.readFileSync(filePath, 'utf8');
    const nl = content.lastIndexOf('\n');
    const complete = nl >= 0 ? content.slice(0, nl) : content;
    for (const line of complete.split('\n')) foldLine(acc, line);
    // Byte offset of the parsed prefix (utf8 length, not string length).
    offset = nl >= 0 ? Buffer.byteLength(content.slice(0, nl + 1), 'utf8') : Buffer.byteLength(content, 'utf8');
  }

  const data = accToData(acc, stat, filePath);
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, offset, acc, data });
  return data;
}

// ---------------------------------------------------------------------------
// Live terminal detection — running `claude` CLI processes and their cwds
// ---------------------------------------------------------------------------

// Returns { byCwd: Map<cwd, [tty,...]>, ttys: Set<tty> } for running claude CLIs.

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

// Tool detail/output strings are folded into the transcript payload so the UI
// can expand each tool call. Cap them so a huge file read or `find /` dump can't
// bloat the JSON (and the browser) — the on-disk transcript stays authoritative.
const TOOL_CAP = 6000;
function clip(s) {
  s = typeof s === 'string' ? s : (s == null ? '' : String(s));
  return s.length > TOOL_CAP ? s.slice(0, TOOL_CAP) + `\n… (${s.length - TOOL_CAP} more chars)` : s;
}

// One-line summary shown on the collapsed tool row (command, path, pattern…).

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
            // browser can render clickable options. The turn was stopped the moment
            // it asked (see pauseForQuestion), so the question is the terminal block;
            // the UI turns these options into buttons and a click becomes the next
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
// install locations before giving up. Platform-aware: Windows has no `/bin/sh`
// and installs to different paths, so it uses `where` + Windows candidates.

// ---------------------------------------------------------------------------
// Full-text search across transcripts ("which session was I fixing X in?").
// Prose only (user + assistant text; tool output is noise), extracted lazily on
// the first search and cached by mtime+size, so the 5s /api/sessions poll never
// pays for it. Files are read async and the loop yields between files, keeping
// the event loop responsive (see the watchdog note in CLAUDE.md).
// ---------------------------------------------------------------------------

const searchCache = new Map(); // filePath -> { mtimeMs, size, text }
const SEARCH_MAX_FILE = 200 * 1024 * 1024;
function extractProse(content) {
  const out = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain) continue;
    const c = o.message && o.message.content;
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) for (const part of c) if (part && part.type === 'text' && part.text) out.push(part.text);
  }
  return out.join('\n');
}
function snippetAround(text, idx, len, radius = 70) {
  const a = Math.max(0, idx - radius), b = Math.min(text.length, idx + len + radius);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ').trim() + (b < text.length ? '…' : '');
}
let searchChain = Promise.resolve();
// Resolves { q, hits: [{ sessionId, snippet }], scanned }. Serialized so two
// overlapping searches don't both walk the tree.
function searchSessions(q, limit = 60) {
  const run = async () => {
    const needle = String(q || '').trim().toLowerCase();
    const hits = [];
    let scanned = 0;
    if (needle.length < 2) return { q, hits, scanned };
    let dirs = []; try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return { q, hits, scanned }; }
    for (const dir of dirs) {
      const dp = path.join(PROJECTS_DIR, dir);
      let files = []; try { files = fs.readdirSync(dp).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const fp = path.join(dp, f);
        let st; try { st = fs.statSync(fp); } catch { continue; }
        if (!st.isFile() || st.size > SEARCH_MAX_FILE) continue;
        let c = searchCache.get(fp);
        if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
          let content; try { content = await fs.promises.readFile(fp, 'utf8'); } catch { continue; }
          c = { mtimeMs: st.mtimeMs, size: st.size, text: extractProse(content) };
          searchCache.set(fp, c);
          await new Promise(r => setImmediate(r));
        }
        scanned++;
        const idx = c.text.toLowerCase().indexOf(needle);
        if (idx >= 0) {
          hits.push({ sessionId: path.basename(f, '.jsonl'), snippet: snippetAround(c.text, idx, needle.length), mtimeMs: st.mtimeMs });
          if (hits.length >= limit) break;
        }
      }
      if (hits.length >= limit) break;
    }
    hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { q, hits, scanned };
  };
  const p = searchChain.then(run, run);
  searchChain = p.catch(() => {});
  return p;
}

module.exports = { searchSessions, extractProse, STD_WINDOW, _jsonCache, readJson, settingsModel, defaultWindowFor, contextWindowFor, cache, freshAcc, foldLine, accToData, readRange, parseSessionFile, findSessionFile, TOOL_CAP, clip, toolDetail, toolBody, resultText, parseTranscript };
