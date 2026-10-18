'use strict';

const TOKEN = document.querySelector('meta[name="leslie-token"]').content;
const $ = (id) => document.getElementById(id);
const docName = location.pathname.startsWith('/d/') ? decodeURIComponent(location.pathname.slice(3)) : null;
const SAVE_AFTER_MS = 600;
const TYPING_BEAT_MS = 10 * 1000;
const PENDING_LINE = /^<!--\s*pending:\s*([\s\S]*?)\s*-->$/gm;

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: { 'x-leslie-token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (raw) {
    if (!res.ok) throw new Error(res.statusText);
    return res.text();
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const docPath = (sub = '') => `docs/${encodeURIComponent(docName)}${sub}`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

let statusTimer = null;
function setStatus(text, cls = '', holdMs = 0) {
  const s = $('status');
  s.textContent = text;
  s.className = `status ${cls}`;
  clearTimeout(statusTimer);
  if (holdMs) statusTimer = setTimeout(idleStatus, holdMs);
}

function idleStatus() {
  const waiting = doc && doc.threads.some(isWaiting);
  setStatus(waiting ? 'Leslie is on it…' : 'Live', waiting ? 'leslie' : '');
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function connect(handlers) {
  const qs = `t=${TOKEN}${docName ? `&doc=${encodeURIComponent(docName)}` : ''}`;
  const es = new EventSource(`/api/events?${qs}`);
  for (const [event, fn] of Object.entries(handlers)) es.addEventListener(event, (e) => fn(JSON.parse(e.data)));
  es.onerror = () => setStatus('Reconnecting…', 'offline');
  es.onopen = () => idleStatus();
}

// --- doc list ---------------------------------------------------------------

function renderList(list) {
  const ul = $('docList');
  ul.replaceChildren(
    ...list.map((d) => {
      const li = el('li');
      const a = el('a', '', d.name);
      a.href = `/d/${encodeURIComponent(d.name)}`;
      const time = el('time', '', ago(d.modified));
      const del = el('button', 'ghost small del', 'Delete');
      del.onclick = async () => {
        if (!confirm(`Delete "${d.name}"? Its last version stays in history.`)) return;
        await api(`docs/${encodeURIComponent(d.name)}`, { method: 'DELETE' }).catch((e) => toast(e.message));
      };
      li.append(a, time, del);
      return li;
    })
  );
  $('docsHint').textContent = list.length ? '' : 'No docs yet. Create one here, or ask Leslie to write one.';
}

function startList() {
  $('listView').hidden = false;
  document.title = 'Leslie Docs';
  $('newDoc').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const created = await api('docs', { method: 'POST', body: { title: $('newTitle').value } });
      location.href = `/d/${encodeURIComponent(created.name)}`;
    } catch (err) {
      toast(err.message);
    }
  };
  connect({ hello: ({ list }) => renderList(list), list: renderList });
}

// --- doc --------------------------------------------------------------------

let doc = null;
const blockEls = new Map();
let edit = null;
let saving = Promise.resolve();
let showResolved = false;
let threadsSig = '';

const blockById = (id) => doc.blocks.find((b) => b.id === id);
const blockIndex = (id) => doc.blocks.findIndex((b) => b.id === id);
const prevId = (id) => {
  const i = blockIndex(id);
  return i > 0 ? doc.blocks[i - 1].id : undefined;
};
const clientId = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, '0')).join('');
const CLIENT = clientId();
let typingBeat = null;

// Tells the server which block is open here, so Leslie leaves it alone until we're done.
function announceTyping(id) {
  clearInterval(typingBeat);
  const post = () => api(docPath('/typing'), { method: 'POST', body: { id, client: CLIENT } }).catch(() => {});
  post();
  if (id) typingBeat = setInterval(post, TYPING_BEAT_MS);
}

const isWaiting = (t) => t.asked && !t.resolved && t.messages[t.messages.length - 1].author === 'user';

function renderMarkdown(text) {
  return window.markdown.render(text.replace(PENDING_LINE, (_m, intent) => `*Pending: ${intent}*`));
}

// --- diagrams ---------------------------------------------------------------

const LIGHT = window.matchMedia('(prefers-color-scheme: light)');
let mermaidLoad = null;
let drawing = Promise.resolve();
let diagramSeq = 0;
// Colours a model picks rarely suit the theme (pastel fills under light text), so the theme decides.
const DIAGRAM_STYLING = /^\s*(style|classDef|class|linkStyle)\s.*$/gm;

// About 3.5 MB, so only fetched once a doc actually has a diagram.
function loadMermaid() {
  mermaidLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/static/mermaid.js';
    script.onload = () => resolve(window.mermaid);
    script.onerror = () => {
      mermaidLoad = null;
      reject(new Error('Could not load the diagram renderer.'));
    };
    document.head.append(script);
  });
  return mermaidLoad;
}

function setupMermaid(mermaid) {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    themeVariables: {
      darkMode: !LIGHT.matches,
      background: v('--bg'),
      primaryColor: v('--raised'),
      primaryBorderColor: v('--accent'),
      primaryTextColor: v('--text'),
      secondaryColor: v('--surface'),
      tertiaryColor: v('--surface'),
      lineColor: v('--dim'),
      textColor: v('--text'),
      clusterBkg: v('--surface'),
      clusterBorder: v('--dim'),
      edgeLabelBackground: v('--surface')
    }
  });
}

/** Swaps each ```mermaid block under `root` for its drawing; a broken one stays as text with the error under it. */
function drawDiagrams(root) {
  const sources = [...root.querySelectorAll('pre > code.language-mermaid')];
  if (!sources.length) return;
  drawing = drawing.then(async () => {
    let mermaid;
    try {
      mermaid = await loadMermaid();
    } catch (err) {
      toast(err.message);
      return;
    }
    setupMermaid(mermaid);
    for (const code of sources) {
      const pre = code.parentElement;
      if (!pre.isConnected) continue;
      try {
        const { svg } = await mermaid.render(`diagram-${++diagramSeq}`, code.textContent.replace(DIAGRAM_STYLING, ''));
        const figure = el('figure', 'diagram');
        figure.innerHTML = svg;
        pre.replaceWith(figure);
      } catch (err) {
        const lines = String(err.message || err).split('\n').filter((l) => l.trim());
        const why = lines.length > 1 ? `${lines[0]} ${lines[lines.length - 1]}` : lines[0] || '';
        pre.after(el('p', 'diagram-error', `This diagram has a mistake, so it is shown as text. ${why}`));
      }
    }
  });
}

function redrawDiagrams() {
  if (!doc) return;
  for (const block of doc.blocks) {
    const node = blockEls.get(block.id);
    if (node && node.querySelector('.diagram, .diagram-error') && !(edit && edit.id === block.id)) paint(node, block);
  }
}

function highlightQuotes(render, blockId) {
  for (const t of doc.threads) {
    if (t.resolved || t.blockId !== blockId || !t.quote) continue;
    const walker = document.createTreeWalker(render, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode()); ) {
      const at = node.data.indexOf(t.quote);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + t.quote.length);
      const mark = el('mark');
      mark.dataset.thread = t.id;
      range.surroundContents(mark);
      break;
    }
  }
}

function paint(blockEl, block) {
  const render = blockEl.querySelector('.render');
  blockEl.dataset.h = block.h;
  if (block.pending !== undefined) {
    render.innerHTML = `<div class="pending"><b>Leslie is writing</b> · ${escapeHtml(block.pending)}</div>`;
    return;
  }
  render.innerHTML = window.markdown.render(block.text);
  highlightQuotes(render, block.id);
  drawDiagrams(render);
}

function makeBlockEl(id) {
  const node = el('div', 'block');
  node.dataset.id = id;
  const add = el('button', 'insert', '+');
  add.title = 'Add a paragraph below';
  add.onclick = (e) => {
    e.stopPropagation();
    startDraft(node.dataset.id);
  };
  node.append(add, el('div', 'render'));
  blockEls.set(id, node);
  return node;
}

function flash(node) {
  node.classList.add('flash');
  requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove('flash')));
}

function applyDoc(next, by) {
  doc = next;
  document.title = `${doc.name} · Leslie Docs`;
  $('crumb').textContent = doc.name;
  const sig = JSON.stringify(doc.threads.map((t) => [t.id, t.blockId, t.quote, t.resolved]));
  const threadsMoved = sig !== threadsSig;
  threadsSig = sig;

  const order = [];
  const live = new Set(doc.blocks.map((b) => b.id));
  for (const block of doc.blocks) {
    let node = blockEls.get(block.id);
    const fresh = !node;
    if (fresh) node = makeBlockEl(block.id);
    const changed = !fresh && node.dataset.h !== block.h;
    const editingThis = edit && edit.id === block.id;
    if (editingThis) {
      if (changed && !edit.dirty && !edit.inflight) {
        edit.ta.value = block.text;
        autosize(edit.ta);
      }
      node.dataset.h = block.h;
    } else if (fresh || changed || threadsMoved) {
      paint(node, block);
    }
    if (by === 'leslie' && (fresh || changed)) flash(node);
    order.push(node);
  }

  for (const [id, node] of blockEls) {
    if (live.has(id)) continue;
    if (edit && edit.id === id) {
      // Still being typed in: keep it where it was; the next save puts it back.
      if (edit.isDraft || edit.dirty || edit.inflight) {
        const anchor = edit.isDraft ? blockEls.get(edit.draftAfter) : null;
        const at = anchor ? order.indexOf(anchor) + 1 : order.length;
        order.splice(at > 0 ? at : order.length, 0, node);
        continue;
      }
      edit = null;
    }
    node.remove();
    blockEls.delete(id);
  }

  const container = $('blocks');
  order.forEach((node, i) => {
    if (container.children[i] !== node) container.insertBefore(node, container.children[i] || null);
  });
  while (container.children.length > order.length) container.lastElementChild.remove();

  renderThreads();
  renderPlan();
  if (by === 'leslie') setStatus('Leslie is editing…', 'leslie', 4000);
  else if (!statusTimer || by === 'comment') idleStatus();
}

// --- editing ----------------------------------------------------------------

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

function openEditor(node, text, entry) {
  const ta = el('textarea');
  ta.value = text;
  ta.spellcheck = true;
  node.querySelector('.render').hidden = true;
  node.append(ta);
  edit = { node, ta, dirty: false, inflight: false, timer: null, ...entry };
  const e = edit;
  announceTyping(e.id);
  ta.addEventListener('input', () => {
    e.dirty = true;
    autosize(ta);
    clearTimeout(e.timer);
    e.timer = setTimeout(() => queueSave(e), SAVE_AFTER_MS);
  });
  ta.addEventListener('keydown', (ev) => onEditorKey(ev, e));
  ta.addEventListener('blur', () => setTimeout(() => edit === e && document.activeElement !== ta && finishEdit(), 0));
  autosize(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function startEdit(id) {
  if (edit && edit.id === id) return;
  finishEdit();
  const block = blockById(id);
  const node = blockEls.get(id);
  if (!block || !node) return;
  openEditor(node, block.text, { id, isDraft: false });
}

function startDraft(after) {
  finishEdit();
  const id = clientId();
  const node = makeBlockEl(id);
  const anchor = after && blockEls.get(after);
  if (anchor) anchor.after(node);
  else $('blocks').append(node);
  openEditor(node, '', { id, isDraft: true, draftAfter: after || undefined });
}

function finishEdit() {
  const e = edit;
  if (!e) return;
  edit = null;
  clearTimeout(e.timer);
  const text = e.ta.value;
  if (e.dirty || (!text.trim() && !e.isDraft)) {
    e.dirty = true;
    queueSave(e);
  }
  saving.then(() => !edit && announceTyping(null));
  e.ta.remove();
  const render = e.node.querySelector('.render');
  render.hidden = false;
  if (!text.trim()) {
    if (e.isDraft) {
      e.node.remove();
      blockEls.delete(e.id);
    }
    return;
  }
  const block = blockById(e.id);
  if (block && block.text === text) paint(e.node, block);
  else {
    render.innerHTML = renderMarkdown(text);
    drawDiagrams(render);
    e.node.dataset.h = '';
  }
}

function onEditorKey(ev, e) {
  const ta = e.ta;
  const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
  const atEnd = ta.selectionStart === ta.value.length;
  const neighbour = (step) => doc.blocks[blockIndex(e.id) + step];
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ta.blur();
  } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    startDraft(e.id);
  } else if (ev.key === 'Backspace' && !ta.value) {
    ev.preventDefault();
    const prev = neighbour(-1);
    finishEdit();
    if (prev) startEdit(prev.id);
  } else if (ev.key === 'ArrowUp' && atStart && neighbour(-1)) {
    ev.preventDefault();
    startEdit(neighbour(-1).id);
  } else if (ev.key === 'ArrowDown' && atEnd && neighbour(1)) {
    ev.preventDefault();
    startEdit(neighbour(1).id);
  }
}

function queueSave(e) {
  saving = saving.then(() => save(e)).catch((err) => toast(`Not saved: ${err.message}`));
  return saving;
}

async function save(e) {
  if (!e.dirty) return;
  e.dirty = false;
  clearTimeout(e.timer);
  const text = e.ta.value;
  let op;
  if (e.isDraft && !e.saved) {
    if (!text.trim()) return;
    op = { op: 'insert', id: e.id, after: e.draftAfter, text };
  } else {
    op = { op: 'replace', id: e.id, after: prevId(e.id), text };
  }
  e.inflight = true;
  let res;
  try {
    res = await api(docPath('/ops'), { method: 'POST', body: { ops: [op] } });
  } catch (err) {
    e.dirty = true;
    throw err;
  } finally {
    e.inflight = false;
  }
  const r = res.results[0];
  if (!r.ok) return toast(r.error);
  e.saved = true;
  if (r.ids.length > 1 && edit === e) {
    // A blank line split the paragraph: carry on typing in the last new one.
    const typedSince = e.ta.value.startsWith(text) ? e.ta.value.slice(text.length) : '';
    finishEditQuietly(e);
    const last = r.ids[r.ids.length - 1];
    startEdit(last);
    if (typedSince && edit) {
      edit.ta.value += typedSince;
      edit.ta.dispatchEvent(new Event('input'));
    }
  }
}

function finishEditQuietly(e) {
  edit = null;
  clearTimeout(e.timer);
  e.ta.remove();
  e.node.querySelector('.render').hidden = false;
  const block = blockById(e.id);
  if (block) paint(e.node, block);
}

function onRenderClick(ev) {
  const node = ev.target.closest('.block');
  if (!node || !ev.target.closest('.render')) return;
  if (ev.target.closest('a')) return;
  const mark = ev.target.closest('mark[data-thread]');
  if (mark) return focusThread(mark.dataset.thread);
  if (String(window.getSelection())) return;
  startEdit(node.dataset.id);
}

// --- comments ---------------------------------------------------------------

let selection = null;

function onSelectionDone() {
  const fab = $('commentFab');
  const sel = window.getSelection();
  const text = String(sel).trim();
  if (!text || sel.rangeCount === 0) {
    fab.hidden = true;
    return;
  }
  const range = sel.getRangeAt(0);
  const host = (n) => (n.nodeType === 1 ? n : n.parentElement).closest('.block .render');
  const a = host(range.startContainer);
  const b = host(range.endContainer);
  if (!a || a !== b) {
    fab.hidden = true;
    return;
  }
  selection = { blockId: a.closest('.block').dataset.id, quote: text.slice(0, 500) };
  const rect = range.getBoundingClientRect();
  fab.style.top = `${rect.bottom + window.scrollY + 8}px`;
  fab.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 120)}px`;
  fab.hidden = false;
}

function openComposer() {
  $('commentFab').hidden = true;
  if (!selection) return;
  $('composerQuote').textContent = selection.quote;
  $('composer').hidden = false;
  $('composer').dataset.block = selection.blockId;
  $('composer').dataset.quote = selection.quote;
  $('composerText').value = '';
  $('composer').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('composerText').focus();
}

async function submitComposer(ask) {
  const text = $('composerText').value.trim();
  if (!text) return $('composerText').focus();
  const c = $('composer');
  try {
    await api(docPath('/threads'), { method: 'POST', body: { blockId: c.dataset.block, quote: c.dataset.quote, text, ask } });
    c.hidden = true;
    window.getSelection().removeAllRanges();
    if (ask) setStatus('Leslie is on it…', 'leslie');
  } catch (err) {
    toast(err.message);
  }
}

const threadEls = new Map();

function threadCard(t) {
  let card = threadEls.get(t.id);
  if (card) return card;
  card = el('div', 'thread');
  card.dataset.id = t.id;
  const quote = el('blockquote', 'quote');
  const detached = el('div', 'detached', 'The text this was on is gone.');
  const msgs = el('div', 'msgs');
  const working = el('div', 'working', 'Leslie is on it…');
  const ta = el('textarea');
  ta.rows = 1;
  ta.placeholder = 'Reply';
  const actions = el('div', 'actions');
  const resolve = el('button', 'ghost small');
  const reply = el('button', 'ghost small', 'Reply');
  const ask = el('button', 'small', 'Ask Leslie');
  actions.append(resolve, reply, ask);
  card.append(quote, detached, msgs, working, ta, actions);
  card.parts = { quote, detached, msgs, working, ta, resolve };

  const send = async (asking) => {
    const text = ta.value.trim();
    if (!text) return ta.focus();
    try {
      await api(docPath(`/threads/${t.id}/reply`), { method: 'POST', body: { text, ask: asking } });
      ta.value = '';
    } catch (err) {
      toast(err.message);
    }
  };
  reply.onclick = () => send(false);
  ask.onclick = () => send(true);
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) send(false);
  });
  resolve.onclick = () =>
    api(docPath(`/threads/${t.id}`), { method: 'POST', body: { resolved: !card.resolved } }).catch((err) => toast(err.message));
  card.addEventListener('mouseenter', () => {
    const node = blockEls.get(card.blockId);
    if (node) node.classList.add('linked');
  });
  card.addEventListener('mouseleave', () => {
    const node = blockEls.get(card.blockId);
    if (node) node.classList.remove('linked');
  });
  card.addEventListener('click', (ev) => {
    if (ev.target.closest('button, textarea')) return;
    const node = blockEls.get(card.blockId);
    if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  threadEls.set(t.id, card);
  return card;
}

function renderThreads() {
  const box = $('threads');
  const position = (t) => {
    const i = blockIndex(t.blockId);
    return i === -1 ? Infinity : i;
  };
  const sorted = doc.threads.slice().sort((a, b) => position(a) - position(b) || a.messages[0].at - b.messages[0].at);
  const shown = sorted.filter((t) => showResolved || !t.resolved);
  for (const t of shown) {
    const card = threadCard(t);
    const p = card.parts;
    card.blockId = t.blockId;
    card.resolved = t.resolved;
    card.classList.toggle('resolved', t.resolved);
    p.quote.textContent = t.quote;
    p.quote.hidden = !t.quote;
    p.detached.hidden = position(t) !== Infinity;
    p.msgs.replaceChildren(
      ...t.messages.map((m) => {
        const row = el('div', `msg ${m.author}`);
        row.append(el('span', 'who', m.author === 'leslie' ? 'Leslie' : 'You'), document.createTextNode(m.text));
        return row;
      })
    );
    p.working.hidden = !isWaiting(t);
    p.resolve.textContent = t.resolved ? 'Reopen' : 'Resolve';
  }
  const keep = new Set(shown.map((t) => t.id));
  for (const [id, card] of threadEls) {
    if (!keep.has(id)) {
      card.remove();
      threadEls.delete(id);
    }
  }
  shown.forEach((t, i) => {
    const card = threadEls.get(t.id);
    if (box.children[i] !== card) box.insertBefore(card, box.children[i] || null);
  });
  const resolvedCount = doc.threads.filter((t) => t.resolved).length;
  const toggle = $('toggleResolved');
  toggle.hidden = !resolvedCount;
  toggle.textContent = showResolved ? 'Hide resolved' : `Show resolved (${resolvedCount})`;
}

function focusThread(id) {
  const card = threadEls.get(id);
  if (!card) return;
  for (const c of threadEls.values()) c.classList.remove('active');
  card.classList.add('active');
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// --- plan -------------------------------------------------------------------

const PLAN_TEXT = {
  proposed: 'Leslie wrote this as a plan. Change anything above first if you like; approving switches her to agent mode and she carries out the plan as it stands.',
  approved: 'Approved. Leslie switched to agent mode and is carrying it out…',
  done: 'Carried out.',
  failed: 'Not carried out.'
};

function renderPlan() {
  const plan = doc.plan;
  $('planBar').hidden = !plan;
  if (!plan) return;
  $('planBar').dataset.status = plan.status;
  $('planText').textContent = PLAN_TEXT[plan.status] || '';
  $('planNote').textContent = plan.note || '';
  $('planNote').hidden = !plan.note;
  const button = $('approvePlan');
  button.hidden = !['proposed', 'failed'].includes(plan.status);
  button.disabled = false;
  button.textContent = plan.status === 'failed' ? 'Approve again' : 'Approve plan';
}

async function approvePlan() {
  const button = $('approvePlan');
  button.disabled = true;
  finishEdit();
  try {
    await saving;
    await api(docPath('/plan'), { method: 'POST', body: { action: 'approve' } });
  } catch (err) {
    button.disabled = false;
    toast(err.message);
  }
}

// --- history ----------------------------------------------------------------

const VERSION_LABEL = { user: 'Before your edits', leslie: "Before Leslie's edits", file: 'Before an outside edit', deleted: 'Before it was deleted' };

async function openHistory() {
  finishEdit();
  const panel = $('historyPanel');
  panel.hidden = false;
  const list = $('versions');
  const restore = $('restoreBtn');
  restore.disabled = true;
  $('versionPreview').innerHTML = '<p class="hint">Pick a version to preview it.</p>';
  let versions;
  try {
    versions = await api(docPath('/history'));
  } catch (err) {
    return toast(err.message);
  }
  if (!versions.length) {
    list.replaceChildren(el('li', 'hint', 'No earlier versions yet.'));
    return;
  }
  list.replaceChildren(
    ...versions.map((v) => {
      const li = el('li');
      li.append(document.createTextNode(VERSION_LABEL[v.by] || v.by), el('small', '', new Date(v.at).toLocaleString()));
      li.onclick = async () => {
        for (const x of list.children) x.classList.remove('on');
        li.classList.add('on');
        try {
          const text = await api(docPath(`/history/${v.id}`), { raw: true });
          $('versionPreview').innerHTML = `<div class="render">${renderMarkdown(text)}</div>`;
          drawDiagrams($('versionPreview'));
          restore.disabled = false;
          restore.onclick = async () => {
            await api(docPath(`/history/${v.id}/restore`), { method: 'POST' });
            panel.hidden = true;
            toast('Restored. The version before it is in history too.');
          };
        } catch (err) {
          toast(err.message);
        }
      };
      return li;
    })
  );
}

async function download() {
  try {
    const text = await api(docPath('/raw'), { raw: true });
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    a.download = `${doc.name}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    toast(err.message);
  }
}

function startDoc() {
  $('docView').hidden = false;
  $('historyBtn').hidden = false;
  $('downloadBtn').hidden = false;
  $('blocks').addEventListener('click', onRenderClick);
  $('addBlock').onclick = () => startDraft(doc.blocks.length ? doc.blocks[doc.blocks.length - 1].id : undefined);
  document.addEventListener('mouseup', () => setTimeout(onSelectionDone, 0));
  document.addEventListener('keyup', (e) => e.shiftKey && onSelectionDone());
  $('commentFab').addEventListener('mousedown', (e) => e.preventDefault());
  $('commentFab').onclick = openComposer;
  $('composerCancel').onclick = () => ($('composer').hidden = true);
  $('composerSave').onclick = () => submitComposer(false);
  $('composerAsk').onclick = () => submitComposer(true);
  $('toggleResolved').onclick = () => {
    showResolved = !showResolved;
    renderThreads();
  };
  $('historyBtn').onclick = openHistory;
  $('historyClose').onclick = () => ($('historyPanel').hidden = true);
  $('downloadBtn').onclick = download;
  $('approvePlan').addEventListener('mousedown', (e) => e.preventDefault());
  $('approvePlan').onclick = approvePlan;
  LIGHT.addEventListener('change', redrawDiagrams);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && edit && edit.dirty) queueSave(edit);
  });
  window.addEventListener('beforeunload', (e) => {
    if (edit && (edit.dirty || edit.inflight)) e.preventDefault();
  });
  connect({
    hello: ({ doc: d }) => applyDoc(d, null),
    doc: ({ doc: d, by }) => applyDoc(d, by)
  });
}

if (docName) startDoc();
else startList();
