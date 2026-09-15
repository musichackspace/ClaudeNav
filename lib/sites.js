'use strict';
// The website wizard: GitHub via `gh`, Pages, site status, publish, worktree merge.
// Part of ClaudeNav's server (see server.js for the routes).

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { HOME } = require('./config');
const { git, gitOk, gitTry } = require('./gitutil');
const store = require('./store');
const { GH_BIN, gh } = require('./bins');
const { excludeWorktrees, underHome } = require('./repos');

function ghErr(e) {
  return (e.stderr || e.stdout || e.message || 'GitHub operation failed').toString().trim().slice(0, 400);
}

// {installed, authed, user, platform} — cheap enough to call on every wizard
// open. `platform` lets the UI word the install/sign-in hints per-OS (the
// terminal-opening + install steps differ on Windows vs macOS).
function ghStatus() {
  const platform = process.platform;
  if (!GH_BIN) return { installed: false, authed: false, user: null, platform };
  try { return { installed: true, authed: true, user: gh(['api', 'user', '--jq', '.login']), platform }; }
  catch { return { installed: true, authed: false, user: null, platform }; }
}

// Repo/URL-safe slug from a human site name. Empty if nothing usable is left.
function siteSlug(name) {
  return (name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Folders provisioned/imported as websites through the wizard. This is what
// tells the publish UI "treat this repo as a site" even before Pages is on, so
// ordinary code repos (which also have a GitHub remote) never get a misleading
// "Not online" pill. A repo with Pages already enabled counts as a site too
// (see siteStatus), so this only needs to remember the wizard's own creations.
const knownSites = new Set();
for (const p of (store.get('sites') || [])) if (typeof p === 'string') knownSites.add(p);
function rememberSite(cwd) {
  const abs = underHome(cwd);
  if (!abs) return;
  knownSites.add(abs);
  store.set('sites', [...knownSites]);
}

function starterIndexHtml(name) {
  const t = String(name || 'My Website').replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${t}</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font: 17px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
           display: grid; place-items: center; min-height: 100vh;
           background: #0f1115; color: #e6e6e6; text-align: center; padding: 2rem; }
    .card { max-width: 40rem; }
    h1 { font-size: clamp(2rem, 6vw, 3.5rem); margin: 0 0 .5rem; }
    p { opacity: .8; margin: .25rem 0; }
    .hint { margin-top: 2rem; font-size: .9rem; opacity: .55; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${t}</h1>
    <p>Your new website is live. 🎉</p>
    <p>Open the chat in ClaudeNav and describe what you'd like it to look like.</p>
    <p class="hint">Edit this file (index.html) or ask Claude — then hit Publish.</p>
  </div>
</body>
</html>
`;
}
function starterReadme(name) {
  return `# ${name || 'My Website'}\n\nA website built with ClaudeNav. Edit \`index.html\` (or ask Claude), then Publish to update the live site.\n`;
}

// Create a website end-to-end: folder → starter files → git repo + first commit
// → GitHub repo (pushed) → GitHub Pages enabled. Returns the local cwd and the
// live URL. Best-effort on Pages (propagation lag / already-enabled are fine).
function createSite({ name, parent }, cb) {
  const status = ghStatus();
  if (!status.installed) return cb(new Error('the GitHub CLI (gh) is not installed — install it from https://cli.github.com'));
  if (!status.authed) return cb(new Error('not signed in to GitHub — connect your account first'));
  const slug = siteSlug(name);
  if (!slug) return cb(new Error('please enter a site name (letters and numbers)'));

  const base = underHome(parent && String(parent).trim() ? parent : HOME);
  if (!base) return cb(new Error('that location is outside your home directory'));
  const cwd = path.join(base, slug);
  try { if (fs.existsSync(cwd) && fs.readdirSync(cwd).length) return cb(new Error(`a folder named "${slug}" already exists here — pick another name`)); }
  catch { /* unreadable — mkdir below will surface it */ }

  const owner = status.user;
  try {
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'index.html'), starterIndexHtml(name));
    fs.writeFileSync(path.join(cwd, 'README.md'), starterReadme(name));

    git(cwd, ['init']);
    try { git(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']); } catch { /* older git defaults are fine */ }
    git(cwd, ['add', '-A']);
    execFileSync('git', ['-C', cwd, 'commit', '-m', 'Initial website (ClaudeNav)'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return cb(new Error('could not set up the folder: ' + (e.message || 'failed')));
  }

  try {
    gh(['repo', 'create', slug, '--source', cwd, '--public', '--push', '--remote', 'origin'], { cwd });
  } catch (e) {
    return cb(new Error('created locally, but publishing to GitHub failed: ' + ghErr(e)));
  }

  // Enable Pages from main / root. Non-fatal: a fresh repo can 404 briefly, and
  // re-runs hit "already enabled" — either way the URL is deterministic.
  const pagesUrl = `https://${owner}.github.io/${slug}/`;
  try { gh(['api', '-X', 'POST', `repos/${owner}/${slug}/pages`, '-f', 'source[branch]=main', '-f', 'source[path]=/']); }
  catch { /* propagation lag or already enabled — leave a note via pagesEnabled */ }

  rememberSite(cwd);
  cb(null, { cwd, slug, owner, repoUrl: `https://github.com/${owner}/${slug}`, pagesUrl });
}

// Live-site status for an existing repo. `GET repos/{nwo}/pages` 404s when Pages
// is off (→ enabled:false); when on, `.html_url` is authoritative (it handles
// custom domains and user/org root sites, unlike the deterministic guess).
// `.source.branch` is the branch GitHub actually serves — publishing has to land
// there or the push is a no-op as far as the live site is concerned.
function pagesInfo(nwo) {
  try {
    const j = JSON.parse(gh(['api', `repos/${nwo}/pages`,
      '--jq', '{url: .html_url, branch: .source.branch}']));
    return { enabled: true, url: j.url || null, branch: j.branch || null };
  } catch { return { enabled: false, url: null, branch: null }; }
}

// List the signed-in user's own repos, newest activity first — the picker for
// "edit a site I already have on GitHub". Lists every repo the user can
// *access* — not just ones they own — via the affiliations endpoint, so repos
// in orgs and repos they collaborate on show up too (e.g. an org-owned site).
// `gh repo list` without an owner only returns the personal account's repos,
// which silently hides org/collaborator repos; `user/repos?affiliation=…` is
// the authoritative "everything I can touch" list.
function ghListRepos(cb) {
  const status = ghStatus();
  if (!status.installed) return cb(new Error('the GitHub CLI (gh) is not installed'));
  if (!status.authed) return cb(new Error('not signed in to GitHub'));
  try {
    const raw = JSON.parse(gh(['api',
      'user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100',
      '--paginate']) || '[]');
    const repos = raw
      .filter(r => !r.archived)
      .map(r => ({
        name: r.name,
        nameWithOwner: r.full_name,
        description: r.description,
        visibility: r.private ? 'PRIVATE' : 'PUBLIC',
        url: r.html_url,
        pushedAt: r.pushed_at,
        isFork: r.fork,
      }))
      .sort((a, b) => String(b.pushedAt || '').localeCompare(String(a.pushedAt || '')));
    cb(null, { owner: status.user, repos });
  } catch (e) { cb(new Error(ghErr(e))); }
}

// Clone an existing repo into a $HOME folder so it can be maintained + published
// from ClaudeNav. If the target folder is already that repo (same origin), reuse
// it rather than failing — the "I already have it locally" case. Reports the
// live Pages URL when the repo already serves one.
function importSite({ repo, parent }, cb) {
  const status = ghStatus();
  if (!status.installed) return cb(new Error('the GitHub CLI (gh) is not installed'));
  if (!status.authed) return cb(new Error('not signed in to GitHub'));
  const nwo = String(repo || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(nwo)) return cb(new Error('pick a repository'));
  const [owner, slug] = nwo.split('/');

  const base = underHome(parent && String(parent).trim() ? parent : HOME);
  if (!base) return cb(new Error('that location is outside your home directory'));
  const cwd = path.join(base, slug);

  try {
    if (fs.existsSync(cwd) && fs.readdirSync(cwd).length) {
      // Non-empty: only OK if it's already this same repo checked out here.
      let origin = '';
      try { origin = git(cwd, ['remote', 'get-url', 'origin']); } catch { /* not a repo */ }
      const matches = origin && new RegExp(`[/:]${owner}/${slug}(\\.git)?/?$`, 'i').test(origin);
      if (!matches) return cb(new Error(`a different folder named "${slug}" already exists here — rename or move it first`));
      const pi = pagesInfo(nwo);
      rememberSite(cwd);
      return cb(null, { cwd, slug, owner, reused: true, repoUrl: `https://github.com/${nwo}`,
        pagesUrl: pi.url || `https://${owner}.github.io/${slug}/`, pagesEnabled: pi.enabled });
    }
  } catch { /* unreadable — clone below will surface it */ }

  try { gh(['repo', 'clone', nwo, cwd]); }
  catch (e) { return cb(new Error('could not download the repository: ' + ghErr(e))); }

  const pi = pagesInfo(nwo);
  rememberSite(cwd);
  cb(null, { cwd, slug, owner, repoUrl: `https://github.com/${nwo}`,
    pagesUrl: pi.url || `https://${owner}.github.io/${slug}/`, pagesEnabled: pi.enabled });
}

// Turn on GitHub Pages for an existing repo (served from its default branch /
// root) — for an imported site that wasn't publishing yet. Idempotent: an
// already-enabled repo just returns its current URL.
function enablePages({ repo }, cb) {
  const status = ghStatus();
  if (!status.authed) return cb(new Error('not signed in to GitHub'));
  const nwo = String(repo || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(nwo)) return cb(new Error('bad repo'));
  const [owner, slug] = nwo.split('/');
  let branch = 'main';
  try { branch = gh(['api', `repos/${nwo}`, '--jq', '.default_branch']) || 'main'; } catch { /* assume main */ }
  try { gh(['api', '-X', 'POST', `repos/${nwo}/pages`, '-f', `source[branch]=${branch}`, '-f', 'source[path]=/']); }
  catch (e) {
    const pi = pagesInfo(nwo);
    if (pi.enabled) return cb(null, { pagesEnabled: true, pagesUrl: pi.url });
    return cb(new Error(ghErr(e)));
  }
  const pi = pagesInfo(nwo);
  cb(null, { pagesEnabled: true, pagesUrl: pi.url || `https://${owner}.github.io/${slug}/` });
}

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

function relTimeShort(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const pagesCache = new Map(); // nwo -> { at, info }
function pagesState(nwo) {
  const c = pagesCache.get(nwo);
  if (c && Date.now() - c.at < 30000) return c.info;
  let info = { pagesEnabled: false, pagesUrl: null, pagesBranch: null, buildStatus: null, builtCommit: null, builtAt: null };
  try {
    const pi = pagesInfo(nwo);
    if (pi.enabled) {
      info = { pagesEnabled: true, pagesUrl: pi.url, pagesBranch: pi.branch, buildStatus: null, builtCommit: null, builtAt: null };
      try {
        const b = JSON.parse(gh(['api', `repos/${nwo}/pages/builds/latest`,
          '--jq', '{status: .status, commit: .commit, updated_at: .updated_at}']));
        info.buildStatus = b.status || null;
        info.builtCommit = b.commit || null;
        info.builtAt = b.updated_at || null;
      } catch { /* enabled but never built yet — buildStatus stays null */ }
    }
  } catch { /* gh missing / offline — leave defaults, treated as unknown below */ }
  pagesCache.set(nwo, { at: Date.now(), info });
  return info;
}
function invalidatePages(nwo) { if (nwo) pagesCache.delete(nwo); }

// True when the git command succeeds. For predicates like `merge-base
// --is-ancestor`, where the answer is the exit code and stdout is empty (so
// gitTry's "did it return anything" can't distinguish yes from no).

// The project's own checkout behind a (possibly linked) session worktree.
// `git worktree list` always names the main working tree first.
function mainCheckout(cwd) {
  const here = path.resolve(cwd);
  const list = gitTry(cwd, ['worktree', 'list', '--porcelain']);
  const first = (list.split('\n').find(l => l.startsWith('worktree ')) || '').slice('worktree '.length);
  const main = first ? path.resolve(first) : here;
  return { main, isWorktree: main !== here };
}

// The branch a publish must land on for the change to actually go live: the
// branch GitHub Pages serves, else the repo's default branch. Session worktrees
// sit on their own `session/<leaf>` branch, which Pages never builds — so
// "which branch am I on" is the wrong question for publishing, and asking this
// instead is what lets a worktree session ship without a manual merge.
function publishBranch(cwd, pagesBranch) {
  if (pagesBranch) return pagesBranch;
  const head = gitTry(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
  if (head.startsWith('origin/')) return head.slice('origin/'.length);
  for (const cand of ['main', 'master']) {
    if (gitOk(cwd, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${cand}`])) return cand;
  }
  return gitTry(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 'main');
}

function repoNwo(cwd) {
  const url = gitTry(cwd, ['remote', 'get-url', 'origin']);
  const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], name: m[2], nwo: `${m[1]}/${m[2]}` } : null;
}

function siteStatus(cwd) {
  const abs = underHome(cwd);
  if (!abs || !fs.existsSync(abs)) return { state: 'unknown', label: 'Unknown' };
  if (gitTry(abs, ['rev-parse', '--is-inside-work-tree']) !== 'true') return { state: 'nonrepo', label: 'Not a website project' };

  // Our own session-worktree directory is not the user's change. Make git hide it
  // BEFORE asking for status: `--porcelain` collapses an untracked directory to a
  // single `?? .claude/` line, which no `.claude/worktrees/` filter can match — so
  // a repo that predates the exclude (or was cloned fresh) read as permanently
  // "Draft" until this ran. The line filter stays as a second net for the case
  // where the exclude file couldn't be written (test/git.test.js covers both).
  excludeWorktrees(abs);
  const changes = gitTry(abs, ['status', '--porcelain']).split('\n')
    .filter(Boolean).filter(l => !/\.claude\/worktrees\//.test(l));
  const dirty = changes.length > 0;
  const changeCount = changes.length;

  const r = repoNwo(abs);
  if (!r) return { state: 'local', label: 'Saved on this computer only', dirty, changeCount, hasRemote: false };

  const ps = pagesState(r.nwo);
  // Measure "is my work online" against the branch GitHub serves — NOT against
  // this checkout's own upstream. A session worktree pushed to its own
  // `session/<leaf>` branch has a perfectly up-to-date @{u} while the live site
  // shows none of it; comparing to origin/<publish branch> tells the truth for
  // worktree and main-checkout sessions alike.
  const branch = publishBranch(abs, ps.pagesBranch);
  const remoteRef = `origin/${branch}`;
  const hasUpstream = gitOk(abs, ['rev-parse', '--verify', '-q', `refs/remotes/${remoteRef}`]);
  const ahead = hasUpstream ? (parseInt(gitTry(abs, ['rev-list', '--count', `${remoteRef}..HEAD`], '0'), 10) || 0) : 0;
  const remoteHead = hasUpstream ? gitTry(abs, ['rev-parse', remoteRef]) : '';

  const pagesUrl = ps.pagesUrl || `https://${r.owner}.github.io/${r.name}/`;
  // "Is this a website?" — Pages already on, or created/imported via the wizard.
  // Ordinary code repos (GitHub remote but neither) get state 'repo' and no pill.
  // Check the project folder too, so a session worktree of a wizard site (whose
  // registry entry names the project, not the worktree) still counts as one.
  const isSite = ps.pagesEnabled || knownSites.has(abs) || knownSites.has(mainCheckout(abs).main);
  const base = { isSite, dirty, changeCount, ahead, hasRemote: true, nwo: r.nwo, publishBranch: branch,
    repoUrl: `https://github.com/${r.nwo}`, pagesEnabled: ps.pagesEnabled, pagesUrl, buildStatus: ps.buildStatus };
  if (!isSite) return { state: 'repo', label: 'Code project', ...base };

  let state, label, detail = '';
  if (dirty || !hasUpstream || ahead > 0) {
    state = 'draft'; label = 'Draft — changes not online yet';
    const n = changeCount || ahead;
    detail = n ? `${n} change${n === 1 ? '' : 's'} to publish` : 'changes to publish';
  } else if (!ps.pagesEnabled) {
    state = 'offline'; label = 'Not online yet';
  } else if (ps.buildStatus === 'errored') {
    state = 'failed'; label = 'Publishing failed';
  } else if (ps.buildStatus === 'built' && ps.builtCommit && remoteHead && ps.builtCommit === remoteHead) {
    state = 'live'; label = 'Published — live'; detail = relTimeShort(ps.builtAt);
  } else {
    state = 'publishing'; label = 'Publishing…'; detail = 'usually under a minute';
  }
  return { state, label, detail, ...base };
}

// The one-button "Publish": stage everything, commit (if there's anything to
// commit), then push (setting upstream on the first push). Non-devs never see a
// commit/push distinction — this is the whole ship-it action. Returns the fresh
// status so the pill flips to "Publishing…" immediately.
// The pre-Pages behavior: commit anything pending and push the branch we're on.
// Used for a GitHub repo that isn't a website (see publishSite).
function pushCurrentBranch(abs, message, r, cb) {
  try {
    if (gitTry(abs, ['status', '--porcelain'])) {
      git(abs, ['add', '-A']);
      execFileSync('git', ['-C', abs, 'commit', '-m', (message || '').trim() || 'Update website (ClaudeNav)'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }
    const hasUpstream = !!gitTry(abs, ['rev-parse', '--abbrev-ref', '@{u}']);
    const branch = gitTry(abs, ['rev-parse', '--abbrev-ref', 'HEAD'], 'main');
    const args = hasUpstream ? ['-C', abs, 'push'] : ['-C', abs, 'push', '-u', 'origin', branch];
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return cb(new Error((e.stderr || e.stdout || e.message || 'publish failed').toString().trim().slice(0, 300)));
  }
  invalidatePages(r.nwo);
  cb(null, siteStatus(abs));
}

function publishSite({ cwd, message }, cb) {
  const abs = underHome(cwd);
  if (!abs) return cb(new Error('that folder is outside your home directory'));
  if (gitTry(abs, ['rev-parse', '--is-inside-work-tree']) !== 'true') return cb(new Error('not a website project'));
  const r = repoNwo(abs);
  if (!r) return cb(new Error('this site has no GitHub connection yet'));
  const ps = pagesState(r.nwo);
  const { main, isWorktree } = mainCheckout(abs);
  const isSite = ps.pagesEnabled || knownSites.has(abs) || knownSites.has(main);
  // Not a website — publish means nothing more than "push this branch". Keep the
  // plain behavior; redirecting a code repo's branch onto main would be wrong.
  if (!isSite) return pushCurrentBranch(abs, message, r, cb);
  const branch = publishBranch(abs, ps.pagesBranch);
  excludeWorktrees(abs); // before any `git add -A`, so we never commit our own worktrees
  try {
    if (gitTry(abs, ['status', '--porcelain'])) {
      git(abs, ['add', '-A']);
      execFileSync('git', ['-C', abs, 'commit', '-m', (message || '').trim() || 'Update website (ClaudeNav)'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }
    // Refresh the published branch first: it may have moved since this session
    // was created (another session shipped). Best-effort and bounded — being
    // offline must not wedge publishing; the push below will fail honestly.
    try {
      execFileSync('git', ['-C', abs, 'fetch', '--quiet', 'origin', branch],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    } catch { /* offline / branch doesn't exist yet — fall through */ }
    const remoteRef = `refs/remotes/origin/${branch}`;
    const haveRemote = gitOk(abs, ['rev-parse', '--verify', '-q', remoteRef]);
    // Replay this session's commits on top of what's live, so the user never has
    // to rebase by hand to get their change online. A no-op when this session is
    // already current (the common case — worktrees branch off a fresh origin).
    if (haveRemote && !gitOk(abs, ['merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD'])) {
      try {
        execFileSync('git', ['-C', abs, 'rebase', `origin/${branch}`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        // Name the clashing files while the rebase is still in progress — that
        // list is the one thing that makes this resolvable without git knowledge.
        const files = gitTry(abs, ['diff', '--name-only', '--diff-filter=U'])
          .split('\n').filter(Boolean).slice(0, 3).join(', ');
        try { git(abs, ['rebase', '--abort']); } catch {}
        return cb(new Error('these changes clash with newer edits that are already online' +
          (files ? ` (${files})` : '') + ' — ask Claude in this session to merge them, then publish again'));
      }
    }
    // Land it on the branch GitHub serves, whatever branch this session is on.
    // Pushing HEAD by ref (not the current branch name) is the whole fix: a
    // session worktree ships to the live branch instead of to a `session/…`
    // branch that Pages never builds.
    execFileSync('git', ['-C', abs, 'push', 'origin', `HEAD:refs/heads/${branch}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!isWorktree) { try { git(abs, ['branch', `--set-upstream-to=origin/${branch}`]); } catch {} }
  } catch (e) {
    return cb(new Error((e.stderr || e.stdout || e.message || 'publish failed').toString().trim().slice(0, 300)));
  }
  // Keep the project's own checkout current, so the NEXT new session branches
  // off what's live rather than off the pre-publish state. Without this the
  // staleness comes straight back: worktreeBase() branches off origin/<default>,
  // which is fine, but a plain session in the project folder would still see old
  // files. Fast-forward only — never touch a dirty or diverged checkout.
  // `-uno`: untracked files don't block a fast-forward (git refuses on its own if
  // one would be clobbered), and before excludeWorktrees ran they always include
  // our own .claude/worktrees/ — which used to make this sync silently never fire.
  if (isWorktree && !gitTry(main, ['status', '--porcelain', '-uno'])) {
    try {
      if (gitTry(main, ['rev-parse', '--abbrev-ref', 'HEAD']) === branch) {
        execFileSync('git', ['-C', main, 'merge', '--ff-only', `origin/${branch}`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } else {
        // Not checked out here, so the ref can be updated directly.
        execFileSync('git', ['-C', main, 'fetch', '--quiet', 'origin', `${branch}:${branch}`],
          { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
      }
    } catch { /* diverged or busy — the live site is published either way */ }
  }
  invalidatePages(r.nwo); // force a fresh Pages read on the next status poll
  cb(null, siteStatus(abs));
}

// Merge a session worktree's branch back into the repo's main checkout, then
// remove the worktree. Refuses if the main checkout has uncommitted changes
// (so we never clobber another session's in-flight work).
function gitWorktreeMerge(wtPath, cb) {
  try {
    const branch = git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const list = git(wtPath, ['worktree', 'list', '--porcelain']);
    const main = (list.split('\n').find(l => l.startsWith('worktree ')) || '').slice('worktree '.length);
    if (!main) return cb(new Error('could not locate main worktree'));
    if (path.resolve(main) === path.resolve(wtPath)) return cb(new Error('this is the main worktree'));
    // `-uno` for the same reason as in publishSite: our own .claude/worktrees/ is
    // untracked in a repo that doesn't ignore it, and counting that as "the user
    // has uncommitted changes" made merge-back refuse on every such repo.
    excludeWorktrees(main);
    if (git(main, ['status', '--porcelain', '-uno'])) {
      return cb(new Error('main checkout has uncommitted changes — commit or stash them first'));
    }
    // Commit anything pending in the session worktree, then merge into main.
    if (git(wtPath, ['status', '--porcelain'])) {
      git(wtPath, ['add', '-A']);
      execFileSync('git', ['-C', wtPath, 'commit', '-m', 'session changes (ClaudeNav)'], { encoding: 'utf8' });
    }
    try {
      execFileSync('git', ['-C', main, 'merge', '--no-edit', branch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      try { git(main, ['merge', '--abort']); } catch {}
      return cb(new Error('merge conflict — resolve manually: ' + (e.stderr || e.message || '').toString().trim().slice(0, 200)));
    }
    try {
      execFileSync('git', ['-C', main, 'worktree', 'remove', '--force', wtPath], { encoding: 'utf8' });
      git(main, ['branch', '-D', branch]);
    } catch { /* merged fine; cleanup is best-effort */ }
    cb(null, { merged: true, branch, into: git(main, ['rev-parse', '--abbrev-ref', 'HEAD']) });
  } catch (e) {
    cb(new Error((e.stderr || e.message || 'merge error').toString().trim().slice(0, 300)));
  }
}

// ---------------------------------------------------------------------------
// Wrap-up: AI "is it safe to wrap?" enquiry + graceful exit
// ---------------------------------------------------------------------------

// Ask the session itself, headlessly, whether it's safe to close. Returns a
// structured verdict. This adds one turn to the transcript (it's an enquiry).

module.exports = { ghErr, ghStatus, siteSlug, knownSites, rememberSite, starterIndexHtml, starterReadme, createSite, pagesInfo, ghListRepos, importSite, enablePages, relTimeShort, pagesCache, pagesState, invalidatePages, mainCheckout, publishBranch, repoNwo, siteStatus, pushCurrentBranch, publishSite, gitWorktreeMerge };
