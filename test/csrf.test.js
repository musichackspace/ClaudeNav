'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tmpHome, loadServer } = require('./helpers');

tmpHome();
const { csrfReject, isLocalHostHeader, server, PORT } = loadServer();

const req = (method, headers = {}) => ({ method, headers });
const ok = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'x-claudenav': '1' };

test('isLocalHostHeader accepts loopback on our port only', () => {
  assert.equal(isLocalHostHeader(`127.0.0.1:${PORT}`), true);
  assert.equal(isLocalHostHeader(`localhost:${PORT}`), true);
  assert.equal(isLocalHostHeader(`[::1]:${PORT}`), true);
  assert.equal(isLocalHostHeader(`attacker.com:${PORT}`), false);
  assert.equal(isLocalHostHeader(`127.0.0.1:${PORT + 1}`), false);
  assert.equal(isLocalHostHeader(''), false);
  assert.equal(isLocalHostHeader(undefined), false);
});

test('same-origin GET and POST pass', () => {
  assert.equal(csrfReject(req('GET', { host: ok.host })), null);
  assert.equal(csrfReject(req('POST', ok)), null);
  assert.equal(csrfReject(req('POST', { ...ok, 'sec-fetch-site': 'same-origin' })), null);
  assert.equal(csrfReject(req('POST', { ...ok, 'sec-fetch-site': 'none' })), null);
});

test('DNS-rebinding Host is refused even on GET', () => {
  assert.match(csrfReject(req('GET', { host: `attacker.com:${PORT}` })), /Host/);
});

test('cross-site Origin is refused', () => {
  assert.match(csrfReject(req('POST', { ...ok, origin: 'https://evil.example' })), /Origin/);
  assert.match(csrfReject(req('POST', { ...ok, origin: 'null' })), /Origin/);
  assert.match(csrfReject(req('GET', { host: ok.host, origin: 'https://evil.example' })), /Origin/);
});

test('cross-site Sec-Fetch-Site is refused', () => {
  assert.match(csrfReject(req('POST', { ...ok, 'sec-fetch-site': 'cross-site' })), /Sec-Fetch-Site/);
});

test('mutating request without X-ClaudeNav is refused; GET without it passes', () => {
  const h = { host: ok.host, origin: ok.origin };
  assert.match(csrfReject(req('POST', h)), /X-ClaudeNav/);
  assert.match(csrfReject(req('DELETE', h)), /X-ClaudeNav/);
  assert.equal(csrfReject(req('GET', h)), null);
  assert.equal(csrfReject(req('HEAD', h)), null);
});

test('over HTTP: preflight carries no CORS grant, attacks get 403, UI passes', async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const pre = await fetch(`${base}/api/chat`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), null);

    const evil = await fetch(`${base}/api/chat`, { method: 'POST', body: '{}',
      headers: { Host: `127.0.0.1:${port}`, Origin: 'https://evil.example', 'Content-Type': 'text/plain' } });
    assert.equal(evil.status, 403);

    const noHeader = await fetch(`${base}/api/archive`, { method: 'POST', body: '{}',
      headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } });
    assert.equal(noHeader.status, 403);

    const ui = await fetch(`${base}/api/archive`, { method: 'POST', body: '{}',
      headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-ClaudeNav': '1' } });
    assert.notEqual(ui.status, 403); // past the guard (400: no session id)

    const get = await fetch(`${base}/api/version`);
    assert.equal(get.status, 200);
  } finally { await new Promise(r => server.close(r)); }
});
