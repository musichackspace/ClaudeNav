'use strict';
// Anthropic account data: usage bars and the pickable model list (OAuth token, background-refreshed).
// Part of ClaudeNav's server (see server.js for the routes).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Model the next headless turn runs under. ClaudeNav lets you pick one per
// session; the exact model id is passed through to the CLI as --model <id>.
// 'default' means "no override" — inherit whatever the CLI/account default is.
// The pickable list is fetched from the Anthropic Models API once a day (see
// maybeFetchModels) so it tracks new releases without a code change; this
// built-in list is the fallback when the API is unreachable. Order = newest
// first (matches the API's ordering); the picker prepends 'default'.
const DEFAULT_MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
// A model id is anything in the safe id charset; 'default' clears the override.
// We don't gate on the fetched list — a saved/picked id may name a model the
// list hasn't caught up to, and the CLI itself rejects a truly bogus id.
// Map a full model id from a transcript to a known model id. Transcript ids may
// carry a date suffix (e.g. claude-haiku-4-5-20251001), so match by prefix
// against the current list. Returns the canonical id, or null if unknown.
function modelChoice(id) {
  if (!id) return null;
  for (const m of modelsState.list) if (id.startsWith(m.id)) return m.id;
  return null;
}

// User-chosen model overrides, sessionId -> model id. Persisted so a chosen
// model survives a restart. When unset, a turn inherits the CLI default.

// ---------------------------------------------------------------------------
// Usage limits — mirrors Claude Code's /usage menu (current session + weekly).
// Same source the CLI uses: GET /api/oauth/usage with the stored OAuth token.
// ---------------------------------------------------------------------------

// The OAuth access token lives in the macOS Keychain (Claude Code-credentials)
// or, on other platforms, in ~/.claude/.credentials.json.
function readOAuthToken() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    if (tok) return tok;
  } catch {}
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8' });
      const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
      if (tok) return tok;
    } catch {}
  }
  return null;
}

// Background-refreshed cache of the usage endpoint (networked; don't block).
const usageState = { at: 0, running: false, data: null, error: null };
const USAGE_TTL = 60 * 1000;
function maybeFetchUsage() {
  const now = Date.now();
  if (usageState.running || (usageState.at && now - usageState.at < USAGE_TTL)) return;
  const token = readOAuthToken();
  if (!token) { usageState = { ...usageState, at: now, error: 'no-token' }; return; }
  usageState.running = true;
  const req = https.request('https://api.anthropic.com/api/oauth/usage', {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    timeout: 15000,
  }, (resp) => {
    let body = '';
    resp.on('data', (c) => { body += c; });
    resp.on('end', () => {
      usageState.running = false;
      usageState.at = Date.now();
      if (resp.statusCode === 200) {
        try { usageState.data = summarizeUsage(JSON.parse(body)); usageState.error = null; }
        catch (e) { usageState.error = 'parse'; }
      } else {
        usageState.error = `http-${resp.statusCode}`;
      }
    });
  });
  req.on('error', () => { usageState.running = false; usageState.at = Date.now(); usageState.error = 'network'; });
  req.on('timeout', () => { req.destroy(); });
  req.end();
}

// Reduce the raw payload to the three bars the /usage menu shows.
function summarizeUsage(raw) {
  const limits = Array.isArray(raw?.limits) ? raw.limits : [];
  const pick = (kind) => limits.find((l) => l.kind === kind);
  const session = pick('session');
  const weeklyAll = pick('weekly_all');
  const weeklyScoped = pick('weekly_scoped');
  const bar = (l, label) => l ? {
    label,
    percent: Math.round(l.percent),
    severity: l.severity || 'normal',
    resets_at: l.resets_at || null,
  } : null;
  return {
    session: bar(session, 'Current session'),
    weeklyAll: bar(weeklyAll, 'All models'),
    weeklyScoped: weeklyScoped
      ? { ...bar(weeklyScoped, weeklyScoped.scope?.model?.display_name || 'Scoped'),
          model: weeklyScoped.scope?.model?.display_name || null }
      : null,
  };
}

function usageInfo() {
  maybeFetchUsage();
  return { ...usageState.data ? usageState.data : {}, error: usageState.error, at: usageState.at };
}

// ---------------------------------------------------------------------------
// Available models — fetched from the Anthropic Models API once a day so the
// per-session picker tracks new releases (and drops retired ones) without a
// code change. Uses the same stored OAuth token as the usage fetch. Keeps the
// last good list (seeded from DEFAULT_MODELS) on failure and retries sooner.
// ---------------------------------------------------------------------------
const modelsState = { at: 0, running: false, list: DEFAULT_MODELS, source: 'default', error: null };
const MODELS_TTL = 24 * 60 * 60 * 1000;     // refresh once a day on success
const MODELS_RETRY = 30 * 60 * 1000;        // but retry sooner after a failure
// "Claude Opus 4.8" -> "Opus 4.8"; fall back to the bare id.
// "Claude Opus 4.8" -> "Opus 4.8"; fall back to the bare id.
function shortModelLabel(displayName, id) {
  return displayName ? displayName.replace(/^Claude\s+/i, '') : id;
}
function parseModelsList(raw) {
  const data = Array.isArray(raw?.data) ? raw.data : [];
  return data
    .filter((m) => typeof m?.id === 'string' && m.id.startsWith('claude-'))
    .map((m) => ({ id: m.id, label: shortModelLabel(m.display_name, m.id) }));
}
function maybeFetchModels() {
  const now = Date.now();
  const ttl = modelsState.error ? MODELS_RETRY : MODELS_TTL;
  if (modelsState.running || (modelsState.at && now - modelsState.at < ttl)) return;
  const token = readOAuthToken();
  if (!token) { modelsState = { ...modelsState, at: now, error: 'no-token' }; return; }
  modelsState.running = true;
  const req = https.request('https://api.anthropic.com/v1/models?limit=100', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    timeout: 15000,
  }, (resp) => {
    let body = '';
    resp.on('data', (c) => { body += c; });
    resp.on('end', () => {
      modelsState.running = false;
      modelsState.at = Date.now();
      if (resp.statusCode === 200) {
        try {
          const list = parseModelsList(JSON.parse(body));
          // Only adopt a non-empty list; otherwise keep the last good one.
          if (list.length) { modelsState.list = list; modelsState.source = 'api'; modelsState.error = null; }
          else modelsState.error = 'empty';
        } catch { modelsState.error = 'parse'; }
      } else {
        modelsState.error = `http-${resp.statusCode}`;
      }
    });
  });
  req.on('error', () => { modelsState.running = false; modelsState.at = Date.now(); modelsState.error = 'network'; });
  req.on('timeout', () => { req.destroy(); });
  req.end();
}

// The picker payload: 'default' first, then the current model list. Carries
// source/error/at so the UI can tell live-from-API apart from the fallback.
function modelsInfo() {
  maybeFetchModels();
  return {
    models: [{ id: 'default', label: 'Default' }, ...modelsState.list],
    source: modelsState.source,
    error: modelsState.error,
    at: modelsState.at,
  };
}

module.exports = { DEFAULT_MODELS, modelChoice, readOAuthToken, usageState, USAGE_TTL, maybeFetchUsage, summarizeUsage, usageInfo, modelsState, MODELS_TTL, MODELS_RETRY, shortModelLabel, parseModelsList, maybeFetchModels, modelsInfo };
