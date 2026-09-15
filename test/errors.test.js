'use strict';
// The auth/usage detectors must fire on an error signal ONLY — never on
// streamed content that merely discusses limits or /login. Earlier versions
// scanned the raw stream and cried wolf; these tests pin the precise rule.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tmpHome, loadServer } = require('./helpers');

tmpHome();
const { errorSignalText, usageErrorMessage, formatResetTime, AUTH_ERR_RE, USAGE_ERR_RE } = loadServer();

const J = o => JSON.stringify(o);
const talk = 'I hit "usage limit reached" yesterday; the docs say please run /login after API Error: 401 or 429.';

test('assistant prose quoting limits is not a signal', () => {
  assert.equal(errorSignalText(J({ type: 'assistant', message: { content: [{ type: 'text', text: talk }] } })), '');
});
test('tool_result output quoting limits is not a signal', () => {
  assert.equal(errorSignalText(J({ type: 'user', message: { content: [{ type: 'tool_result', content: talk }] } })), '');
});
test('a SUCCESSFUL result echoing the assistant text is not a signal', () => {
  assert.equal(errorSignalText(J({ type: 'result', is_error: false, result: talk })), '');
  assert.equal(errorSignalText(J({ type: 'result', result: talk })), '');
});
test('system init and non-JSON diagnostics are not signals', () => {
  assert.equal(errorSignalText(J({ type: 'system', subtype: 'init', model: 'x' })), '');
  assert.equal(errorSignalText('WARN rate limit backoff 429'), '');
  assert.equal(errorSignalText(''), '');
});
test('an error result IS the signal, and the regexes match it', () => {
  const usage = errorSignalText(J({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1760000000' }));
  assert.match(usage, USAGE_ERR_RE);
  assert.doesNotMatch(usage, AUTH_ERR_RE);
  const auth = errorSignalText(J({ type: 'result', is_error: true, result: 'API Error: 401 OAuth token has expired. Please run /login' }));
  assert.match(auth, AUTH_ERR_RE);
  const generic = errorSignalText(J({ type: 'result', is_error: true, result: 'Something else broke' }));
  assert.equal(generic, 'Something else broke');
  assert.doesNotMatch(generic, USAGE_ERR_RE);
  assert.doesNotMatch(generic, AUTH_ERR_RE);
});
test('error result without a string message still yields matchable text', () => {
  const t = errorSignalText(J({ type: 'result', is_error: true, error: { type: 'rate_limit_error' } }));
  assert.match(t, USAGE_ERR_RE);
});
test('usage message names the reset time from the |epoch suffix', () => {
  const epoch = Math.floor(Date.now() / 1000) + 3600;
  const msg = usageErrorMessage(`usage limit reached|${epoch}`);
  assert.match(msg, /resets .+/);
  assert.equal(msg.includes(formatResetTime(epoch)), true);
  assert.match(usageErrorMessage('usage limit reached'), /usage limit/);
});
test('formatResetTime handles seconds, ms and junk', () => {
  assert.equal(formatResetTime('nope'), null);
  assert.equal(formatResetTime(0), null);
  assert.equal(typeof formatResetTime(1760000000), 'string');
  assert.equal(formatResetTime(1760000000), formatResetTime(1760000000000));
});
