'use strict';
// Locating the `claude` and `gh` binaries, and the setup-help text when `claude` is missing.
// Part of ClaudeNav's server (see server.js for the routes).

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { HOME } = require('./config');

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
const IS_WIN = process.platform === 'win32';
let CLAUDE_BIN_OK = true; // false when we fell through to a bare 'claude' guess
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  // Trust PATH first (respects nvm / custom installs).
  try {
    const probe = IS_WIN
      ? execFileSync('where', ['claude'], { encoding: 'utf8' })       // Windows: `where`
      : execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
    const hits = probe.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (hits.length) {
      // `where` can return several shims (claude, claude.cmd, claude.ps1). Node
      // can't spawn a .cmd/.ps1 directly, so prefer a real .exe when present.
      const pick = IS_WIN ? (hits.find(h => /\.exe$/i.test(h)) || hits[0]) : hits[0];
      return pick;
    }
  } catch { /* not on PATH; fall through to probing */ }
  const home = os.homedir();
  const candidates = IS_WIN ? [
    // Native installer, then npm-global shims (%APPDATA%\npm), then ~/.local.
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'claude', 'claude.exe'),
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'claude.exe'),
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd'),
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude.cmd'),
  ] : [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  CLAUDE_BIN_OK = false;
  console.warn('[claudenav] WARNING: could not locate the `claude` binary — headless turns will fail with ENOENT. Set CLAUDE_BIN to its path.');
  return 'claude'; // last resort; will ENOENT, but with the warning above to explain it
}
const CLAUDE_BIN = resolveClaudeBin();
console.log(`[claudenav] using claude binary: ${CLAUDE_BIN}${CLAUDE_BIN_OK ? '' : ' (NOT FOUND — set CLAUDE_BIN)'}`);

// Plain-language, platform-aware guidance for when the `claude` binary can't be
// found or spawned (ENOENT). Powers the chat error message and /api/setup-help.

// Plain-language, platform-aware guidance for when the `claude` binary can't be
// found or spawned (ENOENT). Powers the chat error message and /api/setup-help.
const MISSING_BIN_MSG =
  "ClaudeNav can't find the `claude` command, so it can't run this turn. "
  + "Make sure Claude Code is installed, then set the CLAUDE_BIN environment "
  + "variable to its full path and restart the server.";
function claudeSetupHelp() {
  // Each step is { text, cmd? } — the UI renders `cmd` as a click-to-copy code
  // chip, so keep prose in `text` and the exact command in `cmd`.
  const steps = IS_WIN ? [
    { text: 'Confirm Claude Code is installed — in PowerShell or cmd, run:', cmd: 'claude --version' },
    { text: "If that fails, install it (see the docs below) — the native installer gives you a spawnable claude.exe." },
    { text: 'Find the full path to the binary:', cmd: 'where claude' },
    { text: "Set CLAUDE_BIN to that path (prefer a claude.exe over a .cmd shim — Node can't launch .cmd directly). In cmd:", cmd: 'setx CLAUDE_BIN "C:\\path\\to\\claude.exe"' },
    { text: 'Restart ClaudeNav so it picks up CLAUDE_BIN (close and reopen the terminal/service), then retry your message.' },
  ] : [
    { text: 'Confirm Claude Code is installed:', cmd: 'claude --version' },
    { text: 'Find its path:', cmd: 'command -v claude' },
    { text: 'Set CLAUDE_BIN to that path and restart the server, e.g.:', cmd: 'CLAUDE_BIN=/path/to/claude node server.js' },
    { text: 'Retry your message.' },
  ];
  return {
    platform: process.platform, resolved: CLAUDE_BIN_OK, claudeBin: CLAUDE_BIN,
    message: MISSING_BIN_MSG, docs: 'https://docs.anthropic.com/en/docs/claude-code/setup', steps,
  };
}
// Sessions run with skipped permissions so the assistant can actually use tools
// (matches how these terminal sessions were started). Set CLAUDE_SAFE=1 to omit.

// ---------------------------------------------------------------------------
// Website wizard — a guided "+ New project" path for non-devs: name a site,
// and get a local folder, a starter page, a GitHub repo, and a live GitHub
// Pages URL in one step. Runs alongside the plain folder picker (unchanged).
//
// The `gh` CLI is the engine: it already owns GitHub auth (keychain/config),
// creates the repo, pushes, and enables Pages via its API — so there are no
// tokens to wrangle and no new dependency. "Publish" for these sites is just
// commit + push to main (the existing /api/commit + /api/push), because Pages
// redeploys on every push. Signing in is interactive (`gh auth login` in a
// terminal), like the Claude re-login flow.
// ---------------------------------------------------------------------------

function resolveGhBin() {
  if (process.env.GH_BIN) return process.env.GH_BIN;
  const isWin = process.platform === 'win32';
  try {
    // `where` on Windows, POSIX `command -v` elsewhere. `where` can list several
    // matches (one per line) — take the first.
    const out = isWin
      ? execFileSync('where', ['gh'], { encoding: 'utf8' })
      : execFileSync('/bin/sh', ['-c', 'command -v gh'], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (first) return first;
  } catch { /* not on PATH; probe known install dirs */ }
  const candidates = isWin
    ? [
        // winget / MSI installer default, scoop, choco — all common on Windows.
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'GitHub CLI', 'gh.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
        path.join(HOME, 'scoop', 'shims', 'gh.exe'),
        'C:\\ProgramData\\chocolatey\\bin\\gh.exe',
      ]
    : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', path.join(HOME, '.local', 'bin', 'gh')];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}
const GH_BIN = resolveGhBin();

function gh(args, opts = {}) {
  if (!GH_BIN) { const e = new Error('the GitHub CLI (gh) is not installed'); e.code = 'GH_MISSING'; throw e; }
  return execFileSync(GH_BIN, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, ...opts,
  }).trim();
}

module.exports = { IS_WIN, CLAUDE_BIN_OK, resolveClaudeBin, CLAUDE_BIN, MISSING_BIN_MSG, claudeSetupHelp, resolveGhBin, GH_BIN, gh };
