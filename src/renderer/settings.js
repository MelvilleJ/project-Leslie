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
  if (name === 'server') startServerPanel();
  else stopServerPanel();
  if (name === 'conversations') loadConversations();
  if (name === 'memory') loadMemories();
  clearPreviewTimers(); // stop sprite preview loops from the panel being left
  if (name === 'animations') loadAnimations();
  if (name === 'wardrobe') loadWardrobe();
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
  Voice: 'form-voice',
  Speech: 'form-speech'
};

async function buildForms() {
  const [schema, state] = await Promise.all([api.getSchema(), api.getConfig()]);
  const values = state.values;
  reflectMode(state.mode);

  for (const field of schema) {
    const container = document.getElementById(GROUP_TO_CONTAINER[field.group]);
    if (!container) continue;
    const fieldEl = renderField(field, values[field.key]);
    const controller = field.dependsOn && schema.find((f) => f.key === field.dependsOn.key);
    if (controller && controller.group === field.group) fieldEl.classList.add('field-sub');
    container.append(fieldEl);
  }

  // Set initial dependsOn visibility
  for (const field of schema) {
    if (!field.dependsOn) continue;
    const container = document.getElementById(GROUP_TO_CONTAINER[field.group]);
    if (!container) continue;
    const fieldEl = container.querySelector(`[data-field-key="${field.key}"]`);
    if (fieldEl && values[field.dependsOn.key] !== field.dependsOn.value) {
      fieldEl.classList.add('hidden');
    }
  }

  // Wire change listeners on controlling selects (once per controller)
  const wired = new Set();
  for (const field of schema) {
    if (!field.dependsOn || wired.has(field.dependsOn.key)) continue;
    wired.add(field.dependsOn.key);
    const ctrlField = schema.find((f) => f.key === field.dependsOn.key);
    if (!ctrlField) continue;
    const ctrlContainer = document.getElementById(GROUP_TO_CONTAINER[ctrlField.group]);
    if (!ctrlContainer) continue;
    const ctrlEl = ctrlContainer.querySelector(`[data-field-key="${ctrlField.key}"] select`);
    if (!ctrlEl) continue;
    const ctrlKey = ctrlField.key;
    ctrlEl.addEventListener('change', () => {
      for (const dep of schema) {
        if (!dep.dependsOn || dep.dependsOn.key !== ctrlKey) continue;
        const depCont = document.getElementById(GROUP_TO_CONTAINER[dep.group]);
        if (!depCont) continue;
        const depEl = depCont.querySelector(`[data-field-key="${dep.key}"]`);
        if (depEl) depEl.classList.toggle('hidden', ctrlEl.value !== dep.dependsOn.value);
      }
    });
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
  } else if (field.type === 'select') {
    const sel = el('select');
    for (const opt of (field.options || [])) {
      const o = el('option', { value: opt.value, text: opt.label });
      if (opt.value === value) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', () => save(field.key, sel.value, field.label));
    control.append(sel);
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
    if (field.key === 'piModel') input.setAttribute('list', 'pi-model-options');
    input.addEventListener('change', () => save(field.key, input.value, field.label));
    control.append(input);
    control.dataset.key = field.key;
  }

  return el('div', { class: 'field', 'data-field-key': field.key }, label, control);
}

api.onConfigChanged?.(({ key, value }) => {
  if (key === 'learningMode') buildAbout();
  if (key === 'ttsEnabled' || key === 'autoApprove') {
    const box = document.querySelector(`[data-field-key="${key}"] input[type="checkbox"]`);
    if (box) box.checked = Boolean(value);
  }
});

// --- Speech preview -----------------------------------------------------------
let previewCtx = null;

async function playSamples({ samples, sampleRate }) {
  if (!previewCtx || previewCtx.sampleRate !== sampleRate) previewCtx = new AudioContext({ sampleRate });
  const buf = previewCtx.createBuffer(1, samples.length, sampleRate);
  buf.copyToChannel(samples, 0);
  const src = previewCtx.createBufferSource();
  src.buffer = buf;
  src.connect(previewCtx.destination);
  src.start();
}

function addVoicePreview() {
  const control = document.querySelector('[data-field-key="ttsVoice"] .field-control');
  if (!control) return;
  const select = control.querySelector('select');
  const btn = el('button', { class: 'btn small', type: 'button', text: '▶ Preview' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const audio = await api.ttsPreview(select.value);
      if (audio) await playSamples(audio);
      else toast('Preview failed — is the speech model downloaded?', true);
    } finally {
      btn.disabled = false;
      btn.textContent = '▶ Preview';
    }
  });
  control.append(btn);
}

// --- Voice shortcuts ----------------------------------------------------------
// Phrase → tool call, run without the model. Argument inputs are generated from
// each tool's JSON-schema parameters.
let shortcuts = [];
let shortcutTools = [];
const shortcutList = document.getElementById('shortcut-list');

async function loadShortcuts() {
  const res = await api.getShortcuts();
  shortcuts = res.shortcuts || [];
  shortcutTools = res.tools || [];
  renderShortcuts();
}

// The main process drops incomplete shortcuts (no phrase yet) when persisting;
// the local list keeps them so a half-filled card stays on screen.
async function saveShortcuts(message) {
  const res = await api.saveShortcuts(shortcuts);
  if (res && res.ok) {
    if (message) toast(message);
  } else {
    toast((res && res.error) || 'Save failed', true);
  }
}

function shortcutField(label, control) {
  return el('div', { class: 'field' },
    el('div', { class: 'field-label' }, el('span', { class: 'name', text: label })),
    el('div', { class: 'field-control' }, control));
}

function argControl(sc, name, schema, required) {
  const current = sc.args[name];
  const commit = (value) => {
    if (value === '' || value === undefined) delete sc.args[name];
    else sc.args[name] = value;
    saveShortcuts('Shortcut saved');
  };
  if (Array.isArray(schema.enum)) {
    const sel = el('select');
    if (!required) sel.append(el('option', { value: '', text: '(default)' }));
    for (const v of schema.enum) {
      const o = el('option', { value: v, text: v });
      if (v === current) o.selected = true;
      sel.append(o);
    }
    if (required && current === undefined) sc.args[name] = sel.value;
    sel.addEventListener('change', () => commit(sel.value));
    return sel;
  }
  if (schema.type === 'boolean') {
    const box = el('input', { type: 'checkbox' });
    box.checked = Boolean(current);
    box.addEventListener('change', () => commit(box.checked));
    return el('label', { class: 'switch' }, box, el('span', { class: 'slider' }));
  }
  const input = el('input', {
    type: schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text',
    placeholder: (schema.description || '').slice(0, 90)
  });
  input.value = current ?? '';
  input.title = schema.description || '';
  input.addEventListener('change', () => {
    const v = input.value.trim();
    commit(v === '' ? '' : input.type === 'number' ? Number(v) : v);
  });
  return input;
}

function renderShortcut(sc, index) {
  const tool = shortcutTools.find((t) => t.name === sc.tool);
  const card = el('div', { class: `form${sc.enabled ? '' : ' disabled'}` });

  const enabled = el('input', { type: 'checkbox' });
  enabled.checked = sc.enabled;
  enabled.addEventListener('change', () => {
    sc.enabled = enabled.checked;
    card.classList.toggle('disabled', !sc.enabled);
    saveShortcuts(sc.enabled ? 'Shortcut on' : 'Shortcut off');
  });
  const del = el('button', { class: 'btn small danger', type: 'button', text: 'Delete' });
  del.addEventListener('click', () => {
    shortcuts.splice(index, 1);
    saveShortcuts('Shortcut deleted').then(renderShortcuts);
  });
  card.append(el('div', { class: 'shortcut-head' },
    el('span', { class: 'muted small', text: `“${sc.phrases[0] || 'new shortcut'}”` }),
    el('div', { class: 'actions' }, el('label', { class: 'switch', title: 'On / off' }, enabled, el('span', { class: 'slider' })), del)));

  const phrases = el('input', { type: 'text', placeholder: 'clip this, clip that' });
  phrases.value = sc.phrases.join(', ');
  phrases.addEventListener('change', () => {
    const list = phrases.value.split(',').map((p) => p.trim()).filter(Boolean);
    if (!list.length) return toast('A shortcut needs at least one phrase', true);
    sc.phrases = list;
    saveShortcuts('Shortcut saved').then(renderShortcuts);
  });
  card.append(shortcutField('When I say', phrases));

  const toolSel = el('select');
  for (const t of shortcutTools) {
    const o = el('option', { value: t.name, text: t.name });
    if (t.name === sc.tool) o.selected = true;
    toolSel.append(o);
  }
  toolSel.addEventListener('change', () => {
    sc.tool = toolSel.value;
    sc.args = {};
    saveShortcuts('Shortcut saved').then(renderShortcuts);
  });
  card.append(shortcutField('Run tool', toolSel));
  if (tool) card.append(el('div', { class: 'shortcut-tool-help', text: tool.description }));

  const props = (tool && tool.parameters && tool.parameters.properties) || {};
  const required = new Set((tool && tool.parameters && tool.parameters.required) || []);
  for (const [name, schema] of Object.entries(props)) {
    card.append(shortcutField(`${name}${required.has(name) ? ' *' : ''}`, argControl(sc, name, schema, required.has(name))));
  }

  const reply = el('input', { type: 'text', placeholder: "Blank = say the tool's result" });
  reply.value = sc.reply || '';
  reply.addEventListener('change', () => {
    sc.reply = reply.value;
    saveShortcuts('Shortcut saved');
  });
  card.append(shortcutField('Reply', reply));
  return card;
}

function renderShortcuts() {
  shortcutList.replaceChildren(...shortcuts.map(renderShortcut));
  if (!shortcuts.length) shortcutList.append(el('p', { class: 'muted small', text: 'No shortcuts yet.' }));
}

document.getElementById('shortcut-add').addEventListener('click', () => {
  const tool = shortcutTools[0];
  shortcuts.push({ id: `shortcut-${Date.now()}`, phrases: [], tool: tool ? tool.name : '', args: {}, reply: '', enabled: true });
  renderShortcuts();
  const inputs = shortcutList.querySelectorAll('.form:last-child input[type="text"]');
  if (inputs[0]) inputs[0].focus();
});

// --- Theme accent ----------------------------------------------------------
// The picker writes through the main process, which persists and broadcasts the
// colour to every window; we apply it to --accent so this window re-themes too.
const DEFAULT_ACCENT = '#9b7bff';
const accentInput = document.getElementById('accent');

function applyAccent(color) {
  if (!color) return;
  document.documentElement.style.setProperty('--accent', color);
  if (accentInput.value !== color) accentInput.value = color;
}

api.getAccent().then(applyAccent);
api.onTheme(applyAccent);

accentInput.addEventListener('input', () => applyAccent(accentInput.value)); // live preview
accentInput.addEventListener('change', () => {
  api.setAccent(accentInput.value);
  toast('Theme colour saved');
});
document.getElementById('accent-reset').addEventListener('click', () => {
  applyAccent(DEFAULT_ACCENT);
  api.setAccent(DEFAULT_ACCENT);
  toast('Theme colour reset');
});

const connStatus = document.getElementById('conn-status');
// On the pi engine this lists pi's models (every provider pi is logged in to).
async function listPiModels() {
  const res = await api.pi('models');
  if (!res.ok) return res;
  const dl = document.getElementById('pi-model-options');
  dl.innerHTML = '';
  const ids = res.data.map((m) => `${m.provider}/${m.id}`);
  ids.forEach((id) => dl.append(el('option', { value: id })));
  return { ok: true, models: ids };
}

document.getElementById('model-refresh').addEventListener('click', async () => {
  connStatus.textContent = 'Listing models…';
  connStatus.className = 'status-line muted small';
  const res = engine === 'pi' ? await listPiModels() : await api.listModels();
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
    engine === 'pi'
      ? el('button', { class: 'btn small', text: '⧉ Copy path', onclick: () => navigator.clipboard.writeText(id).then(() => toast('Session path copied')) })
      : null,
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
  const res = await api.deleteConversation(id);
  if (res && res.ok === false) {
    toast(res.error || 'Could not delete', true);
    return;
  }
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

// --- Engine-dependent labels -------------------------------------------------
let engine = 'native';

function applyEngine(next) {
  engine = next;
  const onPi = engine === 'pi';
  document.getElementById('conv-heading').textContent = onPi ? 'pi sessions' : 'Past conversations';
  document.getElementById('conv-hint').classList.toggle('hidden', !onPi);
  document.getElementById('conv-clear').classList.toggle('hidden', onPi);
  document.querySelector('.nav-item[data-panel="conversations"]').textContent = onPi ? '🗂 Sessions' : '🗂 Conversations';
  if (activePanel === 'conversations') loadConversations();
  if (onPi) listPiModels().catch(() => {});
}

api.getEngine().then(applyEngine);
api.onEngine(applyEngine);
api.onPiEvent((ev) => {
  if (ev.type === 'session' && activePanel === 'conversations') loadConversations();
});

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

// --- Animations -------------------------------------------------------------
const animLibraryEl = document.getElementById('anim-library');
const animBindingsEl = document.getElementById('anim-bindings');

// Friendly labels + display order for the bindable states.
const STATE_LABEL = {
  idle: 'Idle (rotates)', thinking: 'Thinking', longThink: 'Long think',
  toolCall: 'Tool call', talking: 'Talking', listening: 'Listening', moving: 'On move'
};
const STATE_ORDER = ['idle', 'thinking', 'longThink', 'toolCall', 'talking', 'listening', 'moving'];

function clipSheetUrl(clip) {
  if (!clip) return '';
  const outfit = clip.outfit ? `?${clip.outfit}` : '';
  if (clip.aseprite) return `leslie-sprite://builtin/${clip.aseprite}${outfit}`;
  return clip.builtin
    ? `../../assets/animations/${clip.sheet}/spritesheet.png`
    : `leslie-sprite://clips/${clip.file}${outfit}`;
}

// Each preview runs its own frame loop; track timers so we can stop them on
// reload / when leaving the panel.
let previewTimers = [];
function clearPreviewTimers() {
  previewTimers.forEach((t) => clearInterval(t));
  previewTimers = [];
}

function makePreview(clip, boxH = 92) {
  const scale = Math.min(1, boxH / clip.frameH);
  const inner = el('div', { class: 'anim-frame' });
  inner.style.width = `${clip.frameW}px`;
  inner.style.height = `${clip.frameH}px`;
  inner.style.backgroundImage = `url('${clipSheetUrl(clip)}')`;
  inner.style.transform = `scale(${scale})`;
  if (clip.pixelArt) inner.style.imageRendering = 'pixelated';
  let f = 0;
  const draw = () => {
    const col = f % clip.cols;
    const row = Math.floor(f / clip.cols);
    inner.style.backgroundPosition = `-${col * clip.frameW}px -${row * clip.frameH}px`;
    f = (f + 1) % Math.max(1, clip.frames);
  };
  draw();
  previewTimers.push(setInterval(draw, clip.frameMs || 140));
  const wrap = el('div', { class: 'anim-preview' }, inner);
  wrap.style.width = `${Math.round(clip.frameW * scale)}px`;
  wrap.style.height = `${boxH}px`;
  return wrap;
}

function gridInput(clip, key, label) {
  const input = el('input', { type: 'number', min: 1, title: label, 'aria-label': label });
  input.value = clip[key];
  input.addEventListener('change', async () => {
    const res = await api.updateClip(clip.id, { [key]: Number(input.value) });
    if (!res.ok) toast('Update failed', true);
  });
  return el('label', { class: 'grid-cell' }, el('span', { text: label }), input);
}

function renderClipCard(clip) {
  const card = el('div', { class: 'anim-card' });
  card.append(makePreview(clip));

  const body = el('div', { class: 'anim-card-body' });
  if (clip.builtin) {
    body.append(
      el('div', { class: 'anim-name', text: clip.name }),
      el('div', { class: 'muted small', text: `${clip.frameW}×${clip.frameH} · ${clip.frames} frames · ${clip.cols} cols · ${clip.frameMs}ms` }),
      el('div', { class: 'muted small', text: 'Built-in (read-only)' })
    );
  } else {
    const name = el('input', { type: 'text', value: clip.name, 'aria-label': 'Clip name' });
    name.addEventListener('change', () => api.updateClip(clip.id, { name: name.value }));

    const grid = el('div', { class: 'grid-row' },
      gridInput(clip, 'frameW', 'W'), gridInput(clip, 'frameH', 'H'),
      gridInput(clip, 'cols', 'Cols'), gridInput(clip, 'frames', 'Frames')
    );

    const speed = el('input', { type: 'range', min: 40, max: 400, step: 10 });
    speed.value = clip.frameMs;
    const speedVal = el('span', { class: 'range-val', text: `${clip.frameMs}ms` });
    speed.addEventListener('input', () => (speedVal.textContent = `${speed.value}ms`));
    speed.addEventListener('change', () => api.updateClip(clip.id, { frameMs: Number(speed.value) }));

    const del = el('button', { class: 'btn small danger', text: 'Delete' });
    del.addEventListener('click', async () => {
      await api.deleteAnimation(clip.id);
      toast('Clip deleted');
    });

    body.append(
      name,
      grid,
      el('div', { class: 'range-wrap' }, el('span', { class: 'muted small', text: 'Speed' }), speed, speedVal),
      el('div', { class: 'anim-card-actions' }, del)
    );
  }
  card.append(body);
  return card;
}

function renderBindings(cfg) {
  animBindingsEl.innerHTML = '';
  const clips = cfg.clips || [];
  const bindings = cfg.bindings || {};

  for (const state of STATE_ORDER) {
    const control = el('div', { class: 'field-control bind-control' });
    const bound = bindings[state] || [];

    if (state === 'idle') {
      // Multi-select: each checked clip joins the idle rotation.
      for (const clip of clips) {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = bound.includes(clip.id);
        cb.addEventListener('change', async () => {
          const ids = [...animBindingsEl.querySelectorAll(`[data-state="idle"] input:checked`)]
            .map((i) => i.dataset.clip);
          await api.setBinding('idle', ids);
        });
        cb.dataset.clip = clip.id;
        control.append(el('label', { class: 'chip' }, cb, el('span', { text: clip.name })));
      }
      control.dataset.state = 'idle';
    } else {
      // Single-select dropdown (None + every clip).
      const sel = el('select');
      sel.append(el('option', { value: '', text: '— None —' }));
      for (const clip of clips) sel.append(el('option', { value: clip.id, text: clip.name }));
      sel.value = bound[0] || '';
      sel.addEventListener('change', () => api.setBinding(state, sel.value ? [sel.value] : []));
      control.append(sel);
    }

    animBindingsEl.append(
      el('div', { class: 'field' },
        el('div', { class: 'field-label' }, el('span', { class: 'name', text: STATE_LABEL[state] })),
        control
      )
    );
  }
}

function renderAnimations(cfg) {
  clearPreviewTimers();
  animLibraryEl.innerHTML = '';
  for (const clip of cfg.clips || []) animLibraryEl.append(renderClipCard(clip));
  renderBindings(cfg);
}

async function loadAnimations() {
  try {
    renderAnimations(await api.getAnimations());
  } catch {
    toast('Could not load animations', true);
  }
}

document.getElementById('anim-import').addEventListener('click', async () => {
  const res = await api.importAnimation();
  if (res && res.cancelled) return;
  if (res && res.ok) toast(`Added "${res.clip.name}" — bind it below`);
  else toast((res && res.error) || 'Import failed', true);
  // The broadcast also refreshes us, but reload now for immediacy.
  loadAnimations();
});

api.onAnimationsChanged((cfg) => {
  if (activePanel === 'animations') renderAnimations(cfg);
});

buildForms().then(addVoicePreview);
loadShortcuts();
buildAbout();
loadConversations();

// --- Models & GPUs (llama.cpp server profiles) ---------------------------------
const srv = api.server;
const srvStatusEl = document.getElementById('srv-status');
const srvProgressEl = document.getElementById('srv-progress');
const srvGpusEl = document.getElementById('srv-gpus');
const srvProfilesEl = document.getElementById('srv-profiles');
const srvPresetsEl = document.getElementById('srv-presets');
const srvPresetModel = document.getElementById('srv-preset-model');
const srvLogEl = document.getElementById('srv-log');
const srvEnabled = document.getElementById('srv-enabled');

const DEVICE_OPTIONS = [
  { value: 'CUDA0', label: 'RTX 3060 only' },
  { value: 'CUDA0,Vulkan0', label: 'Both GPUs' },
  { value: 'Vulkan0', label: 'Radeon only' }
];
const CTX_OPTIONS = [8192, 16384, 32768, 65536, 131072, 262144];
const CACHE_OPTIONS = [
  { value: '', label: 'f16 (default)' },
  { value: 'q8_0', label: 'q8_0 (half the VRAM)' },
  { value: 'q4_0', label: 'q4_0 (quarter, lossier)' }
];

let srvModels = [];
let srvTimer = null;
let srvEditing = false;

function srvToast(res, okText) {
  if (res.ok) {
    if (okText) toast(okText);
  } else toast(res.error, true);
  return res.ok;
}

function select(options, value) {
  const s = el('select');
  for (const o of options) {
    const opt = el('option', { value: o.value, text: o.label });
    if (String(o.value) === String(value)) opt.selected = true;
    s.append(opt);
  }
  return s;
}

function renderProfile(p, st) {
  const active = st.activeProfile === p.name;
  const stateText = { loaded: 'loaded', loading: 'loading…', unloaded: 'not loaded', missing: 'model missing' }[p.state] || p.state;
  const model = select(srvModels.map((m) => ({ value: m.id, label: `${m.id} (${(m.bytes / 1e9).toFixed(1)} GB)` })), p.model);
  const devices = select(DEVICE_OPTIONS, p.devices);
  const split = el('input', { type: 'text', value: p.tensorSplit || '', placeholder: 'e.g. 12,16' });
  const ctx = select(CTX_OPTIONS.map((n) => ({ value: n, label: `${n / 1024}k tokens` })), p.ctx);
  const moe = el('input', { type: 'number', min: 0, max: 64, placeholder: 'auto', value: p.cpuMoeLayers ?? '' });
  const splitRow = [el('span', { text: 'GPU split' }), split];
  const syncSplit = () => splitRow.forEach((n) => n.classList.toggle('hidden', !devices.value.includes(',')));
  devices.addEventListener('change', syncSplit);
  syncSplit();
  for (const c of [model, devices, split, ctx, moe]) c.addEventListener('focus', () => { srvEditing = true; });

  const load = el('button', { class: 'btn', text: active ? 'Reload' : `Load ${p.label}` });
  load.disabled = st.switching;
  load.addEventListener('click', async () => {
    srvToast(await srv.switchTo(p.name), `${p.label} model loaded`);
    refreshServer();
  });
  const save = el('button', { class: 'btn', text: 'Save' });
  save.addEventListener('click', async () => {
    const patch = { profiles: { [p.name]: {
      model: model.value, devices: devices.value, tensorSplit: devices.value.includes(',') ? split.value.trim() : '',
      ctx: Number(ctx.value), cpuMoeLayers: moe.value === '' ? null : Number(moe.value)
    } } };
    srvEditing = false;
    if (!srvToast(await srv.save(patch))) return;
    toast(`${p.label} saved — restart the server to apply`);
    refreshServer();
  });

  return el('div', { class: `scard srv-profile${active ? ' active' : ''}` },
    el('div', { class: 'srv-head' }, el('h3', { text: p.label }), el('span', { class: `srv-state ${p.state}`, text: stateText })),
    el('div', { class: 'sub', text: p.description }),
    el('div', { class: 'srv-form' },
      el('span', { text: 'Model' }), model,
      el('span', { text: 'GPUs' }), devices,
      ...splitRow,
      el('span', { text: 'Context' }), ctx,
      el('span', { text: 'Experts in RAM', title: 'MoE layers whose experts stay in system RAM. Blank = auto-fit to the GPUs.' }), moe
    ),
    el('div', { class: 'srv-actions' }, load, save)
  );
}

function renderPreset(id, preset, st) {
  const devices = select(DEVICE_OPTIONS, preset.devices);
  const split = el('input', { type: 'text', value: preset.tensorSplit || '', placeholder: 'e.g. 11,17' });
  const ctx = select(CTX_OPTIONS.map((n) => ({ value: n, label: `${n / 1024}k tokens` })), preset.ctx);
  const cache = select(CACHE_OPTIONS, preset.cacheType);
  const moe = el('input', { type: 'number', min: 0, max: 64, placeholder: 'auto', value: preset.cpuMoeLayers ?? '' });
  const splitRow = [el('span', { text: 'GPU split' }), split];
  const syncSplit = () => splitRow.forEach((n) => n.classList.toggle('hidden', !devices.value.includes(',')));
  devices.addEventListener('change', syncSplit);
  syncSplit();
  for (const c of [devices, split, ctx, cache, moe]) c.addEventListener('focus', () => { srvEditing = true; });

  const state = st.loaded.includes(id) ? 'loaded' : 'unloaded';
  const save = el('button', { class: 'btn', text: 'Save' });
  save.addEventListener('click', async () => {
    const patch = { modelPresets: { [id]: {
      devices: devices.value, tensorSplit: devices.value.includes(',') ? split.value.trim() : '',
      ctx: Number(ctx.value), cacheType: cache.value, cpuMoeLayers: moe.value === '' ? null : Number(moe.value)
    } } };
    srvEditing = false;
    if (!srvToast(await srv.save(patch))) return;
    toast(`${id} saved, restart the server to apply`);
    refreshServer();
  });
  const remove = el('button', { class: 'btn danger', text: 'Remove' });
  remove.addEventListener('click', async () => {
    srvEditing = false;
    if (srvToast(await srv.save({ modelPresets: { [id]: null } }), `${id} preset removed`)) refreshServer();
  });

  return el('div', { class: 'scard srv-profile' },
    el('div', { class: 'srv-head' }, el('h3', { text: id }), el('span', { class: `srv-state ${state}`, text: state === 'loaded' ? 'loaded' : 'not loaded' })),
    el('div', { class: 'srv-form' },
      el('span', { text: 'GPUs' }), devices,
      ...splitRow,
      el('span', { text: 'Context' }), ctx,
      el('span', { text: 'KV cache', title: 'Quantizing the KV cache lets a longer context fit in the same VRAM.' }), cache,
      el('span', { text: 'Experts in RAM', title: 'MoE layers whose experts stay in system RAM. Blank = auto-fit to the GPUs.' }), moe
    ),
    el('div', { class: 'srv-actions' }, save, remove)
  );
}

function renderPresets(st) {
  const profileModels = new Set(st.profiles.map((p) => p.model));
  const presets = Object.entries(st.modelPresets || {}).filter(([id]) => !profileModels.has(id));
  srvPresetsEl.innerHTML = '';
  for (const [id, preset] of presets) srvPresetsEl.append(renderPreset(id, preset, st));

  const free = srvModels.filter((m) => !profileModels.has(m.id) && !(st.modelPresets || {})[m.id]);
  const keep = srvPresetModel.value;
  srvPresetModel.innerHTML = '';
  for (const m of free) srvPresetModel.append(el('option', { value: m.id, text: m.id }));
  if (free.some((m) => m.id === keep)) srvPresetModel.value = keep;
  document.getElementById('srv-preset-add').disabled = !free.length;
}

function renderServer(st) {
  const svc = st.service;
  const running = st.reachable;
  srvStatusEl.textContent = running
    ? `● Running at ${st.url}${svc.active === 'active' ? ` (${svc.unit})` : ' (started outside the service)'} · ${st.loaded.length ? `loaded: ${st.loaded.join(', ')}` : 'no model loaded'}`
    : `○ Stopped${svc.installed ? '' : ` — ${svc.unit} is not installed (run scripts/setup-llama-router.sh)`}`;
  srvStatusEl.className = `status-line small ${running ? 'ok' : 'muted'}`;
  srvEnabled.checked = svc.enabled;
  document.getElementById('srv-start').disabled = running;
  document.getElementById('srv-stop').disabled = svc.active !== 'active';

  srvGpusEl.innerHTML = '';
  for (const g of st.gpus) {
    const pct = g.totalMiB ? Math.round((g.usedMiB / g.totalMiB) * 100) : 0;
    srvGpusEl.append(scard(g.name, meter(pct), el('div', { class: 'sub', text: `${gb(g.usedMiB)} / ${gb(g.totalMiB)} GB VRAM` })));
  }
  if (srvEditing) return;
  srvProfilesEl.innerHTML = '';
  for (const p of st.profiles) srvProfilesEl.append(renderProfile(p, st));
  renderPresets(st);
}

async function refreshServer() {
  const [st, models] = await Promise.all([srv.status(), srvModels.length ? null : srv.models()]);
  if (models && models.ok) srvModels = models.data;
  if (st.ok) renderServer(st.data);
  else srvStatusEl.textContent = st.error;
}

function startServerPanel() {
  srvEditing = false;
  refreshServer();
  if (!srvTimer) srvTimer = setInterval(refreshServer, 3000);
}
function stopServerPanel() {
  clearInterval(srvTimer);
  srvTimer = null;
}

for (const [id, action, done] of [['srv-start', 'start', 'Server started'], ['srv-stop', 'stop', 'Server stopped'], ['srv-restart', 'restart', 'Server restarted']]) {
  document.getElementById(id).addEventListener('click', async () => {
    srvProgressEl.textContent = `${action === 'stop' ? 'Stopping' : 'Starting'} the model server…`;
    srvProgressEl.classList.remove('hidden');
    srvToast(await srv.service(action), done);
    srvProgressEl.classList.add('hidden');
    refreshServer();
  });
}
document.getElementById('srv-preset-add').addEventListener('click', async () => {
  const id = srvPresetModel.value;
  if (!id) return;
  srvEditing = false;
  if (srvToast(await srv.save({ modelPresets: { [id]: {} } }), `Preset added for ${id}`)) refreshServer();
});
srvEnabled.addEventListener('change', async () => {
  srvToast(await srv.service(srvEnabled.checked ? 'enable' : 'disable'), srvEnabled.checked ? 'Starts at login' : 'Won’t start at login');
  refreshServer();
});
document.getElementById('srv-logs').addEventListener('click', async () => {
  const res = await srv.logs();
  srvLogEl.textContent = res.ok ? res.data || '(no log yet)' : res.error;
  srvLogEl.classList.toggle('hidden');
  srvLogEl.scrollTop = srvLogEl.scrollHeight;
});

srv.onEvent((ev) => {
  if (ev.type === 'progress') {
    srvProgressEl.textContent = ev.text;
    srvProgressEl.classList.remove('hidden');
  } else if (ev.type === 'status') {
    if (!ev.status.switching) srvProgressEl.classList.add('hidden');
    if (activePanel === 'server') renderServer(ev.status);
  }
});
api.onShowPanel((panel) => showPanel(panel));

// --- Wardrobe ---------------------------------------------------------------
const wardrobePreviewEl = document.getElementById('wardrobe-preview');
const wardrobeFormEl = document.getElementById('wardrobe-form');
const SLOT_LABEL = { top: 'Top', bottom: 'Bottom', shoes: 'Shoes' };

const itemLabel = (item) => item.charAt(0).toUpperCase() + item.slice(1).replace(/-/g, ' ');
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;

function outfitQuery(outfit) {
  return new URLSearchParams(outfit).toString();
}

function outfitPicker(state, outfit, onPick) {
  const row = el('div', { class: 'field-control wardrobe-picker' });
  for (const slot of state.slots) {
    const sel = el('select', { 'aria-label': SLOT_LABEL[slot] });
    for (const item of state.catalog[slot]) sel.append(el('option', { value: item, text: itemLabel(item) }));
    sel.value = outfit[slot];
    sel.addEventListener('change', () => onPick({ [slot]: sel.value }));
    row.append(el('label', { class: 'grid-cell' }, el('span', { text: SLOT_LABEL[slot] }), sel));
  }
  return row;
}

function renderWardrobe(state, idleClip) {
  clearPreviewTimers();
  wardrobePreviewEl.innerHTML = '';
  wardrobeFormEl.innerHTML = '';
  const preview = (outfit, boxH) => (idleClip ? makePreview({ ...idleClip, outfit: outfitQuery(outfit) }, boxH) : null);
  const save = async (patch) => renderWardrobe(await api.setWardrobe(patch), idleClip);

  wardrobePreviewEl.append(preview(state.current, 260) || el('div', { class: 'muted small', text: 'No pixel avatar found' }));

  const mode = el('select', { 'aria-label': 'Wardrobe mode' },
    el('option', { value: 'manual', text: 'Manual — wear the outfit below' }),
    el('option', { value: 'auto', text: 'Automatic — change with the time of day' }));
  mode.value = state.mode;
  mode.addEventListener('change', () => save({ mode: mode.value }));
  wardrobeFormEl.append(el('div', { class: 'field' },
    el('div', { class: 'field-label' }, el('span', { class: 'name', text: 'Mode' })),
    el('div', { class: 'field-control' }, mode)));

  if (state.mode === 'manual') {
    wardrobeFormEl.append(el('div', { class: 'field' },
      el('div', { class: 'field-label' }, el('span', { class: 'name', text: 'Outfit' })),
      outfitPicker(state, state.outfit, (pick) => save({ outfit: pick }))));
    return;
  }

  state.periods.forEach((period, i) => {
    const end = state.periods[(i + 1) % state.periods.length].start;
    const isNow = period.id === state.period;
    wardrobeFormEl.append(el('div', { class: `field${isNow ? ' wardrobe-now' : ''}` },
      el('div', { class: 'field-label' },
        el('span', { class: 'name', text: `${period.label}${isNow ? ' · now' : ''}` }),
        el('span', { class: 'help', text: `${hourLabel(period.start)}–${hourLabel(end)}` }),
        preview(state.schedule[period.id], 96)),
      outfitPicker(state, state.schedule[period.id], (pick) => save({ schedule: { [period.id]: pick } }))));
  });
}

async function loadWardrobe() {
  try {
    const [state, anim] = await Promise.all([api.getWardrobe(), api.getAnimations()]);
    renderWardrobe(state, (anim.clips || []).find((c) => c.id === 'builtin:pixel-idle'));
  } catch {
    toast('Could not load wardrobe', true);
  }
}

api.onAnimationsChanged(() => {
  if (activePanel === 'wardrobe') loadWardrobe();
});
