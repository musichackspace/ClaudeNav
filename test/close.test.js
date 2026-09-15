'use strict';
// /api/close end to end against a FAKE `claude` — a shell script named `claude`
// running under a pty (so `ps` shows a tty, as a real terminal session does),
// in a folder that a throwaway session transcript names as its cwd. Exercises
// the real path: findSessionFile -> parseSessionFile -> ps + lsof -> SIGTERM.
// No real session is touched (HOME is a temp dir; the process is ours).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpHome, loadServer, jsonl } = require('./helpers');

const HOME = tmpHome();
const { closeSession } = loadServer();
const darwin = process.platform === 'darwin';

const SID = 'cccccccc-0000-0000-0000-000000000001';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('closeSession SIGTERMs the live claude in the session cwd', { skip: !darwin && 'needs macOS `script -q`' }, async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(HOME, 'work-')));
  const bin = path.join(HOME, 'bin'); fs.mkdirSync(bin);
  const fake = path.join(bin, 'claude');
  const marker = path.join(work, 'got-term');
  // The pty wrapper (`script … /claude`) matches the claude regex too and dies
  // on the same SIGTERM, which HUPs the shell inside — so record either signal.
  // `ready` is written only after the traps are installed: signalling earlier
  // would kill a shell that hasn't set them yet and prove nothing.
  const ready = path.join(work, 'ready');
  fs.writeFileSync(fake, `#!/bin/sh\ntrap 'echo term > "${marker}"; exit 0' TERM\ntrap 'echo hup > "${marker}"; exit 0' HUP\necho ok > "${ready}"\nwhile :; do sleep 0.2; done\n`, { mode: 0o755 });
  const projDir = path.join(HOME, '.claude', 'projects', 'x'); fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, SID + '.jsonl'), jsonl([
    { type: 'user', sessionId: SID, cwd: work, timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'hi' } },
  ]));

  // `script` allocates a pty and runs the fake claude inside it.
  const child = spawn('script', ['-q', '/dev/null', fake], { cwd: work, stdio: 'ignore' });
  const exited = new Promise(r => child.on('exit', r));
  for (let i = 0; i < 40 && !fs.existsSync(ready); i++) await sleep(100);
  assert.equal(fs.existsSync(ready), true, 'fake claude should have started');
  let found = false;
  for (let i = 0; i < 20 && !found; i++) {
    await sleep(150);
    await new Promise(res => closeSession(SID, (err, r) => { found = !err && r.killed > 0; res(); }));
  }
  assert.equal(found, true, 'closeSession should find and signal the fake claude');
  await Promise.race([exited, sleep(4000)]);
  assert.equal(fs.existsSync(marker), true, 'fake claude should have been terminated');
  try { process.kill(child.pid, 'SIGKILL'); } catch {}
});

test('closeSession errors cleanly for an unknown session and for one with no terminal', async () => {
  await new Promise(res => closeSession('nope', (err) => { assert.match(err.message, /not found/); res(); }));
  const projDir = path.join(HOME, '.claude', 'projects', 'y'); fs.mkdirSync(projDir, { recursive: true });
  const id = 'cccccccc-0000-0000-0000-000000000002';
  fs.writeFileSync(path.join(projDir, id + '.jsonl'), jsonl([{ type: 'user', sessionId: id, cwd: path.join(HOME, 'nowhere'), message: { role: 'user', content: 'x' } }]));
  await new Promise(res => closeSession(id, (err) => { assert.match(err.message, /no live terminal/); res(); }));
});
