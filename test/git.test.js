'use strict';
// The $HOME bound and the "session worktrees are invisible to git" rule.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpHome, loadServer, mkRepo, git } = require('./helpers');

const HOME = tmpHome();
const { underHome, siteStatus, excludeWorktrees, publishBranch, mainCheckout, repoNwo } = loadServer();

test('underHome accepts HOME and children, rejects escapes and symlinks out', () => {
  assert.equal(underHome(HOME), HOME);
  assert.equal(underHome(path.join(HOME, 'a', 'b')), path.join(HOME, 'a', 'b'));
  assert.equal(underHome(path.join(HOME, '..', 'elsewhere')), null);
  assert.equal(underHome('/etc'), null);
  assert.equal(underHome(''), null);
  assert.equal(underHome(null), null);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-outside-'));
  const link = path.join(HOME, 'link-out');
  fs.symlinkSync(out, link);
  assert.equal(underHome(link), null);
  fs.rmSync(out, { recursive: true, force: true });
});

test('siteStatus: outside HOME is unknown, non-repo is nonrepo, local repo is local', () => {
  assert.equal(siteStatus('/etc').state, 'unknown');
  fs.mkdirSync(path.join(HOME, 'plain'));
  assert.equal(siteStatus(path.join(HOME, 'plain')).state, 'nonrepo');
  const cwd = mkRepo(HOME, 'site');
  const s = siteStatus(cwd);
  assert.equal(s.state, 'local');
  assert.equal(s.dirty, false);
  assert.equal(s.changeCount, 0);
});

test('a session worktree dir under .claude/worktrees does not make the repo dirty; a real file does', () => {
  const cwd = mkRepo(HOME, 'site2');
  fs.mkdirSync(path.join(cwd, '.claude', 'worktrees', 'x'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'worktrees', 'x', 'junk.txt'), 'x');
  assert.match(git(cwd, 'status', '--porcelain'), /\.claude\//); // git itself sees it…
  const s = siteStatus(cwd);
  assert.equal(s.dirty, false);                                    // …siteStatus filters it
  fs.writeFileSync(path.join(cwd, 'new.txt'), 'real change');
  const s2 = siteStatus(cwd);
  assert.equal(s2.dirty, true);
  assert.equal(s2.changeCount, 1);
});

test('excludeWorktrees writes .git/info/exclude once and hides the worktrees from status', () => {
  const cwd = mkRepo(HOME, 'site3');
  fs.mkdirSync(path.join(cwd, '.claude', 'worktrees', 'y'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'worktrees', 'y', 'f'), 'x');
  excludeWorktrees(cwd);
  excludeWorktrees(cwd);
  const excl = fs.readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf8');
  assert.equal((excl.match(/\.claude\/worktrees\//g) || []).length, 1);
  assert.equal(git(cwd, 'status', '--porcelain'), '');
});

test('publishBranch falls back to the local default; mainCheckout resolves a worktree to its project', () => {
  const cwd = mkRepo(HOME, 'site4');
  assert.equal(publishBranch(cwd, null), 'main');
  assert.equal(publishBranch(cwd, 'gh-pages'), 'gh-pages');
  const wt = path.join(cwd, '.claude', 'worktrees', 'leaf');
  git(cwd, 'worktree', 'add', '-q', '-b', 'session/leaf', wt);
  const mc = mainCheckout(wt);
  assert.equal(mc.isWorktree, true);
  assert.equal(fs.realpathSync(mc.main), cwd);
  assert.equal(repoNwo(cwd), null); // no remote
});
