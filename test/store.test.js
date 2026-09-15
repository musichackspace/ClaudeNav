'use strict';
// The single state file: legacy migration + atomic writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpHome } = require('./helpers');

const HOME = tmpHome();
const dot = path.join(HOME, '.claude');
// Seed legacy files BEFORE the server loads so migration has something to fold in.
fs.writeFileSync(path.join(dot, 'claudenav-modes.json'), JSON.stringify({ 'sess-1': 'plan', 'sess-x': 'bogus' }));
fs.writeFileSync(path.join(dot, 'claudenav-archived.json'), JSON.stringify(['sess-2', 42]));
fs.writeFileSync(path.join(dot, 'claudenav-sites.json'), JSON.stringify([path.join(HOME, 'site')]));
const { loadServer } = require('./helpers');
const srv = loadServer();
const store = require('../lib/store');

test('legacy files migrate into claudenav-state.json (invalid entries dropped)', () => {
  const st = JSON.parse(fs.readFileSync(store.STATE_FILE, 'utf8'));
  assert.deepEqual(st.archived, ['sess-2', 42]);   // raw copy; validation happens in state.js
  assert.equal(srv.sessionModes.get('sess-1'), 'plan');
  assert.equal(srv.sessionModes.has('sess-x'), false);
  assert.equal(srv.archivedSessions.has('sess-2'), true);
  assert.equal(srv.archivedSessions.has(42), false);
  assert.equal(fs.existsSync(path.join(dot, 'claudenav-modes.json')), true); // left in place
});

test('setters persist to the one file, atomically, and keep other sections', () => {
  srv.setArchived('sess-3', true);
  srv.setSessionMode('sess-4', 'acceptEdits');
  srv.setSessionModel('sess-5', 'claude-opus-4-8');
  const st = JSON.parse(fs.readFileSync(store.STATE_FILE, 'utf8'));
  assert.deepEqual(new Set(st.archived), new Set(['sess-2', 'sess-3']));
  assert.equal(st.modes['sess-4'], 'acceptEdits');
  assert.equal(st.modes['sess-1'], 'plan');
  assert.equal(st.models['sess-5'], 'claude-opus-4-8');
  assert.equal(fs.readdirSync(dot).filter(f => f.endsWith('.tmp')).length, 0);
});

test('writeJsonAtomic leaves the old file intact when the write fails', () => {
  const f = path.join(dot, 'nested', 'x.json');
  store.writeJsonAtomic(f, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 1 });
  const circular = {}; circular.self = circular;
  assert.throws(() => store.writeJsonAtomic(f, circular));
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 1 });
  assert.equal(fs.readdirSync(path.dirname(f)).filter(n => n.endsWith('.tmp')).length, 0);
});
