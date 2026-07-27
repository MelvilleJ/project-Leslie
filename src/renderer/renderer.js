'use strict';

const avatar = document.getElementById('avatar');
const stage = document.getElementById('stage');
const transcript = document.getElementById('transcript');
const statusLine = document.getElementById('status');
const input = document.getElementById('input');
const mic = document.getElementById('mic');
const sendBtn = document.getElementById('send-btn');
const agentToggle = document.getElementById('agent-toggle');
const settingsBtn = document.getElementById('settings-btn');
const mentionMenu = document.getElementById('mention-menu');
const commandMenu = document.getElementById('command-menu');

let expanded = false;
let pendingConfirms = 0;

function setExpanded(on) {
  on = !!on;
  if (on === expanded) return;
  expanded = on;
  document.body.classList.toggle('expanded', on);
  window.leslie.setExpanded(on);
  if (on) setTimeout(() => input.focus(), 0);
}

// Guard against collapse while confirming or pointer over panel (focus-follows-mouse).
let pointerInside = false;
document.documentElement.addEventListener('mouseenter', () => { pointerInside = true; });
document.documentElement.addEventListener('mouseleave', () => { pointerInside = false; });

window.leslie.onWindowBlur(() => {
  if (!pendingConfirms && !pointerInside) setExpanded(false);
});

// Measure pointerdown/up distance to avoid Wayland compositor's move-detection.
window.leslie.onWindowMoved(() => {
  setFlag('moving', true);
  if (moveTimer) clearTimeout(moveTimer);
  moveTimer = setTimeout(() => setFlag('moving', false), 600);
});

let pointerDownAt = 0;
let pointerDownX = 0;
let pointerDownY = 0;
let singleClickTimer = null;
let lastClickAt = 0;
const DRAG_PX = 6;
const DBLCLICK_MS = 400;

stage.addEventListener('pointerdown', (e) => {
  pointerDownAt = Date.now();
  pointerDownX = e.clientX;
  pointerDownY = e.clientY;
});

stage.addEventListener('pointerup', (e) => {
  if (Date.now() - pointerDownAt > 800) return; // held too long to be a click
  const dx = Math.abs(e.clientX - pointerDownX);
  const dy = Math.abs(e.clientY - pointerDownY);
  if (dx > DRAG_PX || dy > DRAG_PX) return; // moved — a drag, not a click

  const now = Date.now();
  if (now - lastClickAt < DBLCLICK_MS) {
    if (singleClickTimer) {
      clearTimeout(singleClickTimer);
      singleClickTimer = null;
    }
    lastClickAt = 0;
    setExpanded(true); // second click within the window -> double-click
    return;
  }
  lastClickAt = now;
  singleClickTimer = setTimeout(() => {
    singleClickTimer = null;
    setExpanded(!expanded);
  }, DBLCLICK_MS);
});

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' && event.key !== ' ') return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
  event.preventDefault();
  setExpanded(true);
});

let moveTimer = null;

function clipSheetUrl(clip) {
  if (!clip) return '';
  if (clip.builtin) return `../../assets/animations/${clip.sheet}/spritesheet.png`;
  return `leslie-sprite://clips/${clip.file}`;
}

const STATE_PRIORITY = ['toolCall', 'longThink', 'talking', 'thinking', 'listening', 'moving', 'idle'];
const flags = {
  thinking: false, longThink: false, toolCall: false,
  talking: false, listening: false, moving: false
};

let clipsById = Object.create(null);
let bindings = {};

let currentClip = null;
let frame = 0;
let animTimer = null;
let idleRotateTimer = null;
let lastIdleId = null;

function drawFrame(clip, n) {
  const col = n % clip.cols;
  const row = Math.floor(n / clip.cols);
  avatar.style.backgroundPosition = `-${col * clip.frameW}px -${row * clip.frameH}px`;
}

function playClip(clip) {
  if (!clip || clip === currentClip) return;
  currentClip = clip;
  frame = 0;
  avatar.style.backgroundImage = `url('${clipSheetUrl(clip)}')`;
  avatar.style.backgroundRepeat = 'no-repeat';
  avatar.style.width = `${clip.frameW}px`;
  avatar.style.height = `${clip.frameH}px`;
  drawFrame(clip, 0);
  if (animTimer) clearInterval(animTimer);
  animTimer = setInterval(() => {
    frame = (frame + 1) % currentClip.frames;
    drawFrame(currentClip, frame);
  }, clip.frameMs || 140);
}

function activeState() {
  for (const s of STATE_PRIORITY) {
    if (s === 'idle') return 'idle';
    if (flags[s] && (bindings[s] || []).length) return s;
  }
  return 'idle';
}

function clipForState(state) {
  const ids = bindings[state] || [];
  if (!ids.length) return null;
  if (state === 'idle') {
    const id = lastIdleId && ids.includes(lastIdleId) ? lastIdleId : ids[0];
    return clipsById[id] || clipsById[ids[0]] || null;
  }
  return clipsById[ids[0]] || null;
}

function manageIdleRotation(state) {
  const multi = state === 'idle' && (bindings.idle || []).length > 1;
  if (multi && !idleRotateTimer) {
    idleRotateTimer = setInterval(() => {
      if (activeState() !== 'idle') return;
      const ids = bindings.idle || [];
      const others = ids.filter((id) => id !== lastIdleId);
      const pool = others.length ? others : ids;
      lastIdleId = pool[Math.floor(Math.random() * pool.length)];
      const clip = clipsById[lastIdleId];
      if (clip) playClip(clip);
    }, 10000);
  } else if (!multi && idleRotateTimer) {
    clearInterval(idleRotateTimer);
    idleRotateTimer = null;
  }
}

function resolveAnimation() {
  const state = activeState();
  manageIdleRotation(state);
  const clip = clipForState(state) || clipForState('idle') || clipsById['builtin:idle'];
  if (clip) playClip(clip);
}

function setFlag(name, value) {
  if (flags[name] === value) return;
  flags[name] = value;
  resolveAnimation();
}

function applyAnimConfig(cfg) {
  if (!cfg) return;
  clipsById = Object.create(null);
  for (const c of cfg.clips || []) clipsById[c.id] = c;
  bindings = cfg.bindings || {};
  if (!(bindings.idle || []).length && clipsById['builtin:idle']) bindings.idle = ['builtin:idle'];
  currentClip = null;
  resolveAnimation();
}

applyAnimConfig({
  clips: [
    { id: 'builtin:idle', builtin: true, sheet: 'idle', frameW: 228, frameH: 537, cols: 4, frames: 25, frameMs: 140 },
    { id: 'builtin:thinking', builtin: true, sheet: 'thinking', frameW: 247, frameH: 537, cols: 4, frames: 12, frameMs: 140 }
  ],
  bindings: { idle: ['builtin:idle'], thinking: ['builtin:thinking'] }
});
window.leslie.getAnimations().then(applyAnimConfig).catch(() => {});
window.leslie.onAnimations(applyAnimConfig);

let longThinkTimer = null;
function startThinking() {
  setFlag('talking', false);
  setFlag('longThink', false);
  setFlag('thinking', true);
  if (longThinkTimer) clearTimeout(longThinkTimer);
  longThinkTimer = setTimeout(() => setFlag('longThink', true), 6000);
}
function endTurn() {
  if (longThinkTimer) clearTimeout(longThinkTimer);
  longThinkTimer = null;
  setFlag('thinking', false);
  setFlag('longThink', false);
  setFlag('talking', false);
  setFlag('toolCall', false);
}

function nearBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
}
function scrollToBottom(force) {
  if (force || nearBottom()) transcript.scrollTop = transcript.scrollHeight;
}

function setStatus(text) {
  statusLine.textContent = text || '';
}

function appendUser(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  transcript.appendChild(el);
  scrollToBottom(true);
}

function systemLine(text, kind) {
  const el = document.createElement('div');
  el.className = 'msg system' + (kind ? ` ${kind}` : '');
  el.textContent = text;
  transcript.appendChild(el);
  scrollToBottom();
  return el;
}

let current = null; // { el, thinking, thinkingBody, tools, body, raw, cards }

function beginAssistant() {
  const el = document.createElement('div');
  el.className = 'msg assistant';

  const tools = document.createElement('div');
  tools.className = 'tools';

  const body = document.createElement('div');
  body.className = 'msg-body streaming';

  el.append(tools, body);
  transcript.appendChild(el);
  current = { el, thinking: null, thinkingBody: null, tools, body, raw: '', cards: new Map(), synapses: new Map() };
  scrollToBottom(true);
}

function ensureThinking() {
  if (!current) return null;
  if (current.thinking) return current.thinkingBody;
  const box = document.createElement('div');
  box.className = 'thinking';
  const head = document.createElement('div');
  head.className = 'thinking-head';
  head.innerHTML = '<i class="fa-solid fa-chevron-down chev" aria-hidden="true"></i><span>Reasoning</span>';
  const body = document.createElement('div');
  body.className = 'thinking-body';
  head.addEventListener('click', () => box.classList.toggle('collapsed'));
  box.append(head, body);
  current.el.insertBefore(box, current.tools);
  current.thinking = box;
  current.thinkingBody = body;
  return body;
}

function appendThinking(delta) {
  const body = ensureThinking();
  if (!body) return;
  body.textContent += delta;
  body.scrollTop = body.scrollHeight;
  scrollToBottom();
}

function appendBody(delta) {
  if (!current) return;
  // First answer text: collapse the reasoning block, switch to "talking".
  if (!current.raw && current.thinking) current.thinking.classList.add('collapsed');
  current.raw += delta;
  current.body.textContent = current.raw;
  scrollToBottom();
}

function finishAssistant(reply) {
  if (!current) return;
  // Freeze any still-running synapse timers (normally the tool 'end' event does
  // this, but guard against a turn ending without one so no interval leaks).
  for (const synapse of current.synapses.values()) synapse.complete();
  const md = (reply && reply.trim()) || current.raw;
  current.body.classList.remove('streaming');
  if (md) {
    try {
      current.body.innerHTML = window.markdown.render(md);
    } catch {
      current.body.textContent = md;
    }
  } else {
    // No answer text: drop the empty body, and the whole message too unless it
    // carries tool cards worth keeping.
    current.body.remove();
    if (!current.tools.childElementCount) current.el.remove();
  }
  scrollToBottom();
  current = null;
}

const TOOL_ICON = {
  web_search: 'fa-magnifying-glass', deep_search: 'fa-magnifying-glass', open_search: 'fa-magnifying-glass',
  deep_research: 'fa-magnifying-glass-chart',
  open_url: 'fa-link', open_app: 'fa-rocket', run_command: 'fa-terminal',
  install_software: 'fa-download', create_document: 'fa-file',
  read_file: 'fa-file-lines', read_document: 'fa-file-lines', list_directory: 'fa-folder',
  write_file: 'fa-file-pen', run_subagent: 'fa-diagram-project',
  set_mode: 'fa-toggle-on',
  remember: 'fa-brain'
};

function toolCardStart({ id, name, detail }) {
  if (!current) return;
  // deep_research gets the live synapse visual instead of a compact row.
  if (name === 'deep_research' && typeof window.createResearchSynapse === 'function') {
    const box = document.createElement('div');
    box.className = 'tool-card-research';
    const synapse = window.createResearchSynapse(box, { query: detail || '', compact: true });
    current.tools.appendChild(box);
    if (id) current.synapses.set(id, synapse);
    scrollToBottom();
    return;
  }
  const card = document.createElement('div');
  card.className = 'tool-card running';
  const icon = TOOL_ICON[name] || 'fa-wrench';
  card.innerHTML =
    `<i class="fa-solid ${icon} tc-icon" aria-hidden="true"></i>` +
    `<span class="tc-name"></span>` +
    `<span class="tc-detail"></span>` +
    `<i class="fa-solid fa-spinner tc-status" aria-hidden="true"></i>`;
  card.querySelector('.tc-name').textContent = name;
  card.querySelector('.tc-detail').textContent = detail || '';
  current.tools.appendChild(card);
  if (id) current.cards.set(id, card);
  scrollToBottom();
}

function toolCardEnd({ id, ok, title }) {
  const synapse = current && id ? current.synapses.get(id) : null;
  if (synapse) {
    if (ok) synapse.complete();
    else synapse.fail();
    return;
  }
  const card = current && id ? current.cards.get(id) : null;
  if (!card) return;
  card.classList.remove('running');
  card.classList.add(ok ? 'done' : 'failed');
  if (title) card.querySelector('.tc-detail').textContent = title;
  const status = card.querySelector('.tc-status');
  status.className = `fa-solid ${ok ? 'fa-check' : 'fa-xmark'} tc-status`;
}

// Map a deep_research progress event onto the synapse's controls.
function driveSynapse(synapse, e) {
  if (!e) return;
  if (e.phase) {
    synapse.setPhase(e.phase, { queries: e.queries, title: e.title, total_findings: e.totalFindings });
  }
  if (typeof e.round === 'number') synapse.setRound(e.round);
  if (typeof e.totalFindings === 'number') synapse.setSourceCount(e.totalFindings);
  if (e.phase === 'error') synapse.fail(e.message);
}

// Long-running tools narrate progress mid-run. deep_research drives its synapse;
// everything else updates its card's detail line in place.
function toolCardProgress({ id, detail, research }) {
  if (!current || !id) return;
  const synapse = current.synapses.get(id);
  if (synapse) {
    driveSynapse(synapse, research);
    scrollToBottom();
    return;
  }
  const card = current.cards.get(id);
  if (!card || !detail) return;
  const el = card.querySelector('.tc-detail');
  if (el) el.textContent = detail;
  scrollToBottom();
}

let streaming = false;

window.leslie.onAgentThink((delta) => {
  if (!streaming) return;
  appendThinking(delta);
});

window.leslie.onAgentChunk((delta) => {
  if (!streaming) return;
  if (longThinkTimer) { clearTimeout(longThinkTimer); longThinkTimer = null; }
  setFlag('longThink', false);
  setFlag('talking', true);
  setStatus('Answering…');
  appendBody(delta);
});

window.leslie.onToolCall((ev) => {
  if (!ev || !streaming) return;
  if (ev.phase === 'end') {
    toolCardEnd(ev);
    setFlag('toolCall', false);
    return;
  }
  if (ev.phase === 'progress') {
    toolCardProgress(ev);
    setStatus(ev.detail || `Running ${ev.name}…`);
    return;
  }
  setFlag('toolCall', true);
  setStatus(`Running ${ev.name}…`);
  toolCardStart(ev);
});

async function send(text) {
  text = text.trim();
  if (!text || streaming) return;

  // Only keep "@" mentions whose path still appears in the message.
  const mentions = pendingMentions.filter((m) => text.includes(m.path));
  pendingMentions = [];

  setExpanded(true);
  appendUser(text);
  streaming = true;
  setSendMode(true);
  startThinking();
  setStatus('Thinking…');
  beginAssistant();

  let res;
  try {
    res = await window.leslie.sendMessage(text, mentions);
  } catch (err) {
    res = { error: err && err.message ? err.message : String(err) };
  }
  streaming = false;
  setSendMode(false);
  endTurn();
  setStatus('');

  if (res && res.error) {
    finishAssistant('');
    systemLine(`⚠ ${res.error}`, 'error');
  } else {
    finishAssistant(res && res.reply);
    if (res && res.aborted) systemLine('⏹ Interrupted.');
  }
}

// --- Dedicated deep-research flow -------------------------------------------
// Runs the researcher directly (main process), bypassing the agent loop and its
// tool schemas entirely, so the full cited report renders straight to the
// transcript regardless of the chat model's context window. Driven by a live
// synapse fed from research:progress events.
let activeResearchSynapse = null;

window.leslie.onResearchProgress((e) => {
  if (activeResearchSynapse) driveSynapse(activeResearchSynapse, e);
});

async function runResearchFlow(query) {
  query = query.trim();
  if (!query || streaming) return;

  setExpanded(true);
  appendUser(`🔬 ${query}`);
  streaming = true;
  setSendMode(true);
  setFlag('thinking', true);
  setStatus('Researching…');
  beginAssistant();

  const box = document.createElement('div');
  box.className = 'tool-card-research';
  activeResearchSynapse = window.createResearchSynapse
    ? window.createResearchSynapse(box, { query, compact: true })
    : null;
  current.tools.appendChild(box);
  scrollToBottom();

  let res;
  try {
    res = await window.leslie.runResearch(query);
  } catch (err) {
    res = { error: err && err.message ? err.message : String(err) };
  }
  streaming = false;
  setSendMode(false);
  endTurn();
  setStatus('');

  if (res && res.error) {
    if (activeResearchSynapse) activeResearchSynapse.fail(res.error);
    finishAssistant('');
    systemLine(`⚠ research: ${res.error}`, 'error');
  } else {
    if (activeResearchSynapse) res.aborted ? activeResearchSynapse.fail('interrupted') : activeResearchSynapse.complete();
    finishAssistant(res && res.report);
    if (res && res.aborted) systemLine('⏹ Research interrupted.');
  }
  activeResearchSynapse = null;
}

window.leslie.onConfirm(({ id, message }) => {
  setExpanded(true);
  pendingConfirms++;
  const card = document.createElement('div');
  card.className = 'confirm-card';
  const text = document.createElement('div');
  text.className = 'cc-text';
  text.textContent = message || 'Run this command?';
  const actions = document.createElement('div');
  actions.className = 'cc-actions';
  const yes = document.createElement('button');
  yes.className = 'cc-yes';
  yes.textContent = 'Approve';
  const no = document.createElement('button');
  no.className = 'cc-no';
  no.textContent = 'Deny';
  actions.append(yes, no);
  card.append(text, actions);
  transcript.appendChild(card);
  scrollToBottom(true);

  const answer = (approved) => {
    window.leslie.confirmResponse(id, approved);
    card.classList.add('resolved');
    pendingConfirms = Math.max(0, pendingConfirms - 1);
  };
  yes.addEventListener('click', () => answer(true));
  no.addEventListener('click', () => answer(false));
});

const MODES = ['chat', 'plan', 'agent'];
const MODE_META = {
  chat: { icon: 'fa-comment', label: 'Chat', say: '💬 Chat mode — just conversation.' },
  plan: { icon: 'fa-clipboard-list', label: 'Plan', say: "📋 Plan mode — I'll investigate read-only and propose a plan." },
  agent: { icon: 'fa-robot', label: 'Agent', say: '🤖 Agent mode — I can run commands.' }
};
let mode = 'chat';

function reflectMode(next) {
  mode = MODES.includes(next) ? next : 'chat';
  const meta = MODE_META[mode];
  agentToggle.innerHTML = `<i class="fa-solid ${meta.icon}" aria-hidden="true"></i>`;
  agentToggle.dataset.mode = mode;
  agentToggle.classList.toggle('on', mode !== 'chat');
  agentToggle.title = `Mode: ${meta.label} — click to switch (Chat → Plan → Agent)`;
}

async function setMode(next, { announce = true } = {}) {
  const applied = await window.leslie.setMode(next);
  reflectMode(applied);
  if (announce) systemLine(MODE_META[mode].say);
}

agentToggle.addEventListener('click', () => {
  setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
});
window.leslie.onMode((next) => reflectMode(next));

function clearTranscript() {
  transcript.innerHTML = '';
  current = null;
}

const COMMANDS = {
  hide: () => window.leslie.hide(),
  close: () => window.leslie.quit(),
  quit: () => window.leslie.quit(),
  exit: () => window.leslie.quit(),
  reset: () => {
    window.leslie.resetChat();
    clearTranscript();
    systemLine('Conversation cleared.');
  },
  clear: () => COMMANDS.reset(),
  listen: () => {
    window.leslie.voiceListenOnce();
    setStatus('Listening…');
  },
  mic: () => COMMANDS.listen(),
  settings: () => window.leslie.openSettings(),
  voice: (arg) => {
    const on = !/^(off|0|false|stop|no)$/i.test(arg.trim());
    window.leslie.setVoiceActive(on);
    systemLine(on ? 'Voice on.' : 'Voice off.');
  },
  mode: (arg) => {
    const m = arg.trim().toLowerCase();
    if (MODES.includes(m)) setMode(m);
    else systemLine('Usage: /mode chat|plan|agent');
  },
  plan: (arg) => {
    const off = /^(off|0|false|stop|no)$/i.test(arg.trim());
    setMode(off ? 'chat' : 'plan');
  },
  agent: (arg) => {
    const off = /^(off|0|false|stop|no)$/i.test(arg.trim());
    setMode(off ? 'chat' : 'agent');
  },
  research: (arg) => {
    const q = (arg || '').trim();
    if (q) runResearchFlow(q);
    else systemLine('Usage: /research <question> — deep, multi-source research with a cited report.');
  },
  help: () =>
    systemLine('Commands: /research <q>, /hide, /close, /reset, /settings, /voice on|off, /mode chat|plan|agent, /plan, /agent on|off, /listen, /help')
};

function runCommand(raw) {
  const parts = raw.slice(1).trim().split(/\s+/);
  const name = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');
  const command = COMMANDS[name];
  if (command) command(arg);
  else systemLine(`Unknown command: /${name}`, 'error');
}

// --- "@" file / folder picker -----------------------------------------------
// Type "@" to open an autocomplete of files and folders. Enter navigates into a
// folder or attaches a file; Tab attaches the highlighted item; Esc closes.
let pendingMentions = [];
let mentionStart = -1;
let mentionItems = [];
let mentionIndex = 0;
let mentionSep = '/';
let mentionReq = 0;

function mentionActive() {
  return mentionStart >= 0 && !mentionMenu.classList.contains('hidden');
}

function closeMention() {
  mentionStart = -1;
  mentionItems = [];
  mentionMenu.classList.add('hidden');
  mentionMenu.innerHTML = '';
}

function iconFor(type) {
  return type === 'dir' ? '📁' : type === 'symlink' ? '🔗' : '📄';
}

function renderMention() {
  mentionMenu.innerHTML = '';
  if (!mentionItems.length) {
    const empty = document.createElement('div');
    empty.className = 'mention-empty';
    empty.textContent = 'No matches';
    mentionMenu.appendChild(empty);
  } else {
    mentionItems.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'mention-item' + (i === mentionIndex ? ' active' : '');
      row.setAttribute('role', 'option');
      const icon = document.createElement('span');
      icon.className = 'mi-icon';
      icon.textContent = iconFor(item.type);
      const name = document.createElement('span');
      name.className = 'mi-name';
      name.textContent = item.name;
      const ty = document.createElement('span');
      ty.className = 'mi-type';
      ty.textContent = item.type === 'dir' ? 'folder' : '';
      row.append(icon, name, ty);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        chooseMention(item);
      });
      mentionMenu.appendChild(row);
    });
  }
  mentionMenu.classList.remove('hidden');
}

function moveMention(delta) {
  if (!mentionItems.length) return;
  mentionIndex = (mentionIndex + delta + mentionItems.length) % mentionItems.length;
  renderMention();
  const active = mentionMenu.querySelector('.mention-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

async function refreshMention(query) {
  const seq = ++mentionReq;
  let res;
  try {
    res = await window.leslie.suggestPaths(query);
  } catch {
    res = { items: [], sep: mentionSep };
  }
  if (seq !== mentionReq || mentionStart < 0) return;
  mentionItems = (res && res.items) || [];
  mentionSep = (res && res.sep) || mentionSep;
  mentionIndex = 0;
  renderMention();
}

function updateMention() {
  if (mentionStart < 0) return;
  const caret = input.selectionStart;
  if (caret <= mentionStart || input.value[mentionStart] !== '@') {
    closeMention();
    return;
  }
  refreshMention(input.value.slice(mentionStart + 1, caret));
}

function replaceMentionWith(token) {
  const caret = input.selectionStart;
  const before = input.value.slice(0, mentionStart);
  const after = input.value.slice(caret);
  input.value = before + token + after;
  const pos = (before + token).length;
  input.setSelectionRange(pos, pos);
}

function navigateInto(item) {
  replaceMentionWith('@' + item.path + mentionSep);
  updateMention();
}

function attachMention(item) {
  replaceMentionWith('@' + item.path + ' ');
  if (!pendingMentions.some((m) => m.path === item.path)) {
    pendingMentions.push({ path: item.path, type: item.type === 'dir' ? 'dir' : 'file' });
  }
  closeMention();
  input.focus();
}

function chooseMention(item) {
  if (!item) return;
  if (item.type === 'dir') navigateInto(item);
  else attachMention(item);
}

// --- "/" command palette ----------------------------------------------------
// Type "/" at the start of the input to open a filterable list of commands,
// mirroring the "@" file finder. Selecting completes "/name " into the input.
const COMMAND_META = [
  { name: 'research', usage: '/research <question>', desc: 'Deep multi-source research → cited report' },
  { name: 'mode', usage: '/mode chat|plan|agent', desc: 'Switch operating mode' },
  { name: 'plan', usage: '/plan', desc: 'Read-only plan mode' },
  { name: 'agent', usage: '/agent on|off', desc: 'Agent mode (run commands)' },
  { name: 'voice', usage: '/voice on|off', desc: 'Toggle voice listening' },
  { name: 'listen', usage: '/listen', desc: 'Dictate one utterance' },
  { name: 'settings', usage: '/settings', desc: 'Settings & past conversations' },
  { name: 'reset', usage: '/reset', desc: 'Clear the conversation' },
  { name: 'hide', usage: '/hide', desc: 'Hide the window' },
  { name: 'close', usage: '/close', desc: 'Quit LESLIE' },
  { name: 'help', usage: '/help', desc: 'List all commands' }
];
let commandItems = [];
let commandIndex = 0;

function commandActive() {
  return !commandMenu.classList.contains('hidden');
}

function closeCommandMenu() {
  commandItems = [];
  commandMenu.classList.add('hidden');
  commandMenu.innerHTML = '';
}

function renderCommandMenu() {
  commandMenu.innerHTML = '';
  if (!commandItems.length) {
    const empty = document.createElement('div');
    empty.className = 'mention-empty';
    empty.textContent = 'No matching command';
    commandMenu.appendChild(empty);
  } else {
    commandItems.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'mention-item' + (i === commandIndex ? ' active' : '');
      row.setAttribute('role', 'option');
      const icon = document.createElement('span');
      icon.className = 'mi-icon';
      icon.textContent = '/';
      const name = document.createElement('span');
      name.className = 'mi-name';
      name.textContent = item.usage;
      const desc = document.createElement('span');
      desc.className = 'mi-type';
      desc.textContent = item.desc;
      row.append(icon, name, desc);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        chooseCommand(item);
      });
      commandMenu.appendChild(row);
    });
  }
  commandMenu.classList.remove('hidden');
}

function moveCommand(delta) {
  if (!commandItems.length) return;
  commandIndex = (commandIndex + delta + commandItems.length) % commandItems.length;
  renderCommandMenu();
  const active = commandMenu.querySelector('.mention-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function updateCommandMenu() {
  const caret = input.selectionStart;
  const m = /^\/(\S*)$/.exec(input.value.slice(0, caret));
  if (!m || mentionStart >= 0) {
    closeCommandMenu();
    return;
  }
  const q = m[1].toLowerCase();
  commandItems = COMMAND_META.filter((c) => c.name.startsWith(q));
  commandIndex = 0;
  renderCommandMenu();
}

function chooseCommand(item) {
  if (!item) return;
  input.value = `/${item.name} `;
  input.setSelectionRange(input.value.length, input.value.length);
  closeCommandMenu();
  input.focus();
}

input.addEventListener('input', () => {
  const caret = input.selectionStart;
  if (mentionStart < 0) {
    const ch = input.value[caret - 1];
    const prev = input.value[caret - 2];
    if (ch === '@' && (caret - 1 === 0 || /\s/.test(prev || ''))) mentionStart = caret - 1;
  }
  if (mentionStart >= 0) {
    updateMention();
    closeCommandMenu();
  } else {
    updateCommandMenu();
  }
});

input.addEventListener('keyup', (event) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    if (mentionStart >= 0) updateMention();
    else updateCommandMenu();
  }
});

input.addEventListener('blur', () => {
  closeMention();
  closeCommandMenu();
});

input.addEventListener('keydown', (event) => {
  if (mentionActive()) {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveMention(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveMention(-1); return; }
    if (event.key === 'Enter') { event.preventDefault(); chooseMention(mentionItems[mentionIndex]); return; }
    if (event.key === 'Tab') {
      event.preventDefault();
      if (mentionItems[mentionIndex]) attachMention(mentionItems[mentionIndex]);
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); closeMention(); return; }
  }

  if (commandActive()) {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveCommand(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveCommand(-1); return; }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); chooseCommand(commandItems[commandIndex]); return; }
    if (event.key === 'Escape') { event.preventDefault(); closeCommandMenu(); return; }
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    const text = input.value.trim();
    input.value = '';
    closeMention();
    closeCommandMenu();
    if (text.startsWith('/')) runCommand(text);
    else send(text);
  } else if (event.key === 'Escape') {
    closeMention();
    closeCommandMenu();
    input.blur();
    setExpanded(false); // collapse back to the mascot
  }
});

function submit() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  closeMention();
  closeCommandMenu();
  if (text.startsWith('/')) runCommand(text);
  else send(text);
}

function setSendMode(busy) {
  sendBtn.classList.toggle('stop', busy);
  sendBtn.innerHTML = `<i class="fa-solid ${busy ? 'fa-stop' : 'fa-arrow-up'}" aria-hidden="true"></i>`;
  sendBtn.title = busy ? 'Stop' : 'Send';
}

sendBtn.addEventListener('click', () => {
  if (streaming) window.leslie.cancel();
  else submit();
});
mic.addEventListener('click', () => window.leslie.voiceListenOnce());
settingsBtn.addEventListener('click', () => window.leslie.openSettings());

// --- Voice dictation --------------------------------------------------------

let typingTimer = null;
function typeText(text, autoSend) {
  if (typingTimer) clearInterval(typingTimer);
  input.focus();
  input.value = '';
  let i = 0;
  typingTimer = setInterval(() => {
    input.value = text.slice(0, ++i);
    if (i >= text.length) {
      clearInterval(typingTimer);
      typingTimer = null;
      if (!autoSend) return;
      input.value = '';
      if (text.startsWith('/')) runCommand(text.trim());
      else send(text);
    }
  }, 28);
}

window.leslie.onVoiceWake(({ command }) => {
  setExpanded(true);
  mic.classList.add('listening');
  if (!command) setStatus('Listening…');
});

window.leslie.onVoiceFinal(({ text, autoSend }) => {
  mic.classList.remove('listening');
  if (text && text.trim()) typeText(text.trim(), autoSend !== false);
});

function progressBar(pct) {
  const width = 14;
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${pct}%`;
}

window.leslie.onVoiceStatus(({ state, message, progress }) => {
  const hearing = state === 'listening' || state === 'transcribing';
  mic.classList.toggle('listening', hearing);
  mic.classList.toggle('off', state === 'off');
  setFlag('listening', hearing);
  if (state === 'loading') {
    const bar = typeof progress === 'number' ? ` ${progressBar(progress)}` : '';
    setStatus(`${message || 'Loading speech model…'}${bar}`);
  } else if (state === 'error') {
    systemLine(`⚠ voice: ${message || 'error'}`, 'error');
    setStatus('');
  } else if (state === 'idle' && !streaming) {
    setStatus('');
  }
});

// --- Theme ------------------------------------------------------------------

function applyAccent(color) {
  if (color) document.documentElement.style.setProperty('--accent', color);
}
window.leslie.onTheme(applyAccent);

window.addEventListener('DOMContentLoaded', () => {
  systemLine('Hi, I’m LESLIE — type below to chat.');
  input.focus();
  window.leslie.getMode().then(reflectMode);
  window.leslie.getAccent().then(applyAccent);
});
