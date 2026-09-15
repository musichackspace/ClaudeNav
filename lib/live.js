'use strict';
// Live terminal detection (`ps` + `lsof`, cached) and opening terminals / URLs per platform.
// Part of ClaudeNav's server (see server.js for the routes).

const os = require('os');
const { execFile, execFileSync, spawn } = require('child_process');
const { gh } = require('./bins');

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

// Liveness detection spawns `ps` plus one `lsof` per live `claude` process —
// hundreds of ms when `lsof` is slow (network mounts, many fds). The server is
// single-threaded, so doing it inline on every 5s /api/sessions poll can stall
// the event loop long enough for the watchdog's health probe to time out and
// hard-kill us. Cache it briefly: the poll reuses a recent scan instead of
// re-spawning every time. Callers that need ground truth (closeSession, about
// to kill pids) call getLiveTerminals() directly.
let _liveCache = { at: 0, data: null };
const LIVE_TTL = Number(process.env.CLAUDENAV_LIVE_TTL_MS) || 4000;
function liveTerminals() {
  const now = Date.now();
  if (_liveCache.data && now - _liveCache.at < LIVE_TTL) return _liveCache.data;
  _liveCache = { at: now, data: getLiveTerminals() };
  return _liveCache.data;
}

// ---------------------------------------------------------------------------
// Build the full session list grouped by project
// ---------------------------------------------------------------------------

// A short closing acknowledgement from the user ("thanks", "perfect", "👍") — the
// "satisfactory user response" that signals the thread actually concluded. Kept
// deliberately tight: it must be a brief sign-off, not "thanks, now also do X"
// (which is still unfinished work). Anything longer than a one-liner fails.

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

// Re-login can't be headless (the OAuth flow is interactive-only), but we can
// open a terminal with `claude /login` already running — the CLI executes a
// slash command passed as the initial prompt. The echo is a fallback hint in
// case a CLI version treats it as plain text instead.
function buildLoginCommand() {
  return `cd ${shQuote(os.homedir())} && echo 'Re-authenticating Claude — if login does not start automatically, type /login' && claude /login`;
}

// Connecting a GitHub account (for the website wizard) is also interactive-only
// — `gh auth login` runs its own browser/device flow — so we open a terminal
// with it already running, same pattern as the Claude re-login above.
function buildGhLoginCommand() {
  return `cd ${shQuote(os.homedir())} && echo 'Connecting to GitHub — choose GitHub.com, then "Login with a web browser" and follow the prompts.' && gh auth login`;
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

// Open a URL in the system default browser. The chat routes web-link clicks
// through here so they land in the user's real browser rather than navigating
// the ClaudeNav tab/webview itself. http/https only.
function openUrl(rawUrl, cb) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return cb(new Error('bad url')); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb(new Error('unsupported scheme'));
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', u.href] : [u.href];
  execFile(cmd, args, (err) => err ? cb(new Error(err.message)) : cb(null, { opened: u.href }));
}

// Windows: open a fresh console window running `command` and keep it open
// (`cmd /k`). We keep `command` free of embedded paths/quotes — the login flows
// only need the bare binary (`gh`/`claude`, resolved via the new shell's PATH),
// and session-resume sets the window's cwd via the spawn option instead of a
// `cd` — so there's nothing to quote and no injection surface. `start`'s first
// argument is the window title.
function openTerminalWindows({ cwd, sessionId, login, ghLogin }, cb) {
  let command, startCwd;
  if (ghLogin) command = 'gh auth login';
  else if (login) command = 'claude /login';
  else {
    if (sessionId && !/^[\w-]+$/.test(sessionId)) return cb(new Error('bad session id'));
    command = 'claude' + (sessionId ? ' --resume ' + sessionId : '');
    startCwd = cwd;
  }
  let done = false;
  const finish = (err) => { if (done) return; done = true; err ? cb(err) : cb(null, { ran: command }); };
  try {
    const child = spawn('cmd', ['/c', 'start', 'ClaudeNav', 'cmd', '/k', command], {
      cwd: startCwd || os.homedir(), detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.on('error', (e) => finish(new Error(e.message)));
    child.unref();
    // `start` returns at once; if cmd itself couldn't spawn, the error event
    // fires within a tick, so treat "no error shortly after" as success.
    setTimeout(() => finish(null), 150);
  } catch (e) { finish(new Error(e.message)); }
}

// Linux: no single blessed terminal, so try the common emulators in order and
// fall through on ENOENT. The command is the same bash string the macOS path
// builds; `; exec bash` keeps the window open after it finishes so the user can
// read the result. bash + args go through the spawn array (no shell re-quoting).
// `-e` is honored by most; gnome-terminal wants `--`, xfce4-terminal wants `-x`.
function openTerminalLinux({ cwd, sessionId, login, ghLogin }, cb) {
  const shellCmd = ghLogin ? buildGhLoginCommand()
    : login ? buildLoginCommand()
    : buildShellCommand({ cwd, sessionId });
  const inner = `${shellCmd}; exec bash`;
  const attempts = [
    ['x-terminal-emulator', ['-e', 'bash', '-c', inner]],
    ['gnome-terminal', ['--', 'bash', '-c', inner]],
    ['konsole', ['-e', 'bash', '-c', inner]],
    ['xfce4-terminal', ['-x', 'bash', '-c', inner]],
    ['xterm', ['-e', 'bash', '-c', inner]],
  ];
  let i = 0;
  const tryNext = () => {
    if (i >= attempts.length) {
      return cb(new Error('no terminal emulator found (tried x-terminal-emulator, gnome-terminal, '
        + 'konsole, xfce4-terminal, xterm) — '
        + (ghLogin ? 'run `gh auth login`' : login ? 'run `claude /login`' : 'resume from a terminal') + ' yourself'));
    }
    const [bin, args] = attempts[i++];
    let settled = false;
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => { if (!settled) { settled = true; tryNext(); } });
      child.unref();
      // No error within a tick → the emulator launched.
      setTimeout(() => { if (!settled) { settled = true; cb(null, { ran: shellCmd }); } }, 150);
    } catch { tryNext(); }
  };
  tryNext();
}

function openTerminal({ cwd, sessionId, app, login, ghLogin }, cb) {
  if (!login && !ghLogin && !cwd) return cb(new Error('missing cwd'));

  if (process.platform === 'win32') return openTerminalWindows({ cwd, sessionId, login, ghLogin }, cb);
  if (process.platform !== 'darwin') return openTerminalLinux({ cwd, sessionId, login, ghLogin }, cb);

  const shellCmd = ghLogin ? buildGhLoginCommand()
    : login ? buildLoginCommand()
    : buildShellCommand({ cwd, sessionId });
  const script = appleScriptFor(app === 'iTerm' ? 'iTerm' : 'Terminal', shellCmd);
  execFile('osascript', ['-e', script], (err, stdout, stderr) => {
    if (err) return cb(new Error(stderr || err.message));
    cb(null, { ran: shellCmd });
  });
}

// ---------------------------------------------------------------------------
// Transcript reading (for the in-browser conversation view)
// ---------------------------------------------------------------------------

module.exports = { getLiveTerminals, _liveCache, LIVE_TTL, liveTerminals, shQuote, osaQuote, buildShellCommand, buildLoginCommand, buildGhLoginCommand, appleScriptFor, openUrl, openTerminalWindows, openTerminalLinux, openTerminal };
