// ClaudeNav's Markdown renderer + the small HTML helpers it relies on.
// Loaded by index.html (<script src="markdown.js">, exposes `ClaudeNavMd`) and by
// the tests (require('../public/markdown.js')). No DOM access: the only
// environment input is the page host (for in-app session links), read once.
//
// The renderer uses SPACE-delimited placeholders (` CB0 `, ` IMG… `, ` LNK0 `).
// An earlier edit corrupted these to null bytes and made the file read as
// binary — keep them spaces (test/markdown.test.js checks).
(function (root) {
'use strict';
const HOST_NAME = (typeof location !== 'undefined' && location.host) || '';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}
// Uploaded files are stored as `<ts>-<rand>-<original name>`; show the real name.
function uploadLabel(n) { return decodeURIComponent(n).replace(/^\d+-[0-9a-f]+-/, ''); }
// Known session ids (set by the app from /api/sessions) — lets the renderer linkify a
// session reference only when it actually resolves to a session we can open.
let KNOWN_SESSIONS = new Set();
function setKnownSessions(set) { KNOWN_SESSIONS = set; }
function isKnownSession(id) { return KNOWN_SESSIONS.has(id); }

// If an href points back into this ClaudeNav (claudenav:<id>, or our own origin
// with ?session=<id>), return the session id so it opens in-app. Else null.
function sessionRef(href) {
  let m = /^claudenav:(?:\/\/)?([\w-]{8,})/.exec(href);
  if (m) return m[1];
  if (HOST_NAME && href.indexOf(HOST_NAME) !== -1) {
    m = /[?&]session=([\w-]{8,})/.exec(href);
    if (m && isKnownSession(m[1])) return m[1];
  }
  return null;
}

// Build an anchor for a (pre-escaped) href + label. Session links open in-app;
// everything else is a web link routed to the system browser on click.
function linkHtml(href, label) {
  const sid = sessionRef(href);
  if (sid) return `<a href="#" class="slink" data-session="${esc(sid)}">${label}</a>`;
  return `<a href="${href}" class="weblink" target="_blank" rel="noopener">${label}</a>`;
}

// --- Minimal, safe Markdown renderer -----------------------------------------
function md(src) {
  if (!src) return '';
  const codeBlocks = [];
  // 1. Pull out fenced code blocks first so their contents aren't formatted.
  src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = codeBlocks.length;
    codeBlocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return ` CB${i} `;
  });
  // 2. Escape everything else.
  src = esc(src);
  // 3. Attached-image markers -> <img>; attached-PDF markers -> a link.
  src = src.replace(/\[Attached image: ([^\]]+)\]/g, (_, p) =>
    ` IMG${encodeURIComponent(p.split('/').pop())} `);
  src = src.replace(/\[Attached PDF: ([^\]]+)\]/g, (_, p) =>
    ` PDF${encodeURIComponent(p.split('/').pop())} `);
  src = src.replace(/\[Attached file: ([^\]]+)\]/g, (_, p) =>
    ` FILE${encodeURIComponent(p.split('/').pop())} `);
  // 4. Inline formatting. Links are stashed as opaque ` LNKn ` tokens (like code
  //    blocks) so the bare-URL autolinker can't re-process an href it already
  //    wrapped, and so block parsing leaves them intact until the final restore.
  const links = [];
  const stash = (html) => ` LNK${links.push(html) - 1} `;
  src = src
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    // [label](url) — http(s) or an in-app claudenav: session link
    .replace(/\[([^\]]+)\]\(((?:https?|claudenav):[^)\s]+)\)/g, (_, label, href) => stash(linkHtml(href, label)))
    // Bare URLs — leave trailing sentence punctuation outside the link.
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_, pre, href) => {
      let trail = '';
      const tm = /(?:[.,;:!?)\]]|&quot;|&gt;|&lt;)+$/.exec(href);
      if (tm) { trail = href.slice(tm.index); href = href.slice(0, tm.index); }
      return pre + stash(linkHtml(href, href)) + trail;
    })
    // Bare session ids we actually know about -> open-in-app links.
    .replace(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g,
      (m, id) => isKnownSession(id) ? stash(`<a href="#" class="slink" data-session="${id}">${id}</a>`) : m);
  // 5. Block structure: headings, lists, paragraphs.
  const lines = src.split('\n');
  let html = '', inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (let line of lines) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) { closeList(); html += `<h4>${h[2]}</h4>`; }
    else if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${li[1]}</li>`; }
    else if (line.trim() === '') { closeList(); }
    else if (line.startsWith(' CB')) { closeList(); html += line; }
    else { closeList(); html += `<div class="ln">${line}</div>`; }
  }
  closeList();
  // 6. Restore code blocks and images.
  html = html
    .replace(/ CB(\d+) /g, (_, i) => codeBlocks[+i])
    .replace(/ LNK(\d+) /g, (_, i) => links[+i])
    .replace(/ IMG([^ ]+) /g, (_, n) =>
      `<a href="/uploads/${n}" target="_blank"><img class="chatimg" src="/uploads/${n}" alt="attachment"></a>`)
    .replace(/ PDF([^ ]+) /g, (_, n) =>
      `<a class="pdfchip" href="/uploads/${n}" target="_blank">📄 ${esc(uploadLabel(n))}</a>`)
    .replace(/ FILE([^ ]+) /g, (_, n) =>
      `<a class="pdfchip" href="/uploads/${n}" target="_blank">📄 ${esc(uploadLabel(n))}</a>`);
  return html;
}
const api = { esc, uploadLabel, md, sessionRef, linkHtml, isKnownSession, setKnownSessions };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.ClaudeNavMd = api;
})(typeof window !== 'undefined' ? window : globalThis);
