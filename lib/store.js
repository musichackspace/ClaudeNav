'use strict';
// One state file for ClaudeNav's persisted user choices, written atomically.
// Part of ClaudeNav's server (see server.js for the routes).
//
// ~/.claude/claudenav-state.json holds { modes, models, archived, sites } — the
// per-session permission mode / model pins, the archived session ids and the
// website wizard's registry. It replaces four separate files (claudenav-modes /
// -models / -archived / -sites.json), which are read once for migration when the
// state file doesn't exist yet and then left alone. Every save goes through
// writeJsonAtomic (write a temp file, then rename), so a crash mid-write can
// never leave a truncated file behind. Per-port turn state (runs / queue) uses
// the same atomic writer but stays in its own files — two instances on
// different ports must not share it.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.homedir(), '.claude', 'claudenav-state.json');
const LEGACY = {
  modes: path.join(os.homedir(), '.claude', 'claudenav-modes.json'),
  models: path.join(os.homedir(), '.claude', 'claudenav-models.json'),
  archived: path.join(os.homedir(), '.claude', 'claudenav-archived.json'),
  sites: path.join(os.homedir(), '.claude', 'claudenav-sites.json'),
};

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

let state = null;
function load() {
  if (state) return state;
  const s = readJson(STATE_FILE, null);
  if (s && typeof s === 'object') {
    state = { modes: {}, models: {}, archived: [], sites: [], ...s };
  } else {
    // First run on this layout: fold the legacy files in (left in place).
    state = {
      modes: readJson(LEGACY.modes, {}) || {},
      models: readJson(LEGACY.models, {}) || {},
      archived: readJson(LEGACY.archived, []) || [],
      sites: readJson(LEGACY.sites, []) || [],
    };
    if (Object.keys(state.modes).length || Object.keys(state.models).length || state.archived.length || state.sites.length) {
      try { writeJsonAtomic(STATE_FILE, state); } catch {}
    }
  }
  return state;
}
// Read one section (a plain object or array — callers copy into their Map/Set).
function get(section) { return load()[section]; }
// Replace one section and persist the whole file atomically. Best-effort: a
// failed write is logged, never thrown — the in-memory state is still correct.
function set(section, value) {
  load()[section] = value;
  try { writeJsonAtomic(STATE_FILE, state); }
  catch (e) { console.error(`[claudenav] could not save ${STATE_FILE}: ${e.message}`); }
}

module.exports = { STATE_FILE, LEGACY, get, set, writeJsonAtomic, readJson };
