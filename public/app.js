// ClaudeNav frontend. Loaded by index.html after markdown.js; no build step.
const { esc, uploadLabel, md, sessionRef, linkHtml, isKnownSession, setKnownSessions } = ClaudeNavMd;
// Every API call goes through the native fetch with one extra header. The server
// refuses mutating requests without it (its CSRF guard — a cross-site page can
// POST to 127.0.0.1 but can't attach a custom header without a preflight, which
// the server doesn't grant). Wrapping here means no call site can forget it.
{
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const sameOrigin = typeof input === 'string' ? !/^[a-z]+:/i.test(input) || input.startsWith(location.origin)
      : new URL(input.url || String(input), location.href).origin === location.origin;
    if (!sameOrigin) return nativeFetch(input, init);
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('X-ClaudeNav', '1');
    return nativeFetch(input, { ...init, headers });
  };
}
let DATA = { projects: [] };
let showAllProjects = false;
const collapsed = new Set(JSON.parse(localStorage.getItem('cn-collapsed') || '[]'));
function setCollapsed(cwd, on) {
  if (on) collapsed.add(cwd); else collapsed.delete(cwd);
  localStorage.setItem('cn-collapsed', JSON.stringify([...collapsed]));
}
function projectRecency(p) {
  let m = 0;
  for (const s of p.sessions) if (s.mtimeMs > m) m = s.mtimeMs;
  return m;
}
let timer = null;

function timeAgo(ms) {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24); return d + 'd ago';
}
function refreshKnownSessions() {
  const set = new Set();
  for (const p of (DATA.projects || [])) for (const s of p.sessions) set.add(s.sessionId);
  setKnownSessions(set);
}
function fmtTok(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}
// Approx Claude context window for the fill bar (200K standard).
const CTX_WINDOW = 200000;
const STATUS_LABEL = { working: 'Working', waiting: 'Your turn', interrupted: 'Interrupted', idle: 'Idle' };
// Permission modes (mirrors the CLI's --permission-mode choices). Shown per
// session and changeable from the chat header; 'plan' is the read-only one.
const MODE_LABEL = { default: 'Default', plan: 'Plan', acceptEdits: 'Accept edits', auto: 'Auto', bypassPermissions: 'Bypass', dontAsk: "Don't ask" };
const MODE_CHOICES = ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk'];
function modeOf(s) { return (s && s.mode) || 'bypassPermissions'; }
// Model per session — exact model ids passed to the CLI as --model. 'default' =
// inherit the account/CLI default (no override). The list is fetched from the
// Anthropic Models API once a day (server side) and delivered with each poll, so
// it tracks new releases without a code change. We keep a fallback so the picker
// still works before the first poll lands.
let MODEL_CATALOG = [
  { id: 'default', label: 'Default' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
function modelLabel(id) {
  const m = MODEL_CATALOG.find(x => x.id === id);
  return m ? m.label : (id || 'Default');
}
// Adopt the server's daily-refreshed list (arrives on each /api/sessions poll).
function handleModels(info) {
  if (info && Array.isArray(info.models) && info.models.length) MODEL_CATALOG = info.models;
  // Refresh the open picker so a newly-arrived model appears without reopening.
  const sel = document.getElementById('chatModel');
  if (sel && document.getElementById('overlay').classList.contains('show')) {
    setupModelSelect(sel.value);
  }
}
function modelOf(s) { return (s && s.model) || 'default'; }
// Recency-first view: by default show sessions touched in the last 3 days
// (ANY status) and collapse everything older — what's recent matters more than
// what state it's in. "Show older" reveals the rest; they stay searchable
// regardless. (This replaces the old status-based "Hide idle", which hid recent
// finished sessions you cared about while leaving stale ones on screen.)
let showStale = localStorage.getItem('cn-show-stale') === '1';
// Archived sessions (user tucked them away on the server) are hidden until this
// is ticked. Persisted server-side; this toggle just reveals them to unarchive.
let showArchived = localStorage.getItem('cn-show-archived') === '1';
const STALE_MS = 3 * 24 * 60 * 60 * 1000;
function isStale(s) {
  // Never collapse a live/working session; otherwise purely age-based.
  return s.status !== 'working' && (Date.now() - (s.mtimeMs || 0)) > STALE_MS;
}
// Context-fill thresholds (% of the session's real window) that prompt
// token-hygiene UX. The window comes from the server (`s.contextWindow`): it's
// proven 1M when any turn exceeded 200K, else the repo's configured default
// model variant — so the % reflects true headroom-to-the-wall, not a guess.
const CTX_WARN = 60, CTX_HOT = 85;
function shortModel(m) {
  return (m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[1m\]$/, ' 1M');
}

function termApp() { return document.getElementById('termApp').value; }

// Optional `action` = { label, fn } renders a button inside the toast (e.g.
// "Re-login" on auth failures) and keeps it up longer. The status poll re-toasts
// a persistent chat error every tick, so skip the rebuild when nothing changed —
// otherwise the button is replaced every 2s and can eat the user's click.
function toast(msg, isErr, action) {
  const t = document.getElementById('toast');
  if (t.classList.contains('show') && t._msg === msg && !!t._hadAction === !!action) {
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.className = 'toast'; t._msg = null; }, action ? 8000 : 3200);
    return;
  }
  t.textContent = msg;
  t._msg = msg;
  t._hadAction = !!action;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = (e) => { e.stopPropagation(); t.className = 'toast'; t._msg = null; action.fn(); };
    t.appendChild(b);
  }
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = 'toast'; t._msg = null; }, action ? 8000 : 3200);
}

// Open a terminal with `claude /login` running — the fix for expired OAuth
// credentials (the flow is interactive-only, so ClaudeNav can't run it itself).
async function openLoginTerminal() {
  try {
    const r = await fetch('/api/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: true, app: termApp() }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    toast('Opened ' + termApp() + ' — finish /login there, then retry your message');
  } catch (e) {
    toast('Could not open terminal: ' + e.message, true);
  }
}

// Setup-help dialog — shown when a headless turn fails because the `claude`
// binary can't be found/spawned (the "spawn claude ENOENT" case, common on
// Windows where the CLI isn't on the service's PATH). Terminal-opening is
// macOS-only, so on other platforms we can't run the fix for the user — instead
// we lay out the exact, platform-aware steps (from /api/setup-help) to resolve it.
function closeSetupHelp() {
  document.getElementById('setupOverlay').classList.remove('show');
  document.body.classList.remove('overlay-open');
}
async function openSetupHelp() {
  const ov = document.getElementById('setupOverlay');
  ov.classList.add('show');
  document.body.classList.add('overlay-open');
  const body = document.getElementById('setupBody');
  body.innerHTML = '<div class="empty">Loading setup steps…</div>';
  try {
    const r = await fetch('/api/setup-help');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    const plat = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[j.platform] || j.platform;
    const steps = (j.steps || []).map(s => {
      const cmd = s.cmd ? ` <code class="setup-cmd" title="Click to copy">${esc(s.cmd)}</code>` : '';
      return `<li>${esc(s.text)}${cmd}</li>`;
    }).join('');
    const docs = j.docs
      ? `<p class="setup-doc">Install docs: <a href="${esc(j.docs)}" target="_blank" rel="noopener">${esc(j.docs)}</a></p>`
      : '';
    body.innerHTML =
      `<p>${esc(j.message)}</p>`
      + `<p class="setup-plat">Detected platform: <b>${esc(plat)}</b>. `
      + `Current binary guess: <code>${esc(j.claudeBin)}</code>${j.resolved ? '' : ' <b>(not found)</b>'}.</p>`
      + `<ol class="setup-steps">${steps}</ol>`
      + docs;
    body.querySelectorAll('.setup-cmd').forEach(el => {
      el.style.cursor = 'pointer';
      el.onclick = () => navigator.clipboard.writeText(el.textContent).then(() => toast('Copied: ' + el.textContent));
    });
  } catch (e) {
    body.innerHTML = '<div class="empty">Could not load setup steps: ' + esc(e.message) + '</div>';
  }
}

async function openTerminal(payload) {
  try {
    const r = await fetch('/api/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, app: termApp() }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    toast('Opened ' + termApp() + ': ' + j.ran);
  } catch (e) {
    toast('Could not open terminal: ' + e.message, true);
  }
}

function matchesQuery(s, p, q) {
  if (!q) return true;
  const hay = (s.title + ' ' + s.lastPrompt + ' ' + p.cwd + ' ' + s.gitBranch).toLowerCase();
  return hay.includes(q) || searchHits.has(s.sessionId);
}

// Full-text hits from /api/search (session id -> snippet), keyed by the query
// they answer. The row metadata match above is instant; this arrives a beat
// later (debounced) and widens the result set to "anything said in the chat".
let searchHits = new Map(), searchHitsFor = '', searchTimer = null, searchSeq = 0;
function scheduleSearch() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  clearTimeout(searchTimer);
  if (q.length < 2) { if (searchHits.size) { searchHits = new Map(); searchHitsFor = ''; } return; }
  if (q === searchHitsFor) return;
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const r = await fetch('/api/search?q=' + encodeURIComponent(q));
      const j = await r.json();
      if (seq !== searchSeq) return; // a newer query superseded this one
      searchHits = new Map((j.hits || []).map(h => [h.sessionId, h.snippet]));
      searchHitsFor = q;
      render();
    } catch {}
  }, 250);
}

function render() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  const root = document.getElementById('content');
  const searching = q.length > 0;
  let html = '';
  let shown = 0;
  let hiddenStale = 0;
  let hiddenArchived = 0;

  for (const p of DATA.projects) {
    const sessions = p.sessions.filter(s => {
      if (!matchesQuery(s, p, q)) return false;
      // Archived: hidden until "Show archived" (or a search) reveals them. Takes
      // precedence over the recency cutoff so an archived session shows once,
      // regardless of age.
      if (s.archived) {
        if (searching || showArchived) return true;
        hiddenArchived++; return false;
      }
      // Sessions older than the recency window are collapsed out of the default
      // view but stay searchable — a search query overrides the age cutoff.
      if (!searching && !showStale && isStale(s)) { hiddenStale++; return false; }
      return true;
    });
    if (!sessions.length) continue;
    shown += sessions.length;

    const liveBadge = p.liveTerminals > 0
      ? `<span class="badge live">● ${p.liveTerminals} live terminal${p.liveTerminals > 1 ? 's' : ''}</span>`
      : '';

    const isCollapsed = collapsed.has(p.cwd);
    html += `<div class="project${isCollapsed ? ' collapsed' : ''}" id="proj-${esc(p.cwd.replace(/[^a-zA-Z0-9]/g, '_'))}">
      <div class="project-head">
        <button class="chev" data-collapse="${esc(p.cwd)}" title="${isCollapsed ? 'Expand' : 'Collapse'}">${isCollapsed ? '▸' : '▾'}</button>
        <span class="project-name">${esc(p.name)}</span>
        <span class="pubpill" data-pubpill data-cwd="${esc(p.cwd)}" hidden></span>
        ${liveBadge}
        <span class="badge">${p.sessions.length} session${p.sessions.length > 1 ? 's' : ''}</span>
        <span class="project-path">${esc(p.cwd)}</span>
        <button class="new-btn" data-newsession="${esc(p.cwd)}" data-newname="${esc(p.name)}" title="New session in its own git worktree — runs in-browser, no terminal">+ New session</button>
        <button data-viz="${esc(p.cwd)}" data-vizname="${esc(p.name)}" title="Visualise this repo's git history">📊 Visualise</button>
      </div>
      <div class="sessions">`;

    for (const s of sessions) {
      const t = s.tokens || {};
      const ctxTok = s.contextTokens || 0;
      const win = s.contextWindow || ((ctxTok > 200000) ? 1000000 : CTX_WINDOW);
      const ctxPct = Math.min(100, Math.round(ctxTok / win * 100));
      const tier = ctxPct >= CTX_HOT ? 'hot' : ctxPct >= CTX_WARN ? 'warn' : '';
      const model = s.models && s.models.length ? shortModel(s.models[s.models.length - 1]) : '';
      const tokTip =
        `output ${fmtTok(t.output)} · billed input ${fmtTok((t.input||0)+(t.cacheCreation||0))} · ` +
        `cache read ${fmtTok(t.cacheRead)} · context ${fmtTok(s.contextTokens)} (${ctxPct}% of ${win === CTX_WINDOW ? '200K' : '1M'})` +
        (model ? ` · ${esc(model)}` : '');
      // Token hygiene: a context-heavy session re-sends its whole history every
      // turn (slower, pricier, more drift). Offer the two real remedies — compact
      // in place (same thread) or hand over to a fresh session (keeps continuity).
      // ("+ New session" stays separate: that's a blank session for unrelated work.)
      const hint = tier && s.status !== 'working'
        ? `<div class="freshhint ${tier}"
             title="This session is ${ctxPct}% of its ${win === CTX_WINDOW ? '200K' : '1M'} window (~${fmtTok(ctxTok)}), re-sent every turn — costlier, and the model drifts.">
             <span>${tier === 'hot' ? '⚠ Context heavy' : '◐ Context filling'} (${ctxPct}%)</span>
             <button class="hintbtn" data-compact="${esc(s.sessionId)}" data-cwd="${esc(s.cwd || p.cwd)}"
               title="Compact in place: summarises old history within THIS session, keeping the same thread. Frees context, no new session.">Compact</button>
             <button class="hintbtn primary" data-handover="${esc(s.sessionId)}"
               title="Hand over: writes a handoff brief, then opens a NEW session seeded with it. Fresh context, full continuity — continue work there and wrap this one up.">Hand over ▸</button>
           </div>`
        : '';
      html += `<div class="session${s.archived ? ' archived' : ''}" data-session="${esc(s.sessionId)}" title="Click to view conversation">
        <span class="light ${s.status}" title="${STATUS_LABEL[s.status] || s.status}"></span>
        <span class="pill ${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
        ${s.archived ? '<span class="pill archived-tag">Archived</span>' : ''}
        <div class="s-main">
          <div class="s-title">${esc(s.title)} <span class="mode-badge ${modeOf(s) === 'plan' ? 'plan' : ''}" title="Permission mode for the next ClaudeNav turn${s.modeOverride ? ' (pinned)' : ''}">${esc(MODE_LABEL[modeOf(s)] || modeOf(s))}</span>${s.modelOverride ? `<span class="mode-badge model" title="Model pinned for the next ClaudeNav turn">${esc(modelLabel(s.modelOverride))}</span>` : ''}</div>
          <div class="s-sub">${s.gitBranch ? '⎇ ' + esc(s.gitBranch) + ' · ' : ''}${esc(s.lastPrompt) || '<em>no prompt</em>'}</div>
          ${searching && searchHits.has(s.sessionId) ? `<div class="s-hit" title="Matched inside the conversation">🔍 ${esc(searchHits.get(s.sessionId))}</div>` : ''}
          ${hint}
        </div>
        <div class="s-meta ${tier}" title="${tokTip}">
          ${timeAgo(s.mtimeMs)} · ${s.userMsgCount} msgs<br>
          <span class="tok" title="Total tokens this session has generated over its whole life (cumulative across ${s.userMsgCount} turns) — NOT the current context size.">↓${fmtTok(t.output)} generated</span> ·
          <span class="tok" title="Current context re-sent every turn — ${ctxPct}% of the ${win === CTX_WINDOW ? '200K' : '1M'} window.">${fmtTok(s.contextTokens)}/${win === CTX_WINDOW ? '200K' : '1M'} ctx · ${ctxPct}%</span>
          <span class="ctxbar ${tier}"><i style="width:${ctxPct}%"></i></span>
        </div>
        <div class="s-actions">
          <button class="primary" data-chat="${esc(s.sessionId)}" title="Continue this session here in the browser (headless turns — no terminal)">💬 Chat</button>
          <button data-resume="${esc(s.sessionId)}" data-cwd="${esc(s.cwd || p.cwd)}" title="Resume this session in a terminal window">Resume ▸</button>
          <button data-copy="${esc(s.sessionId)}" data-cwd="${esc(s.cwd || p.cwd)}" title="Copy resume command">⧉</button>
          <button data-link="${esc(s.sessionId)}" title="Copy a link that opens this session">🔗</button>
          <button data-archive="${esc(s.sessionId)}" data-archived="${s.archived ? '1' : '0'}" title="${s.archived ? 'Unarchive — show this session in the normal list again' : 'Archive — hide this session from the list (stays searchable and resumable)'}">${s.archived ? '⤴ Unarchive' : '🗄'}</button>
        </div>
      </div>`;
    }
    html += `</div></div>`;
  }

  if (hiddenStale) {
    html += `<div class="stale-note">${hiddenStale} older session${hiddenStale > 1 ? 's' : ''} (not touched in 3+ days) hidden — <a id="revealStale">show older</a> or search to find ${hiddenStale > 1 ? 'them' : 'it'}.</div>`;
  }
  if (hiddenArchived) {
    html += `<div class="stale-note">${hiddenArchived} archived session${hiddenArchived > 1 ? 's' : ''} hidden — <a id="revealArchived">show archived</a> or search.</div>`;
  }

  const emptyMsg = q
    ? 'No sessions match your search.'
    : hiddenStale
      ? `Nothing active in the last 3 days — ${hiddenStale} older session${hiddenStale > 1 ? 's are' : ' is'} hidden. <a id="revealStale">Show older</a> or search.`
      : hiddenArchived
        ? `Nothing active — ${hiddenArchived} archived session${hiddenArchived > 1 ? 's are' : ' is'} hidden. <a id="revealArchived">Show archived</a> or search.`
        : 'No sessions.';
  root.innerHTML = shown ? html : `<div class="empty">${emptyMsg}</div>`;
  document.getElementById('status').textContent =
    `${DATA.projects.length} projects · updated ${new Date(DATA.generatedAt).toLocaleTimeString()}`;
  renderFolders();
  renderLightSummary();
  refreshRowPubStatus();
}

// Paint the row pills from cache, and (re)fetch publish status for expanded
// projects — scoped to what's visible so we don't spawn `gh` for every repo.
// Collapsed sections are skipped; the open chat's cwd is handled by the poll.
function refreshRowPubStatus() {
  const seen = new Set();
  for (const p of DATA.projects) {
    if (!p.cwd || seen.has(p.cwd)) continue;
    seen.add(p.cwd);
    paintPubUI(p.cwd);
    if (!collapsed.has(p.cwd)) fetchSiteStatus(p.cwd);
  }
}

function renderLightSummary() {
  // Count only recent (non-collapsed) sessions — the summary is about what needs
  // attention now, not questions you walked away from weeks ago.
  const counts = { working: 0, waiting: 0, interrupted: 0 };
  for (const p of DATA.projects) for (const s of p.sessions)
    if (counts[s.status] !== undefined && !isStale(s)) counts[s.status]++;
  const parts = [];
  if (counts.working) parts.push(`<span class="l"><span class="light working"></span>${counts.working} working</span>`);
  if (counts.waiting) parts.push(`<span class="l"><span class="light waiting"></span>${counts.waiting} ready</span>`);
  if (counts.interrupted) parts.push(`<span class="l"><span class="light interrupted"></span>${counts.interrupted} stalled</span>`);
  document.getElementById('lights').innerHTML = parts.join('');
}

const RECENT_LIMIT = 5;

function renderFolders() {
  const el = document.getElementById('folders');
  const projects = DATA.projects.slice().sort((a, b) => projectRecency(b) - projectRecency(a));
  if (!projects.length) { el.innerHTML = ''; return; }

  const visible = showAllProjects ? projects : projects.slice(0, RECENT_LIMIT);
  let html = visible.map(p => {
    const active = p.sessions.filter(s => s.status === 'working' || s.status === 'waiting').length;
    const live = p.liveTerminals > 0;
    const meta = live
      ? `${p.liveTerminals} live · ${p.sessions.length} session${p.sessions.length > 1 ? 's' : ''}${active ? ` · ${active} active` : ''}`
      : `${p.sessions.length} session${p.sessions.length > 1 ? 's' : ''} · ${timeAgo(projectRecency(p))}`;
    return `<div class="fcard${live ? ' is-live' : ''}" data-goto="proj-${esc(p.cwd.replace(/[^a-zA-Z0-9]/g, '_'))}" data-cwd="${esc(p.cwd)}" title="${esc(p.cwd)}">
      <div class="fname"><span class="fdot${live ? ' live' : ''}">●</span> ${esc(p.name)}</div>
      <div class="fmeta">${meta}</div>
    </div>`;
  }).join('');

  if (!showAllProjects && projects.length > RECENT_LIMIT) {
    html += `<button class="browse-btn" id="browseMore">Browse all ${projects.length} ▾</button>`;
  } else if (showAllProjects && projects.length > RECENT_LIMIT) {
    html += `<button class="browse-btn" id="browseMore">Show recent ▴</button>`;
  }
  el.innerHTML = html;
}

document.getElementById('folders').addEventListener('click', e => {
  if (e.target.closest('#browseMore')) { showAllProjects = !showAllProjects; renderFolders(); return; }
  const card = e.target.closest('.fcard');
  if (!card) return;
  if (card.dataset.cwd && collapsed.has(card.dataset.cwd)) { setCollapsed(card.dataset.cwd, false); render(); }
  const target = document.getElementById(card.dataset.goto);
  if (target) {
    // Offset by the sticky header height so the section top isn't hidden under it.
    const header = document.querySelector('header');
    const offset = (header ? header.getBoundingClientRect().height : 0) + 8;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    target.style.outline = '2px solid var(--accent)'; setTimeout(() => target.style.outline = '', 1200);
  }
});

document.getElementById('content').addEventListener('click', e => {
  if (e.target.id === 'revealStale') { setShowStale(true); return; }
  if (e.target.id === 'revealArchived') { setShowArchived(true); return; }
  const btn = e.target.closest('button');
  if (btn) {
    if (btn.dataset.collapse !== undefined) {
      setCollapsed(btn.dataset.collapse, !collapsed.has(btn.dataset.collapse));
      render();
    }
    else if (btn.dataset.handover) doHandover(btn.dataset.handover);
    else if (btn.dataset.compact) doCompact(btn.dataset.compact, btn.dataset.cwd);
    else if (btn.dataset.newsession) openIsolated(btn.dataset.newsession, btn.dataset.newname || btn.dataset.newsession);
    else if (btn.dataset.chat) openChat(btn.dataset.chat);
    else if (btn.dataset.resume) openTerminal({ cwd: btn.dataset.cwd, sessionId: btn.dataset.resume });
    else if (btn.dataset.copy) {
      const cmd = `cd ${JSON.stringify(btn.dataset.cwd)} && claude --resume ${btn.dataset.copy}`;
      navigator.clipboard.writeText(cmd).then(() => toast('Copied: ' + cmd));
    }
    else if (btn.dataset.link) {
      const url = sessionLink(btn.dataset.link);
      navigator.clipboard.writeText(url).then(() => toast('Link copied: ' + url));
    }
    else if (btn.dataset.viz) openViz(btn.dataset.viz, btn.dataset.vizname || btn.dataset.viz);
    else if (btn.dataset.archive !== undefined) { e.stopPropagation(); doArchive(btn.dataset.archive, btn.dataset.archived !== '1'); }
    return;
  }
  const row = e.target.closest('.session');
  if (row && row.dataset.session) openChat(row.dataset.session);
});

// ---- Chat panel ------------------------------------------------------------
let chat = { sessionId: null, total: 0, poll: null, running: false, attachments: [], cwd: null, isNew: false, echoes: 0 };

function findSession(id) {
  for (const p of DATA.projects) {
    const s = p.sessions.find(x => x.sessionId === id);
    if (s) return { p, s };
  }
  return null;
}

// Deep links: `#session=<id>` opens that session's chat (works even for idle /
// hidden sessions, since the list is filtered for display only). sessionLink()
// builds one for the 🔗 button.
function sessionLink(id) { return location.origin + '/#session=' + encodeURIComponent(id); }
let hashJumped = false;
function jumpToHashSession() {
  const m = /[#&]session=([\w-]+)/.exec(location.hash || '');
  const id = m ? m[1] : null;
  if (!id || chat.sessionId === id) return; // nothing to do / already open
  if (findSession(id)) openChat(id);
  else toast('Session not found: ' + id, true);
}
window.addEventListener('hashchange', jumpToHashSession);

// Populate the chat-head permission-mode selector for the open session and
// wire its change handler. `current` is the effective mode to preselect.
function setupModeSelect(current) {
  const sel = document.getElementById('chatMode');
  if (!sel) return;
  const cur = current || 'bypassPermissions';
  sel.innerHTML = MODE_CHOICES.map(m =>
    `<option value="${m}"${m === cur ? ' selected' : ''}>${MODE_LABEL[m]}</option>`).join('');
  sel.className = cur === 'plan' ? 'plan' : '';
  sel.onchange = () => changeSessionMode(sel.value);
}

async function changeSessionMode(mode) {
  const id = chat.sessionId;
  if (!id) return;
  const sel = document.getElementById('chatMode');
  if (sel) sel.className = mode === 'plan' ? 'plan' : '';
  try {
    const r = await fetch('/api/session-mode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: id, mode }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    // Reflect immediately in the cached session so the row badge updates.
    const found = findSession(id);
    if (found) { found.s.mode = mode; found.s.modeOverride = mode; }
    toast('Mode → ' + (MODE_LABEL[mode] || mode));
  } catch (e) { toast('Could not set mode: ' + e.message, true); }
}

// Populate the chat-head model selector for the open session and wire its
// change handler. `current` is the effective model to preselect.
function setupModelSelect(current) {
  const sel = document.getElementById('chatModel');
  if (!sel) return;
  const ids = MODEL_CATALOG.map(m => m.id);
  // The session's effective model may not be in the catalog (e.g. a pinned id
  // the daily list hasn't caught up to, or an older model) — show it anyway.
  const opts = ids.includes(current)
    ? MODEL_CATALOG.slice()
    : [...MODEL_CATALOG, { id: current, label: modelLabel(current) }];
  sel.innerHTML = opts.map(m =>
    `<option value="${esc(m.id)}"${m.id === current ? ' selected' : ''}>${esc(m.label)}</option>`).join('');
  sel.onchange = () => changeSessionModel(sel.value);
}

async function changeSessionModel(model) {
  const id = chat.sessionId;
  if (!id) return;
  try {
    const r = await fetch('/api/session-model', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: id, model }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    // Reflect immediately in the cached session so the row badge updates.
    const found = findSession(id);
    if (found) { found.s.model = model; found.s.modelOverride = model === 'default' ? null : model; }
    toast('Model → ' + modelLabel(model));
  } catch (e) { toast('Could not set model: ' + e.message, true); }
}

function openChat(id) {
  const found = findSession(id);
  if (!found) return;
  const { p, s } = found;
  chat.sessionId = id;
  chat.total = 0;
  chat.running = false;
  chat.echoes = 0;
  chat.name = s.title;
  chat.cwd = s.cwd || p.cwd;
  chat.isNew = false;
  setChatLight(s.status === 'working' ? 'working' : s.status === 'interrupted' ? 'interrupted' : 'waiting',
    s.status === 'working' ? 'Working' : 'Ready');
  document.getElementById('chatTitle').textContent = s.title;
  document.getElementById('chatSub').textContent =
    `${p.name} · ${STATUS_LABEL[s.status] || s.status}` + (s.gitBranch ? ` · ⎇ ${s.gitBranch}` : '');
  document.getElementById('chatBody').innerHTML = '<div class="empty">Loading conversation…</div>';
  setupModeSelect(modeOf(s));
  setupModelSelect(modelOf(s));
  document.getElementById('overlay').classList.add('show');
  document.body.classList.add('overlay-open');
  renderPubBar(chat.cwd);            // show cached status instantly, if any
  fetchSiteStatus(chat.cwd, true);   // then refresh
  renderCompose(p, s); // after .show so box.focus() lands on a visible element
  loadTranscript(true);
  checkChatStatus();
  clearInterval(chat.poll);
  chat.poll = setInterval(pollTick, 2000);
}

// Start a brand-new session headlessly in a folder — no terminal. We pick the
// session id up front so the panel attaches immediately; the first send creates
// it (server uses --session-id), later sends continue it (--resume).
function openNewChat(cwd, name) {
  chat.sessionId = (crypto.randomUUID && crypto.randomUUID()) ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  chat.total = 0;
  chat.running = false;
  chat.echoes = 0;
  chat.cwd = cwd;
  chat.isNew = true;
  chat.name = 'New session · ' + name;
  setChatLight('waiting', 'Ready');
  document.getElementById('chatTitle').textContent = 'New session';
  document.getElementById('chatSub').textContent = `${name} · type a message to start`;
  document.getElementById('chatBody').innerHTML =
    '<div class="empty">New headless session in this folder.<br>Send a message to begin — no terminal needed.</div>';
  setupModeSelect('bypassPermissions');
  setupModelSelect('default');
  document.getElementById('overlay').classList.add('show');
  document.body.classList.add('overlay-open');
  renderPubBar(chat.cwd);
  fetchSiteStatus(chat.cwd, true);
  renderCompose({ liveTerminals: 0 }, null); // after .show so box.focus() lands on a visible element
  checkChatStatus();
  clearInterval(chat.poll);
  chat.poll = setInterval(pollTick, 2000);
}

function closeChat() {
  document.getElementById('overlay').classList.remove('show');
  document.body.classList.remove('overlay-open');
  clearInterval(chat.poll);
  chat.sessionId = null;
  document.getElementById('chatPublish').hidden = true;
  resetTabSignal();
}

// Create an isolated git worktree for this folder, then start a headless
// session inside it — safe parallel changes that merge back via the wrap-up panel.
async function openIsolated(cwd, name) {
  toast('Creating isolated worktree…');
  try {
    const r = await fetch('/api/worktree', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, name }),
    });
    const j = await r.json();
    if (!r.ok) {
      // A worktree needs a repo to branch from. If this folder isn't one,
      // don't dead-end — start a plain session in the folder itself (same as
      // "+ New project" does for a fresh folder). Isolation is an upgrade for
      // repos, not a precondition for having a session.
      if (/not a git repo|no commits yet|invalid reference: HEAD/i.test(j.error || '')) {
        toast('No git history yet — starting a plain session here (no isolation)');
        openNewChat(cwd, name);
        return;
      }
      throw new Error(j.error || 'failed');
    }
    load(); // surface the new worktree in the session list
    openNewChat(j.path, name + ' (' + j.branch + ')');
    toast('Worktree ' + j.branch);
  } catch (e) { toast('Worktree failed: ' + e.message, true); }
}

// Compact a heavy session in place: send the `/compact` slash command as a turn.
// The CLI summarises older history within the SAME session, freeing context
// without breaking the thread. Context shrinks once the turn completes.
async function doCompact(sessionId, cwd) {
  toast('Compacting session…');
  try {
    await api('/api/chat', { session: sessionId, text: '/compact', cwd });
    toast('Compaction started — context will shrink when it finishes');
    setTimeout(load, 2000);
  } catch (e) { toast('Compact failed: ' + e.message, true); }
}

// Hand over to a fresh session: the server has this session write a handoff brief
// (one added turn), then seeds a brand-new session with it. We then jump into the
// new session so work continues with clean context but full continuity.
async function doHandover(sessionId) {
  if (!confirm('Hand over to a fresh session?\n\nThis session writes a handoff brief (one extra turn), '
    + 'then a new session opens seeded with it. Continue work in the new one and wrap this up.\n\nThis can take a minute.')) return;
  toast('Writing handoff brief, then seeding a fresh session…');
  try {
    const j = await api('/api/handover', { session: sessionId });
    toast('Handed over → opening the fresh session');
    await load();
    if (findSession(j.newSession)) openChat(j.newSession);
    else { location.hash = '#session=' + j.newSession; toast('New session created: ' + j.newSession); }
  } catch (e) { toast('Handover failed: ' + e.message, true); }
}

// --- Traffic-light feedback --------------------------------------------------
const LIGHT_COLORS = { working: '#e3b341', waiting: '#3fb950', ready: '#3fb950', interrupted: '#f85149', idle: '#4a5160' };

function setChatLight(status, label) {
  const el = document.getElementById('chatLight');
  const lab = document.getElementById('chatLightLabel');
  if (el) el.className = 'light ' + status;
  if (lab) lab.textContent = label || '';
}

function setFavicon(color) {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const x = c.getContext('2d');
  x.beginPath(); x.arc(16, 16, 13, 0, 7); x.fillStyle = color; x.fill();
  document.getElementById('favicon').href = c.toDataURL('image/png');
}

let titleFlash = null;
function setTabSignal(state) {
  // state: 'working' | 'ready' | null
  clearInterval(titleFlash);
  if (state === 'working') {
    document.title = '⏳ Working — ClaudeNav';
    setFavicon(LIGHT_COLORS.working);
  } else if (state === 'ready') {
    setFavicon(LIGHT_COLORS.ready);
    // Flash the tab title so a backgrounded tab gets noticed.
    let on = true;
    const name = chat.name ? ' · ' + chat.name : '';
    document.title = '🟢 Ready' + name;
    titleFlash = setInterval(() => {
      document.title = (on ? '🟢 Ready — your turn' : 'ClaudeNav') + name;
      on = !on;
    }, 1000);
  } else {
    resetTabSignal();
  }
}
function resetTabSignal() {
  clearInterval(titleFlash);
  document.title = 'ClaudeNav';
  setFavicon(LIGHT_COLORS.idle);
}

// Desktop notification when a turn finishes (only if the tab isn't focused).
function notifyReady() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return; // tab flash is enough when you're looking
  try {
    const n = new Notification('🟢 Ready — your turn', {
      body: (chat.name || 'A Claude session') + ' finished and is waiting for you.',
      tag: 'claudenav-' + chat.sessionId, // collapse repeats per session
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}

// Desktop notification when Claude stops to ask you something (background tab only).
function notifyQuestion() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;
  try {
    const n = new Notification('❓ Claude has a question', {
      body: (chat.name || 'A Claude session') + ' is waiting for your answer.',
      tag: 'claudenav-ask-' + chat.sessionId,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}

function ensureNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}
// Stop flashing once the user looks at the tab.
window.addEventListener('focus', () => { if (titleFlash) { clearInterval(titleFlash); document.title = 'ClaudeNav' + (chat.name ? ' · ' + chat.name : ''); } });

// Drag-and-drop attach. The WHOLE window is the drop target — people drop a
// file onto the conversation, not the little compose bar — so a file dropped
// anywhere attaches to the currently-open chat (and the browser never navigates
// away from it). Bound once at load to `document`; listeners live for the page.
(function setupDropZone() {
  let depth = 0; // dragenter/leave fire per element; count to avoid flicker
  const composeEl = () => document.getElementById('chatCompose');
  const chatOpen = () => !!document.getElementById('composeBox');
  // `dataTransfer.types` is a frozen array in modern browsers but a DOMStringList
  // in older ones — support both so the file check never throws (a throw here
  // would skip preventDefault and the browser would refuse the drop entirely).
  const hasFiles = ev => {
    const t = ev.dataTransfer && ev.dataTransfer.types;
    if (!t) return false;
    return t.includes ? t.includes('Files') : Array.prototype.indexOf.call(t, 'Files') >= 0;
  };
  const setHL = on => { const z = composeEl(); if (z) z.classList.toggle('dragging', !!on && chatOpen()); };
  const clear = () => { depth = 0; setHL(false); };
  document.addEventListener('dragenter', ev => { if (!hasFiles(ev)) return; ev.preventDefault(); depth++; setHL(true); });
  document.addEventListener('dragover', ev => { if (hasFiles(ev)) ev.preventDefault(); });
  document.addEventListener('dragleave', ev => { if (!hasFiles(ev)) return; if (--depth <= 0) clear(); });
  document.addEventListener('drop', ev => {
    if (!hasFiles(ev)) return;
    ev.preventDefault(); clear();
    if (!chatOpen()) { toast('Open a session first, then drop files to attach', true); return; }
    if (ev.dataTransfer.files && ev.dataTransfer.files.length) addFiles(ev.dataTransfer.files);
  });
})();

function renderCompose(p, s) {
  const el = document.getElementById('chatCompose');
  const liveNote = p.liveTerminals > 0
    ? `<span class="hint">also open in a terminal — that's fine; each browser turn continues from the latest</span>` : '';
  el.innerHTML = `
    <div id="attach" class="attach"></div>
    <textarea id="composeBox" placeholder="Message this session… paste or drop a file to attach — images, PDFs, text/source, Office docs (Enter to send, Shift+Enter for newline)"></textarea>
    <div class="row">
      <button id="attachBtn" class="ghost" title="Attach a file (images, PDFs, text/source, Office docs)">📎</button>
      <input id="fileInput" type="file" accept="image/*,application/pdf,text/*,.docx,.xlsx,.pptx,.md,.csv,.json,.yaml,.yml,.py,.js,.ts,.go,.rs,.java,.c,.h,.cpp,.sh,.sql,.toml,.heic,.heif,.zip" multiple hidden>
      ${liveNote}<span id="working" class="hint"></span>
      <button id="stopBtn" class="ghost stop" title="Stop the running turn and clear the queue" hidden>■ Stop</button>
      <button id="sendBtn">Send ▸</button>
    </div>`;
  const box = el.querySelector('#composeBox');
  el.querySelector('#sendBtn').onclick = doSend;
  el.querySelector('#stopBtn').onclick = doStop;
  el.querySelector('#attachBtn').onclick = () => el.querySelector('#fileInput').click();
  el.querySelector('#fileInput').onchange = ev => { addFiles(ev.target.files); ev.target.value = ''; };
  box.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); doSend(); }
  });
  box.addEventListener('paste', ev => {
    // Only intercept pasted *files* (screenshots, dragged-in docs); leave plain
    // text paste alone so it lands in the textarea as usual.
    const files = [...(ev.clipboardData?.items || [])]
      .filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
    if (files.some(f => attachKind(f))) { ev.preventDefault(); addFiles(files); }
  });
  renderAttachments();
  box.focus();
}

// Supported attachments: images, PDFs, plain text/source files, and Office docs.
// The CLI's Read tool consumes them (HEIC and Office are converted server-side).
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif'];
const OFFICE_EXTS = ['docx', 'xlsx', 'pptx'];
const TEXT_EXTS = [
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'mjs', 'cjs', 'ts',
  'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cc', 'hpp',
  'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'sql', 'toml', 'ini', 'cfg',
  'conf', 'env', 'properties', 'gradle', 'r', 'lua', 'pl', 'dart', 'ex', 'exs',
  'vue', 'svelte', 'make', 'mk', 'dockerfile', 'gitignore',
];
const extOf = name => (/\.([A-Za-z0-9]+)$/.exec(name || '') || ['', ''])[1].toLowerCase();
// Only formats an <img> can actually render inline (HEIC can't, so it's a chip).
const previewable = name => ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extOf(name));
function attachKind(f) {
  const ext = extOf(f && f.name), t = (f && f.type) || '';
  if (t.startsWith('image/') || IMAGE_EXTS.includes(ext)) return 'image';
  if (ext === 'pdf' || t === 'application/pdf') return 'pdf';
  if (OFFICE_EXTS.includes(ext) || TEXT_EXTS.includes(ext) || ext === 'zip' || t.startsWith('text/')) return 'file';
  return null;
}

function addFiles(files) {
  const all = [...files].filter(Boolean);
  const rejected = all.filter(f => !attachKind(f));
  if (rejected.length) {
    const names = rejected.map(f => f.name || f.type || 'file').join(', ');
    toast(`Can't attach ${names} — supported: images, PDFs, text/source files, Office docs`, true);
  }
  all.filter(f => attachKind(f)).forEach(f => {
    const reader = new FileReader();
    const name = f.name || `pasted.${(f.type.split('/')[1] || 'bin')}`;
    reader.onload = () => { chat.attachments.push({ data: reader.result, name }); renderAttachments(); };
    reader.readAsDataURL(f);
  });
}

function renderAttachments() {
  const el = document.getElementById('attach');
  if (!el) return;
  el.innerHTML = chat.attachments.map((a, i) => {
    const preview = previewable(a.name)
      ? `<img src="${a.data}">`
      : `<span class="pdfthumb" title="${esc(a.name)}">📄 ${esc(extOf(a.name) || 'file')}</span>`;
    return `<div class="thumb">${preview}<button data-rm="${i}" title="Remove">×</button></div>`;
  }).join('');
  el.querySelectorAll('button[data-rm]').forEach(b => b.onclick = () => {
    chat.attachments.splice(+b.dataset.rm, 1); renderAttachments();
  });
}

// Reflect server state: running + how many turns are queued behind it.
function setStatus(running, queued) {
  const was = chat.running;
  chat.running = running;
  const w = document.getElementById('working');
  if (w) w.textContent = running
    ? '⏳ Claude is working…' + (queued > 0 ? ` (${queued} queued)` : '')
    : '';
  const stop = document.getElementById('stopBtn');
  if (stop) stop.hidden = !running;
  if (running) {
    setChatLight('working', queued > 0 ? `Working · ${queued} queued` : 'Working');
    setTabSignal('working');
  } else {
    setChatLight('waiting', 'Ready');
    // Only fire the "ready" notification on a real working→ready transition.
    if (was) { setTabSignal('ready'); toast('🟢 Ready — your turn'); notifyReady(); }
  }
}

// Fire one resumed turn. Shared by the compose box and the question-card clicks.
async function postTurn(text, images) {
  setStatus(true, 0);
  const r = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: chat.sessionId, text, images: images || [], cwd: chat.cwd }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'failed');
  if (chat.isNew) { chat.isNew = false; load(); } // refresh list so the new session appears
  setTimeout(() => loadTranscript(false), 600);
}

async function doSend() {
  const box = document.getElementById('composeBox');
  const text = box.value.trim();
  const images = chat.attachments.slice();
  if (!text && !images.length) return; // sending while a turn runs is fine — it queues server-side
  ensureNotifyPermission(); // ask once, on this user gesture
  box.value = '';
  chat.attachments = [];
  renderAttachments();
  echoUser(text, images);   // show the message immediately, before the poll catches up
  try {
    await postTurn(text, images);
  } catch (e) {
    toast('Chat failed: ' + e.message, true);
    box.value = text; // restore so the message isn't lost
    chat.attachments = images;
    renderAttachments();
    dropLastEcho();   // the send didn't land — take the optimistic bubble back
    chat.running = false;
    const w = document.getElementById('working'); if (w) w.textContent = '';
    const stop = document.getElementById('stopBtn'); if (stop) stop.hidden = true;
    setChatLight('waiting', 'Ready');
  }
  box.focus();
}

// The live question is the most recent card with no user reply after it; older
// cards (or ones already answered) stay inert as a read-only record.
function refreshAsks() {
  const body = document.getElementById('chatBody');
  if (!body) return;
  const rows = [...body.children];
  let lastUser = -1;
  rows.forEach((el, i) => { if (el.classList?.contains('user')) lastUser = i; });
  let live = null;
  body.querySelectorAll('.askcard').forEach(card => {
    card.classList.add('inert');
    if (card.dataset.answered) return;
    const idx = rows.indexOf(card.closest('.msg'));
    if (idx > lastUser) live = card; // latest unanswered wins
  });
  if (live) {
    live.classList.remove('inert');
    // Pull a freshly-activated question into view once, so it's never missed
    // below the fold (it doesn't re-scroll on every 2s poll).
    if (!live.dataset.seen) {
      live.dataset.seen = '1';
      requestAnimationFrame(() => live.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      notifyQuestion();
    }
  }
}

// Compose the answer in Claude's native format and send it as the next turn.
async function submitAsk(card) {
  const parts = [];
  card.querySelectorAll('.askblock').forEach(b => {
    const q = b.querySelector('.askq')?.textContent || '';
    const sel = [...b.querySelectorAll('.askopt.sel .ol')].map(e => e.textContent);
    if (sel.length) parts.push({ q, a: sel.join(', ') });
  });
  if (!parts.length) return; // nothing picked yet
  card.dataset.answered = '1';
  card.classList.add('inert');
  const done = card.querySelector('.askdone');
  if (done) { done.hidden = false; done.textContent = '✓ ' + parts.map(p => p.a).join('  ·  '); }
  ensureNotifyPermission();
  try {
    await postTurn(parts.map(p => `"${p.q}"="${p.a}"`).join(', '), []);
  } catch (e) {
    toast('Chat failed: ' + e.message, true);
    delete card.dataset.answered; // let them try again
    if (done) done.hidden = true;
    refreshAsks();
  }
}

// Optimistically render the just-sent user message so it appears instantly.
// Tagged .optimistic so loadTranscript can retract it once the real one lands.
function echoUser(text, images) {
  const body = document.getElementById('chatBody');
  if (!body) return;
  const ph = body.querySelector('.empty'); if (ph) ph.remove();
  const imgs = (images || []).map(a => previewable(a.name)
    ? `<img class="chatimg" src="${a.data}" alt="attachment">`
    : `<span class="pdfchip">📄 ${esc(a.name)}</span>`).join('');
  body.insertAdjacentHTML('beforeend',
    `<div class="msg user optimistic"><div class="who">You</div>` +
    `${text ? `<div class="bubble">${md(text)}</div>` : ''}${imgs}</div>`);
  chat.echoes = (chat.echoes || 0) + 1;
  pinToBottom(body);
}
function dropLastEcho() {
  const nodes = document.querySelectorAll('#chatBody .msg.optimistic');
  if (nodes.length) { nodes[nodes.length - 1].remove(); chat.echoes = Math.max(0, (chat.echoes || 0) - 1); }
}

// Live, in-flight assistant output (block-level), rebuilt from chat-status each
// poll. Removed as soon as the finalized message arrives via the transcript.
// NB: the interactive question card is deliberately NOT rendered here — only
// from the finalized transcript (renderMsg). Drawing it from the live partial
// too raced the transcript poll: the two pollers fire concurrently every 2s, so
// during the running→finished flip you'd get a duplicate card (and refreshAsks
// would mark the one you're clicking inert), and clearStreaming() would wipe any
// options you'd already selected. The transcript always records the AskUser
// Question tool_use, and headless turns finalize right after asking, so the
// card still appears within a poll — just from a single, stable source.
function renderStreaming(partial) {
  const body = document.getElementById('chatBody');
  if (!body) return;
  const ph = body.querySelector('.empty'); if (ph) ph.remove();
  const toolLine = renderTools(partial.tools);
  const textHtml = partial.text
    ? `<div class="bubble">${md(partial.text)}</div>`
    : (toolLine ? '' : `<div class="bubble"><span class="typing">▍</span></div>`);
  const inner = `<div class="who">Claude</div>${textHtml}${toolLine}`;
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 200;
  let el = body.querySelector('.msg.streaming');
  if (!el) {
    body.insertAdjacentHTML('beforeend', `<div class="msg assistant streaming">${inner}</div>`);
    el = body.querySelector('.msg.streaming');
  } else if (el.dataset.prev !== inner) {
    // The poll re-renders this preview every ~2s. A naive innerHTML swap snaps
    // every <details> shut, so a tool block you expanded to read closes under
    // you mid-turn. Carry the open/closed state across the swap (by position —
    // blocks only append as the turn streams), and skip the swap entirely when
    // nothing changed.
    const open = [...el.querySelectorAll('details')].map(d => d.open);
    el.innerHTML = inner;
    const fresh = el.querySelectorAll('details');
    open.forEach((o, i) => { if (o && fresh[i]) fresh[i].open = true; });
  }
  el.dataset.prev = inner;
  if (nearBottom) pinToBottom(body);
}
function clearStreaming() {
  const el = document.querySelector('#chatBody .msg.streaming');
  if (el) el.remove();
}

async function doStop() {
  if (!chat.sessionId) return;
  try {
    const r = await fetch('/api/chat-cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: chat.sessionId }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    clearStreaming();
    toast(j.stopped
      ? 'Stopped' + (j.dropped ? ` · cleared ${j.dropped} queued` : '')
      : (j.dropped ? `Cleared ${j.dropped} queued` : 'Nothing to stop'));
    checkChatStatus();
  } catch (e) { toast('Stop failed: ' + e.message, true); }
}

async function checkChatStatus() {
  if (!chat.sessionId) return;
  try {
    const r = await fetch(`/api/chat-status?session=${encodeURIComponent(chat.sessionId)}`);
    const j = await r.json();
    setStatus(j.running, j.queued || 0);
    if (j.running && j.partial && (j.partial.text || j.partial.ask || (j.partial.tools && j.partial.tools.length))) {
      renderStreaming(j.partial);
    } else if (!j.running) {
      clearStreaming();
    }
    if (j.error && !j.running) {
      if (j.usageLimited || j.interrupted) {
        // Not a crash — either a usage limit or a turn cut short by a server
        // restart (its progress was saved). The server already phrased it as
        // plain, actionable guidance, so show it as-is with no scary "Turn
        // error:" prefix, and let it linger so it's readable.
        toast(j.error, true, { label: 'Dismiss', fn: () => {} });
      } else if (j.needsSetup) {
        // The `claude` binary couldn't be found/spawned — offer the fix steps
        // instead of a cryptic "spawn claude ENOENT".
        toast(j.error, true, { label: 'Fix setup', fn: openSetupHelp });
      } else {
        toast('Turn error: ' + j.error, true,
          j.needsLogin ? { label: 'Re-login', fn: openLoginTerminal } : null);
      }
    }
  } catch {}
}

function pollTick() {
  loadTranscript(false);
  checkChatStatus();
  // Refresh publish status while the chat is open (throttled inside fetch);
  // catches the "Publishing… → Live" flip without user action.
  if (chat.cwd) fetchSiteStatus(chat.cwd);
}

// Pin the transcript to the newest message. Runs now, on the next frame (after
// layout), and again as any images finish loading — otherwise late-loading
// attachments grow the height and leave the view stranded near the top.
function pinToBottom(body) {
  const stick = () => { body.scrollTop = body.scrollHeight; };
  stick();
  requestAnimationFrame(stick);
  body.querySelectorAll('img').forEach(img => {
    if (!img.complete) img.addEventListener('load', stick, { once: true });
  });
}

async function loadTranscript(reset) {
  if (!chat.sessionId) return;
  const after = reset ? 0 : chat.total;
  try {
    const r = await fetch(`/api/transcript?session=${encodeURIComponent(chat.sessionId)}&after=${after}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    const body = document.getElementById('chatBody');
    if (reset) body.innerHTML = '';
    if (j.messages.length) {
      if (after === 0 && body.querySelector('.empty')) body.innerHTML = ''; // clear placeholder
      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 200;
      // Retract optimistic echoes now confirmed by the transcript (one per
      // real user message), and drop the live preview — the finalized
      // messages below supersede it.
      const userArrived = j.messages.filter(m => m.role === 'user').length;
      if (userArrived) {
        const echoes = body.querySelectorAll('.msg.optimistic');
        for (let i = 0; i < userArrived && i < echoes.length; i++) echoes[i].remove();
        chat.echoes = Math.max(0, (chat.echoes || 0) - userArrived);
      }
      clearStreaming();
      body.insertAdjacentHTML('beforeend', j.messages.map(renderMsg).join(''));
      refreshAsks();
      if (reset || nearBottom) pinToBottom(body);
    } else if (reset) {
      body.innerHTML = '<div class="empty">No conversation yet.</div>';
    }
    chat.total = j.total; // server-reported message count = next cursor
  } catch (e) { /* transient */ }
}

// Render tool calls as expandable blocks. Each tool is {name, detail, body,
// output, error}; older transcripts may still hold bare name strings, so coerce.
function renderTools(list) {
  const tools = (list || [])
    .map(t => typeof t === 'string' ? { name: t } : t)
    .filter(t => t && t.name !== 'AskUserQuestion');
  if (!tools.length) return '';
  const rows = tools.map(t => {
    const detail = t.detail ? `<span class="tdetail">${esc(t.detail)}</span>` : '';
    const hasBody = t.body || t.output;
    const head = `<summary><span class="tname">${esc(t.name)}</span>${detail}</summary>`;
    if (!hasBody) return `<details class="tool${t.error ? ' err' : ''}">${head}</details>`;
    const input = t.body ? `<h6>Input</h6><pre>${esc(t.body)}</pre>` : '';
    const output = t.output ? `<h6>Output</h6><pre>${esc(t.output)}</pre>` : '';
    return `<details class="tool${t.error ? ' err' : ''}">${head}<div class="tbody">${input}${output}</div></details>`;
  }).join('');
  // A long run of tool calls (Bash/Read/…) otherwise fills the whole chat
  // panel. Collapse groups of more than COLLAPSE_AT into a single summary line
  // (showing a count + a breakdown by tool name); the individual rows — each
  // still independently expandable — live inside.
  const COLLAPSE_AT = 4;
  if (tools.length <= COLLAPSE_AT) return `<div class="tools">${rows}</div>`;
  const counts = {};
  for (const t of tools) counts[t.name] = (counts[t.name] || 0) + 1;
  const breakdown = Object.entries(counts)
    .map(([n, c]) => c > 1 ? `${esc(n)}×${c}` : esc(n)).join(', ');
  const anyErr = tools.some(t => t.error);
  return `<details class="toolgroup${anyErr ? ' err' : ''}">
    <summary><span class="tgname">${tools.length} tool calls</span><span class="tgdetail">${breakdown}</span></summary>
    <div class="tools">${rows}</div>
  </details>`;
}

function renderMsg(m) {
  // The question card replaces the bare "AskUserQuestion" tool row.
  const tools = renderTools(m.tools);
  const text = m.text ? `<div class="bubble">${md(m.text)}</div>` : '';
  const ask = m.ask ? renderAsk(m.ask) : '';
  return `<div class="msg ${m.role}">
    <div class="who">${m.role === 'user' ? 'You' : 'Claude'}</div>${text}${tools}${ask}</div>`;
}

// Render an AskUserQuestion as a card of clickable options. Starts inert;
// refreshAsks() activates the latest unanswered one after each render.
function renderAsk(ask) {
  const qs = ask.questions || [];
  const single = qs.length === 1 && !qs[0].multiSelect; // one tap → send
  const blocks = qs.map(q => {
    const opts = (q.options || []).map(o =>
      `<button class="askopt"><span class="ol">${esc(o.label)}</span>${
        o.description ? `<span class="od">${esc(o.description)}</span>` : ''}</button>`).join('');
    return `<div class="askblock">
      <div class="askq">${esc(q.question)}</div>
      <div class="askopts" data-multi="${q.multiSelect ? 1 : 0}">${opts}</div>
    </div>`;
  }).join('');
  return `<div class="askcard inert" data-auto="${single ? 1 : 0}">${blocks}
    <button class="asksend">Send answer ▸</button>
    <div class="askdone" hidden></div></div>`;
}

// Delegated handler for question-card clicks (cards are re-rendered on every
// poll, so listen once on the persistent chat body).
// Open a web link in the system default browser via the backend, so it escapes
// the ClaudeNav tab/webview. Falls back to a plain new tab if the call fails.
async function openExternal(href) {
  try {
    const r = await fetch('/api/open-url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: href }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'failed');
  } catch {
    window.open(href, '_blank', 'noopener');
  }
}

document.getElementById('chatBody').addEventListener('click', ev => {
  const slink = ev.target.closest('a.slink');
  if (slink) {
    ev.preventDefault();
    const id = slink.dataset.session;
    if (isKnownSession(id)) openChat(id);
    else toast('That session is no longer available', true);
    return;
  }
  const wlink = ev.target.closest('a.weblink');
  if (wlink) { ev.preventDefault(); openExternal(wlink.getAttribute('href')); return; }
  const opt = ev.target.closest('.askopt');
  if (opt) {
    const card = opt.closest('.askcard');
    if (card.classList.contains('inert')) return; // not the live question
    const group = opt.closest('.askopts');
    if (group.dataset.multi === '1') {
      opt.classList.toggle('sel');
    } else {
      group.querySelectorAll('.askopt').forEach(b => b.classList.remove('sel'));
      opt.classList.add('sel');
    }
    if (card.dataset.auto === '1') submitAsk(card); // single question → one tap sends
    return;
  }
  const send = ev.target.closest('.asksend');
  if (send) submitAsk(send.closest('.askcard'));
});

document.getElementById('chatClose').addEventListener('click', closeChat);
document.getElementById('overlay').addEventListener('click', e => {
  if (e.target.id === 'overlay') closeChat();
});
document.getElementById('setupClose').addEventListener('click', closeSetupHelp);
document.getElementById('setupOverlay').addEventListener('click', e => {
  if (e.target.id === 'setupOverlay') closeSetupHelp();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeChat(); closeHousekeeping(); closeViz(); closeDashboard(); closeNewProject(); closeSetupHelp(); } });

// ---- Repo history visualiser ----------------------------------------------
function closeViz() { document.getElementById('vizOverlay').classList.remove('show'); document.body.classList.remove('overlay-open'); }

async function openViz(cwd, name) {
  document.getElementById('vizOverlay').classList.add('show');
  document.body.classList.add('overlay-open');
  document.getElementById('vizTitle').textContent = '📊 ' + name;
  document.getElementById('vizSub').textContent = cwd;
  const body = document.getElementById('vizBody');
  body.innerHTML = '<div class="empty">Reading git history…</div>';
  try {
    const r = await fetch('/api/repo-history?cwd=' + encodeURIComponent(cwd));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    body.innerHTML = renderViz(d);
  } catch (e) {
    body.innerHTML = '<div class="empty">Could not load history: ' + esc(e.message) + '</div>';
  }
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function fmtDate(iso) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isNaN(t) ? '—' : new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderViz(d) {
  const r = d.repo || {};
  let h = '';

  // Overview stats
  h += `<div class="viz-section"><div class="viz-stats">
    <div class="viz-stat"><b>${(r.totalCommits || 0).toLocaleString()}</b><span>commits</span></div>
    <div class="viz-stat"><b>${(r.contributors || 0).toLocaleString()}</b><span>contributors</span></div>
    <div class="viz-stat"><b>${esc(r.branch || '—')}</b><span>branch @ ${esc(r.head || '')}</span></div>
    <div class="viz-stat"><b>${fmtDate(r.firstDate)}</b><span>first commit</span></div>
    <div class="viz-stat"><b>${fmtDate(r.lastDate)}</b><span>latest commit</span></div>
  </div>${r.remoteUrl ? `<div class="csub" style="margin-top:8px">⎇ ${esc(r.remoteUrl)}</div>` : ''}</div>`;

  // Commits per week (52w)
  const weekly = d.weekly || [];
  const maxW = Math.max(1, ...weekly);
  h += `<div class="viz-section"><h3>Commits per week · last 52 weeks</h3>
    <div class="bars">${weekly.map((c, i) =>
      `<i style="height:${Math.round(c / maxW * 100)}%" title="${52 - i}w ago: ${c} commit${c !== 1 ? 's' : ''}"></i>`).join('')}</div></div>`;

  // Top contributors
  const contribs = d.contributors || [];
  if (contribs.length) {
    const maxC = Math.max(1, ...contribs.map(c => c.count));
    h += `<div class="viz-section"><h3>Top contributors</h3>${contribs.map(c =>
      `<div class="crow"><span class="cname" title="${esc(c.name)}">${esc(c.name)}</span>` +
      `<span class="cbar" style="width:${Math.round(c.count / maxC * 100)}%"></span>` +
      `<span class="ccount">${c.count.toLocaleString()}</span></div>`).join('')}</div>`;
  }

  // Languages (by extension byte share)
  const langs = Object.entries(d.languages || {}).sort((a, b) => b[1] - a[1]);
  const totalBytes = langs.reduce((s, [, n]) => s + n, 0);
  if (langs.length && totalBytes) {
    const top = langs.slice(0, 10);
    const maxL = top[0][1];
    h += `<div class="viz-section"><h3>Code by file type</h3>${top.map(([ext, bytes]) =>
      `<div class="crow"><span class="cname">.${esc(ext)}</span>` +
      `<span class="cbar" style="width:${Math.round(bytes / maxL * 100)}%"></span>` +
      `<span class="ccount">${(bytes / totalBytes * 100).toFixed(0)}%</span></div>`).join('')}</div>`;
  }

  // Punch-card heatmap (weekday × hour)
  const pc = d.punchCard || [];
  const maxP = Math.max(1, ...pc.flat());
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let cells = '<span class="plabel"></span>';
  for (let hr = 0; hr < 24; hr++) cells += `<span class="phour">${hr % 6 === 0 ? hr : ''}</span>`;
  for (let day = 0; day < 7; day++) {
    cells += `<span class="plabel">${days[day]}</span>`;
    for (let hr = 0; hr < 24; hr++) {
      const v = (pc[day] && pc[day][hr]) || 0;
      const op = v ? (0.15 + 0.85 * v / maxP).toFixed(2) : 0.06;
      cells += `<span class="pcell" style="opacity:${op}" title="${days[day]} ${hr}:00 — ${v} commit${v !== 1 ? 's' : ''}"></span>`;
    }
  }
  h += `<div class="viz-section"><h3>When commits happen · weekday × hour (local time)</h3><div class="punch">${cells}</div></div>`;

  // Recent commits
  const rc = d.recentCommits || [];
  if (rc.length) {
    h += `<div class="viz-section"><h3>Recent commits</h3>${rc.map(c =>
      `<div class="commit"><span class="sha">${esc(c.sha)}</span>` +
      `<span class="cmsg" title="${esc(c.message)}">${esc(c.message)}</span>` +
      `<span class="cmeta">${esc(c.author)} · ${timeAgo(Date.parse(c.date))}</span></div>`).join('')}</div>`;
  }

  return h;
}

// ---- Current-work dashboard ------------------------------------------------
// An at-a-glance overlay aggregating live state across ALL projects: what needs
// your attention, what's running, what's context-heavy, and what's uncommitted.
// Sessions come straight from the cached /api/sessions poll (DATA); git state is
// fetched from /api/housekeeping on open (heavier, so not on every 5s tick).
let dashGit = null; // last housekeeping repos, or null while loading
function dashOpen() { return document.getElementById('dashOverlay').classList.contains('show'); }

function openDashboard() {
  document.getElementById('dashOverlay').classList.add('show');
  document.body.classList.add('overlay-open');
  dashGit = null;
  renderDashboard();
  loadDashGit();
}
function closeDashboard() {
  document.getElementById('dashOverlay').classList.remove('show');
  document.body.classList.remove('overlay-open');
}

async function loadDashGit() {
  try {
    const r = await fetch('/api/housekeeping');
    const d = await r.json();
    dashGit = d.repos || [];
  } catch { dashGit = []; }
  if (dashOpen()) renderDashboard();
}

// One clickable session row (opens the in-app chat).
function dashRow({ p, s }) {
  const ctxTok = s.contextTokens || 0;
  const win = s.contextWindow || ((ctxTok > 200000) ? 1000000 : CTX_WINDOW);
  const pct = Math.min(100, Math.round(ctxTok / win * 100));
  return `<div class="dash-row" data-dashsession="${esc(s.sessionId)}" title="Open this session">
    <span class="light ${s.status}" title="${STATUS_LABEL[s.status] || s.status}"></span>
    <span class="pill ${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
    <div class="dr-main">
      <div class="dr-title">${esc(s.title)}</div>
      <div class="dr-sub">${esc(p.name)}${s.gitBranch ? ' · ⎇ ' + esc(s.gitBranch) : ''} · ${esc(s.lastPrompt) || '<em>no prompt</em>'}</div>
    </div>
    <div class="dr-meta">${timeAgo(s.mtimeMs)}<br><span class="tok">${fmtTok(ctxTok)} ctx · ${pct}%</span></div>
  </div>`;
}

// One repo row with uncommitted/unpushed work (opens Wrap-up to act on it).
function dashRepoRow(r) {
  const g = r.git || {};
  const line = `⎇ ${esc(g.branch || '?')}${g.dirty ? ` · ${g.dirty} uncommitted` : ''}${g.ahead ? ` · ${g.ahead} unpushed` : ''}`;
  return `<div class="dash-row" data-dashrepo="1" title="Open Wrap-up to commit / push">
    <span class="vbadge ${r.verdict}">${VERDICT_LABEL[r.verdict]}</span>
    <div class="dr-main">
      <div class="dr-title">${esc(r.name)}</div>
      <div class="dash-gitline">${line}</div>
    </div>
  </div>`;
}

function renderDashboard() {
  // Flatten non-archived sessions; "current work" = recent (non-stale) ones.
  const all = [];
  for (const p of DATA.projects) for (const s of p.sessions)
    if (!s.archived) all.push({ p, s });
  const active = all.filter(x => !isStale(x.s));

  const counts = { working: 0, waiting: 0, interrupted: 0 };
  for (const { s } of active) if (counts[s.status] !== undefined) counts[s.status]++;
  const liveTerminals = DATA.projects.reduce((n, p) => n + (p.liveTerminals || 0), 0);
  const activeProjects = new Set(active.map(x => x.p.cwd)).size;

  document.getElementById('dashSub').textContent =
    `${counts.working} working · ${counts.waiting} your turn · ${counts.interrupted} interrupted · across ${activeProjects} project${activeProjects !== 1 ? 's' : ''}`;

  let h = `<div class="dash-stats">
    <div class="dash-stat waiting"><b>${counts.waiting}</b><span>your turn</span></div>
    <div class="dash-stat working"><b>${counts.working}</b><span>working</span></div>
    <div class="dash-stat interrupted"><b>${counts.interrupted}</b><span>interrupted</span></div>
    <div class="dash-stat"><b>${activeProjects}</b><span>active project${activeProjects !== 1 ? 's' : ''}</span></div>
    <div class="dash-stat"><b>${liveTerminals}</b><span>live terminal${liveTerminals !== 1 ? 's' : ''}</span></div>
  </div>`;

  // Needs your attention: a turn finished (waiting) or stalled (interrupted).
  const attention = active.filter(x => x.s.status === 'waiting' || x.s.status === 'interrupted')
    .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs);
  h += `<div class="dash-sec"><h3>Needs your attention</h3>${
    attention.length ? attention.map(dashRow).join('') : '<div class="dash-empty">Nothing waiting — all caught up.</div>'}</div>`;

  // In progress now.
  const working = active.filter(x => x.s.status === 'working').sort((a, b) => b.s.mtimeMs - a.s.mtimeMs);
  h += `<div class="dash-sec"><h3>In progress now</h3>${
    working.length ? working.map(dashRow).join('') : '<div class="dash-empty">Nothing running.</div>'}</div>`;

  // Context heavy: sessions past the warn threshold, fullest first.
  const heavy = active.map(x => {
    const ctxTok = x.s.contextTokens || 0;
    const win = x.s.contextWindow || ((ctxTok > 200000) ? 1000000 : CTX_WINDOW);
    return { x, pct: Math.min(100, Math.round(ctxTok / win * 100)) };
  }).filter(o => o.pct >= CTX_WARN).sort((a, b) => b.pct - a.pct);
  if (heavy.length) {
    h += `<div class="dash-sec"><h3>Context heavy</h3>${heavy.map(o => dashRow(o.x)).join('')}</div>`;
  }

  // Uncommitted / unpushed work, from the housekeeping scan.
  let gitSec;
  if (dashGit === null) {
    gitSec = '<div class="dash-empty">Checking repositories…</div>';
  } else {
    const dirty = dashGit.filter(r => r.verdict === 'dirty' || r.verdict === 'unpushed');
    gitSec = dirty.length ? dirty.map(dashRepoRow).join('')
      : '<div class="dash-empty">Everything committed and pushed.</div>';
  }
  h += `<div class="dash-sec"><h3>Uncommitted work</h3>${gitSec}</div>`;

  document.getElementById('dashBody').innerHTML = h;
}

document.getElementById('dashBody').addEventListener('click', e => {
  const sRow = e.target.closest('[data-dashsession]');
  if (sRow) { const id = sRow.dataset.dashsession; closeDashboard(); openChat(id); return; }
  if (e.target.closest('[data-dashrepo]')) { closeDashboard(); openHousekeeping(); }
});
document.getElementById('dashboard').addEventListener('click', openDashboard);
document.getElementById('dashClose').addEventListener('click', closeDashboard);
document.getElementById('dashRefresh').addEventListener('click', () => { renderDashboard(); loadDashGit(); });
document.getElementById('dashOverlay').addEventListener('click', e => { if (e.target.id === 'dashOverlay') closeDashboard(); });

async function load() {
  try {
    const r = await fetch('/api/sessions');
    DATA = await r.json();
    refreshKnownSessions();
    trackTransitions();
    render();
    if (dashOpen()) renderDashboard(); // keep the open dashboard live with the 5s poll
    handleVersion(DATA.version);
    handleUsage(DATA.usage);
    handleModels(DATA.models);
    if (!hashJumped) { hashJumped = true; jumpToHashSession(); } // honor #session=… on first load
  } catch (e) {
    // load() is both the initial fetch and the 5s poll. A transient poll
    // failure (server briefly busy/restarting — Safari reports "Load failed")
    // must NOT blank the last good render; only show the error if we've never
    // loaded. Persistent outages still surface via a throttled toast.
    if (!DATA.generatedAt) {
      document.getElementById('content').innerHTML = '<div class="empty">Failed to load: ' + esc(e.message) + '</div>';
    } else if (Date.now() - lastLoadErrorToast > 30000) {
      lastLoadErrorToast = Date.now();
      toast('Refresh failed (' + esc(e.message) + ') — showing last known state', true);
    }
  }
}
let lastLoadErrorToast = 0;

// --- "While you were away" -----------------------------------------------------
// Sessions whose turn finished (working -> anything else) since you last looked.
// Recorded on every poll for sessions you weren't watching in the open chat, or
// while the window wasn't focused; shown as a dismissable strip above the list
// and (if permitted) as a desktop notification. Dismiss clears the strip.
const prevStatus = new Map(); // sessionId -> last seen status
let awayEvents = [];          // [{ sessionId, title, project, status, at }]
function trackTransitions() {
  const focusedOnIt = (id) => chat.sessionId === id && document.hasFocus()
    && document.getElementById('overlay').classList.contains('show');
  for (const p of DATA.projects) for (const s of p.sessions) {
    const prev = prevStatus.get(s.sessionId);
    prevStatus.set(s.sessionId, s.status);
    if (prev !== 'working' || s.status === 'working') continue;
    if (focusedOnIt(s.sessionId)) continue;
    awayEvents = awayEvents.filter(e => e.sessionId !== s.sessionId);
    awayEvents.unshift({ sessionId: s.sessionId, title: s.title, project: p.name, status: s.status, at: Date.now() });
    if (chat.sessionId !== s.sessionId) notifySession(s, p);
  }
  if (awayEvents.length > 12) awayEvents.length = 12;
  renderAway();
}
function renderAway() {
  const el = document.getElementById('away');
  if (!el) return;
  if (!awayEvents.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<div class="away-head"><strong>While you were away</strong> — ${awayEvents.length} session${awayEvents.length > 1 ? 's' : ''} finished a turn
      <button id="awayDismiss" title="Clear this list">Dismiss</button></div>` +
    awayEvents.map(e => `<div class="away-row" data-session="${esc(e.sessionId)}" title="Open this session">
      <span class="light ${esc(e.status)}"></span>
      <span class="pill ${esc(e.status)}">${esc(STATUS_LABEL[e.status] || e.status)}</span>
      <span class="away-title">${esc(e.title)}</span>
      <span class="away-proj">${esc(e.project)} · ${timeAgo(e.at)}</span>
    </div>`).join('');
  el.querySelector('#awayDismiss').onclick = () => { awayEvents = []; renderAway(); };
  el.querySelectorAll('.away-row').forEach(r => r.onclick = () => {
    awayEvents = awayEvents.filter(e => e.sessionId !== r.dataset.session); renderAway(); openChat(r.dataset.session);
  });
}
// Desktop notification for a session finishing while you weren't watching it.
function notifySession(s, p) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification((STATUS_LABEL[s.status] || 'Finished') + ' — ' + (p.name || 'session'), {
      body: s.title, tag: 'claudenav-' + s.sessionId,
    });
    n.onclick = () => { window.focus(); openChat(s.sessionId); n.close(); };
  } catch {}
}

// --- Usage limits ------------------------------------------------------------
// Mirrors Claude Code's /usage menu: a compact row of bars for the current
// session and the weekly limits, fed by the server's /api/oauth/usage proxy.
function fmtReset(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins <= 0) return 'resets now';
  if (mins < 60) return `resets in ${mins} min`;
  const hrs = Math.floor(mins / 60), rem = mins % 60;
  if (hrs < 24) return `resets in ${hrs} hr${rem ? ' ' + rem + ' min' : ''}`;
  return 'resets ' + new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
// Compact form of the reset countdown for the always-visible chip next to each
// bar (the full phrasing stays in the hover tooltip).
function fmtResetShort(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return mins + 'm';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h';
  return Math.round(hrs / 24) + 'd';
}
function handleUsage(u) {
  const el = document.getElementById('usage');
  if (!el) return;
  const bars = u ? [u.session, u.weeklyAll, u.weeklyScoped].filter(Boolean) : [];
  if (!bars.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = bars.map(b => {
    const pct = Math.max(0, Math.min(100, b.percent));
    const cls = pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '';
    const tip = esc(b.label + ' — ' + pct + '% used' + (b.resets_at ? ' · ' + fmtReset(b.resets_at) : ''));
    const short = fmtResetShort(b.resets_at);
    return `<span class="u" title="${tip}">`
      + `<span class="u-label">${esc(b.label)}</span>`
      + `<span class="u-bar"><span class="u-fill ${cls}" style="width:${pct}%"></span></span>`
      + `<span class="u-pct">${pct}%</span>`
      + (short ? `<span class="u-reset" aria-label="resets">↻ ${esc(short)}</span>` : '')
      + `</span>`;
  }).join('');
}

// --- In-app update / relaunch ------------------------------------------------
// firstVersion = what the server reported when this tab loaded. We compare every
// poll against it to spot a restarted backend, new on-disk code, or upstream commits.
let firstVersion = null;
let updateState = null; // 'reload' | 'relaunch' | 'update' | null
function handleVersion(v) {
  if (!v) return;
  if (!firstVersion) { firstVersion = v; }
  const btn = document.getElementById('updateBtn');
  let state = null, label = '', title = '', stale = false;
  if (v.bootId !== firstVersion.bootId) {
    // Backend restarted under us — the served page may be stale. Just reload.
    state = 'reload'; label = '↻ Update ready — reload';
    title = 'ClaudeNav restarted with new code. Reload to pick it up.';
  } else if (v.head && v.bootHead && v.head !== v.bootHead) {
    // Code on disk changed but this process is still running the old commit.
    state = 'relaunch'; label = '⟳ New code — relaunch'; stale = true;
    title = `Disk is at ${v.head} but the server is still running ${v.bootHead}. Relaunch to apply.`;
  } else if (v.hasRemote && v.behind > 0) {
    state = 'update';
    if (v.ahead > 0) {
      // Diverged: a --ff-only pull will refuse. Don't offer a doomed button —
      // show a non-actionable warning; the fix is manual (reset to origin).
      state = 'blocked';
      label = `⚠ ${v.behind} behind — can't auto-update`; stale = true;
      title = `origin is ${v.behind} commit(s) ahead but this checkout has ${v.ahead} local commit(s), so a fast-forward update isn't possible. Reset the ClaudeNav repo to origin/main, then relaunch.`;
    } else if (v.dirty > 0) {
      label = `⬆ ${v.behind} update${v.behind > 1 ? 's' : ''} available`; stale = true;
      title = `origin is ${v.behind} commit(s) ahead, but the working tree has ${v.dirty} uncommitted change(s) — a fast-forward update may fail.`;
    } else {
      label = `⬆ Update & relaunch (${v.behind})`;
      title = `Pull ${v.behind} new commit(s) from origin and relaunch the server.`;
    }
  }
  updateState = state;
  if (!btn) return;
  if (btn.dataset.busy === '1') return; // a relaunch is in flight — leave the label alone
  btn.hidden = false;
  if (!state) {
    // Up to date: a quiet, non-actionable status chip (keeps the feature visible).
    btn.disabled = true;
    btn.classList.add('idle');
    btn.classList.remove('stale');
    btn.textContent = '✓ Up to date';
    btn.title = `ClaudeNav is running the latest code (${v.head || v.bootHead || '—'}).`;
  } else {
    // 'blocked' = behind but can't fast-forward (diverged): warn, don't offer a click.
    btn.disabled = state === 'blocked';
    btn.classList.remove('idle');
    btn.classList.toggle('stale', stale);
    btn.textContent = label;
    btn.title = title;
  }
}

async function doUpdate() {
  const btn = document.getElementById('updateBtn');
  if (updateState === 'reload') { location.reload(); return; }
  if (updateState !== 'update' && updateState !== 'relaunch') return; // 'blocked'/none: nothing to do
  const pull = updateState === 'update';
  btn.dataset.busy = '1';
  btn.disabled = true;
  btn.classList.remove('idle');
  btn.textContent = pull ? 'Updating…' : 'Relaunching…';
  try {
    const r = await fetch('/api/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pull }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'update failed');
  } catch (e) {
    toast('Update failed: ' + e.message, true);
    btn.dataset.busy = ''; btn.disabled = false; handleVersion(DATA.version);
    return;
  }
  // Server is exiting; run-server.sh relaunches it. Poll until a new bootId, then reload.
  toast('Restarting ClaudeNav…');
  const oldBoot = firstVersion ? firstVersion.bootId : null;
  for (let i = 0; i < 40; i++) {
    await new Promise(res => setTimeout(res, 500));
    try {
      const v = await (await fetch('/api/version')).json();
      if (v.bootId && v.bootId !== oldBoot) { location.reload(); return; }
    } catch { /* server still down between exit and relaunch */ }
  }
  toast('Server is taking a while — reload manually when it’s back.', true);
  btn.dataset.busy = ''; btn.disabled = false;
}

// --- Housekeeping / Wrap-up --------------------------------------------------
const VERDICT_LABEL = { clean: 'Safe to close', dirty: 'Unsaved changes', unpushed: 'Unpushed commits', busy: 'Busy — working' };
let HK = { repos: [] };
const hkResult = {}; // cwd -> { state, text }  progress/result per repo

function openHousekeeping() {
  document.getElementById('hkOverlay').classList.add('show');
  document.body.classList.add('overlay-open');
  loadHousekeeping();
}
function closeHousekeeping() { document.getElementById('hkOverlay').classList.remove('show'); document.body.classList.remove('overlay-open'); }

async function loadHousekeeping() {
  const body = document.getElementById('hkBody');
  body.innerHTML = '<div class="empty">Scanning repositories…</div>';
  try {
    const r = await fetch('/api/housekeeping');
    HK = await r.json();
    renderHk();
  } catch (e) { body.innerHTML = '<div class="empty">Failed: ' + esc(e.message) + '</div>'; }
}

function renderHk() {
  const d = HK;
  const counts = { dirty: 0, unpushed: 0, busy: 0, clean: 0 };
  d.repos.forEach(r => counts[r.verdict]++);
  document.getElementById('hkSub').textContent =
    `${counts.clean} safe · ${counts.dirty} unsaved · ${counts.unpushed} unpushed · ${counts.busy} busy`;
  const wrappable = d.repos.filter(r => r.verdict !== 'busy').length;
  const unsaved = d.repos.filter(r => r.verdict === 'dirty').length;
  const body = document.getElementById('hkBody');
  body.innerHTML =
    `<div class="hk-bulk">
       <button class="primary" id="wrapAll" ${wrappable ? '' : 'disabled'}>▶ Wrap up ${wrappable} safe-candidate folder${wrappable !== 1 ? 's' : ''}</button>
       <span class="hint">enquires each session, saves &amp; pushes, then closes — work-in-progress is left open</span>
     </div>
     <div class="hk-bulk">
       <button id="commitAll" ${unsaved ? '' : 'disabled'} title="Commit every folder with uncommitted changes (no push, no close). Busy folders are skipped.">💾 Commit all unsaved (${unsaved})</button>
       <span class="hint">just saves — nothing is pushed or closed</span>
     </div>`
    + (d.repos.map(repoHtml).join('') || '<div class="empty">No sessions.</div>');
  body.querySelector('#wrapAll')?.addEventListener('click', wrapAll);
  body.querySelector('#commitAll')?.addEventListener('click', commitAll);
  body.querySelectorAll('button[data-commit]').forEach(b => b.onclick = () => doCommit(b.dataset.commit, b.dataset.name));
  body.querySelectorAll('button[data-push]').forEach(b => b.onclick = () => doPush(b.dataset.push));
  body.querySelectorAll('button[data-assess]').forEach(b => b.onclick = () => doAssess(b.dataset.assess));
  body.querySelectorAll('button[data-close]').forEach(b => b.onclick = () => doClose(b.dataset.close, b.dataset.name));
  body.querySelectorAll('button[data-merge]').forEach(b => b.onclick = () => doMerge(b.dataset.merge, b.dataset.name));
}

// Commit every dirty, non-busy repo in turn (sequential — each is a git call
// plus a re-scan). Uses the same per-folder doCommit path as the row button.
async function commitAll() {
  const targets = HK.repos.filter(r => r.verdict === 'dirty');
  if (!targets.length) return;
  if (!confirm(`Commit uncommitted changes in ${targets.length} folder${targets.length > 1 ? 's' : ''}?\n\n${targets.map(r => '• ' + r.name).join('\n')}\n\nNothing is pushed or closed.`)) return;
  const msg = prompt('One commit message for all of them:', 'checkpoint (ClaudeNav wrap-up)');
  if (msg === null) return;
  const btn = document.getElementById('commitAll');
  if (btn) { btn.disabled = true; btn.textContent = 'Committing…'; }
  let ok = 0, failed = 0;
  for (const r of targets) {
    try { await api('/api/commit', { cwd: r.cwd, message: msg }); setRes(r.cwd, 'ok', 'Committed'); ok++; }
    catch (e) { setRes(r.cwd, 'err', 'Commit failed: ' + e.message); failed++; }
  }
  toast(`Committed ${ok} folder${ok !== 1 ? 's' : ''}${failed ? ` · ${failed} failed` : ''}`, failed > 0);
  loadHousekeeping();
}

async function doMerge(wtPath, name) {
  if (!confirm(`Merge ${name} back into its main checkout and remove the worktree?\n\nRefuses if main has uncommitted changes.`)) return;
  try {
    const r = await fetch('/api/worktree-merge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: wtPath }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    toast(`Merged ${j.branch} into ${j.into}`); loadHousekeeping();
  } catch (e) { toast('Merge failed: ' + e.message, true); }
}

function repoHtml(r) {
  const g = r.git || {};
  const gitline = !g.isRepo ? 'not a git repo'
    : `⎇ ${esc(g.branch || '?')}${g.dirty ? ` · ${g.dirty} uncommitted` : ''}${g.ahead ? ` · ${g.ahead} ahead` : ''}${g.behind ? ` · ${g.behind} behind` : ''}${g.hasRemote ? '' : ' · no remote'}`;
  const files = (g.files && g.files.length) ? `<div class="files">${g.files.map(esc).join('\n')}</div>` : '';
  const idleSession = r.sessions.find(s => s.status !== 'working');
  const actions = [];
  if (r.verdict !== 'busy' && idleSession)
    actions.push(`<button data-assess="${esc(idleSession.sessionId)}">Enquire (AI)</button>`);
  if (r.verdict === 'dirty') actions.push(`<button class="primary" data-commit="${esc(r.cwd)}" data-name="${esc(r.name)}">Commit</button>`);
  if (g.ahead > 0 && g.hasRemote) actions.push(`<button data-push="${esc(r.cwd)}">Push</button>`);
  if (r.verdict !== 'busy' && r.liveTerminals > 0)
    actions.push(`<button data-close="${esc(r.sessions[0]?.sessionId || '')}" data-name="${esc(r.name)}">Close terminal${r.liveTerminals > 1 ? 's' : ''}</button>`);
  const isWorktree = /\/\.claude\/worktrees\//.test(r.cwd);
  if (isWorktree && r.verdict !== 'busy')
    actions.push(`<button class="primary" data-merge="${esc(r.cwd)}" data-name="${esc(r.name)}">Merge to main</button>`);
  const res = hkResult[r.cwd];
  const resLine = res ? `<div class="hkres ${res.state}">${esc(res.text)}</div>` : '';
  return `<div class="repo">
    <div class="repo-head">
      <span class="vbadge ${r.verdict}">${VERDICT_LABEL[r.verdict]}</span>
      <span class="repo-name">${esc(r.name)}</span>
      <span class="repo-path">${esc(r.cwd)}</span>
    </div>
    <div class="repo-detail">
      <div class="gitline">${gitline} · ${r.sessions.length} session${r.sessions.length > 1 ? 's' : ''}${r.liveTerminals ? ` · ${r.liveTerminals} live` : ''}</div>
      ${files}${resLine}
      <div class="repo-actions">${actions.join('') || '<span class="hint">nothing to do — safe to close</span>'}</div>
    </div>
  </div>`;
}

function setRes(cwd, state, text) { hkResult[cwd] = { state, text }; renderHk(); }

async function api(path, payload) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'failed');
  return j;
}

async function doArchive(sessionId, archived) {
  try {
    await api('/api/archive', { session: sessionId, archived });
    // Reflect immediately without waiting for the next poll.
    for (const p of DATA.projects) for (const s of p.sessions)
      if (s.sessionId === sessionId) s.archived = archived;
    toast(archived ? 'Session archived' : 'Session unarchived');
    render();
  } catch (e) { toast('Archive failed: ' + e.message, true); }
}

async function doCommit(cwd, name) {
  const msg = prompt(`Commit message for ${name}:`, 'checkpoint (ClaudeNav wrap-up)');
  if (msg === null) return;
  try { await api('/api/commit', { cwd, message: msg }); toast('Committed ' + name); loadHousekeeping(); }
  catch (e) { toast('Commit failed: ' + e.message, true); }
}
async function doPush(cwd) {
  try { await api('/api/push', { cwd }); toast('Pushed'); loadHousekeeping(); }
  catch (e) { toast('Push failed: ' + e.message, true); }
}
async function doAssess(sessionId) {
  const repo = HK.repos.find(r => r.sessions.some(s => s.sessionId === sessionId));
  if (repo) setRes(repo.cwd, 'pending', 'Enquiring…');
  try {
    const v = await api('/api/assess', { session: sessionId });
    if (repo) setRes(repo.cwd, v.safe ? 'safe' : 'wip', (v.safe ? '🟢 Safe — ' : '🔴 WIP — ') + (v.reason || ''));
  } catch (e) { if (repo) setRes(repo.cwd, 'wip', 'Enquiry failed: ' + e.message); }
}
async function doClose(sessionId, name) {
  if (!confirm(`Close the live terminal(s) for ${name}? The session is saved and can be resumed.`)) return;
  try { const j = await api('/api/close', { session: sessionId }); toast(`Closed ${j.killed} terminal(s) in ${name}`); setTimeout(loadHousekeeping, 800); }
  catch (e) { toast('Close failed: ' + e.message, true); }
}

// The orchestrated command: enquire each candidate, save+push, then exit. WIP stays open.
async function wrapAll() {
  const candidates = HK.repos.filter(r => r.verdict !== 'busy');
  if (!candidates.length) return;
  if (!confirm(`Wrap up ${candidates.length} folder(s)?\n\nFor each: ask the session if it's safe, commit + push if there are changes, then close its terminal. Anything flagged work-in-progress is left open and untouched.`)) return;
  const btn = document.getElementById('wrapAll'); if (btn) btn.disabled = true;

  for (const r of candidates) {
    const idle = r.sessions.find(s => s.status !== 'working');
    try {
      // 1. Enquire
      let verdict = { safe: true, reason: 'no session to ask', commitMessage: '' };
      if (idle) { setRes(r.cwd, 'pending', 'Enquiring…'); verdict = await api('/api/assess', { session: idle.sessionId }); }
      if (!verdict.safe) { setRes(r.cwd, 'wip', '🔴 WIP — left open — ' + (verdict.reason || '')); continue; }

      // 2. Update repo
      const did = [];
      if (r.git?.isRepo && r.git.dirty > 0) {
        setRes(r.cwd, 'pending', 'Committing…');
        await api('/api/commit', { cwd: r.cwd, message: verdict.commitMessage || 'checkpoint (ClaudeNav wrap-up)' });
        did.push('committed');
      }
      if (r.git?.isRepo && r.git.hasRemote) {
        try { setRes(r.cwd, 'pending', 'Pushing…'); await api('/api/push', { cwd: r.cwd }); did.push('pushed'); } catch {}
      }
      // 3. Gracefully exit
      if (r.liveTerminals > 0 && idle) {
        setRes(r.cwd, 'pending', 'Closing…');
        try { await api('/api/close', { session: idle.sessionId }); did.push('closed'); } catch {}
      }
      setRes(r.cwd, 'safe', '🟢 Wrapped' + (did.length ? ' — ' + did.join(', ') : ' — nothing to do'));
    } catch (e) {
      setRes(r.cwd, 'wip', 'Skipped — ' + e.message);
    }
  }
  toast('Wrap-up complete');
  setTimeout(loadHousekeeping, 1000);
}

// ---- New project ----------------------------------------------------------
// Browse the filesystem (server-driven, bounded to $HOME), optionally create a
// folder, then start a plain headless session in it — offering `git init` first
// for non-repos so the wrap-up/commit machinery works from day one. The folder
// you're *viewing* is the one you start in; descend into it, then Start.
let npState = { path: null, parent: null, isRepo: false };

function openNewProject() {
  document.getElementById('newProjOverlay').classList.add('show');
  document.body.classList.add('overlay-open');
  npNewFormReset();
  npBrowse(''); // server defaults to $HOME
}
function closeNewProject() {
  document.getElementById('newProjOverlay').classList.remove('show');
  document.body.classList.remove('overlay-open');
}
function npOpen() { return document.getElementById('newProjOverlay').classList.contains('show'); }

async function npBrowse(p) {
  const list = document.getElementById('npList');
  list.innerHTML = '<div class="np-empty">Loading…</div>';
  let j;
  try {
    const r = await fetch('/api/browse?path=' + encodeURIComponent(p || ''));
    j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
  } catch (e) { list.innerHTML = '<div class="np-empty">' + esc(e.message) + '</div>'; return; }

  npState = { path: j.path, parent: j.parent, isRepo: j.isRepo };
  document.getElementById('npPath').textContent = j.path;
  document.getElementById('npPath').title = j.path;
  document.getElementById('npUp').disabled = !j.parent;

  list.innerHTML = j.dirs.length
    ? j.dirs.map(d => `<div class="np-row" data-path="${esc(d.path)}">📁 ${esc(d.name)}</div>`).join('')
    : '<div class="np-empty">No sub-folders here.</div>';

  // Selected = the folder you're currently in. Reflect its git state.
  document.getElementById('npSelected').textContent = j.path;
  document.getElementById('npStart').disabled = false;
  const gl = document.getElementById('npGitLine');
  if (j.isRepo) {
    gl.innerHTML = '✓ Git repo — commit &amp; wrap-up ready.';
  } else {
    gl.innerHTML = '<label><input type="checkbox" id="npGitInit" checked> <code>git init</code> first — enables commit, push &amp; wrap-up.</label>';
  }
  npNewFormReset();
}

function npNewFormReset() {
  document.getElementById('npNewForm').hidden = true;
  document.getElementById('npNewToggle').hidden = false;
  document.getElementById('npNewName').value = '';
}

async function npCreateFolder() {
  const name = document.getElementById('npNewName').value.trim();
  if (!name) return;
  try {
    const j = await api('/api/mkdir', { parent: npState.path, name });
    await npBrowse(j.path); // descend into the freshly-created folder
    toast('Folder created');
  } catch (e) { toast('Create failed: ' + e.message, true); }
}

async function npStart() {
  const cwd = npState.path;
  if (!cwd) return;
  const name = cwd.split('/').filter(Boolean).slice(-1)[0] || cwd;
  const initEl = document.getElementById('npGitInit');
  try {
    if (!npState.isRepo && initEl && initEl.checked) {
      toast('Initialising git repo…');
      await api('/api/git-init', { cwd });
    }
    closeNewProject();
    openNewChat(cwd, name);
    load(); // surface the new folder once the first turn lands
  } catch (e) { toast('Could not start: ' + e.message, true); }
}

// The "+ New project" button now opens a small chooser: the guided website
// wizard, or the original folder picker (unchanged, one click deeper).
function openProjChoice() {
  document.getElementById('projChoiceOverlay').classList.add('show');
  document.body.classList.add('overlay-open');
}
function closeProjChoice() {
  document.getElementById('projChoiceOverlay').classList.remove('show');
  document.body.classList.remove('overlay-open');
}
document.getElementById('newProject').addEventListener('click', openProjChoice);
document.getElementById('pcClose').addEventListener('click', closeProjChoice);
document.getElementById('pcFolder').addEventListener('click', () => { closeProjChoice(); openNewProject(); });
document.getElementById('pcWebsite').addEventListener('click', () => { closeProjChoice(); openSiteWizard(); });

// ---- Website wizard -------------------------------------------------------
// Guided, git-free path for non-devs: name a site → server provisions a folder,
// a starter page, a GitHub repo (pushed) and GitHub Pages, then hands off to the
// in-browser chat. Publishing later is just commit + push (Pages redeploys).
let wizState = { authed: false, done: null };

function wizShow(step) {
  for (const id of ['wizForm', 'wizWorking', 'wizDone'])
    document.getElementById(id).hidden = (id !== step);
}

async function openSiteWizard() {
  document.getElementById('wizOverlay').classList.add('show');
  document.body.classList.add('overlay-open');
  wizShow('wizForm');
  document.getElementById('wizName').value = '';
  document.getElementById('wizUrl').textContent = '';
  document.getElementById('wizCreate').disabled = true;
  document.getElementById('wizSub').textContent = 'Give your site a name to get started.';
  await wizCheckGh();
  document.getElementById('wizName').focus();
}
function closeSiteWizard() {
  document.getElementById('wizOverlay').classList.remove('show');
  document.body.classList.remove('overlay-open');
}

// Shared GitHub-connection status line for both website wizards. Renders into
// `el` and calls onReady(status) each time it settles (after a check or retry).
// Queries are scoped to `el` so the two wizards never fight over element ids.
async function renderGhStatus(el, onReady) {
  el.innerHTML = '<span class="dot"></span><span>Checking GitHub…</span>';
  let s;
  try { s = await (await fetch('/api/gh-status')).json(); } catch { s = {}; }
  const isWin = s.platform === 'win32';
  if (!s.installed) {
    // Windows: winget is the one-liner most people have; keep the download link
    // as a fallback. macOS/Linux: point at the download page.
    const hint = isWin
      ? 'GitHub CLI not found — install it (in a terminal: <code>winget install --id GitHub.cli</code>) '
        + 'or from <a href="#" class="gh-cli">cli.github.com</a>, then <a href="#" class="gh-retry">re-check</a>.'
      : 'GitHub CLI not found — install it from <a href="#" class="gh-cli">cli.github.com</a>, '
        + 'then <a href="#" class="gh-retry">re-check</a>.';
    el.innerHTML = '<span class="dot no"></span><span>' + hint + '</span>';
    el.querySelector('.gh-cli').onclick = (e) => { e.preventDefault(); openExternal('https://cli.github.com'); };
    el.querySelector('.gh-retry').onclick = (e) => { e.preventDefault(); renderGhStatus(el, onReady); };
  } else if (!s.authed) {
    const opens = isWin ? 'opens a new terminal window' : 'opens a terminal';
    el.innerHTML = '<span class="dot no"></span><span>Not signed in — '
      + '<a href="#" class="gh-login">Connect GitHub</a> (' + opens + ' running <code>gh auth login</code>), '
      + 'then <a href="#" class="gh-retry">re-check</a>.</span>';
    el.querySelector('.gh-login').onclick = async (e) => {
      e.preventDefault();
      try { await api('/api/open', { ghLogin: true }); toast('Follow the GitHub sign-in in the terminal window, then re-check.'); }
      catch (err) { toast('Could not open a terminal for sign-in: ' + err.message + ' — you can run `gh auth login` yourself, then re-check.', true); }
    };
    el.querySelector('.gh-retry').onclick = (e) => { e.preventDefault(); renderGhStatus(el, onReady); };
  } else {
    el.innerHTML = '<span class="dot ok"></span><span>Signed in as <b>' + esc(s.user) + '</b></span>';
  }
  onReady(s);
  return s;
}

function wizCheckGh() {
  return renderGhStatus(document.getElementById('wizGh'), (s) => {
    wizState.authed = !!s.authed;
    wizSyncCreate();
  });
}

function wizSlug(name) {
  return (name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
function wizSyncCreate() {
  const name = document.getElementById('wizName').value;
  const slug = wizSlug(name);
  document.getElementById('wizCreate').disabled = !(wizState.authed && slug);
  const urlEl = document.getElementById('wizUrl');
  urlEl.innerHTML = slug ? ('Folder <b>~/' + esc(slug) + '</b> · will be live at a github.io address') : '';
}

async function wizCreate() {
  const name = document.getElementById('wizName').value.trim();
  if (!name) return;
  wizShow('wizWorking');
  document.getElementById('wizSub').textContent = 'Creating your website…';
  try {
    const r = await api('/api/site-create', { name });
    wizState.done = r;
    document.getElementById('wizSub').textContent = 'All set.';
    const a = document.getElementById('wizLiveLink');
    a.textContent = r.pagesUrl;
    a.href = r.pagesUrl;
    a.onclick = (e) => { e.preventDefault(); openExternal(r.pagesUrl); };
    wizShow('wizDone');
    load(); // surface the new project
  } catch (e) {
    wizShow('wizForm');
    document.getElementById('wizSub').textContent = 'Give your site a name to get started.';
    toast('Could not create the website: ' + e.message, true);
  }
}

document.getElementById('wizClose').addEventListener('click', closeSiteWizard);
document.getElementById('wizDoneClose').addEventListener('click', closeSiteWizard);
document.getElementById('wizBack').addEventListener('click', () => { closeSiteWizard(); openProjChoice(); });
document.getElementById('wizName').addEventListener('input', wizSyncCreate);
document.getElementById('wizName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !document.getElementById('wizCreate').disabled) wizCreate();
});
document.getElementById('wizCreate').addEventListener('click', wizCreate);
document.getElementById('wizStartChat').addEventListener('click', () => {
  const d = wizState.done; if (!d) return;
  closeSiteWizard();
  openNewChat(d.cwd, d.slug);
});

// ---- Import wizard (edit an existing GitHub site) -------------------------
// Pick one of the user's repos → clone into $HOME → detect its live Pages URL →
// hand off to chat. Publishing later is the same commit + push as any repo.
let impState = { authed: false, user: null, repos: [], selected: null, done: null };

function impShow(step) {
  for (const id of ['impPick', 'impWorking', 'impDone'])
    document.getElementById(id).hidden = (id !== step);
}
function openImportWizard() {
  document.getElementById('impOverlay').classList.add('show');
  document.body.classList.add('overlay-open');
  impState = { authed: false, user: null, repos: [], selected: null, done: null };
  impShow('impPick');
  document.getElementById('impSub').textContent = 'Pick a repository from your GitHub.';
  document.getElementById('impSearch').hidden = true;
  document.getElementById('impSearch').value = '';
  document.getElementById('impList').hidden = true;
  document.getElementById('impOpen').disabled = true;
  renderGhStatus(document.getElementById('impGh'), (s) => {
    impState.authed = !!s.authed;
    impState.user = s.user || null;
    if (s.authed) impLoadRepos();
  });
}
function closeImportWizard() {
  document.getElementById('impOverlay').classList.remove('show');
  document.body.classList.remove('overlay-open');
}

async function impLoadRepos() {
  const list = document.getElementById('impList');
  list.hidden = false;
  list.innerHTML = '<div class="imp-empty">Loading your repositories…</div>';
  try {
    const j = await (await fetch('/api/gh-repos')).json();
    if (j.error) throw new Error(j.error);
    impState.repos = j.repos || [];
    document.getElementById('impSearch').hidden = false;
    impRenderRepos('');
  } catch (e) {
    list.innerHTML = '<div class="imp-empty">Could not list repositories: ' + esc(e.message) + '</div>';
  }
}

function impRenderRepos(filter) {
  const list = document.getElementById('impList');
  const q = (filter || '').toLowerCase();
  const rows = impState.repos.filter(r =>
    !q || (r.nameWithOwner || '').toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q));
  if (!rows.length) { list.innerHTML = '<div class="imp-empty">No matching repositories.</div>'; return; }
  list.innerHTML = rows.map(r => {
    const owner = (r.nameWithOwner || '').split('/')[0];
    // Show the owner when it's not your own account (org / collaborator repos).
    const ownerTag = owner && owner !== impState.user ? `<span class="ro">${esc(owner)}/</span>` : '';
    return `<div class="imp-repo" data-nwo="${esc(r.nameWithOwner)}">
       <div class="rn">${ownerTag}${esc(r.name)}<span class="rv">${esc((r.visibility || '').toLowerCase())}</span></div>
       ${r.description ? `<div class="rd">${esc(r.description)}</div>` : ''}
     </div>`;
  }).join('');
}

document.getElementById('impList').addEventListener('click', (e) => {
  const row = e.target.closest('.imp-repo'); if (!row) return;
  for (const el of document.querySelectorAll('.imp-repo.sel')) el.classList.remove('sel');
  row.classList.add('sel');
  impState.selected = row.dataset.nwo;
  document.getElementById('impOpen').disabled = false;
});
document.getElementById('impSearch').addEventListener('input', (e) => impRenderRepos(e.target.value));

async function impOpen() {
  const repo = impState.selected; if (!repo) return;
  impShow('impWorking');
  document.getElementById('impSub').textContent = 'Downloading your website…';
  try {
    const r = await api('/api/site-import', { repo });
    impState.done = r;
    document.getElementById('impSub').textContent = 'Ready.';
    // Live-URL vs no-pages messaging.
    const hasPages = !!r.pagesEnabled;
    document.getElementById('impLiveWrap').hidden = !hasPages;
    document.getElementById('impNoPages').hidden = hasPages;
    if (hasPages) {
      const a = document.getElementById('impLiveLink');
      a.textContent = r.pagesUrl; a.href = r.pagesUrl;
      a.onclick = (e) => { e.preventDefault(); openExternal(r.pagesUrl); };
    }
    impShow('impDone');
    load();
  } catch (e) {
    impShow('impPick');
    document.getElementById('impSub').textContent = 'Pick a repository from your GitHub.';
    toast('Could not open that site: ' + e.message, true);
  }
}

async function impDoEnablePages() {
  const d = impState.done; if (!d) return;
  const repo = d.owner + '/' + d.slug;
  try {
    toast('Turning on GitHub Pages…');
    const r = await api('/api/site-enable-pages', { repo });
    d.pagesEnabled = true; d.pagesUrl = r.pagesUrl || d.pagesUrl;
    document.getElementById('impNoPages').hidden = true;
    document.getElementById('impLiveWrap').hidden = false;
    const a = document.getElementById('impLiveLink');
    a.textContent = d.pagesUrl; a.href = d.pagesUrl;
    a.onclick = (e) => { e.preventDefault(); openExternal(d.pagesUrl); };
    toast('GitHub Pages enabled — it may take a minute to build.');
  } catch (e) { toast('Could not enable Pages: ' + e.message, true); }
}

document.getElementById('impClose').addEventListener('click', closeImportWizard);
document.getElementById('impDoneClose').addEventListener('click', closeImportWizard);
document.getElementById('impBack').addEventListener('click', () => { closeImportWizard(); openProjChoice(); });
document.getElementById('impOpen').addEventListener('click', impOpen);
document.getElementById('impEnablePages').addEventListener('click', (e) => { e.preventDefault(); impDoEnablePages(); });
document.getElementById('impStartChat').addEventListener('click', () => {
  const d = impState.done; if (!d) return;
  closeImportWizard();
  openNewChat(d.cwd, d.slug);
});
document.getElementById('pcImport').addEventListener('click', () => { closeProjChoice(); openImportWizard(); });

// ---- Publish status -------------------------------------------------------
// One honest answer to "is what I made live?" — a full control in the chat
// header (status + Publish/View/Enable) and a compact pill on each website's
// project row. Both read from one client cache; /api/site-status is cheap
// (git is local; the Pages half is server-cached ~30s), so we can poll it.
const PUB_STATES = {
  draft:      { short: 'Draft',          act: { kind: 'publish', label: 'Publish ▸', go: true } },
  publishing: { short: 'Publishing…',    act: null },
  live:       { short: 'Live',           act: { kind: 'view', label: 'View site ↗' } },
  failed:     { short: 'Publish failed', act: { kind: 'publish', label: 'Retry', go: true } },
  offline:    { short: 'Not online',     act: { kind: 'enable', label: 'Put it online', go: true } },
};
const siteStat = {}; // cwd -> { data, at, inflight }

async function fetchSiteStatus(cwd, force) {
  if (!cwd) return;
  const e = siteStat[cwd] || (siteStat[cwd] = {});
  if (e.inflight) return;
  if (!force && e.at && Date.now() - e.at < 5000) return;
  e.inflight = true;
  try {
    const r = await fetch('/api/site-status?cwd=' + encodeURIComponent(cwd));
    e.data = await r.json(); e.at = Date.now();
    paintPubUI(cwd);
  } catch { /* transient — next tick retries */ }
  finally { e.inflight = false; }
}

// Repaint every visible surface for this cwd: the chat bar (if open here) and
// any project-row pills.
function paintPubUI(cwd) {
  const st = (siteStat[cwd] || {}).data;
  if (chat && chat.cwd === cwd) renderPubBar(cwd);
  document.querySelectorAll(`.pubpill[data-cwd="${CSS.escape(cwd)}"]`).forEach(el => {
    const cfg = st && PUB_STATES[st.state];
    if (!cfg) { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'pubpill st-' + st.state;
    el.title = st.label + (st.detail ? ' · ' + st.detail : '');
    el.innerHTML = '<span class="pb-dot"></span>' + esc(cfg.short);
  });
}

function renderPubBar(cwd) {
  const bar = document.getElementById('chatPublish');
  const st = (siteStat[cwd] || {}).data;
  const cfg = st && PUB_STATES[st.state];
  if (!cfg) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.className = 'pubbar st-' + st.state;
  bar.dataset.cwd = cwd;
  let right = '';
  // Always let them peek at the current live site (except when it isn't online).
  if (st.pagesEnabled && st.pagesUrl && st.state !== 'live')
    right += `<a class="pb-act pb-view" data-act="view" href="#">View live ↗</a>`;
  if (cfg.act)
    right += `<button class="pb-act${cfg.act.go ? ' pb-go' : ''}" data-act="${cfg.act.kind}">${esc(cfg.act.label)}</button>`;
  bar.innerHTML = '<span class="pb-dot"></span>'
    + `<span class="pb-txt">${esc(st.label)}</span>`
    + (st.detail ? `<span class="pb-det">· ${esc(st.detail)}</span>` : '')
    + '<span class="pb-sp"></span>' + right;
}

document.getElementById('chatPublish').addEventListener('click', (e) => {
  const el = e.target.closest('.pb-act'); if (!el) return;
  e.preventDefault();
  const cwd = document.getElementById('chatPublish').dataset.cwd;
  const st = (siteStat[cwd] || {}).data; if (!st) return;
  if (el.dataset.act === 'view') return openExternal(st.pagesUrl);
  if (el.dataset.act === 'publish') return doPublish(cwd);
  if (el.dataset.act === 'enable') return doEnablePages(cwd, st.nwo);
});

async function doPublish(cwd) {
  const bar = document.getElementById('chatPublish');
  const btn = bar.querySelector('.pb-go');
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
  try {
    const r = await api('/api/publish', { cwd });
    const e = siteStat[cwd] || (siteStat[cwd] = {});
    e.data = r; e.at = Date.now();
    paintPubUI(cwd);
    toast('Published — your site will update in about a minute.');
  } catch (err) {
    toast('Could not publish: ' + err.message, true);
    fetchSiteStatus(cwd, true);
  }
}

async function doEnablePages(cwd, nwo) {
  if (!nwo) return;
  try {
    toast('Putting your site online…');
    await api('/api/site-enable-pages', { repo: nwo });
    toast('Online! GitHub Pages may take a minute to build.');
    fetchSiteStatus(cwd, true);
  } catch (err) { toast('Could not put it online: ' + err.message, true); }
}

document.getElementById('npClose').addEventListener('click', closeNewProject);
document.getElementById('npCancel').addEventListener('click', closeNewProject);
document.getElementById('npStart').addEventListener('click', npStart);
document.getElementById('npUp').addEventListener('click', () => { if (npState.parent) npBrowse(npState.parent); });
document.getElementById('npList').addEventListener('click', e => {
  const row = e.target.closest('.np-row'); if (row) npBrowse(row.dataset.path);
});
document.getElementById('npNewToggle').addEventListener('click', () => {
  document.getElementById('npNewForm').hidden = false;
  document.getElementById('npNewToggle').hidden = true;
  document.getElementById('npNewName').focus();
});
document.getElementById('npNewCreate').addEventListener('click', npCreateFolder);
document.getElementById('npNewName').addEventListener('keydown', e => { if (e.key === 'Enter') npCreateFolder(); });
document.getElementById('newProjOverlay').addEventListener('click', e => { if (e.target.id === 'newProjOverlay') closeNewProject(); });

document.getElementById('wrapup').addEventListener('click', openHousekeeping);
document.getElementById('hkClose').addEventListener('click', closeHousekeeping);
document.getElementById('hkRefresh').addEventListener('click', loadHousekeeping);
document.getElementById('hkOverlay').addEventListener('click', e => { if (e.target.id === 'hkOverlay') closeHousekeeping(); });
document.getElementById('vizClose').addEventListener('click', closeViz);
document.getElementById('vizOverlay').addEventListener('click', e => { if (e.target.id === 'vizOverlay') closeViz(); });

document.getElementById('search').addEventListener('input', () => { scheduleSearch(); render(); });
document.getElementById('refresh').addEventListener('click', load);
document.getElementById('updateBtn').addEventListener('click', doUpdate);
const showStaleBox = document.getElementById('showStale');
function setShowStale(v) {
  showStale = v;
  showStaleBox.checked = v;
  localStorage.setItem('cn-show-stale', v ? '1' : '0');
  render();
}
showStaleBox.checked = showStale;
showStaleBox.addEventListener('change', () => setShowStale(showStaleBox.checked));
const showArchivedBox = document.getElementById('showArchived');
function setShowArchived(v) {
  showArchived = v;
  showArchivedBox.checked = v;
  localStorage.setItem('cn-show-archived', v ? '1' : '0');
  render();
}
showArchivedBox.checked = showArchived;
showArchivedBox.addEventListener('change', () => setShowArchived(showArchivedBox.checked));
setFavicon(LIGHT_COLORS.idle);
// Auto-refresh every 5s so live terminals stay current.
timer = setInterval(load, 5000);
load();
