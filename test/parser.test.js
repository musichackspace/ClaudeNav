'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpHome, loadServer, jsonl } = require('./helpers');

const HOME = tmpHome();
const { parseSessionFile, parseTranscript } = loadServer();
const dir = path.join(HOME, '.claude', 'projects', '-tmp-x');
fs.mkdirSync(dir, { recursive: true });

const SID = 'aaaaaaaa-0000-0000-0000-000000000001';
const user = (text, extra = {}) => ({ type: 'user', sessionId: SID, cwd: '/tmp/x', timestamp: '2026-09-01T10:00:00Z',
  message: { role: 'user', content: text }, ...extra });
const asst = (content, usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }) =>
  ({ type: 'assistant', sessionId: SID, timestamp: '2026-09-01T10:00:01Z',
    message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content, usage } });

function fresh(name, text) {
  const fp = path.join(dir, name + '.jsonl');
  fs.writeFileSync(fp, text);
  return fp;
}
const parse = fp => parseSessionFile(fp, fs.statSync(fp));
const strip = d => { const { mtimeMs, sizeBytes, filePath, ...rest } = d; return rest; };

test('full parse extracts the essentials', () => {
  const fp = fresh('a', jsonl([
    { type: 'ai-title', aiTitle: 'Fix the thing', sessionId: SID },
    user('please fix it', { gitBranch: 'main', version: '2.1.0', permissionMode: 'plan' }),
    asst([{ type: 'text', text: 'Done.' }]),
  ]));
  const d = parse(fp);
  assert.equal(d.sessionId, SID);
  assert.equal(d.title, 'Fix the thing');
  assert.equal(d.firstUserPrompt, 'please fix it');
  assert.equal(d.userMsgCount, 1);
  assert.equal(d.assistantTurns, 1);
  assert.deepEqual(d.models, ['claude-opus-4-8']);
  assert.equal(d.contextTokens, 110);
  assert.equal(d.tokens.output, 5);
  assert.equal(d.lastEventType, 'assistant');
  assert.equal(d.permissionMode, 'plan');
  assert.equal(d.gitBranch, 'main');
});

test('incremental append equals a fresh full parse', async () => {
  const first = jsonl([user('one'), asst([{ type: 'text', text: 'r1' }])]);
  const more = jsonl([user('two'), asst([{ type: 'text', text: 'r2' }]), user('three')]);
  const fp = fresh('b', first);
  parse(fp);                                   // seed the cache
  await new Promise(r => setTimeout(r, 15));   // ensure a distinct mtime
  fs.appendFileSync(fp, more);
  const incremental = parse(fp);
  const ref = parse(fresh('b-ref', first + more));
  assert.deepEqual(strip(incremental), strip(ref));
  assert.equal(incremental.userMsgCount, 3);
  assert.equal(incremental.lastEventType, 'user');
  assert.equal(incremental.lastUserText, 'three');
});

test('a torn (incomplete) last line is left for later, then folded once complete', async () => {
  const fp = fresh('c', jsonl([user('hello')]));
  const half = JSON.stringify(user('world')).slice(0, 20);
  fs.appendFileSync(fp, half);
  assert.equal(parse(fp).userMsgCount, 1);
  await new Promise(r => setTimeout(r, 15));
  fs.appendFileSync(fp, JSON.stringify(user('world')).slice(20) + '\n');
  assert.equal(parse(fp).userMsgCount, 2);
  assert.equal(parse(fp).lastUserText, 'world');
});

test('synthetic user records do not move the turn pointer', () => {
  const fp = fresh('d', jsonl([
    user('real question'),
    asst([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'a b c' }]),
    asst([{ type: 'text', text: 'Bye!' }]),
    user('<local-command-stdout>Bye!</local-command-stdout>'),
    user('   ', { isMeta: true }),
  ]));
  const d = parse(fp);
  assert.equal(d.lastEventType, 'assistant');
  assert.equal(d.lastUserText, 'real question');
  assert.equal(d.lastAssistantText, 'Bye!');
});

test('a shrunken file falls back to a full re-parse', async () => {
  const fp = fresh('e', jsonl([user('one'), user('two'), user('three')]));
  assert.equal(parse(fp).userMsgCount, 3);
  await new Promise(r => setTimeout(r, 15));
  fs.writeFileSync(fp, jsonl([user('only')]));
  assert.equal(parse(fp).userMsgCount, 1);
});

test('parseTranscript attaches tool results and surfaces AskUserQuestion as the terminal block', () => {
  const q = { question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] };
  const fp = fresh('f', jsonl([
    user('go'),
    asst([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }]),
    asst([{ type: 'text', text: 'Need input' }, { type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: { questions: [q] } }]),
    user([{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Answer questions?' }]),
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } },
  ]));
  const msgs = parseTranscript(fp);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].tools[0].output, 'file.txt');
  const last = msgs[msgs.length - 1];
  assert.equal(last.text, 'Need input');
  assert.deepEqual(last.ask.questions[0].options.map(o => o.label), ['A', 'B']);
  assert.equal(last.tools[0].error, true);
  assert.equal(msgs.some(m => /subagent/.test(m.text)), false);
});
