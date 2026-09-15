'use strict';
// Assembling /api/sessions: status classification + grouping by project.
// Part of ClaudeNav's server (see server.js for the routes).

const fs = require('fs');
const path = require('path');
const { PROJECTS_DIR } = require('./config');
const { contextWindowFor, parseSessionFile } = require('./transcripts');
const { liveTerminals } = require('./live');
const { archivedSessions, sessionModels, sessionModes } = require('./state');
const { chatQueues, runningChats } = require('./turns');

// ---------------------------------------------------------------------------
// Build the full session list grouped by project
// ---------------------------------------------------------------------------

// A short closing acknowledgement from the user ("thanks", "perfect", "👍") — the
// "satisfactory user response" that signals the thread actually concluded. Kept
// deliberately tight: it must be a brief sign-off, not "thanks, now also do X"
// (which is still unfinished work). Anything longer than a one-liner fails.
function looksLikeClosingAck(text) {
  if (!text) return false;
  // Normalise: drop punctuation/whitespace, keep letters + the few emoji we allow.
  const t = text.trim().toLowerCase();
  if (t.length > 40) return false;                 // a real instruction, not a sign-off
  const stripped = t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const ACK = /^(thanks|thank you|thanks a lot|thanks so much|thank you so much|thx|ty|cheers|perfect|great|great stuff|awesome|nice|nice one|brilliant|lovely|excellent|lgtm|looks good|looks great|ship it|all good|that works|works|done|sorted|sweet|fab|wonderful)( now)?$/;
  if (ACK.test(stripped)) return true;
  // Pure emoji sign-offs (👍 🙏 🎉 ✅ 🙌 etc.) with no other words.
  if (!stripped && /[\u{1F44D}\u{1F64F}\u{1F389}✅\u{1F64C}\u{1F525}❤\u{1F60A}]/u.test(t)) return true;
  return false;
}

// Does the assistant's final message actually put the ball in your court? An
// end_turn alone doesn't mean "your turn" — most completed work ends with a
// statement ("Done.", "Pushed PR #10."), which expects nothing back. We only
// call it your turn when the closing message *ends on a question*.
//
// We require the question mark to TERMINATE the message (or its last line), not
// just appear somewhere in it. Sign-offs routinely contain "want me to" / "do
// you want" used conditionally ("Flag me if you want me to…", "Want me to X?
// Otherwise we're done.") — keying off those phrases lit finished work up as
// "your turn", which was the main false-positive source. A genuine open question
// ends with "?"; a sign-off ends with a period.

// Does the assistant's final message actually put the ball in your court? An
// end_turn alone doesn't mean "your turn" — most completed work ends with a
// statement ("Done.", "Pushed PR #10."), which expects nothing back. We only
// call it your turn when the closing message *ends on a question*.
//
// We require the question mark to TERMINATE the message (or its last line), not
// just appear somewhere in it. Sign-offs routinely contain "want me to" / "do
// you want" used conditionally ("Flag me if you want me to…", "Want me to X?
// Otherwise we're done.") — keying off those phrases lit finished work up as
// "your turn", which was the main false-positive source. A genuine open question
// ends with "?"; a sign-off ends with a period.
function awaitsUserReply(text) {
  if (!text) return false;
  const trimmed = text.trim();
  // Closing line, ignoring a short trailing parenthetical aside such as
  // "Want me to commit? (takes a second)".
  const lastLine = (trimmed.split('\n').map(l => l.trim()).filter(Boolean).pop() || '')
    .replace(/\s*\([^()]{0,80}\)[.!\s]*$/, '');
  const endsInQ = /[?？]["'’”)\]*_`~\s]*$/;
  return endsInQ.test(trimmed) || endsInQ.test(lastLine);
}

// Classify a session's state from its tail records + liveness.
//   working      — mid-turn and actively producing output: the transcript was
//                  written to in the last 90s, or the server is running a headless
//                  turn for it. NOT based on terminal liveness — that's detected
//                  per-directory and can't tell an exited session from a sibling.
//   waiting      — "Your turn": the assistant genuinely handed a decision back to
//                  you (its closing message asks a question / offers a choice), or
//                  a turn was left parked unanswered. Independent of age — an open
//                  question doesn't answer itself with time.
//   idle         — done/parked: a finished turn that expects nothing back (work
//                  delivered, wrap confirmed, a sign-off), or a user sign-off ack.
//                  Most completed sessions land here.
//   interrupted  — a turn that was cut off mid-flight *recently* (last 30 min):
//                  worth jumping back into now. An old mid-turn isn't "interrupted",
//                  it's just abandoned → idle. (Alarming on hours/days-old cut-offs
//                  was the main interrupted false-positive source.)

// Classify a session's state from its tail records + liveness.
//   working      — mid-turn and actively producing output: the transcript was
//                  written to in the last 90s, or the server is running a headless
//                  turn for it. NOT based on terminal liveness — that's detected
//                  per-directory and can't tell an exited session from a sibling.
//   waiting      — "Your turn": the assistant genuinely handed a decision back to
//                  you (its closing message asks a question / offers a choice), or
//                  a turn was left parked unanswered. Independent of age — an open
//                  question doesn't answer itself with time.
//   idle         — done/parked: a finished turn that expects nothing back (work
//                  delivered, wrap confirmed, a sign-off), or a user sign-off ack.
//                  Most completed sessions land here.
//   interrupted  — a turn that was cut off mid-flight *recently* (last 30 min):
//                  worth jumping back into now. An old mid-turn isn't "interrupted",
//                  it's just abandoned → idle. (Alarming on hours/days-old cut-offs
//                  was the main interrupted false-positive source.)
function computeStatus(s) {
  // A turn this server is running (or has queued) for the session counts as live,
  // even when ps+lsof can't see a terminal for it (headless / IDE / remote).
  const serverActive = runningChats.has(s.sessionId)
    || (chatQueues.get(s.sessionId) || []).length > 0;
  if (serverActive) return 'working';

  const recentMs = Date.now() - (s.mtimeMs || 0);
  const activelyWriting = recentMs < 90 * 1000;     // transcript written in last 90s
  const recentlyCutOff = recentMs < 30 * 60 * 1000; // mid-turn within the last 30 min
  // end_turn / stop_sequence are clean turn endings; tool_use / null mean the turn
  // was cut off mid-flight (a tool call with no follow-up recorded).
  const cleanlyEnded = s.lastStopReason === 'end_turn' || s.lastStopReason === 'stop_sequence';
  const lastWasUser = s.lastEventType === 'user';
  const midTurn = lastWasUser || (s.lastStopReason && !cleanlyEnded);

  // A satisfactory sign-off from the user marks a thread done outright.
  if (lastWasUser && looksLikeClosingAck(s.lastUserText)) return 'idle';

  if (midTurn) {
    // "working" must mean actually producing output. We deliberately do NOT trust
    // s.likelyLive here: liveness is detected per working-directory, so a session
    // you've exited still looks "live" whenever a sibling terminal runs in the same
    // dir — which made exited mid-turn sessions show amber "working" indefinitely.
    // A real in-progress turn writes blocks continuously, so a recent transcript
    // write is the only trustworthy signal. (serverActive, above, covers headless.)
    if (activelyWriting) return 'working';
    // Cut off in the last half hour → still warm, flag it to resume. Older than
    // that, it's just parked — don't keep raising a red flag for days.
    if (recentlyCutOff) return 'interrupted';
    return 'idle';
  }
  // Assistant finished cleanly. Your turn ONLY if it actually asked you something;
  // otherwise the work is delivered and nothing's pending → done.
  if (cleanlyEnded) return awaitsUserReply(s.lastAssistantText) ? 'waiting' : 'idle';
  return 'idle';
}

function buildData() {
  const { byCwd: liveByCwd } = liveTerminals();
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
      // Effective context window (200K vs proven/configured 1M) for fill %.
      s.contextWindow = contextWindowFor(s, p.cwd);
      // Permission mode: what the next ClaudeNav turn will run under, and
      // whether the user pinned it (vs. inherited from the transcript).
      s.modeOverride = sessionModes.get(s.sessionId) || null;
      s.mode = s.modeOverride || s.permissionMode || 'bypassPermissions';
      // Model: what the next ClaudeNav turn will run under. modelOverride is the
      // pinned model id (null = inherit); model is the effective choice for the
      // picker (override, else the last-used model, else 'default').
      s.modelOverride = sessionModels.get(s.sessionId) || null;
      s.model = s.modelOverride || s.lastModelChoice || 'default';
      s.archived = archivedSessions.has(s.sessionId);
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

module.exports = { looksLikeClosingAck, awaitsUserReply, computeStatus, buildData };
