'use strict';
// Thin `git` wrappers (throwing / defaulting / boolean).
// Part of ClaudeNav's server (see server.js for the routes).

const { execFileSync } = require('child_process');

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

// ---------------------------------------------------------------------------
// Publish status — "is what I made actually live?" for a Pages-backed site.
// The honest definition: working tree clean AND the pushed commit is the exact
// commit GitHub Pages last built AND that build succeeded. Everything else is a
// flavour of "not live", collapsed into plain-language states for non-devs:
//   draft      — uncommitted or unpushed changes (not online yet)
//   publishing — pushed, Pages still building (or built an older commit)
//   live       — pushed commit is built and serving
//   failed     — the Pages build errored
//   offline    — repo has a GitHub remote but Pages isn't enabled
//   local      — no GitHub remote (saved on this computer only)
// The networked half (Pages build) is cached per-repo so callers can poll.
// ---------------------------------------------------------------------------

function gitTry(cwd, args, dflt = '') { try { return git(cwd, args); } catch { return dflt; } }

// True when the git command succeeds. For predicates like `merge-base
// --is-ancestor`, where the answer is the exit code and stdout is empty (so
// gitTry's "did it return anything" can't distinguish yes from no).
function gitOk(cwd, args) { try { git(cwd, args); return true; } catch { return false; } }

// The project's own checkout behind a (possibly linked) session worktree.
// `git worktree list` always names the main working tree first.

module.exports = { git, gitTry, gitOk };
