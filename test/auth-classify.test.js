'use strict';
// Run with: npm test   (node --test, no dependencies)
//
// Every "real" fixture below is copied from actual output: the stream-json of a
// `claude -p` run made with a deliberately bogus CLAUDE_CODE_OAUTH_TOKEN, and
// transcript lines from ~/.claude/projects where a live OAuth session expired
// mid-work. The negative cases matter as much as the positive ones — assistant
// prose quotes these phrases constantly and must never trip the classifier.

const test = require('node:test');
const assert = require('node:assert');
const {
  classifyAuthFailure, classifyAuthStderr, transcriptErrorKind, isFatalAuthText,
} = require('../auth-classify');

// --- real strings the CLI actually emits ------------------------------------

const REAL_MESSAGES = [
  'Failed to authenticate: OAuth session expired and could not be refreshed',
  'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
  'Login expired · Please run /login',
  'OAuth token revoked',
  'OAuth token has expired',
  'Not logged in',
  '401 Invalid authentication credentials',
];

// A synthetic assistant record, exactly as the CLI writes it (fields trimmed).
function syntheticAssistant(text, extra = {}) {
  return {
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'authentication_failed',
    message: {
      id: 'msg_x', model: '<synthetic>', role: 'assistant', type: 'message',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text }],
    },
    ...extra,
  };
}

function resultLine(text, extra = {}) {
  return { type: 'result', subtype: 'success', is_error: true, result: text, ...extra };
}

// --- the text matcher -------------------------------------------------------

test('every real auth-failure message is recognised as fatal', () => {
  for (const m of REAL_MESSAGES) {
    assert.ok(isFatalAuthText(m), `should match: ${m}`);
  }
});

test('ordinary prose that merely mentions auth is not fatal', () => {
  const innocent = [
    'I updated the login form and the auth middleware.',
    'The user is not logged out, so the session cookie persists.',
    'Add a test for the case where authentication succeeds.',
    'This endpoint returns 401 when the header is missing.',
    'expiresAt is stored in milliseconds since the epoch.',
  ];
  for (const m of innocent) assert.ok(!isFatalAuthText(m), `should NOT match: ${m}`);
});

// --- result lines -----------------------------------------------------------

test('an is_error result carrying an auth failure is classified', () => {
  for (const m of REAL_MESSAGES) {
    const got = classifyAuthFailure(resultLine(m));
    assert.ok(got, `should classify: ${m}`);
    assert.strictEqual(got.carrier, 'result');
    assert.strictEqual(got.reason, 'authentication_failed');
  }
});

test('the exit-0 case is caught: subtype success, is_error false, terminal_reason api_error', () => {
  // This is the exact shape that used to slip through — the process exits
  // cleanly and hands back the failure as its result string.
  const line = {
    type: 'result', subtype: 'success', is_error: false,
    terminal_reason: 'api_error', num_turns: 1,
    result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
  };
  const got = classifyAuthFailure(line);
  assert.ok(got, 'exit-0 auth failure must be classified');
  assert.match(got.message, /OAuth session expired/);
});

test('a successful result that merely echoes auth prose is NOT classified', () => {
  // The `result` field of a clean run just repeats the assistant's final text.
  // Sessions about auth bugs quote these strings verbatim.
  const line = {
    type: 'result', subtype: 'success', is_error: false,
    result: 'I added a classifier for "Failed to authenticate" and "Login expired". '
      + 'It also handles "please run /login".',
  };
  assert.strictEqual(classifyAuthFailure(line), null);
});

test('an is_error result from a non-auth failure is not misread as auth', () => {
  assert.strictEqual(classifyAuthFailure(resultLine('Error: usage limit reached|1788642769')), null);
  assert.strictEqual(classifyAuthFailure(resultLine('Error: ENOSPC no space left on device')), null);
});

// --- synthetic assistant messages -------------------------------------------

test('the real transcript record is classified, not treated as assistant text', () => {
  const line = syntheticAssistant('Failed to authenticate: OAuth session expired and could not be refreshed');
  const got = classifyAuthFailure(line);
  assert.ok(got);
  assert.strictEqual(got.carrier, 'assistant');
  assert.strictEqual(got.message, 'Failed to authenticate: OAuth session expired and could not be refreshed');
});

test('a synthetic message is recognised by model:<synthetic> alone', () => {
  // Older CLI builds set neither isApiErrorMessage nor error.
  const line = {
    type: 'assistant',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Login expired · Please run /login' }] },
  };
  assert.ok(classifyAuthFailure(line));
});

test('a structured error code is decisive even with unfamiliar wording', () => {
  const line = syntheticAssistant('Something went sideways with your credentials.');
  const got = classifyAuthFailure(line);
  assert.ok(got, 'error: authentication_failed alone must be enough');
  assert.strictEqual(got.reason, 'authentication_failed');
});

test('a REAL assistant message quoting the error is NOT classified', () => {
  // Same text, but produced by the model — no synthetic marker. This is the
  // false positive that makes naive raw-stream scanning unusable.
  const line = {
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8', role: 'assistant',
      content: [{ type: 'text', text: 'The CLI prints "Failed to authenticate: OAuth session expired and could not be refreshed" here.' }],
    },
  };
  assert.strictEqual(classifyAuthFailure(line), null);
});

// --- the mid-response case --------------------------------------------------

test('auth failure appended AFTER real output is still caught (result)', () => {
  const line = resultLine(
    'I refactored the parser and added two tests.\n'
    + 'Both pass locally.\n'
    + 'Failed to authenticate: OAuth session expired and could not be refreshed',
    { is_error: false, terminal_reason: 'api_error' });
  const got = classifyAuthFailure(line);
  assert.ok(got, 'mid-response auth failure must be caught');
  // The banner should name the failure, not the unrelated work that preceded it.
  assert.strictEqual(got.message, 'Failed to authenticate: OAuth session expired and could not be refreshed');
});

test('auth failure in one block of a multi-block synthetic message is caught', () => {
  const line = {
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      model: '<synthetic>', role: 'assistant',
      content: [
        { type: 'text', text: 'Partial results were saved to disk.' },
        { type: 'text', text: 'Login expired · Please run /login' },
      ],
    },
  };
  const got = classifyAuthFailure(line);
  assert.ok(got);
  assert.strictEqual(got.message, 'Login expired · Please run /login');
});

test('auth failure mid-stderr is caught and the banner quotes the right line', () => {
  const tail = 'node:internal/process warning: something noisy\n'
    + 'Failed to authenticate: OAuth session expired and could not be refreshed\n'
    + 'at Object.<anonymous> (/x/y.js:1:1)';
  const got = classifyAuthStderr(tail);
  assert.ok(got);
  assert.strictEqual(got.carrier, 'stderr');
  assert.strictEqual(got.message, 'Failed to authenticate: OAuth session expired and could not be refreshed');
});

// --- non-signal carriers ----------------------------------------------------

test('system, user and non-JSON lines are never signals', () => {
  const notSignals = [
    '{"type":"system","subtype":"init","tools":["Bash"]}',
    // A retry may still succeed — it is not terminal on its own.
    '{"type":"system","subtype":"api_retry","attempt":1,"error_status":401,"error":"authentication_failed"}',
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"401 Invalid authentication credentials"}]}}',
    'Failed to authenticate: OAuth session expired and could not be refreshed', // bare, non-JSON
    '',
    '   ',
    'not json at all',
  ];
  for (const l of notSignals) {
    assert.strictEqual(classifyAuthFailure(l), null, `should NOT classify: ${l.slice(0, 60)}`);
  }
});

test('classifies from a raw JSON string, matching how pumpLogs reads the log', () => {
  const raw = JSON.stringify(syntheticAssistant('Failed to authenticate: OAuth session expired and could not be refreshed'));
  assert.ok(classifyAuthFailure(raw));
});

test('malformed input never throws', () => {
  for (const bad of [null, undefined, 42, [], {}, { type: 'result' }, { type: 'assistant' }]) {
    assert.doesNotThrow(() => classifyAuthFailure(bad));
  }
});

// --- transcript rendering ---------------------------------------------------

test('transcriptErrorKind flags the auth record so it is not rendered as Claude prose', () => {
  assert.strictEqual(
    transcriptErrorKind(syntheticAssistant('Failed to authenticate: OAuth session expired and could not be refreshed')),
    'auth');
});

test('transcriptErrorKind reports non-auth CLI errors as api, and leaves real messages alone', () => {
  const apiErr = {
    type: 'assistant', isApiErrorMessage: true,
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500 internal server error' }] },
  };
  assert.strictEqual(transcriptErrorKind(apiErr), 'api');

  const real = {
    type: 'assistant',
    message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired' }] },
  };
  assert.strictEqual(transcriptErrorKind(real), null);
  assert.strictEqual(transcriptErrorKind({ type: 'user' }), null);
});
