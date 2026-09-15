'use strict';
// Self-version, upstream check and the graceful exit-42 relaunch.
// Part of ClaudeNav's server (see server.js for the routes).
const path = require('path');

const { execFile } = require('child_process');
const { git } = require('./gitutil');
const { onIdle, persistQueue, persistRuns, runningChats } = require('./turns');

// ---------------------------------------------------------------------------
// Self-version + update/relaunch — lets the browser notice new code and apply it
// ---------------------------------------------------------------------------

const REPO_DIR = path.join(__dirname, '..'); // the repo root (this file lives in lib/)
const BOOT_ID = Date.now();            // unique per process — changes on restart
function gitRepo(args) { try { return git(REPO_DIR, args); } catch { return ''; } }
const BOOT_HEAD = gitRepo(['rev-parse', '--short', 'HEAD']);  // code this process started on

// `git fetch` is networked and can stall, so we run it in the background at most
// once per TTL and serve the last-known "commits behind" count to callers.

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

// What the running process is, what's on disk now, and what's upstream.
function versionInfo() {
  maybeFetch();
  const head = gitRepo(['rev-parse', '--short', 'HEAD']) || BOOT_HEAD;
  const branch = gitRepo(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = gitRepo(['status', '--porcelain']).split('\n').filter(Boolean).length;
  const hasRemote = !!gitRepo(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  // Local commits not on the upstream. A `--ff-only` pull refuses to run when
  // ahead > 0 ("Not possible to fast-forward"), so this must gate canUpdate too
  // — a clean-but-diverged checkout would otherwise show a button doomed to fail.
  const ahead = hasRemote ? (Number(gitRepo(['rev-list', '--count', '@{u}..HEAD'])) || 0) : 0;
  return {
    bootId: BOOT_ID,        // changes when the server restarts
    bootHead: BOOT_HEAD,    // commit the process is running
    head,                   // commit currently checked out on disk
    branch,
    dirty,
    behind: fetchState.behind,
    ahead,
    hasRemote,
    // Safe to fast-forward only when clean, actually behind, and NOT diverged.
    canUpdate: hasRemote && fetchState.behind > 0 && dirty === 0 && ahead === 0,
  };
}

// A relaunch (in-app update, or the watchdog auto-applying a new commit) that
// arrives mid-turn is deferred until every turn has finished, so a deploy never
// interrupts active work. maybeRelaunch fires once the server goes idle.

// A relaunch (in-app update, or the watchdog auto-applying a new commit) that
// arrives mid-turn is deferred until every turn has finished, so a deploy never
// interrupts active work. maybeRelaunch fires once the server goes idle.
let pendingRelaunch = null; // { pull } while a relaunch waits for turns to drain
function relaunchNow(pull) {
  if (pull) { try { git(REPO_DIR, ['pull', '--ff-only']); } catch { /* keep running the current code */ } }
  persistRuns();
  persistQueue();
  process.exit(42); // run-server.sh treats 42 as "relaunch now"
}
onIdle(maybeRelaunch);
function maybeRelaunch() {
  if (pendingRelaunch && runningChats.size === 0) {
    const { pull } = pendingRelaunch;
    pendingRelaunch = null;
    setTimeout(() => relaunchNow(pull), 100);
  }
}

// Pull (optional) then ask run-server.sh to relaunch us via the dedicated exit
// code 42. Responds first, then exits a beat later so the HTTP reply lands.

// Pull (optional) then ask run-server.sh to relaunch us via the dedicated exit
// code 42. Responds first, then exits a beat later so the HTTP reply lands.
function selfUpdate({ pull }, cb) {
  if (!BOOT_HEAD) return cb(new Error('not a git checkout — cannot self-update'));
  // Turn(s) in flight: don't interrupt them (the whole point of this work).
  // Remember the request and relaunch when the server next goes idle; the pull
  // happens at that point so it picks up the newest commit.
  if (runningChats.size > 0) {
    pendingRelaunch = { pull: !!pull };
    return cb(null, { relaunching: true, deferred: true, head: gitRepo(['rev-parse', '--short', 'HEAD']) });
  }
  if (pull) {
    try { git(REPO_DIR, ['pull', '--ff-only']); }
    catch (e) {
      const msg = (e.stderr || e.stdout || e.message || '').toString().trim().slice(0, 300);
      return cb(new Error('git pull --ff-only failed: ' + (msg || 'unknown error')));
    }
  }
  cb(null, { relaunching: true, head: gitRepo(['rev-parse', '--short', 'HEAD']) });
  setTimeout(() => relaunchNow(false), 300); // pull (if any) already applied above
}

// ---------------------------------------------------------------------------
// Usage limits — mirrors Claude Code's /usage menu (current session + weekly).
// Same source the CLI uses: GET /api/oauth/usage with the stored OAuth token.
// ---------------------------------------------------------------------------

// The OAuth access token lives in the macOS Keychain (Claude Code-credentials)
// or, on other platforms, in ~/.claude/.credentials.json.

module.exports = { REPO_DIR, BOOT_ID, gitRepo, BOOT_HEAD, fetchState, FETCH_TTL, maybeFetch, versionInfo, pendingRelaunch, relaunchNow, maybeRelaunch, selfUpdate };
