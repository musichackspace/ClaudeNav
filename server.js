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
const { execFile, execFileSync } = require('child_process');

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
//   working      — mid-turn and active: a terminal is live, it was just touched,
//                  or the server itself is running a headless turn for it.
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
  const veryRecent = recentMs < 30 * 1000;          // touched in last 30s
  const recent = recentMs < 5 * 60 * 1000;          // touched in last 5 min
  const longAbandoned = recentMs > 30 * 60 * 1000;  // mid-turn, untouched 30 min+
  const ended = s.lastStopReason === 'end_turn';
  const midTurn = s.lastEventType === 'user' || (s.lastStopReason && !ended);

  if (midTurn) {
    if (veryRecent || s.likelyLive) return 'working';
    if (longAbandoned) return 'interrupted';  // really left half-done → needs you
    return 'idle';                            // paused / headless — don't alarm
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

      const cwd = s.cwd || dir;
      if (!projects.has(cwd)) {
        const ttys = liveByCwd.get(cwd) || [];
        projects.set(cwd, {
          cwd,
          name: cwd.split('/').filter(Boolean).slice(-2).join('/') || cwd,
          liveTerminals: ttys.length,
          liveTtys: ttys,
          sessions: [],
        });
      }
      projects.get(cwd).sessions.push(s);
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

function parseTranscript(filePath) {
  const messages = [];
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
      // Skip messages that are purely tool results (no human text).
      const onlyToolResult = Array.isArray(c) && c.every(p => p && p.type === 'tool_result');
      if (text.trim() && !onlyToolResult) {
        messages.push({ role: 'user', text: text.trim(), ts: o.timestamp || null });
      }
    } else if (o.type === 'assistant' && m) {
      const c = m.content;
      let text = '';
      const tools = [];
      if (Array.isArray(c)) {
        for (const p of c) {
          if (!p) continue;
          if (p.type === 'text') text += (text ? '\n' : '') + p.text;
          else if (p.type === 'tool_use') tools.push(p.name);
        }
      } else if (typeof c === 'string') text = c;
      if (text.trim() || tools.length) {
        messages.push({ role: 'assistant', text: text.trim(), tools, ts: o.timestamp || null });
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

const runningChats = new Map(); // sessionId -> { child, startedAt, timer }
const chatQueues = new Map();   // sessionId -> [text, ...] turns waiting their turn
const lastChatError = new Map(); // sessionId -> error string

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

function drainQueue(sessionId) {
  if (runningChats.has(sessionId)) return;
  const q = chatQueues.get(sessionId);
  if (!q || !q.length) return;
  const { text, cwd } = q.shift();
  lastChatError.delete(sessionId);

  // First turn of a brand-new session creates it at our chosen id; later turns
  // (and all turns of existing sessions) continue it.
  const exists = findSessionFile(sessionId);
  const args = exists
    ? ['--resume', sessionId, '-p', text]
    : ['--session-id', sessionId, '-p', text];
  if (SKIP_PERMS) args.push('--dangerously-skip-permissions');

  const child = execFile(CLAUDE_BIN, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    const entry = runningChats.get(sessionId);
    if (entry && entry.timer) clearTimeout(entry.timer);
    runningChats.delete(sessionId);
    if (err && !(entry && entry.killed)) {
      lastChatError.set(sessionId, (stderr || err.message || 'turn failed').trim().slice(0, 500));
    }
    drainQueue(sessionId); // start the next queued turn, if any
  });

  const entry = { child, startedAt: Date.now(), killed: false };
  entry.timer = setTimeout(() => {
    entry.killed = true;
    lastChatError.set(sessionId, 'turn timed out and was stopped');
    try { child.kill('SIGTERM'); } catch {}
  }, TURN_TIMEOUT_MS);
  runningChats.set(sessionId, entry);
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
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
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
    try { return sendJSON(res, 200, buildData()); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
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
    return sendJSON(res, 200, {
      running: runningChats.has(id) || queued > 0,
      queued,
      error: lastChatError.get(id) || null,
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
