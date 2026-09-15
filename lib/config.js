'use strict';
// Paths and ports shared by every module.
// Part of ClaudeNav's server (see server.js for the routes).

const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 4317;
const HOST = '127.0.0.1';
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOADS_DIR = path.join(os.homedir(), '.claude', 'claudenav-uploads');
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}
// Headless turns are spawned detached, with stdout/stderr redirected here, so a
// turn keeps running (and its output keeps landing on disk) even if the server
// restarts mid-turn — the way a terminal session would. RUNS_FILE/QUEUE_FILE
// persist enough to rediscover an in-flight turn and its backlog on the next
// boot (see reconcileOnBoot).
// Keyed by PORT so two ClaudeNav instances (e.g. a second one on another port)
// never share turn state and try to reattach to each other's turns.
// Headless turns are spawned detached, with stdout/stderr redirected here, so a
// turn keeps running (and its output keeps landing on disk) even if the server
// restarts mid-turn — the way a terminal session would. RUNS_FILE/QUEUE_FILE
// persist enough to rediscover an in-flight turn and its backlog on the next
// boot (see reconcileOnBoot).
// Keyed by PORT so two ClaudeNav instances (e.g. a second one on another port)
// never share turn state and try to reattach to each other's turns.
const TURNS_DIR = path.join(os.homedir(), '.claude', `claudenav-turns-${PORT}`);
try { fs.mkdirSync(TURNS_DIR, { recursive: true }); } catch {}
const RUNS_FILE = path.join(os.homedir(), '.claude', `claudenav-runs-${PORT}.json`);
const QUEUE_FILE = path.join(os.homedir(), '.claude', `claudenav-queue-${PORT}.json`);

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

// ---------------------------------------------------------------------------
// New-project bootstrapping — browse the filesystem, make folders, git init.
// All three are bounded to the user's home dir: the browser-driven picker has
// no business reaching outside it, and the bound keeps the path guard simple
// (the git write endpoints guard on knownCwds(); a fresh folder isn't known
// yet, so these need their own boundary).
// ---------------------------------------------------------------------------

const HOME = os.homedir();

// Resolve a candidate path and confirm it stays within HOME. Returns the
// resolved absolute path, or null if it escapes (via .., symlink, etc.).

module.exports = { PORT, HOST, PROJECTS_DIR, PUBLIC_DIR, UPLOADS_DIR, TURNS_DIR, RUNS_FILE, QUEUE_FILE, HOME };
