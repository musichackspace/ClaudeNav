#!/usr/bin/env node
'use strict';

/*
 * GitHub History — a local visualizer for the commit history of any public
 * GitHub repository.
 *
 * Proxies the GitHub REST API (so the browser never hits CORS and an optional
 * token stays server-side), then renders the data as hand-rolled SVG charts in
 * a single static page.
 *
 * No dependencies. Binds to 127.0.0.1 only.
 * Set GITHUB_TOKEN to raise the API rate limit from 60 to 5000 req/hour.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4318;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

// ---------------------------------------------------------------------------
// GitHub API helper
// ---------------------------------------------------------------------------

// Tiny in-memory cache so re-renders of the same repo within a session don't
// burn the rate limit. Keyed by API path, 5-minute TTL.
const apiCache = new Map(); // apiPath -> { at, status, body }
const CACHE_TTL_MS = 5 * 60 * 1000;

function ghRequest(apiPath) {
  return new Promise((resolve, reject) => {
    const cached = apiCache.get(apiPath);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return resolve({ status: cached.status, body: cached.body, cached: true });
    }
    const headers = {
      'User-Agent': 'github-history-viz',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

    const req = https.request(
      { hostname: 'api.github.com', path: apiPath, method: 'GET', headers },
      (resp) => {
        let data = '';
        resp.on('data', (c) => { data += c; });
        resp.on('end', () => {
          const status = resp.statusCode || 0;
          let body;
          try { body = data ? JSON.parse(data) : null; } catch { body = data; }
          const result = {
            status,
            body,
            rateRemaining: resp.headers['x-ratelimit-remaining'],
            rateReset: resp.headers['x-ratelimit-reset'],
          };
          if (status === 200) apiCache.set(apiPath, { at: Date.now(), status, body });
          resolve(result);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('GitHub API request timed out')));
    req.end();
  });
}

// Some stats endpoints return 202 while GitHub computes them. Poll briefly.
async function ghStats(apiPath, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await ghRequest(apiPath);
    if (r.status !== 202) return r;
    apiCache.delete(apiPath); // 202 has an empty/placeholder body; don't cache it
    await new Promise((res) => setTimeout(res, 1200));
  }
  return ghRequest(apiPath);
}

// ---------------------------------------------------------------------------
// Aggregate everything the frontend needs for one repo
// ---------------------------------------------------------------------------

function parseRepoArg(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  s = s.replace(/^\/+|\/+$/g, '');
  const m = s.match(/^([\w.-]+)\/([\w.-]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

async function buildRepoData(owner, repo) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const meta = await ghRequest(base);
  if (meta.status === 404) {
    const e = new Error('Repository not found (it may be private or misspelled).');
    e.status = 404;
    throw e;
  }
  if (meta.status === 403) {
    const reset = meta.rateReset ? new Date(Number(meta.rateReset) * 1000).toLocaleTimeString() : 'soon';
    const e = new Error(`GitHub rate limit reached. Resets at ${reset}. Set GITHUB_TOKEN to raise the limit.`);
    e.status = 403;
    throw e;
  }
  if (meta.status !== 200) {
    const e = new Error(`GitHub returned ${meta.status}` + (meta.body && meta.body.message ? `: ${meta.body.message}` : ''));
    e.status = meta.status;
    throw e;
  }

  // Fetch the rest in parallel. Stats endpoints may lag (202); tolerate failure.
  const [languages, contributors, commitActivity, punchCard, recentCommits, participation] =
    await Promise.all([
      ghRequest(`${base}/languages`).catch(() => null),
      ghRequest(`${base}/contributors?per_page=100&anon=0`).catch(() => null),
      ghStats(`${base}/stats/commit_activity`).catch(() => null),
      ghStats(`${base}/stats/punch_card`).catch(() => null),
      ghRequest(`${base}/commits?per_page=30`).catch(() => null),
      ghStats(`${base}/stats/participation`).catch(() => null),
    ]);

  const m = meta.body;
  return {
    rateRemaining: meta.rateRemaining,
    tokenInUse: Boolean(TOKEN),
    repo: {
      fullName: m.full_name,
      description: m.description,
      htmlUrl: m.html_url,
      homepage: m.homepage,
      stars: m.stargazers_count,
      forks: m.forks_count,
      watchers: m.subscribers_count,
      openIssues: m.open_issues_count,
      language: m.language,
      license: m.license && m.license.spdx_id,
      defaultBranch: m.default_branch,
      size: m.size,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
      pushedAt: m.pushed_at,
      archived: m.archived,
      topics: m.topics || [],
    },
    languages: (languages && languages.status === 200 && languages.body) || {},
    contributors: normalizeContributors(contributors),
    commitActivity: (commitActivity && commitActivity.status === 200 && Array.isArray(commitActivity.body))
      ? commitActivity.body : [],
    punchCard: (punchCard && punchCard.status === 200 && Array.isArray(punchCard.body))
      ? punchCard.body : [],
    participation: (participation && participation.status === 200 && participation.body) || null,
    recentCommits: normalizeCommits(recentCommits),
  };
}

function normalizeContributors(r) {
  if (!r || r.status !== 200 || !Array.isArray(r.body)) return [];
  return r.body.slice(0, 25).map((c) => ({
    login: c.login || '(anonymous)',
    avatar: c.avatar_url || '',
    url: c.html_url || '',
    contributions: c.contributions || 0,
  }));
}

function normalizeCommits(r) {
  if (!r || r.status !== 200 || !Array.isArray(r.body)) return [];
  return r.body.map((c) => {
    const commit = c.commit || {};
    const author = commit.author || {};
    return {
      sha: c.sha ? c.sha.slice(0, 7) : '',
      url: c.html_url || '',
      message: (commit.message || '').split('\n')[0],
      authorName: author.name || (c.author && c.author.login) || 'unknown',
      authorLogin: c.author && c.author.login,
      avatar: (c.author && c.author.avatar_url) || '',
      date: author.date || null,
    };
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const fp = path.join(PUBLIC_DIR, rel);
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(fp);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);

  if (url.pathname === '/api/repo') {
    const parsed = parseRepoArg(url.searchParams.get('repo'));
    if (!parsed) return sendJSON(res, 400, { error: 'Provide a repo as "owner/name" or a github.com URL.' });
    try {
      const data = await buildRepoData(parsed.owner, parsed.repo);
      return sendJSON(res, 200, data);
    } catch (e) {
      return sendJSON(res, e.status || 500, { error: e.message });
    }
  }

  serveStatic(res, url.pathname);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT=<other> to run elsewhere.`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`GitHub History → http://${HOST}:${PORT}`);
  console.log(TOKEN ? 'Using GITHUB_TOKEN (5000 req/hour).' : 'No token set — limited to 60 req/hour. Set GITHUB_TOKEN to raise it.');
});
