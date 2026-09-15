'use strict';
// Shared test setup. Every test file points HOME at a throwaway directory
// BEFORE requiring server.js, so the server's state files, uploads dir and
// $HOME-bounding all land in /tmp and nothing touches the real ~/.claude.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudenav-test-'));
  fs.mkdirSync(path.join(dir, '.claude', 'projects'), { recursive: true });
  process.env.HOME = dir;
  process.env.PORT = '0';
  return fs.realpathSync(dir);
}

function loadServer() {
  // Silence the startup banner for cleaner test output.
  const err = console.error; console.error = () => {};
  try { return require('../server.js'); } finally { console.error = err; }
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A fresh git repo with one commit, under `parent`.
function mkRepo(parent, name = 'repo') {
  const cwd = path.join(parent, name);
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@example.com');
  git(cwd, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(cwd, 'index.html'), '<h1>hi</h1>\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'init');
  return cwd;
}

function jsonl(lines) { return lines.map(o => JSON.stringify(o)).join('\n') + '\n'; }

module.exports = { tmpHome, loadServer, git, mkRepo, jsonl };
