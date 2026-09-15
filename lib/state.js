'use strict';
// Per-session user choices persisted under ~/.claude: permission mode, model, archived flag.
// Part of ClaudeNav's server (see server.js for the routes).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { findSessionFile, parseSessionFile } = require('./transcripts');

// Sessions run with skipped permissions so the assistant can actually use tools
// (matches how these terminal sessions were started). Set CLAUDE_SAFE=1 to omit.
const SKIP_PERMS = process.env.CLAUDE_SAFE !== '1';

// Permission modes the `claude` CLI accepts via --permission-mode. ClaudeNav
// lets you pick one per session; the next headless turn runs under it (and the
// transcript then records it, so the choice "sticks" even without the override).

// Permission modes the `claude` CLI accepts via --permission-mode. ClaudeNav
// lets you pick one per session; the next headless turn runs under it (and the
// transcript then records it, so the choice "sticks" even without the override).
const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk'];

// User-chosen mode overrides, sessionId -> mode. Persisted so a chosen mode
// survives a restart. When unset, a turn falls back to the transcript's last
// recorded mode, else 'bypassPermissions' (ClaudeNav's historical default).

// User-chosen mode overrides, sessionId -> mode. Persisted so a chosen mode
// survives a restart. When unset, a turn falls back to the transcript's last
// recorded mode, else 'bypassPermissions' (ClaudeNav's historical default).
const MODES_FILE = path.join(os.homedir(), '.claude', 'claudenav-modes.json');
const sessionModes = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(MODES_FILE, 'utf8'));
  for (const [k, v] of Object.entries(raw)) if (PERMISSION_MODES.includes(v)) sessionModes.set(k, v);
} catch { /* no file yet */ }
function persistModes() {
  try { fs.writeFileSync(MODES_FILE, JSON.stringify(Object.fromEntries(sessionModes))); } catch {}
}

// Archived sessions: explicitly tucked away by the user, hidden from the default
// list regardless of recency/status (they stay searchable and resumable). Just a
// set of session IDs persisted alongside the modes file.

// Archived sessions: explicitly tucked away by the user, hidden from the default
// list regardless of recency/status (they stay searchable and resumable). Just a
// set of session IDs persisted alongside the modes file.
const ARCHIVE_FILE = path.join(os.homedir(), '.claude', 'claudenav-archived.json');
const archivedSessions = new Set();
try {
  const raw = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
  if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') archivedSessions.add(id);
} catch { /* no file yet */ }
function setArchived(sessionId, archived) {
  if (!/^[\w-]+$/.test(sessionId || '')) throw new Error('bad session id');
  if (archived) archivedSessions.add(sessionId); else archivedSessions.delete(sessionId);
  try { fs.writeFileSync(ARCHIVE_FILE, JSON.stringify([...archivedSessions])); } catch {}
}
function setSessionMode(sessionId, mode) {
  if (!/^[\w-]+$/.test(sessionId || '')) throw new Error('bad session id');
  if (!PERMISSION_MODES.includes(mode)) throw new Error('unknown mode');
  sessionModes.set(sessionId, mode);
  persistModes();
}

// Model the next headless turn runs under. ClaudeNav lets you pick one per
// session; the exact model id is passed through to the CLI as --model <id>.
// 'default' means "no override" — inherit whatever the CLI/account default is.
// The pickable list is fetched from the Anthropic Models API once a day (see
// maybeFetchModels) so it tracks new releases without a code change; this
// built-in list is the fallback when the API is unreachable. Order = newest
// first (matches the API's ordering); the picker prepends 'default'.
// A model id is anything in the safe id charset; 'default' clears the override.
// We don't gate on the fetched list — a saved/picked id may name a model the
// list hasn't caught up to, and the CLI itself rejects a truly bogus id.
function isValidModel(model) {
  return model === 'default' || /^[a-zA-Z0-9._-]+$/.test(model || '');
}
// Map a full model id from a transcript to a known model id. Transcript ids may
// carry a date suffix (e.g. claude-haiku-4-5-20251001), so match by prefix
// against the current list. Returns the canonical id, or null if unknown.

// User-chosen model overrides, sessionId -> model id. Persisted so a chosen
// model survives a restart. When unset, a turn inherits the CLI default.
const MODELS_FILE = path.join(os.homedir(), '.claude', 'claudenav-models.json');
const sessionModels = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v !== 'default' && isValidModel(v)) sessionModels.set(k, v);
} catch { /* no file yet */ }
function persistModels() {
  try { fs.writeFileSync(MODELS_FILE, JSON.stringify(Object.fromEntries(sessionModels))); } catch {}
}
function setSessionModel(sessionId, model) {
  if (!/^[\w-]+$/.test(sessionId || '')) throw new Error('bad session id');
  if (!isValidModel(model)) throw new Error('unknown model');
  if (model === 'default') sessionModels.delete(sessionId); // clear the override
  else sessionModels.set(sessionId, model);
  persistModels();
}
// The model id a turn for this session will pass to the CLI, or null to inherit.
// The model id a turn for this session will pass to the CLI, or null to inherit.
function effectiveModel(sessionId) {
  return sessionModels.get(sessionId) || null;
}
// The mode a turn for this session will actually run under.
// The mode a turn for this session will actually run under.
function effectiveMode(sessionId) {
  if (sessionModes.has(sessionId)) return sessionModes.get(sessionId);
  const fp = findSessionFile(sessionId);
  if (fp) { try { return parseSessionFile(fp, fs.statSync(fp)).permissionMode || 'bypassPermissions'; } catch {} }
  return 'bypassPermissions';
}

module.exports = { SKIP_PERMS, PERMISSION_MODES, MODES_FILE, sessionModes, persistModes, ARCHIVE_FILE, archivedSessions, setArchived, setSessionMode, isValidModel, MODELS_FILE, sessionModels, persistModels, setSessionModel, effectiveModel, effectiveMode };
