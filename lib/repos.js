'use strict';
// Git operations on session repos: housekeeping, history, worktrees, commit/push, browse/mkdir/init.
// Part of ClaudeNav's server (see server.js for the routes).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { HOME } = require('./config');
const { git } = require('./gitutil');
const { liveTerminals } = require('./live');
const { buildData } = require('./sessions');

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

// Pick a fresh, canonical commit to branch a new worktree from. Branching off
// whatever the main checkout's HEAD happens to point at makes every new session
// inherit a stale state — a leftover feature branch, or a `main` that's behind
// origin. Prefer the repo's default branch, refreshed from origin when there's
// a remote, so a new session always starts from clean, recent code. Falls back
// to local HEAD when there's no remote / no discoverable default branch.
function worktreeBase(cwd) {
  const hasRemote = (() => { try { return !!git(cwd, ['remote']); } catch { return false; } })();
  if (!hasRemote) {
    // No remote: use the local default branch if it's not the one checked out
    // here, else HEAD. (Can't check out a branch that's already in use.)
    return 'HEAD';
  }
  // Refresh so origin/<default> is current. Best-effort and bounded — an
  // offline / slow remote must not wedge session creation; we just fall back
  // to the last-fetched origin ref (or HEAD).
  try { execFileSync('git', ['-C', cwd, 'fetch', '--quiet', 'origin'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }); }
  catch { /* offline / no such remote — use whatever origin refs we already have */ }
  // Resolve the default branch: origin/HEAD when set, else probe the usual names.
  let def = '';
  try { def = git(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']); } catch {}
  if (!def) {
    for (const cand of ['origin/main', 'origin/master']) {
      try { git(cwd, ['rev-parse', '--verify', '-q', cand + '^{commit}']); def = cand; break; } catch {}
    }
  }
  return def || 'HEAD';
}

// Keep our own worktree directory out of the repo's eyes. Session worktrees live
// at <repo>/.claude/worktrees/<leaf>, which in a repo without a .gitignore for
// `.claude/` (every wizard-created website) shows up as an untracked change: the
// project folder then reads as permanently "Draft", a `git add -A` publish
// commits the worktrees tree into the site, and a fast-forward sync looks unsafe.
// Written to .git/info/exclude — local and untracked, so we never edit a file the
// user owns. Idempotent.
const excludedRepos = new Set(); // cwd -> already ensured this process (keeps polls cheap)
function excludeWorktrees(cwd) {
  if (excludedRepos.has(cwd)) return;
  try {
    let dir = git(cwd, ['rev-parse', '--git-common-dir']);
    if (!path.isAbsolute(dir)) dir = path.resolve(cwd, dir);
    const file = path.join(dir, 'info', 'exclude');
    const line = '.claude/worktrees/';
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur.split('\n').some(l => l.trim() === line)) { excludedRepos.add(cwd); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) +
      '# ClaudeNav session worktrees\n' + line + '\n');
    excludedRepos.add(cwd);
  } catch { /* best-effort — a missing exclude only costs cosmetics */ }
}

// Create a worktree on a fresh branch off the repo's up-to-date default branch
// (see worktreeBase); returns its path + branch.
function gitWorktreeAdd(cwd, name, cb) {
  if (!knownCwds().has(cwd)) return cb(new Error('unknown working directory'));
  try { if (git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return cb(new Error('not a git repo')); }
  catch { return cb(new Error('not a git repo')); }
  // A repo with no commits has no HEAD to branch a worktree from ("fatal:
  // invalid reference: HEAD"). Treat it like a non-repo: the caller falls back
  // to a plain session in the folder itself.
  try { git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']); }
  catch { return cb(new Error('no commits yet')); }
  excludeWorktrees(cwd);
  const leaf = sanitizeLeaf(name) + '-' + crypto.randomBytes(3).toString('hex');
  const branch = 'session/' + leaf;
  const wtPath = path.join(cwd, '.claude', 'worktrees', leaf);
  const base = worktreeBase(cwd);
  try {
    execFileSync('git', ['-C', cwd, 'worktree', 'add', '-b', branch, wtPath, base],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    cb(null, { path: wtPath, branch, base });
  } catch (e) {
    cb(new Error((e.stderr || e.message || 'worktree add failed').toString().trim().slice(0, 300)));
  }
}

// ---------------------------------------------------------------------------
// New-project bootstrapping — browse the filesystem, make folders, git init.
// All three are bounded to the user's home dir: the browser-driven picker has
// no business reaching outside it, and the bound keeps the path guard simple
// (the git write endpoints guard on knownCwds(); a fresh folder isn't known
// yet, so these need their own boundary).
// ---------------------------------------------------------------------------

// Resolve a candidate path and confirm it stays within HOME. Returns the
// resolved absolute path, or null if it escapes (via .., symlink, etc.).
function underHome(p) {
  if (!p || typeof p !== 'string') return null;
  let abs;
  try { abs = fs.realpathSync(path.resolve(p)); }
  catch { abs = path.resolve(p); } // may not exist yet (mkdir target) — resolve lexically
  const root = fs.realpathSync(HOME);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

// List immediate subdirectories of a path (dotfiles hidden by default), plus
// whether the path itself is a git repo. Powers the new-project folder picker.
function browseDir(p) {
  const abs = underHome(p && p.trim() ? p : HOME);
  if (!abs) { const e = new Error('path is outside your home directory'); e.status = 403; throw e; }
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch { const e = new Error('cannot read that folder'); e.status = 400; throw e; }
  const dirs = entries
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .sort((a, b) => a.localeCompare(b))
    .map(name => ({ name, path: path.join(abs, name) }));
  let isRepo = false;
  try { isRepo = git(abs, ['rev-parse', '--is-inside-work-tree']) === 'true'; } catch {}
  const parent = path.dirname(abs);
  return {
    path: abs,
    parent: (abs !== fs.realpathSync(HOME) && underHome(parent)) ? parent : null,
    home: fs.realpathSync(HOME),
    isRepo,
    dirs,
  };
}

function makeDir(parent, name) {
  const base = underHome(parent);
  if (!base) { const e = new Error('parent is outside your home directory'); e.status = 403; throw e; }
  const clean = (name || '').trim();
  if (!clean || /[/\\]/.test(clean) || clean === '.' || clean === '..') {
    const e = new Error('invalid folder name'); e.status = 400; throw e;
  }
  const target = path.join(base, clean);
  if (!underHome(path.dirname(target))) { const e = new Error('outside your home directory'); e.status = 403; throw e; }
  try { fs.mkdirSync(target, { recursive: true }); }
  catch (e2) { const e = new Error('could not create folder: ' + e2.message); e.status = 400; throw e; }
  return { path: fs.realpathSync(target) };
}

// `git init` a folder (idempotent) so the wrap-up / commit / push machinery
// has a repo to work with. New projects start as a plain session in the folder
// (not a worktree — there's no HEAD to branch from yet); worktrees stay the
// per-project "+ New session" affordance for established repos.
function gitInit(cwd, cb) {
  const abs = underHome(cwd);
  if (!abs) return cb(new Error('outside your home directory'));
  if (!fs.existsSync(abs)) return cb(new Error('folder does not exist'));
  try {
    if (git(abs, ['rev-parse', '--is-inside-work-tree']) === 'true') return cb(null, { path: abs, alreadyRepo: true });
  } catch {}
  try {
    execFileSync('git', ['-C', abs, 'init'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    cb(null, { path: abs, initialized: true });
  } catch (e) {
    cb(new Error((e.stderr || e.message || 'git init failed').toString().trim().slice(0, 300)));
  }
}

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

module.exports = { gitInfo, knownCwds, housekeeping, gitOut, repoHistory, gitCommit, gitPush, sanitizeLeaf, worktreeBase, excludedRepos, excludeWorktrees, gitWorktreeAdd, underHome, browseDir, makeDir, gitInit };
