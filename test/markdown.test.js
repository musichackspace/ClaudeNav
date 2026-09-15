'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { md, esc, uploadLabel, setKnownSessions, sessionRef } = require('../public/markdown.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'markdown.js'), 'utf8');

test('renderer source has no null bytes and uses space-delimited placeholders', () => {
  assert.equal(SRC.includes('\0'), false);
  assert.match(SRC, /` CB\$\{i\} `/);
  assert.match(SRC, /\/ CB\(\\d\+\) \//);
});

test('three code blocks and two images round-trip with no leaked placeholders', () => {
  const src = [
    'Intro **bold** text', '```js', 'a < b && c', '```', 'mid', '```', 'plain', '```',
    '[Attached image: /Users/x/.claude/claudenav-uploads/1-ab-shot one.png]',
    '```sh', 'echo `hi`', '```',
    '[Attached image: /tmp/2-cd-other.jpg]', 'done',
  ].join('\n');
  const html = md(src);
  assert.equal((html.match(/<pre><code>/g) || []).length, 3);
  assert.equal((html.match(/<img /g) || []).length, 2);
  assert.doesNotMatch(html, / (CB|IMG|LNK|PDF|FILE)\d* /);
  assert.doesNotMatch(html, /\bCB\d\b/);
  assert.match(html, /a &lt; b &amp;&amp; c/);
  assert.match(html, /echo `hi`/);          // backticks inside a fence are literal
  assert.match(html, /shot%20one\.png/);
  assert.equal(html.includes('\0'), false);
});

test('HTML in prose is escaped, code spans and emphasis render', () => {
  const html = md('<script>alert(1)</script> `x<y` *it* **b**');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<code>x&lt;y<\/code>/);
  assert.match(html, /<em>it<\/em>/);
  assert.match(html, /<strong>b<\/strong>/);
});

test('bare URL keeps trailing punctuation outside the link; markdown links render', () => {
  const html = md('see https://example.com/a. Also [doc](https://x.y/z) ok');
  assert.match(html, /href="https:\/\/example\.com\/a"[^>]*>https:\/\/example\.com\/a<\/a>\./);
  assert.match(html, /href="https:\/\/x\.y\/z"[^>]*>doc<\/a>/);
});

test('known session ids become in-app links; unknown ones stay text', () => {
  const known = '12345678-1234-1234-1234-123456789abc', unknown = '99999999-1234-1234-1234-123456789abc';
  setKnownSessions(new Set([known]));
  const html = md(`${known} vs ${unknown}`);
  assert.match(html, new RegExp(`data-session="${known}"`));
  assert.doesNotMatch(html, new RegExp(`data-session="${unknown}"`));
  assert.equal(sessionRef(`claudenav:${known}`), known);
  assert.equal(sessionRef('https://example.com/?session=' + known), null);
});

test('headings, lists and paragraphs', () => {
  const html = md('# Title\n\n- one\n- two\n\npara');
  assert.match(html, /<h4>Title<\/h4>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<div class="ln">para<\/div>/);
});

test('esc and uploadLabel', () => {
  assert.equal(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
  assert.equal(esc(null), '');
  assert.equal(uploadLabel('1726000000000-ab12cd-My%20File.pdf'), 'My File.pdf');
});
