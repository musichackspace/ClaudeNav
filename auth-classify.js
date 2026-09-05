'use strict';
// ---------------------------------------------------------------------------
// Terminal auth-failure classifier.
//
// Split out of server.js (and dependency-free) so it can be unit-tested against
// real recorded CLI output without booting the server.
//
// The problem it solves: when the CLI's OAuth session has expired and can't be
// refreshed, `claude -p` does NOT crash. It writes a *synthetic* assistant
// message — "Failed to authenticate: OAuth session expired and could not be
// refreshed" — into the transcript and returns that same string as its result,
// frequently with exit code 0. ClaudeNav used to render that as ordinary
// assistant prose, so the session looked alive and every later turn failed
// identically in milliseconds with no indication anything was wrong.
//
// The hard part is precision, not recall. Assistant prose quotes these phrases
// constantly — a session *about* this very bug is full of "Failed to
// authenticate" and "please run /login" — so matching raw streamed text cries
// wolf on any turn that merely discusses auth (see CLAUDE.md; every historical
// match in real transcripts was discussion, zero were real failures).
//
// So we never match free text. We match only the CLI's own error channels,
// each identified structurally:
//
//   1. a terminal `result` line that is flagged `is_error`, or whose
//      `terminal_reason` is `api_error` (the exit-0 case);
//   2. a *synthetic* assistant message — one the CLI injected rather than the
//      model producing it. Three independent markers, all observed in real
//      transcripts: `message.model === '<synthetic>'`, top-level
//      `isApiErrorMessage: true`, or a top-level `error` string;
//   3. stderr, the CLI's dedicated error stream.
//
// Within those carriers the structured `error: "authentication_failed"` field
// is decisive on its own; otherwise we pattern-match the message text. Because
// the error can arrive appended to real output rather than as the entire result
// (the model answers, then the token dies mid-response), the text match is a
// substring search, not a whole-string comparison.
// ---------------------------------------------------------------------------

// Terminal auth failures: the login is gone and no amount of retrying a
// headless spawn can recover it — re-auth needs an interactive browser flow.
const AUTH_FATAL_RE = new RegExp([
  'failed to authenticate',
  'login expired',
  // "OAuth session expired", "OAuth token revoked", "OAuth token has expired",
  // "OAuth session expired and could not be refreshed"
  'oauth (?:session|token|access token) (?:has |been )*(?:expired|revoked|is invalid)',
  'not logged in',
  'invalid authentication credentials',
  'please run /login',
].join('|'), 'i');

// Recoverable-looking auth errors the CLI reports as plain API failures. Kept
// separate from AUTH_FATAL_RE because a bare 401 can also come from a
// momentarily bad key rather than a dead login, but the user-facing fix is the
// same, so both drive the AUTH_FAILED state.
const AUTH_API_RE = /api error: 401|invalid authentication|invalid api key|authentication_error|authentication_failed/i;

// Structured error codes the CLI puts on the record itself. Decisive: no text
// matching required.
const AUTH_ERROR_CODES = new Set(['authentication_failed', 'authentication_error', 'oauth_expired']);

function isFatalAuthText(text) {
  return typeof text === 'string' && (AUTH_FATAL_RE.test(text) || AUTH_API_RE.test(text));
}

// Pull the plain text out of an Anthropic-style `content` field, which is
// either a string or an array of blocks.
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');
}

// A message the CLI injected on the model's behalf to report a failure, rather
// than one the model actually produced. Only these may be scanned for auth text.
function isSyntheticAssistant(o) {
  if (!o || o.type !== 'assistant') return false;
  if (o.isApiErrorMessage === true) return true;
  if (typeof o.error === 'string' && o.error) return true;
  return !!(o.message && o.message.model === '<synthetic>');
}

// Trim an error message down to something a banner can hold, preferring the
// line that actually names the failure when it arrived appended to real output.
function authLine(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const hit = lines.find(isFatalAuthText);
  return (hit || flat).slice(0, 300);
}

/**
 * Classify one line of `--output-format stream-json` (or a parsed object).
 *
 * Returns null for everything that isn't a trustworthy auth-failure signal —
 * including assistant prose, tool results, successful result echoes and system
 * init lines, all of which quote these phrases without being failures.
 *
 * @param {string|object} line
 * @returns {{reason:string, message:string, carrier:string}|null}
 */
function classifyAuthFailure(line) {
  let o = line;
  if (typeof line === 'string') {
    const s = line.trim();
    if (!s) return null;
    try { o = JSON.parse(s); } catch { return null; }  // non-JSON diagnostics: ignore
  }
  if (!o || typeof o !== 'object') return null;

  // (1) The terminal result. `is_error` covers the honest failure; the exit-0
  // case shows up as subtype "success" with terminal_reason "api_error".
  if (o.type === 'result') {
    const trusted = o.is_error === true || o.terminal_reason === 'api_error';
    if (!trusted) return null;                 // a clean result just echoes prose
    const text = typeof o.result === 'string' ? o.result : contentText(o.result);
    if (AUTH_ERROR_CODES.has(o.error)) {
      return { reason: o.error, message: authLine(text) || 'Claude CLI authentication failed', carrier: 'result' };
    }
    if (isFatalAuthText(text)) {
      return { reason: 'authentication_failed', message: authLine(text), carrier: 'result' };
    }
    return null;
  }

  // (2) A synthetic assistant message — the CLI's error-injection channel. This
  // is what makes the exit-0 case detectable *before* the turn even ends, and
  // it's the same record that used to render as innocent assistant prose.
  if (isSyntheticAssistant(o)) {
    const text = contentText(o.message && o.message.content);
    if (AUTH_ERROR_CODES.has(o.error)) {
      return { reason: o.error, message: authLine(text) || 'Claude CLI authentication failed', carrier: 'assistant' };
    }
    if (isFatalAuthText(text)) {
      return { reason: 'authentication_failed', message: authLine(text), carrier: 'assistant' };
    }
    return null;
  }

  // Everything else — assistant prose, user/tool_result, system init, and
  // `system`/`api_retry` lines (a retry may still succeed, so it is not
  // terminal) — is not a signal.
  return null;
}

// stderr is a trusted carrier in its own right: the CLI writes nothing there but
// diagnostics, so a raw text match is safe.
function classifyAuthStderr(text) {
  if (!isFatalAuthText(text)) return null;
  return { reason: 'authentication_failed', message: authLine(text), carrier: 'stderr' };
}

// A transcript entry (`~/.claude/projects/**/*.jsonl`) that is really a CLI
// error report rather than model output. Used so the chat view renders it as a
// failure notice instead of a normal Claude message.
function transcriptErrorKind(o) {
  if (!o || o.type !== 'assistant') return null;
  const synthetic = isSyntheticAssistant(o);
  if (!synthetic) return null;
  const text = contentText(o.message && o.message.content);
  if (AUTH_ERROR_CODES.has(o.error) || isFatalAuthText(text)) return 'auth';
  return 'api';
}

module.exports = {
  AUTH_FATAL_RE, AUTH_API_RE,
  classifyAuthFailure, classifyAuthStderr, transcriptErrorKind,
  isFatalAuthText, isSyntheticAssistant, contentText,
};
