'use strict';

const api = window.settingsApi;

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1800);
}

const navButtons = [...document.querySelectorAll('.nav-item')];
const panels = [...document.querySelectorAll('.panel')];
let activePanel = 'conversations';

function showPanel(name) {
  activePanel = name;
  navButtons.forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  panels.forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  if (name === 'system') startMonitor();
  else stopMonitor();
  if (name === 'conversations') loadConversations();
  if (name === 'memory') loadMemories();
}
navButtons.forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.panel)));

const modeButtons = [...document.querySelectorAll('.mode-btn')];
function reflectMode(mode) {
  modeButtons.forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
}
modeButtons.forEach((b) =>
  b.addEventListener('click', async () => {
    const applied = await api.setMode(b.dataset.mode);
    reflectMode(applied);
    toast(`Mode: ${applied}`);
  })
);
api.onMode((mode) => reflectMode(mode));

const GROUP_TO_CONTAINER = {
  Connection: 'form-connection',
  Generation: 'form-generation',
  Behaviour: 'form-behaviour',
  Voice: 'form-voice'
};

async function buildForms() {
  const [schema, state] = await Promise.all([api.getSchema(), api.getConfig()]);
  const values = state.values;
  reflectMode(state.mode);

  for (const field of schema) {
    const container = document.getElementById(GROUP_TO_CONTAINER[field.group]);
    if (!container) continue;
    container.append(renderField(field, values[field.key]));
  }
}

function save(key, value, label) {
  api.setConfig(key, value).then((res) => {
    if (res && res.ok) toast(`Saved ${label}`);
    else toast((res && res.error) || 'Save failed', true);
  });
}

function renderField(field, value) {
  const label = el('div', { class: 'field-label' },
    el('span', { class: 'name', text: field.label }),
    field.help ? el('span', { class: 'help', text: field.help }) : null
  );
  const control = el('div', { class: 'field-control' });

  if (field.type === 'boolean') {
    const input = el('input', { type: 'checkbox' });
    input.checked = Boolean(value);
    input.addEventListener('change', () => save(field.key, input.checked, field.label));
    control.append(el('label', { class: 'switch' }, input, el('span', { class: 'slider' })));
  } else if (field.type === 'text') {
    const ta = el('textarea', {});
    ta.value = value ?? '';
    ta.addEventListener('change', () => save(field.key, ta.value, field.label));
    control.append(ta);
  } else if (field.type === 'number' && typeof field.min === 'number' && typeof field.max === 'number') {
    const range = el('input', { type: 'range', min: field.min, max: field.max, step: field.step ?? 1 });
    range.value = value;
    const out = el('span', { class: 'range-val', text: String(value) });
    range.addEventListener('input', () => (out.textContent = range.value));
    range.addEventListener('change', () => save(field.key, Number(range.value), field.label));
    control.append(el('div', { class: 'range-wrap' }, range, out));
  } else if (field.type === 'number') {
    const input = el('input', { type: 'number' });
    if (field.step) input.step = field.step;
    input.value = value;
    input.addEventListener('change', () => save(field.key, Number(input.value), field.label));
    control.append(input);
  } else {
    const input = el('input', { type: field.type === 'password' ? 'password' : 'text' });
    input.value = value ?? '';
    if (field.key === 'model') input.setAttribute('list', 'model-options');
    input.addEventListener('change', () => save(field.key, input.value, field.label));
    control.append(input);
    control.dataset.key = field.key;
  }

  return el('div', { class: 'field' }, label, control);
}

api.onConfigChanged?.(({ key }) => {
  if (key === 'learningMode') buildAbout();
});

const connStatus = document.getElementById('conn-status');
document.getElementById('model-refresh').addEventListener('click', async () => {
  connStatus.textContent = 'Listing models…';
  connStatus.className = 'status-line muted small';
  const res = await api.listModels();
  if (!res.ok) {
    connStatus.textContent = `Couldn't list models: ${res.error}`;
    connStatus.className = 'status-line err small';
    return;
  }
  const dl = document.getElementById('model-options');
  dl.innerHTML = '';
  res.models.forEach((m) => dl.append(el('option', { value: m })));
  connStatus.textContent = res.models.length
    ? `${res.models.length} model(s): ${res.models.join(', ')}`
    : 'Server returned no models (some local servers don’t list them).';
  connStatus.className = 'status-line ok small';
});
document.getElementById('conn-test').addEventListener('click', async () => {
  connStatus.textContent = 'Testing…';
  connStatus.className = 'status-line muted small';
  const res = await api.testConnection();
  connStatus.textContent = res.ok ? '✓ Connected.' : `✗ ${res.error}`;
  connStatus.className = `status-line ${res.ok ? 'ok' : 'err'} small`;
});

const convListEl = document.getElementById('conv-list');
const convDetailEl = document.getElementById('conv-detail');
let selectedConv = null;

function fmtTime(ts) {
  const d = new Date(ts);
  const now = Date.now();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
        ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function loadConversations() {
  const items = await api.listConversations();
  convListEl.innerHTML = '';
  if (!items.length) {
    convListEl.append(el('p', { class: 'muted small', text: 'No conversations yet.' }));
    return;
  }
  for (const c of items) {
    const meta = el('div', { class: 'row-meta' },
      el('span', { text: fmtTime(c.updatedAt) }),
      el('span', { text: `${c.messageCount} msg` }),
      c.current ? el('span', { class: 'badge', text: 'current' }) : null
    );
    const row = el('div', { class: 'row' + (c.id === selectedConv ? ' selected' : '') },
      el('div', { class: 'row-title', text: c.title }),
      meta
    );
    row.addEventListener('click', () => openConversation(c.id));
    convListEl.append(row);
  }
}

async function openConversation(id) {
  selectedConv = id;
  loadConversations();
  const conv = await api.getConversation(id);
  convDetailEl.innerHTML = '';
  if (!conv) {
    convDetailEl.append(el('p', { class: 'muted', text: 'Conversation not found.' }));
    return;
  }
  const head = el('div', { class: 'reader-head' },
    el('button', { class: 'btn small', text: '▶ Resume', onclick: () => resumeConv(id) }),
    el('button', { class: 'btn small danger', text: '🗑 Delete', onclick: () => deleteConv(id) })
  );
  convDetailEl.append(head, el('h3', { text: conv.title, style: 'margin-bottom:12px;color:#f3f1fb' }));
  for (const m of conv.messages) {
    convDetailEl.append(
      el('div', { class: `turn ${m.role}` },
        el('div', { class: 'who', text: m.role === 'user' ? 'You' : 'LESLIE' }),
        el('div', { class: 'text', text: m.content })
      )
    );
  }
}

async function resumeConv(id) {
  const res = await api.resumeConversation(id);
  if (res && res.ok) toast('Resumed — keep chatting in the companion');
  else toast('Could not resume', true);
  loadConversations();
}
async function deleteConv(id) {
  await api.deleteConversation(id);
  if (selectedConv === id) {
    selectedConv = null;
    convDetailEl.innerHTML = '';
    convDetailEl.append(el('p', { class: 'muted', text: 'Select a conversation to read it.' }));
  }
  loadConversations();
  toast('Deleted');
}
document.getElementById('conv-new').addEventListener('click', async () => {
  await api.newConversation();
  selectedConv = null;
  convDetailEl.innerHTML = '';
  convDetailEl.append(el('p', { class: 'muted', text: 'Started a fresh conversation.' }));
  loadConversations();
  toast('New conversation started');
});
document.getElementById('conv-clear').addEventListener('click', async () => {
  await api.clearConversations();
  selectedConv = null;
  convDetailEl.innerHTML = '';
  loadConversations();
  toast('All conversations deleted');
});
api.onConversationsChanged?.(() => { if (activePanel === 'conversations') loadConversations(); });

const memListEl = document.getElementById('mem-list');
async function loadMemories() {
  const items = await api.listMemories();
  memListEl.innerHTML = '';
  if (!items.length) {
    memListEl.append(el('p', { class: 'muted small', style: 'padding:14px', text:
      'Nothing remembered yet. With learning mode on, LESLIE saves durable preferences here.' }));
    return;
  }
  for (const m of items) {
    const del = el('button', { class: 'btn small danger', text: 'Forget' });
    del.addEventListener('click', async () => { await api.deleteMemory(m.id); loadMemories(); toast('Forgotten'); });
    memListEl.append(
      el('div', { class: 'mem-row' },
        el('div', {},
          el('div', { class: 'mem-text', text: m.text }),
          el('div', { class: 'mem-src', text: `via ${m.source} · ${fmtTime(m.createdAt)}` })
        ),
        del
      )
    );
  }
}
document.getElementById('mem-clear').addEventListener('click', async () => {
  await api.clearMemories();
  loadMemories();
  toast('All memories forgotten');
});

const sysGrid = document.getElementById('sys-grid');
let monitorTimer = null;
let monitorPaused = false;

function meterClass(pct) { return pct >= 90 ? 'meter hot' : pct >= 70 ? 'meter warn' : 'meter'; }
function gb(mb) { return (mb / 1024).toFixed(1); }
function fmtUptime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function meter(pct) {
  const fill = el('span', {});
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  return el('div', { class: meterClass(pct) }, fill);
}
function scard(title, ...kids) { return el('div', { class: 'scard' }, el('h3', { text: title }), ...kids); }
function kv(k, v) { return el('div', { class: 'kv' }, el('span', { class: 'k', text: k }), el('span', { text: v })); }

function renderSystem(s) {
  sysGrid.innerHTML = '';

  sysGrid.append(scard('Processor',
    el('div', { class: 'big', text: `${s.cpu.usagePct}%` }),
    meter(s.cpu.usagePct),
    el('div', { class: 'sub', text: `${s.cpu.cores} cores · ${s.cpu.model}` })
  ));

  sysGrid.append(scard('Memory',
    el('div', { class: 'big', text: `${s.mem.pct}%` }),
    meter(s.mem.pct),
    el('div', { class: 'sub', text: `${gb(s.mem.usedMB)} / ${gb(s.mem.totalMB)} GB used` })
  ));

  if (s.gpu.available && s.gpu.gpus.length) {
    for (const g of s.gpu.gpus) {
      const memPct = g.memTotalMB ? Math.round((g.memUsedMB / g.memTotalMB) * 100) : 0;
      sysGrid.append(scard('GPU',
        el('div', { class: 'big', text: `${g.utilPct}%` }),
        meter(g.utilPct),
        el('div', { class: 'sub', text: g.name }),
        kv('VRAM', `${gb(g.memUsedMB)} / ${gb(g.memTotalMB)} GB`),
        kv('Temp', `${g.tempC}°C`)
      ));
    }
  } else {
    const names = (s.gpu.gpus || []).map((g) => g.name).join(', ') || 'Unknown adapter';
    sysGrid.append(scard('GPU',
      el('div', { class: 'sub', text: names }),
      el('div', { class: 'sub', style: 'margin-top:8px',
        text: 'Live utilisation needs nvidia-smi (NVIDIA only).' })
    ));
  }

  sysGrid.append(scard('LESLIE (this app)',
    el('div', { class: 'big', text: `${s.app.cpuPct}%` }),
    el('div', { class: 'sub', text: 'CPU across all processes' }),
    kv('Memory', `${gb(s.app.memMB)} GB`),
    kv('Processes', String(s.app.processes))
  ));

  sysGrid.append(scard('Host',
    kv('Platform', `${s.host.platform} · ${s.host.arch}`),
    kv('Hostname', s.host.hostname),
    kv('OS uptime', fmtUptime(s.host.uptimeSec))
  ));
}

async function tickMonitor() {
  if (monitorPaused) return;
  try {
    const s = await api.sampleSystem();
    renderSystem(s);
  } catch {
  }
}
function startMonitor() {
  if (monitorTimer) return;
  tickMonitor();
  monitorTimer = setInterval(tickMonitor, 1500);
}
function stopMonitor() {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
}
document.getElementById('sys-pause').addEventListener('click', () => {
  monitorPaused = !monitorPaused;
  document.getElementById('sys-pause').textContent = monitorPaused ? 'Resume' : 'Pause';
  document.getElementById('sys-pause-label').textContent = monitorPaused ? 'paused' : 'live';
});

async function buildAbout() {
  const state = await api.getConfig();
  const v = state.values;
  const about = document.getElementById('about');
  about.innerHTML = '';
  const row = (k, val) => el('div', { class: 'field' },
    el('div', { class: 'field-label' }, el('span', { class: 'name', text: k })),
    el('div', { class: 'field-control' }, el('span', { class: 'muted small', text: val })));
  about.append(
    row('App', 'LESLIE — AI desktop companion'),
    row('Mode', state.mode),
    row('Server', v.baseURL),
    row('Model', v.model),
    row('Tools', v.toolsEnabled ? 'enabled' : 'disabled'),
    row('Tip', 'Changes here apply live and persist across restarts (layered over .env).')
  );
}

buildForms();
buildAbout();
loadConversations();
