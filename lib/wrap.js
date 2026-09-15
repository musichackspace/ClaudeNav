'use strict';
// Wrap-up helpers that run a turn: assess, handover, close.
// Part of ClaudeNav's server (see server.js for the routes).

const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { CLAUDE_BIN } = require('./bins');
const { findSessionFile, parseSessionFile } = require('./transcripts');
const { getLiveTerminals } = require('./live');
const { SKIP_PERMS } = require('./state');
const { TURN_TIMEOUT_MS, runningChats } = require('./turns');

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

// Hand a context-heavy session off to a fresh one. Ask the session to write a
// concise handoff brief (one added turn), then seed a brand-new session with it
// so work continues with a clean context but full continuity. Returns the new
// session id and the brief. Unlike "+ New session" (a blank worktree session),
// this carries the thread forward.
function handoverSession(sessionId, cb) {
  if (!/^[\w-]+$/.test(sessionId || '')) return cb(new Error('bad session id'));
  if (runningChats.has(sessionId)) return cb(new Error('session is busy'));
  const fp = findSessionFile(sessionId);
  if (!fp) return cb(new Error('session not found'));
  let cwd = '';
  try { cwd = parseSessionFile(fp, fs.statSync(fp)).cwd; } catch {}
  if (!cwd || !fs.existsSync(cwd)) return cb(new Error('working directory is missing'));

  const briefPrompt =
    'HANDOFF BRIEF. Your context is nearly full; work will continue in a NEW session that starts '
    + 'fresh and can only see what you write here. Do NOT modify any files. Write a concise but complete '
    + 'brief, in markdown, with these sections: GOAL, DONE, IN PROGRESS / NEXT STEP, KEY FILES & BRANCHES, '
    + 'COMMANDS, GOTCHAS & DECISIONS. Output only the brief.';
  const briefArgs = ['--resume', sessionId, '-p', briefPrompt, '--output-format', 'json'];
  if (SKIP_PERMS) briefArgs.push('--dangerously-skip-permissions');

  const child = execFile(CLAUDE_BIN, briefArgs, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
    const e = runningChats.get(sessionId); if (e && e.timer) clearTimeout(e.timer);
    runningChats.delete(sessionId);
    if (err && !(e && e.killed)) return cb(new Error('handover brief failed'));
    let brief = '';
    try { brief = (JSON.parse(stdout).result || '').trim(); } catch {}
    if (!brief) return cb(new Error('could not produce a handoff brief'));

    // Seed a brand-new session with the brief as its first turn (creates it via
    // --session-id, in the same working directory, so the work continues there).
    const newId = crypto.randomUUID();
    const seed =
      'You are continuing work from a previous Claude Code session that ran low on context. Below is '
      + 'its handoff brief — treat it as the authoritative context for what is done and what comes next. '
      + 'Reply with a one-line acknowledgement and the immediate next step.\n\n--- HANDOFF BRIEF ---\n' + brief;
    const seedArgs = ['--session-id', newId, '-p', seed, '--output-format', 'json'];
    if (SKIP_PERMS) seedArgs.push('--dangerously-skip-permissions');
    execFile(CLAUDE_BIN, seedArgs, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err2) => {
      if (err2) return cb(new Error('wrote brief but failed to seed the new session'));
      cb(null, { newSession: newId, brief });
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

module.exports = { assessSession, handoverSession, closeSession };
