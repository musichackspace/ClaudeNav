#!/usr/bin/env node
'use strict';

/*
 * ClaudeNav — a local navigator for your Claude Code sessions.
 *
 * Reads ~/.claude/projects, groups sessions by project, marks which ones are
 * backed by a currently-running `claude` terminal, and can open a terminal to
 * resume a session or start a new one.
 *
 * No dependencies. Binds to 127.0.0.1 only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { HOST, PORT, PROJECTS_DIR, PUBLIC_DIR, UPLOADS_DIR } = require('./lib/config');
const { claudeSetupHelp } = require('./lib/bins');
const { findSessionFile, parseTranscript } = require('./lib/transcripts');
const { openTerminal, openUrl } = require('./lib/live');
const { setArchived, setSessionMode, setSessionModel } = require('./lib/state');
const { modelsInfo, usageInfo } = require('./lib/account');
const { chatCancel, chatQueues, chatTurn, lastChatError, lastChatErrorKind, livePartial, reconcileOnBoot, runningChats } = require('./lib/turns');
const { selfUpdate, versionInfo } = require('./lib/version');
const { buildData } = require('./lib/sessions');
const { browseDir, gitCommit, gitInit, gitPush, gitWorktreeAdd, housekeeping, repoHistory } = require('./lib/repos');
const { createSite, enablePages, ghListRepos, ghStatus, gitWorktreeMerge, importSite, publishSite, siteStatus } = require('./lib/sites');
const { assessSession, closeSession, handoverSession } = require('./lib/wrap');

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const fp = path.join(PUBLIC_DIR, rel);
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(fp);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    // No caching: this is a single-file local app that redeploys on every commit,
    // and a stale cached index.html would silently keep running old JS long after
    // a relaunch. `no-store` guarantees a reload always fetches the current build.
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

function readBody(req, cb, maxBytes = 1e6) {
  let data = '';
  req.on('data', c => { data += c; if (data.length > maxBytes) req.destroy(); });
  req.on('end', () => { try { cb(null, data ? JSON.parse(data) : {}); } catch (e) { cb(e); } });
}

// Cross-site request forgery guard. The server binds to loopback, but any web
// page you visit can still fire a no-cors `fetch()` at 127.0.0.1:PORT — the
// response is opaque to it, yet the side effect (a headless turn under
// --dangerously-skip-permissions, a publish, a terminal window) still happens.
// Three checks, in order of what they defeat:
//   1. Host must be loopback — stops DNS rebinding (attacker.com → 127.0.0.1
//      would otherwise be "same-origin" from the browser's point of view).
//   2. Origin (when sent) must be this server; `Sec-Fetch-Site` (when sent) must
//      be same-origin/none — rejects the cross-site POST outright.
//   3. Mutating requests must carry `X-ClaudeNav`. A custom header makes a
//      cross-site request non-simple, so the browser preflights it with OPTIONS;
//      we answer that without CORS headers and the real request is never sent.
// GETs are already unreadable cross-site (no Access-Control-Allow-Origin), so
// only Host applies to them. The UI adds the header via a `fetch` wrapper; curl
// callers add `-H 'X-ClaudeNav: 1'`.

// Cross-site request forgery guard. The server binds to loopback, but any web
// page you visit can still fire a no-cors `fetch()` at 127.0.0.1:PORT — the
// response is opaque to it, yet the side effect (a headless turn under
// --dangerously-skip-permissions, a publish, a terminal window) still happens.
// Three checks, in order of what they defeat:
//   1. Host must be loopback — stops DNS rebinding (attacker.com → 127.0.0.1
//      would otherwise be "same-origin" from the browser's point of view).
//   2. Origin (when sent) must be this server; `Sec-Fetch-Site` (when sent) must
//      be same-origin/none — rejects the cross-site POST outright.
//   3. Mutating requests must carry `X-ClaudeNav`. A custom header makes a
//      cross-site request non-simple, so the browser preflights it with OPTIONS;
//      we answer that without CORS headers and the real request is never sent.
// GETs are already unreadable cross-site (no Access-Control-Allow-Origin), so
// only Host applies to them. The UI adds the header via a `fetch` wrapper; curl
// callers add `-H 'X-ClaudeNav: 1'`.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
function isLocalHostHeader(h) {
  if (!h) return false;
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(h);
  if (!m) return false;
  // The port we're actually bound to (tests listen on an ephemeral one), else PORT.
  const bound = (typeof server !== 'undefined' && server.listening && server.address().port) || PORT;
  return LOOPBACK_HOSTS.has(m[1].toLowerCase()) && (!m[2] || Number(m[2]) === bound);
}
function csrfReject(req) {
  if (!isLocalHostHeader(req.headers.host)) return 'bad Host header (not loopback)';
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let ok = false;
    try { const o = new URL(origin); ok = o.protocol === 'http:' && isLocalHostHeader(o.host); } catch {}
    if (!ok) return 'cross-site request refused (Origin)';
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site request refused (Sec-Fetch-Site)';
  if (req.method !== 'GET' && req.method !== 'HEAD' && !req.headers['x-claudenav']) {
    return 'missing X-ClaudeNav header (mutating requests must come from the ClaudeNav UI)';
  }
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  {
    const why = csrfReject(req);
    if (why) {
      console.error(`[claudenav] refused ${req.method} ${url.pathname}: ${why}` +
        (req.headers.origin ? ` origin=${req.headers.origin}` : '') + ` host=${req.headers.host}`);
      return sendJSON(res, 403, { error: why });
    }
  }

  if (url.pathname === '/api/sessions') {
    try {
      const data = buildData();
      try { data.version = versionInfo(); } catch {}
      try { data.usage = usageInfo(); } catch {}
      try { data.models = modelsInfo(); } catch {}
      return sendJSON(res, 200, data);
    }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/version') {
    try { return sendJSON(res, 200, versionInfo()); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/usage') {
    try { return sendJSON(res, 200, usageInfo()); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/models') {
    try { return sendJSON(res, 200, modelsInfo()); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/update' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      selfUpdate({ pull: body.pull !== false }, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/transcript') {
    const id = url.searchParams.get('session') || '';
    const after = Number(url.searchParams.get('after')) || 0;
    const fp = findSessionFile(id);
    if (!fp) return sendJSON(res, 404, { error: 'session not found' });
    try {
      const all = parseTranscript(fp);
      return sendJSON(res, 200, { total: all.length, messages: all.slice(after) });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      chatTurn(body.session, body.text, body.images, body.cwd, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    }, 80 * 1024 * 1024); // allow pasted images
  }

  if (url.pathname === '/api/session-mode' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      try {
        setSessionMode(body.session, body.mode);
        return sendJSON(res, 200, { ok: true, session: body.session, mode: body.mode });
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    });
  }

  if (url.pathname === '/api/session-model' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      try {
        setSessionModel(body.session, body.model);
        return sendJSON(res, 200, { ok: true, session: body.session, model: body.model });
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    });
  }

  if (url.pathname === '/api/archive' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      try {
        const archived = body.archived !== false; // default true; pass false to unarchive
        setArchived(body.session, archived);
        return sendJSON(res, 200, { ok: true, session: body.session, archived });
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    });
  }

  if (url.pathname.startsWith('/uploads/')) {
    const name = path.basename(url.pathname);
    const fp = path.join(UPLOADS_DIR, name);
    if (!fp.startsWith(UPLOADS_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    return fs.readFile(fp, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(fp).slice(1).toLowerCase();
      const types = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', pdf: 'application/pdf',
        txt: 'text/plain', md: 'text/plain', csv: 'text/plain', log: 'text/plain',
        json: 'application/json', xml: 'application/xml', html: 'text/plain',
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
      res.end(buf);
    });
  }

  if (url.pathname === '/api/housekeeping') {
    try { return sendJSON(res, 200, housekeeping()); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/repo-history') {
    const cwd = url.searchParams.get('cwd') || '';
    try { return sendJSON(res, 200, repoHistory(cwd)); }
    catch (e) { return sendJSON(res, e.status || 500, { error: e.message }); }
  }

  if (url.pathname === '/api/commit' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      gitCommit(body.cwd, body.message, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/push' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      gitPush(body.cwd, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/worktree' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      gitWorktreeAdd(body.cwd, body.name, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/worktree-merge' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      gitWorktreeMerge(body.path, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/browse') {
    try { return sendJSON(res, 200, browseDir(url.searchParams.get('path') || '')); }
    catch (e) { return sendJSON(res, e.status || 500, { error: e.message }); }
  }

  if (url.pathname === '/api/mkdir' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      try { return sendJSON(res, 200, { ok: true, ...makeDir(body.parent, body.name) }); }
      catch (e) { return sendJSON(res, e.status || 500, { error: e.message }); }
    });
  }

  if (url.pathname === '/api/git-init' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      gitInit(body.cwd, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/gh-status') {
    try { return sendJSON(res, 200, ghStatus()); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/site-create' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      createSite(body, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/gh-repos') {
    return ghListRepos((e, info) => {
      if (e) return sendJSON(res, 400, { error: e.message });
      sendJSON(res, 200, info);
    });
  }

  if (url.pathname === '/api/site-import' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      importSite(body, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/site-enable-pages' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      enablePages(body, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/site-status') {
    try { return sendJSON(res, 200, siteStatus(url.searchParams.get('cwd') || '')); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/publish' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      publishSite(body, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/assess' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      assessSession(body.session, (e, verdict) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...verdict });
      });
    });
  }

  if (url.pathname === '/api/handover' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      handoverSession(body.session, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/close' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      closeSession(body.session, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/setup-help') {
    // Platform-aware steps to fix a missing/unspawnable `claude` binary. Powers
    // the "Fix setup" help dialog the UI offers on a needsSetup chat error.
    return sendJSON(res, 200, claudeSetupHelp());
  }

  if (url.pathname === '/api/chat-status') {
    const id = url.searchParams.get('session') || '';
    const queued = (chatQueues.get(id) || []).length;
    const lp = livePartial.get(id);
    return sendJSON(res, 200, {
      running: runningChats.has(id) || queued > 0,
      queued,
      error: lastChatError.get(id) || null,
      // Structured flags so the UI can react (offer "Re-login", soften the
      // usage-limit toast) without pattern-matching the human-readable text.
      needsLogin: lastChatErrorKind.get(id) === 'auth',
      usageLimited: lastChatErrorKind.get(id) === 'usage',
      needsSetup: lastChatErrorKind.get(id) === 'missing',
      // A turn cut short by a server restart — its progress was saved and it can
      // be continued; the UI shows this as a gentle notice, not a crash.
      interrupted: lastChatErrorKind.get(id) === 'interrupted',
      partial: lp ? { text: lp.text, tools: lp.tools, ask: lp.ask || null } : null,
    });
  }

  if (url.pathname === '/api/chat-cancel' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      chatCancel(body.session, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/open-url' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      openUrl(body.url, (e, info) => {
        if (e) return sendJSON(res, 400, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  if (url.pathname === '/api/open' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad json' });
      openTerminal(body, (e, info) => {
        if (e) return sendJSON(res, 500, { error: e.message });
        sendJSON(res, 200, { ok: true, ...info });
      });
    });
  }

  serveStatic(res, url.pathname);
});

// A port clash is often transient — another local node server (or our own
// previous process mid-restart) briefly holds 4317. Retrying beats exiting:
// exit(1) counts against run-server.sh's 3-crashes-in-60s cap, so a brief
// overlap could otherwise knock ClaudeNav out *permanently*. Retry with backoff
// for ~30s; only give up if the port stays occupied (a real second instance).

// A port clash is often transient — another local node server (or our own
// previous process mid-restart) briefly holds 4317. Retrying beats exiting:
// exit(1) counts against run-server.sh's 3-crashes-in-60s cap, so a brief
// overlap could otherwise knock ClaudeNav out *permanently*. Retry with backoff
// for ~30s; only give up if the port stays occupied (a real second instance).
const BIND_RETRIES = 10;
const BIND_RETRY_MS = 3000;
let bindAttempts = 0;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    bindAttempts++;
    if (bindAttempts <= BIND_RETRIES) {
      console.error(`Port ${PORT} is busy (attempt ${bindAttempts}/${BIND_RETRIES}) — `
        + `another local server may be using it; retrying in ${BIND_RETRY_MS / 1000}s…`);
      setTimeout(() => server.listen(PORT, HOST), BIND_RETRY_MS);
      return;
    }
    console.error(`Port ${PORT} is still in use after ${BIND_RETRIES} retries — `
      + `ClaudeNav may already be running.`);
    console.error(`Open http://${HOST}:${PORT} or set PORT=<other> to run a second instance.`);
    process.exit(1);
  }
  throw e;
});

// Only bind when run directly. `require('./server')` (tests) gets the helpers
// below without starting a server or touching the network.

// Only bind when run directly. `require('./server')` (tests) gets the helpers
// below without starting a server or touching the network.
if (require.main === module) server.listen(PORT, HOST, () => {
  if (bindAttempts) console.log(`Port ${PORT} freed up after ${bindAttempts} retr${bindAttempts > 1 ? 'ies' : 'y'}.`);
  console.log(`ClaudeNav running at http://${HOST}:${PORT}`);
  console.log(`Reading sessions from ${PROJECTS_DIR}`);
  // Rediscover any turns/queue a previous process left mid-flight, so a restart
  // is invisible: live turns are reattached, ones that died in the gap are
  // finalized from their logs. Best-effort — never let it stop the server.
  try { reconcileOnBoot(); } catch (e) { console.error('[claudenav] reconcile on boot failed:', e && e.message); }
});

// Re-export the helpers tests reach for (node --test): tests require('../server.js').
module.exports = {
  server, PORT, HOST, csrfReject, isLocalHostHeader, readBody, sendJSON,
  ...require('./lib/config'),
  ...require('./lib/gitutil'),
  ...require('./lib/bins'),
  ...require('./lib/transcripts'),
  ...require('./lib/live'),
  ...require('./lib/state'),
  ...require('./lib/account'),
  ...require('./lib/turns'),
  ...require('./lib/version'),
  ...require('./lib/sessions'),
  ...require('./lib/repos'),
  ...require('./lib/sites'),
  ...require('./lib/wrap'),
};
