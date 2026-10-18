'use strict';

const avatar = document.getElementById('avatar');
const stage = document.getElementById('stage');
const transcript = document.getElementById('transcript');
const statusLine = document.getElementById('status');
const input = document.getElementById('input');
const mic = document.getElementById('mic');
const sendBtn = document.getElementById('send-btn');
const agentToggle = document.getElementById('agent-toggle');
const autoToggle = document.getElementById('auto-toggle');
const settingsBtn = document.getElementById('settings-btn');
const mentionMenu = document.getElementById('mention-menu');
const commandMenu = document.getElementById('command-menu');
const attachmentsEl = document.getElementById('attachments');

let expanded = false;

function setExpanded(on) {
  on = !!on;
  if (on === expanded) return;
  expanded = on;
  document.body.classList.toggle('expanded', on);
  window.leslie.setExpanded(on);
  if (on) setTimeout(() => input.focus(), 0);
}

// Guard against collapse while the pointer is over the panel (focus-follows-mouse).
let pointerInside = false;
document.documentElement.addEventListener('mouseenter', () => { pointerInside = true; });
document.documentElement.addEventListener('mouseleave', () => { pointerInside = false; });

window.leslie.onWindowBlur(() => {
  if (!pointerInside) setExpanded(false);
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
  const outfit = clip.outfit ? `?${clip.outfit}` : '';
  if (clip.aseprite) return `leslie-sprite://builtin/${clip.aseprite}${outfit}`;
  if (clip.builtin) return `../../assets/animations/${clip.sheet}/spritesheet.png`;
  return `leslie-sprite://clips/${clip.file}${outfit}`;
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
  avatar.style.imageRendering = clip.pixelArt ? 'pixelated' : '';
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

const FALLBACK_ANIM_CONFIG = {
  clips: [
    { id: 'builtin:idle', builtin: true, sheet: 'idle', frameW: 228, frameH: 537, cols: 4, frames: 25, frameMs: 140 },
    { id: 'builtin:thinking', builtin: true, sheet: 'thinking', frameW: 247, frameH: 537, cols: 4, frames: 12, frameMs: 140 }
  ],
  bindings: { idle: ['builtin:idle'], thinking: ['builtin:thinking'] }
};
window.leslie.getAnimations().then(applyAnimConfig).catch(() => applyAnimConfig(FALLBACK_ANIM_CONFIG));
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
  setFlag('talking', speech.busy());
  setFlag('toolCall', false);
}

// --- Spoken replies ---------------------------------------------------------
// Reply text is cut into sentences as it streams; each is synthesized in the main
// process (Kokoro) and played in order, so she starts talking before the reply ends.
const speech = (() => {
  const SENTENCE_END = /(?<!\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St))[.!?…:;](?=["')\]]*\s)|\n+/g;
  const LIST_MARKER = /(^|\n)[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/g;
  const MAX_CHUNK = 220;

  let enabled = false;
  let generation = 0;
  let buffer = '';
  let spokeThisTurn = false;
  let chain = Promise.resolve();
  let queued = 0;
  let audioCtx = null;
  let source = null;

  window.leslie.getTtsEnabled().then((on) => (enabled = on)).catch(() => {});
  window.leslie.onTtsEnabled((on) => {
    enabled = on;
    if (!on) stop();
  });

  /** Markdown → something worth saying: no code, tables, URLs or markup. */
  function clean(text) {
    return text
      .replace(/^\s*\|.*$/gm, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'a link')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
      .replace(/[*_~#>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function setPlaying(on) {
    window.leslie.ttsPlaying(on);
    if (!streaming) setFlag('talking', on);
  }

  async function play({ samples, sampleRate }) {
    if (!audioCtx || audioCtx.sampleRate !== sampleRate) audioCtx = new AudioContext({ sampleRate });
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const buf = audioCtx.createBuffer(1, samples.length, sampleRate);
    buf.copyToChannel(samples, 0);
    source = audioCtx.createBufferSource();
    source.buffer = buf;
    source.connect(audioCtx.destination);
    await new Promise((resolve) => {
      source.onended = resolve;
      source.start();
    });
    source = null;
  }

  function say(text) {
    const line = clean(text);
    if (!enabled || !/[a-z0-9]/i.test(line)) return;
    spokeThisTurn = true;
    const gen = generation;
    window.leslie.ttsSaid(line);
    const audio = window.leslie.ttsSpeak(line).catch(() => null);
    if (queued++ === 0) setPlaying(true);
    chain = chain.then(async () => {
      try {
        const clip = await audio;
        if (clip && gen === generation) await play(clip);
      } finally {
        if (gen === generation && --queued === 0) setPlaying(false);
      }
    });
  }

  /** Speak every complete sentence in the buffer (all of it when `final`), skipping code blocks. */
  function drain(final) {
    buffer = buffer.replace(/```[\s\S]*?```/g, '\n').replace(LIST_MARKER, '$1');
    const fence = buffer.indexOf('```');
    let text = fence === -1 ? buffer : buffer.slice(0, fence);
    const held = fence === -1 ? '' : buffer.slice(fence);

    let cut = final ? text.length : 0;
    if (!final) {
      for (const m of text.matchAll(SENTENCE_END)) cut = m.index + m[0].length;
      if (!cut && text.length > MAX_CHUNK) cut = text.lastIndexOf(' ', MAX_CHUNK) + 1 || MAX_CHUNK;
    }
    if (cut) say(text.slice(0, cut));
    buffer = text.slice(cut) + (final ? '' : held);
  }

  return {
    busy: () => queued > 0,
    /** Resolves once everything queued so far has been spoken (or cut off). */
    whenQuiet: () => chain,
    /** Streaming answer text. */
    feed(delta) {
      if (!enabled) return;
      buffer += delta;
      drain(false);
    },
    /** A short spoken acknowledgement that isn't part of any reply. */
    ack(text) {
      const spoke = spokeThisTurn;
      say(text);
      spokeThisTurn = spoke;
    },
    /** End of turn: speak the remainder, or the whole reply if nothing streamed (shortcuts, commands). */
    finish(reply) {
      if (!spokeThisTurn && !buffer && reply) buffer = reply;
      if (enabled) drain(true);
      buffer = '';
      spokeThisTurn = false;
    },
    stop
  };

  function stop() {
    generation++;
    buffer = '';
    spokeThisTurn = false;
    chain = Promise.resolve();
    window.leslie.ttsCancel();
    if (source) {
      try {
        source.stop();
      } catch {
      }
    }
    if (queued) {
      queued = 0;
      setPlaying(false);
    }
  }
})();

function nearBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
}
function scrollToBottom(force) {
  if (force || nearBottom()) transcript.scrollTop = transcript.scrollHeight;
}

function setStatus(text) {
  statusLine.textContent = text || '';
}

/** Thumbnails for a user message; `images` are attachments or pi's image blocks. */
function imageStrip(images) {
  const strip = document.createElement('div');
  strip.className = 'msg-images';
  for (const img of images) {
    const pic = document.createElement('img');
    pic.src = img.url || base64Url(img.data, img.mimeType);
    pic.alt = 'Attached image';
    pic.addEventListener('click', () => openLightbox(pic.src));
    strip.appendChild(pic);
  }
  return strip;
}

function appendUser(text, { tag, images = [] } = {}) {
  const el = document.createElement('div');
  el.className = 'msg user';
  if (tag) {
    el.classList.add('queued');
    const t = document.createElement('span');
    t.className = 'queued-tag';
    t.textContent = tag;
    el.appendChild(t);
  }
  if (images.length) el.appendChild(imageStrip(images));
  if (text) el.appendChild(document.createTextNode(text));
  transcript.appendChild(el);
  scrollToBottom(true);
  return el;
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

// A queued steer/follow-up was delivered mid-run: close this reply and continue
// in a new bubble below the user's message so the transcript stays in order.
function splitAssistant() {
  const bubble = queuedBubbles.shift();
  if (!bubble) return;
  markDelivered(bubble);
  if (!current) return;
  finishAssistant(current.raw);
  beginAssistant();
  bubble.after(current.el);
}

window.leslie.onUserMessageDelivered(() => {
  if (streaming && queuedBubbles.length) splitAssistant();
});

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
  play_video: 'fa-circle-play', media_control: 'fa-play', window_control: 'fa-window-maximize',
  install_software: 'fa-download', create_document: 'fa-file',
  read_file: 'fa-file-lines', read_document: 'fa-file-lines', list_directory: 'fa-folder',
  write_file: 'fa-file-pen', run_subagent: 'fa-diagram-project',
  set_mode: 'fa-toggle-on',
  remember: 'fa-brain',
  bash: 'fa-terminal', read: 'fa-file-lines', write: 'fa-file-pen', edit: 'fa-pen-to-square',
  grep: 'fa-magnifying-glass', find: 'fa-magnifying-glass', ls: 'fa-folder',
  $: 'fa-terminal', '$ (private)': 'fa-terminal',
  screen_record: 'fa-video', screenshot: 'fa-camera', close_app: 'fa-xmark',
  model_profile: 'fa-microchip', speech: 'fa-volume-high'
};

/** A tool row plus a collapsible output pane underneath (filled as output arrives). */
function createToolCard(container, { name, detail }) {
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
  card.title = detail || '';
  const output = document.createElement('pre');
  output.className = 'tc-output hidden';
  card.addEventListener('click', () => {
    if (!output.textContent) return;
    card.classList.toggle('open');
    output.classList.toggle('hidden');
  });
  container.append(card, output);
  card.output = output;
  return card;
}

function setToolOutput(card, text) {
  if (!card || !text) return;
  card.output.textContent = text;
  card.classList.add('has-output');
  if (card.classList.contains('open')) card.output.scrollTop = card.output.scrollHeight;
}

function settleToolCard(card, ok, title) {
  card.classList.remove('running');
  card.classList.add(ok ? 'done' : 'failed');
  if (title) card.querySelector('.tc-detail').textContent = title;
  card.querySelector('.tc-status').className = `fa-solid ${ok ? 'fa-check' : 'fa-xmark'} tc-status`;
}

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
  const card = createToolCard(current.tools, { name, detail });
  if (id) current.cards.set(id, card);
  scrollToBottom();
}

function toolCardEnd({ id, ok, title, output }) {
  const synapse = current && id ? current.synapses.get(id) : null;
  if (synapse) {
    if (ok) synapse.complete();
    else synapse.fail();
    return;
  }
  const card = current && id ? current.cards.get(id) : null;
  if (!card) return;
  settleToolCard(card, ok, title);
  setToolOutput(card, output);
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
let turnDone = Promise.resolve();

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
  speech.feed(delta);
});

window.leslie.onToolCall((ev) => {
  if (!ev || !streaming) return;
  if (ev.phase === 'end') {
    toolCardEnd(ev);
    setFlag('toolCall', false);
    return;
  }
  if (ev.phase === 'output') {
    setToolOutput(current && current.cards.get(ev.id), ev.output);
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

// Messages typed while pi is working, waiting to be delivered (oldest first).
const queuedBubbles = [];

async function queueMessage(text, followUp) {
  const bubble = appendUser(text, { tag: followUp ? 'follow-up — after LESLIE finishes' : 'steer — after the current step' });
  queuedBubbles.push(bubble);
  const res = await window.leslie.pi(followUp ? 'followUp' : 'steer', { text });
  if (!res.ok) {
    queuedBubbles.splice(queuedBubbles.indexOf(bubble), 1);
    bubble.remove();
    systemLine(`⚠ ${res.error}`, 'error');
  }
}

function markDelivered(bubble) {
  bubble.classList.remove('queued');
  const tag = bubble.querySelector('.queued-tag');
  if (tag) tag.remove();
}

async function send(text, { followUp = false, byVoice = false, display = '', fromDoc = false } = {}) {
  text = text.trim();
  if (!text && !(pendingImages.length && !fromDoc)) return;
  if (streaming) {
    // A task runs outside the chat session, so there's nothing to steer.
    if (mode === 'assistant') systemLine('Wait for this task to finish, or press Esc to stop it.');
    // Steering takes text only; attached images wait in the tray for the next turn.
    else if (text) queueMessage(text, followUp);
    else systemLine('Images go with the next message once this turn finishes.');
    return;
  }

  const images = fromDoc ? [] : takeImages();
  // Only keep "@" mentions whose path still appears in the message.
  const mentions = fromDoc ? [] : pendingMentions.filter((m) => text.includes(m.path));
  if (!fromDoc) pendingMentions = [];
  // The wake word already silenced her, and stopping now would cut off the "On it".
  if (!byVoice) speech.stop();

  setExpanded(true);
  appendUser(display || text, { images });
  if (!byVoice) conversing = false;
  streaming = true;
  let settleTurn;
  turnDone = new Promise((resolve) => (settleTurn = resolve));
  if (byVoice && !conversing) acknowledgeIfSlow();
  setSendMode(true);
  startThinking();
  setStatus('Thinking…');
  beginAssistant();

  let res;
  try {
    res = await window.leslie.sendMessage(text, mentions, images.map(({ type, data, mimeType }) => ({ type, data, mimeType })));
  } catch (err) {
    res = { error: err && err.message ? err.message : String(err) };
  }
  streaming = false;
  settleTurn();
  setSendMode(false);
  endTurn();
  setStatus('');
  while (queuedBubbles.length) markDelivered(queuedBubbles.shift());

  if (res && res.error) {
    finishAssistant('');
    systemLine(`⚠ ${res.error}`, 'error');
    speech.finish('');
  } else {
    finishAssistant(res && res.reply);
    if (res && res.aborted) systemLine('⏹ Interrupted.');
    if (res && res.aborted) speech.stop();
    else speech.finish(res && res.reply);
  }
  // Only a question from her keeps the mic open; a finished job goes back to needing her name.
  if (byVoice && !(res && (res.error || res.aborted)) && window.dialog.invitesReply(res && res.reply)) keepListening();
  return res;
}

const MODES = ['chat', 'plan', 'agent', 'assistant'];
const MODE_META = {
  chat: { icon: 'fa-comment', label: 'Chat', say: '💬 Chat mode — just conversation.' },
  plan: { icon: 'fa-clipboard-list', label: 'Plan', say: "📋 Plan mode: I'll look around read-only and write the plan as a doc for you to approve." },
  agent: { icon: 'fa-robot', label: 'Agent', say: '🤖 Agent mode — I can run commands.' },
  assistant: {
    icon: 'fa-bolt',
    label: 'Assistant',
    say: "⚡ Assistant mode — each message is a one-off task. I do it and forget it; nothing carries over."
  }
};
let mode = 'chat';

function reflectMode(next) {
  mode = MODES.includes(next) ? next : 'chat';
  const meta = MODE_META[mode];
  agentToggle.innerHTML = `<i class="fa-solid ${meta.icon}" aria-hidden="true"></i>`;
  agentToggle.dataset.mode = mode;
  agentToggle.classList.toggle('on', mode !== 'chat');
  agentToggle.title = `Mode: ${meta.label} — click to switch (Chat → Plan → Agent → Assistant)`;
  setSendMode(streaming);
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

let autoApprove = false;

function reflectAutoApprove(on) {
  autoApprove = Boolean(on);
  autoToggle.classList.toggle('on', autoApprove);
  autoToggle.title = autoApprove
    ? 'Auto mode: on — safe commands run without asking; destructive ones still ask. Click to turn off'
    : 'Auto mode: off — click to run safe commands without asking';
}

autoToggle.addEventListener('click', async () => {
  reflectAutoApprove(await window.leslie.setAutoApprove(!autoApprove));
  systemLine(autoApprove
    ? '⏩ Auto mode on — I\'ll run safe commands without asking. Anything destructive still needs your OK.'
    : '⏸ Auto mode off — I\'ll ask before running commands.');
});
window.leslie.onAutoApprove(reflectAutoApprove);

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
  converse: (arg) => setConversation(!/^(off|0|false|stop|no)$/i.test(arg.trim())),
  settings: () => window.leslie.openSettings(),
  everyday: () => switchProfile('everyday'),
  power: () => switchProfile('power'),
  server: () => window.leslie.openSettings('server'),
  voice: (arg) => {
    const on = !/^(off|0|false|stop|no)$/i.test(arg.trim());
    window.leslie.setVoiceActive(on);
    systemLine(on ? 'Voice on.' : 'Voice off.');
  },
  mode: (arg) => {
    const m = arg.trim().toLowerCase();
    if (MODES.includes(m)) setMode(m);
    else systemLine('Usage: /mode chat|plan|agent|assistant');
  },
  plan: (arg) => {
    const off = /^(off|0|false|stop|no)$/i.test(arg.trim());
    setMode(off ? 'chat' : 'plan');
  },
  agent: (arg) => {
    const off = /^(off|0|false|stop|no)$/i.test(arg.trim());
    setMode(off ? 'chat' : 'agent');
  },
  assistant: (arg) => {
    const off = /^(off|0|false|stop|no)$/i.test(arg.trim());
    setMode(off ? 'chat' : 'assistant');
  },
  research: (arg) => {
    const q = (arg || '').trim();
    if (!q) systemLine('Usage: /research <question> — deep, multi-source research with a cited report.');
    else send(`Use the deep_research tool to research: ${q}`);
  },
  help: () => {
    const names = visibleCommands().map((c) => `/${c.name}`);
    systemLine(`Commands: ${names.join(', ')} · !cmd runs a shell command (!!cmd keeps it private)`);
  }
};

function runCommand(raw) {
  const parts = raw.slice(1).trim().split(/\s+/);
  const name = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');
  if (PI_COMMANDS[name]) return PI_COMMANDS[name](arg);
  const command = COMMANDS[name];
  if (command) return command(arg);
  // Prompt templates, skills and extension commands are expanded by pi itself.
  if (piCommands.some((c) => c.name === parts[0])) return send(raw);
  systemLine(`Unknown command: /${parts[0]}`, 'error');
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
const PI_COMMAND_META = [
  { name: 'model', usage: '/model [search]', desc: 'Switch model or profile' },
  { name: 'thinking', usage: '/thinking [level]', desc: 'Set thinking level' },
  { name: 'compact', usage: '/compact [focus]', desc: 'Summarize older context now' },
  { name: 'new', usage: '/new', desc: 'Start a new session' },
  { name: 'resume', usage: '/resume', desc: 'Open a previous session' },
  { name: 'name', usage: '/name <name>', desc: 'Name this session' },
  { name: 'session', usage: '/session', desc: 'Tokens, cost and context for this session' },
  { name: 'fork', usage: '/fork', desc: 'Branch from an earlier message' },
  { name: 'clone', usage: '/clone', desc: 'Duplicate this session' },
  { name: 'copy', usage: '/copy', desc: 'Copy the last reply' },
  { name: 'export', usage: '/export', desc: 'Export this session to HTML' },
  { name: 'autocompact', usage: '/autocompact on|off', desc: 'Toggle automatic compaction' },
  { name: 'reload', usage: '/reload', desc: 'Restart pi (reload extensions, skills, settings)' }
];
const COMMAND_META = [
  { name: 'everyday', usage: '/everyday', desc: 'Load the Everyday model (RTX 3060)' },
  { name: 'power', usage: '/power', desc: 'Load the Power model (both GPUs)' },
  { name: 'server', usage: '/server', desc: 'Model server, profiles and GPUs' },
  { name: 'research', usage: '/research <question>', desc: 'Deep multi-source research → cited report' },
  { name: 'mode', usage: '/mode chat|plan|agent', desc: 'Switch operating mode' },
  { name: 'plan', usage: '/plan', desc: 'Read-only plan mode' },
  { name: 'agent', usage: '/agent on|off', desc: 'Agent mode (run commands)' },
  { name: 'assistant', usage: '/assistant on|off', desc: 'One-off tasks, no conversation history' },
  { name: 'voice', usage: '/voice on|off', desc: 'Toggle voice listening' },
  { name: 'listen', usage: '/listen', desc: 'Dictate one utterance' },
  { name: 'converse', usage: '/converse on|off', desc: 'Talk freely without saying her name' },
  { name: 'settings', usage: '/settings', desc: 'Settings & past conversations' },
  { name: 'reset', usage: '/reset', desc: 'Clear the conversation' },
  { name: 'hide', usage: '/hide', desc: 'Hide the window' },
  { name: 'close', usage: '/close', desc: 'Quit LESLIE' },
  { name: 'help', usage: '/help', desc: 'List all commands' }
];
let commandItems = [];
let commandIndex = 0;

// Prompt templates, skills and extension commands pi reports (get_commands).
let piCommands = [];

function visibleCommands() {
  const extra = piCommands.map((c) => ({
    name: c.name,
    usage: `/${c.name}`,
    desc: `${c.description || ''} (${c.source})`.trim()
  }));
  return [...PI_COMMAND_META, ...COMMAND_META, ...extra];
}

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
  commandItems = visibleCommands().filter((c) => c.name.toLowerCase().startsWith(q));
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
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const item = commandItems[commandIndex];
      const typedInFull = item && input.value.trim() === `/${item.name}`;
      if (event.key === 'Enter' && typedInFull) {
        closeCommandMenu();
        submit();
      } else chooseCommand(item);
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); closeCommandMenu(); return; }
  }

  if (event.key === 'Enter') {
    if (event.shiftKey) return;
    event.preventDefault();
    submit({ followUp: event.altKey });
  } else if (event.key === 'Escape') {
    closeMention();
    closeCommandMenu();
    if (streaming) {
      stopRun();
      return;
    }
    if (speech.busy()) {
      speech.stop();
      return;
    }
    input.blur();
    setExpanded(false); // collapse back to the mascot
  }
});

function submit(opts = {}) {
  const text = input.value.trim();
  if (!text && !pendingImages.length) return;
  input.value = '';
  autosize();
  closeMention();
  closeCommandMenu();
  if (text.startsWith('!')) runBash(text);
  else if (text.startsWith('/')) runCommand(text);
  else send(text, opts);
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
  input.classList.toggle('scrolls', input.scrollHeight > input.clientHeight);
}
input.addEventListener('input', autosize);

const PLACEHOLDER = {
  piIdle: 'Message LESLIE… (@ files, / commands, ! shell)',
  piBusy: 'Steer… (Alt+Enter: queue for after)',
  task: 'Give LESLIE a task… (nothing is remembered)',
  taskBusy: 'Working on the task…'
};

function setSendMode(busy) {
  sendBtn.classList.toggle('stop', busy);
  sendBtn.innerHTML = `<i class="fa-solid ${busy ? 'fa-stop' : 'fa-arrow-up'}" aria-hidden="true"></i>`;
  sendBtn.title = busy ? 'Stop' : 'Send';
  if (mode === 'assistant') input.placeholder = busy ? PLACEHOLDER.taskBusy : PLACEHOLDER.task;
  else input.placeholder = busy ? PLACEHOLDER.piBusy : PLACEHOLDER.piIdle;
}

// --- Attached images (sent with the next prompt) ----------------------------
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGES = 8;
// Bigger images cost the model context without helping it see more.
const MAX_IMAGE_SIDE = 1568;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const attachInput = document.getElementById('attach-input');
let pendingImages = [];

function base64Url(data, mimeType) {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Scales big images down and flattens GIFs to their first frame (models want stills).
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES && file.type !== 'image/gif') {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = file.type === 'image/jpeg' ? 'image/jpeg' : file.type === 'image/webp' ? 'image/webp' : 'image/png';
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
}

async function addImageFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;
  const skipped = images.filter((f) => !IMAGE_TYPES.includes(f.type));
  if (skipped.length) systemLine(`⚠ Can't attach ${skipped.map((f) => f.name || f.type).join(', ')}: use PNG, JPEG, WebP or GIF.`);
  const room = MAX_IMAGES - pendingImages.length;
  const usable = images.filter((f) => IMAGE_TYPES.includes(f.type));
  if (usable.length > room) systemLine(`⚠ Up to ${MAX_IMAGES} images per message; ${usable.length - Math.max(room, 0)} left out.`);
  const wasEmpty = !pendingImages.length;
  for (const file of usable.slice(0, Math.max(room, 0))) {
    try {
      const blob = await prepareImage(file);
      pendingImages.push({ type: 'image', data: await blobToBase64(blob), mimeType: blob.type, url: URL.createObjectURL(blob) });
    } catch (err) {
      systemLine(`⚠ Couldn't read ${file.name || 'that image'}: ${err.message || err}`, 'error');
    }
  }
  renderAttachments();
  if (wasEmpty && pendingImages.length && piState && piState.model && !piState.model.vision) {
    systemLine(`⚠ ${piState.model.name} can't see images. Switch to a vision model (/model) before sending.`);
  }
}

function takeImages() {
  const images = pendingImages;
  pendingImages = [];
  renderAttachments();
  return images;
}

function renderAttachments() {
  attachmentsEl.innerHTML = '';
  attachmentsEl.classList.toggle('hidden', !pendingImages.length);
  pendingImages.forEach((img, i) => {
    const box = document.createElement('div');
    box.className = 'attachment';
    const pic = document.createElement('img');
    pic.src = img.url;
    pic.alt = 'Attached image';
    pic.addEventListener('click', () => openLightbox(img.url));
    const drop = document.createElement('button');
    drop.textContent = '×';
    drop.title = 'Remove';
    drop.addEventListener('click', () => {
      URL.revokeObjectURL(img.url);
      pendingImages.splice(i, 1);
      renderAttachments();
    });
    box.append(pic, drop);
    attachmentsEl.appendChild(box);
  });
}

function openLightbox(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  const pic = document.createElement('img');
  pic.src = src;
  box.appendChild(pic);
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(box);
}

input.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData ? event.clipboardData.files : [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  event.preventDefault();
  addImageFiles(files);
});

document.getElementById('attach-btn').addEventListener('click', () => attachInput.click());
attachInput.addEventListener('change', () => {
  addImageFiles(attachInput.files);
  attachInput.value = '';
});

const panelEl = document.getElementById('panel');
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
panelEl.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  panelEl.classList.add('dropping');
});
panelEl.addEventListener('dragleave', (e) => {
  if (!panelEl.contains(e.relatedTarget)) panelEl.classList.remove('dropping');
});
panelEl.addEventListener('drop', (e) => {
  panelEl.classList.remove('dropping');
  if (!hasFiles(e)) return;
  e.preventDefault();
  setExpanded(true);
  addImageFiles(e.dataTransfer.files);
  input.focus();
});

// --- "!command" runs a shell command through pi; "!!" keeps it out of context -
let bashCard = null;
window.leslie.onPiBashChunk((delta) => {
  if (!bashCard) return;
  bashCard.output.textContent += delta;
  bashCard.classList.add('has-output');
  bashCard.output.scrollTop = bashCard.output.scrollHeight;
});

async function runBash(raw) {
  const exclude = raw.startsWith('!!');
  const command = raw.slice(exclude ? 2 : 1).trim();
  if (!command) return;
  setExpanded(true);
  const box = document.createElement('div');
  box.className = 'msg assistant';
  transcript.appendChild(box);
  const card = createToolCard(box, { name: exclude ? '$ (private)' : '$', detail: command });
  card.classList.add('open');
  card.output.classList.remove('hidden');
  bashCard = card;
  scrollToBottom(true);
  const res = await window.leslie.piBash(command, exclude);
  bashCard = null;
  const data = res.data || {};
  if (!res.ok) setToolOutput(card, res.error);
  else if (!card.output.textContent) setToolOutput(card, data.output || '(no output)');
  const ok = res.ok && data.exitCode === 0 && !data.cancelled;
  settleToolCard(card, ok, ok ? '' : data.cancelled ? `${command} — cancelled` : `${command} — exit ${data.exitCode ?? '?'}`);
  scrollToBottom();
}

// Stop the run. On pi, queued messages would otherwise run after the abort, so
// pull them back into the editor first (pi's own Esc behaviour).
async function stopRun() {
  if (queuedBubbles.length) {
    try {
      const { steering = [], followUp = [] } = (await pi('clearQueue')) || {};
      const restored = [...steering, ...followUp].join('\n\n');
      while (queuedBubbles.length) queuedBubbles.shift().remove();
      if (restored) {
        input.value = [restored, input.value].filter(Boolean).join('\n\n');
        autosize();
      }
    } catch {
    }
  }
  speech.stop();
  window.leslie.cancel();
}

sendBtn.addEventListener('click', () => {
  if (streaming) stopRun();
  else submit();
});
mic.addEventListener('click', () => window.leslie.voiceListenOnce());
settingsBtn.addEventListener('click', () => window.leslie.openSettings());

// --- Voice dictation --------------------------------------------------------

let typingTimer = null;
function typeText(text, autoSend, sendOpts) {
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
      else send(text, sendOpts);
    }
  }, 28);
}

// {n} becomes ", <first name of whoever the camera sees>" or nothing.
const WAKE_REPLIES = ['Yes{n}?', 'Yes{n}?', 'Hm?', "I'm here{n}.", 'What can I do{n}?'];
const COMMAND_REPLIES = ['On it.', 'On it{n}.', 'Sure thing{n}.', 'Got it{n}.', 'Right away{n}.'];
const THANKED_REPLIES = ["You're welcome{n}.", 'Any time{n}.', 'Happy to help{n}.', 'No problem{n}.'];
let addressName = '';
const named = (line) => line.replace('{n}', addressName ? `, ${addressName}` : '');
const pickReply = (list) => named(list[Math.floor(Math.random() * list.length)]);

const CONVERSE = /^(?:ok(?:ay)?[,.]?\s*)?(?:let'?s (?:talk|chat)|(?:start |enter )?(?:a )?conversation(?: mode)?(?: on)?)[.!]*$/i;

// True while a spoken back-and-forth is going: follow-ups skip "Yes?" and "On it".
let conversing = false;
// Conversation mode: she hears everything without her name until dismissed or left idle.
let conversation = false;

function setConversation(on) {
  conversation = on;
  conversing = on;
  window.leslie.setConversation(on);
  systemLine(on
    ? '🗣 Conversation mode on: no need to say my name. Say "that\'s all" to stop.'
    : '🗣 Conversation mode off.');
  if (on) speech.ack(named("I'm listening{n}."));
}

window.leslie.onConversationEnded(() => {
  if (!conversation) return;
  conversation = false;
  conversing = false;
  systemLine('🗣 Conversation mode off after a quiet spell.');
});
// The reply she was cut off from, which has to wind down before the next one starts.
let cutOff = null;

// "On it" only when the job takes a moment: instant shortcuts answer for themselves.
const ACK_DELAY_MS = 700;
function acknowledgeIfSlow() {
  setTimeout(() => {
    if (streaming && current && !current.raw && !speech.busy()) speech.ack(pickReply(COMMAND_REPLIES));
  }, ACK_DELAY_MS);
}

// After a spoken exchange, listen for an answer without needing the wake word.
async function keepListening() {
  await speech.whenQuiet();
  if (streaming || mic.classList.contains('off') || conversation) return;
  if (!(await window.leslie.voiceFollowUp())) return;
  conversing = true;
  setStatus('Listening…');
}

window.leslie.onVoiceWake(({ command, interrupt }) => {
  // Talking over her stops the reply; while she works silently it is queued as a steer instead.
  if (streaming && speech.busy()) {
    cutOff = turnDone;
    window.leslie.cancel();
  }
  speech.stop();
  setExpanded(true);
  mic.classList.add('listening');
  conversing = conversation || Boolean(interrupt);
  if (interrupt) setStatus('Listening…');
  if (command || interrupt) return;
  const reply = pickReply(WAKE_REPLIES);
  setStatus(`${reply} Listening…`);
  speech.ack(reply);
});

window.leslie.onHush(() => speech.stop());

window.leslie.onVoiceFinal(async ({ text, autoSend }) => {
  mic.classList.remove('listening');
  text = text && text.trim();
  if (!text) return;
  if (CONVERSE.test(text)) {
    if (!conversation) setConversation(true);
    return;
  }
  if (window.dialog.isClosing(text)) {
    if (conversation) setConversation(false);
    conversing = false;
    setStatus('');
    if (/thank|cheers|appreciate/i.test(text)) speech.ack(pickReply(THANKED_REPLIES));
    return;
  }
  if (cutOff) {
    await cutOff;
    cutOff = null;
  }
  typeText(text, autoSend !== false, { byVoice: true });
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

// --- pi: footer, pickers, dialogs, history ----------------------------------

const piBar = document.getElementById('pi-bar');
const piModelChip = document.getElementById('pi-model');
const piThinkingChip = document.getElementById('pi-thinking');
const piContextChip = document.getElementById('pi-context');
const piQueueChip = document.getElementById('pi-queue');
const piStatusEl = document.getElementById('pi-status');
const picker = document.getElementById('picker-menu');

const GREETING = 'Hi, I’m LESLIE — type below to chat.';
let piState = null;
const piStatuses = new Map();

const kTokens = (n) => {
  if (n == null) return '—';
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}k`;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
};

async function pi(name, args) {
  const res = await window.leslie.pi(name, args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function piFail(err) {
  systemLine(`⚠ ${err && err.message ? err.message : err}`, 'error');
}

function updatePiBar(state) {
  piState = state;
  piContextChip.classList.toggle('hidden', !(state && state.model));
  if (!state || !state.model) {
    piModelChip.textContent = 'no model';
    piThinkingChip.classList.add('hidden');
    return;
  }
  piModelChip.textContent = state.model.name;
  piModelChip.title = `${state.model.provider}/${state.model.id} — click to switch`;
  piThinkingChip.classList.toggle('hidden', !state.model.reasoning);
  piThinkingChip.textContent = `🧠 ${state.thinkingLevel || 'off'}`;
  const { tokens, window: win, percent } = state.context || {};
  piContextChip.textContent = `${kTokens(tokens)} / ${kTokens(win)}${percent != null ? ` · ${Math.round(percent)}%` : ''}`;
  piContextChip.classList.toggle('warn', percent >= 70 && percent < 90);
  piContextChip.classList.toggle('hot', percent >= 90);
  piContextChip.title =
    `${state.sessionName ? `${state.sessionName} — ` : ''}context used${state.autoCompaction === false ? ' (auto-compaction off)' : ''}` +
    ' — click for session stats';
}

function renderPiStatus() {
  piStatusEl.textContent = [...piStatuses.values()].join(' · ');
  piStatusEl.classList.toggle('hidden', !piStatuses.size);
}

// Generic picker anchored above the composer.
let pickerItems = [];
let pickerIndex = 0;
let pickerOnPick = null;

function closePicker() {
  picker.classList.add('hidden');
  picker.innerHTML = '';
  pickerItems = [];
  pickerOnPick = null;
}

function renderPicker(title) {
  picker.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'picker-head';
  head.textContent = title;
  picker.appendChild(head);
  if (!pickerItems.length) {
    const empty = document.createElement('div');
    empty.className = 'mention-empty';
    empty.textContent = 'Nothing to choose from';
    picker.appendChild(empty);
  }
  pickerItems.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'mention-item' + (i === pickerIndex ? ' active' : '') + (item.selected ? ' selected' : '');
    const name = document.createElement('span');
    name.className = 'mi-name';
    name.textContent = item.label;
    const detail = document.createElement('span');
    detail.className = 'mi-type';
    detail.textContent = item.detail || '';
    row.append(name, detail);
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickItem(item);
    });
    picker.appendChild(row);
  });
  picker.classList.remove('hidden');
  const active = picker.querySelector('.mention-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function openPicker(title, items, onPick) {
  setExpanded(true);
  pickerItems = items;
  pickerIndex = Math.max(0, items.findIndex((i) => i.selected));
  pickerOnPick = onPick;
  picker.dataset.title = title;
  renderPicker(title);
}

function pickItem(item) {
  const onPick = pickerOnPick;
  closePicker();
  if (item && onPick) Promise.resolve(onPick(item.value)).catch(piFail);
}

document.addEventListener('keydown', (event) => {
  if (picker.classList.contains('hidden')) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePicker(); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    if (!pickerItems.length) return;
    pickerIndex = (pickerIndex + (event.key === 'ArrowDown' ? 1 : -1) + pickerItems.length) % pickerItems.length;
    renderPicker(picker.dataset.title);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    pickItem(pickerItems[pickerIndex]);
  }
}, true);
document.addEventListener('mousedown', (e) => {
  if (!picker.contains(e.target) && !piBar.contains(e.target)) closePicker();
});

// Everyday / Power profiles from the model server, offered above pi's model list.
async function serverProfiles() {
  const res = await window.leslie.server.status();
  if (!res.ok || !res.data.reachable) return [];
  return res.data.profiles
    .filter((p) => p.state !== 'missing')
    .map((p) => ({
      label: `${p.name === 'power' ? '⚡' : '🌙'} ${p.label} — ${p.model}`,
      detail: p.devices.includes(',') ? 'both GPUs' : p.devices === 'CUDA0' ? 'RTX 3060' : p.devices,
      selected: res.data.activeProfile === p.name,
      value: { profile: p.name }
    }));
}

async function switchProfile(profile) {
  const res = await window.leslie.server.switchTo(profile);
  if (!res.ok) piFail(res.error);
}

async function chooseModel(search) {
  const [models, profiles] = await Promise.all([pi('models'), search ? [] : serverProfiles()]);
  const q = (search || '').trim().toLowerCase();
  const matches = models.filter((m) => !q || `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q));
  const setModel = async (m) => {
    await pi('setModel', { provider: m.provider, id: m.id });
    systemLine(`Model → ${m.name || m.id}`);
  };
  if (q && matches.length === 1) return setModel(matches[0]);
  const current = piState && piState.model;
  const modelItems = matches.map((m) => ({
    label: m.name || m.id,
    detail: `${m.provider} · ${kTokens(m.contextWindow)}`,
    selected: !profiles.length && current && current.provider === m.provider && current.id === m.id,
    value: m
  }));
  openPicker(profiles.length ? 'Load a profile, or pick a loaded model' : 'Model', [...profiles, ...modelItems], (value) =>
    value.profile ? switchProfile(value.profile) : setModel(value)
  );
}

async function chooseThinking(level) {
  const levels = await pi('thinkingLevels');
  const setLevel = async (l) => {
    await pi('setThinking', { level: l });
    systemLine(`Thinking → ${l}`);
  };
  if (level) {
    if (!levels.includes(level)) return systemLine(`Levels for this model: ${levels.join(', ')}`);
    return setLevel(level);
  }
  openPicker(
    'Thinking level',
    levels.map((l) => ({ label: l, selected: piState && piState.thinkingLevel === l, value: l })),
    setLevel
  );
}

async function showSessionStats() {
  const st = await pi('state');
  updatePiBar(st);
  const c = st.counts || {};
  const t = st.tokens || {};
  const ctx = st.context || {};
  systemLine(
    [
      `${st.sessionName || 'Session'}: ${c.user || 0} prompts, ${c.assistant || 0} replies, ${c.tools || 0} tool calls`,
      `tokens in ${kTokens(t.input)} · out ${kTokens(t.output)} · cache ${kTokens(t.cacheRead)}${st.cost ? ` · $${st.cost.toFixed(4)}` : ''}`,
      `context ${kTokens(ctx.tokens)} of ${kTokens(ctx.window)}${ctx.percent != null ? ` (${Math.round(ctx.percent)}%)` : ''} · auto-compaction ${st.autoCompaction === false ? 'off' : 'on'}`,
      st.model ? `${st.model.provider}/${st.model.id}` : ''
    ].filter(Boolean).join('\n')
  );
}

const PI_COMMANDS = {
  model: (arg) => chooseModel(arg).catch(piFail),
  thinking: (arg) => chooseThinking(arg.trim()).catch(piFail),
  compact: async (arg) => {
    if (streaming) return systemLine('Wait for LESLIE to finish before compacting.');
    try {
      await pi('compact', { instructions: arg.trim() || undefined });
    } catch (err) {
      piFail(err);
    }
  },
  new: () => COMMANDS.reset(),
  resume: () => window.leslie.openSettings(),
  name: async (arg) => {
    if (!arg.trim()) return systemLine('Usage: /name <session name>');
    await pi('setSessionName', { name: arg.trim() }).catch(piFail);
    systemLine(`Session named “${arg.trim()}”.`);
  },
  session: () => showSessionStats().catch(piFail),
  fork: async () => {
    if (streaming) return systemLine('Wait for LESLIE to finish before forking.');
    try {
      const messages = await pi('forkMessages');
      openPicker(
        'Fork from message',
        messages.map((m) => ({ label: m.text.split('\n')[0].slice(0, 80), value: m })).reverse(),
        async (m) => {
          const res = await pi('fork', { entryId: m.entryId });
          if (res && res.cancelled) return;
          input.value = res && res.text ? res.text : m.text;
          autosize();
          input.focus();
        }
      );
    } catch (err) {
      piFail(err);
    }
  },
  clone: async () => {
    await pi('clone').catch(piFail);
  },
  copy: async () => {
    try {
      const text = await pi('lastReply');
      await navigator.clipboard.writeText(text);
      systemLine(text ? 'Copied the last reply.' : 'Nothing to copy yet.');
    } catch (err) {
      piFail(err);
    }
  },
  export: async () => {
    try {
      systemLine(`Exported to ${await pi('exportHtml')}`);
    } catch (err) {
      piFail(err);
    }
  },
  autocompact: async (arg) => {
    const enabled = !/^(off|0|false|no)$/i.test(arg.trim());
    await pi('setAutoCompaction', { enabled }).catch(piFail);
    systemLine(`Auto-compaction ${enabled ? 'on' : 'off'}.`);
  },
  reload: async () => {
    systemLine('Restarting pi…');
    await pi('reload').catch(piFail);
  }
};

piModelChip.addEventListener('click', () => PI_COMMANDS.model(''));
piThinkingChip.addEventListener('click', () => PI_COMMANDS.thinking(''));
piContextChip.addEventListener('click', () => PI_COMMANDS.session());

const contentText = (content) =>
  typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const imageBlocks = (content) => (Array.isArray(content) ? content.filter((b) => b.type === 'image' && b.data) : []);
const stripReplyTags = (text) =>
  String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\/summary>/g, '\n\n')
    .replace(/<\/?(?:summary|details)>/g, '')
    .trim();
const argDetail = (args) => (args && (args.command || args.path || args.pattern || args.query || args.url || args.text)) || '';

/** Rebuild the transcript from pi's messages (after resume, fork, or at startup). */
function renderHistory(messages) {
  const cards = new Map();
  for (const m of messages) {
    switch (m.role) {
      case 'user':
        appendUser(contentText(m.content), { images: imageBlocks(m.content) });
        break;
      case 'assistant': {
        beginAssistant();
        for (const b of m.content || []) {
          if (b.type === 'thinking' && b.thinking) {
            appendThinking(b.thinking);
            current.thinking.classList.add('collapsed');
          } else if (b.type === 'toolCall') {
            cards.set(b.id, createToolCard(current.tools, { name: b.name, detail: argDetail(b.arguments) }));
          }
        }
        let text = stripReplyTags(contentText(m.content));
        if (!text && m.stopReason === 'error' && m.errorMessage) text = `Error: ${m.errorMessage}`;
        finishAssistant(text);
        break;
      }
      case 'toolResult': {
        const card = cards.get(m.toolCallId);
        if (!card) break;
        settleToolCard(card, !m.isError);
        setToolOutput(card, contentText(m.content));
        cards.delete(m.toolCallId);
        break;
      }
      case 'bashExecution': {
        const box = document.createElement('div');
        box.className = 'msg assistant';
        transcript.appendChild(box);
        const card = createToolCard(box, { name: m.excludeFromContext ? '$ (private)' : '$', detail: m.command });
        settleToolCard(card, m.exitCode === 0 && !m.cancelled);
        setToolOutput(card, m.output);
        break;
      }
      case 'compactionSummary':
        systemLine(`🗜 Earlier conversation compacted (${kTokens(m.tokensBefore)} tokens summarized).`);
        break;
      case 'branchSummary':
        systemLine('↳ Continued from a summarized branch.');
        break;
      case 'custom':
        if (m.display) systemLine(contentText(m.content));
        break;
      default:
    }
  }
  for (const card of cards.values()) settleToolCard(card, false);
  scrollToBottom(true);
}

async function reloadTranscript() {
  if (streaming) return;
  let messages = [];
  try {
    messages = await pi('messages');
  } catch (err) {
    clearTranscript();
    piFail(err);
    return;
  }
  clearTranscript();
  if (messages.length) renderHistory(messages);
  else systemLine(GREETING);
}

// On pi the new session also triggers a transcript reload, so redraw from pi
// before adding the notice rather than having the reload wipe it.
window.leslie.onIdleReset(async (minutes) => {
  await reloadTranscript();
  systemLine(`Started a fresh chat after ${minutes} minutes idle. The last one is in Settings, ready to resume.`);
});

async function refreshPiCommands() {
  try {
    piCommands = await pi('commands');
  } catch {
    piCommands = [];
  }
}

// One status line per model load, updated in place as the server reports progress.
let serverLine = null;
window.leslie.server.onEvent((ev) => {
  if (ev.type === 'progress') {
    setExpanded(true);
    if (serverLine) serverLine.textContent = `⏳ ${ev.text}`;
    else serverLine = systemLine(`⏳ ${ev.text}`);
    scrollToBottom();
  } else if (ev.type === 'status' && !ev.status.switching && serverLine) {
    const active = ev.status.profiles.find((p) => p.name === ev.status.activeProfile);
    serverLine.textContent = active ? `✓ ${active.label} model ready — ${active.model}` : serverLine.textContent.replace('⏳', '⚠');
    serverLine = null;
  }
});

let compactionLine = null;
window.leslie.onPiEvent((ev) => {
  switch (ev.type) {
    case 'state':
      updatePiBar(ev.state);
      break;
    case 'queue': {
      const n = ev.steering.length + ev.followUp.length;
      piQueueChip.classList.toggle('hidden', !n);
      piQueueChip.textContent = `${n} queued`;
      break;
    }
    case 'compaction':
      if (ev.phase === 'start') {
        compactionLine = systemLine(`🗜 Compacting conversation${ev.reason === 'manual' ? '' : ' (context is filling up)'}…`);
      } else {
        const text = ev.error
          ? `⚠ Compaction failed: ${ev.error}`
          : ev.aborted
            ? '🗜 Compaction cancelled.'
            : `🗜 Compacted ${kTokens(ev.tokensBefore)} → ~${kTokens(ev.tokensAfter)} tokens.`;
        if (compactionLine) compactionLine.textContent = text;
        else systemLine(text, ev.error ? 'error' : undefined);
        compactionLine = null;
      }
      break;
    case 'retry':
      systemLine(`↻ Retrying (${ev.attempt}/${ev.maxAttempts}): ${ev.error}`);
      break;
    case 'notify':
      systemLine(`${ev.level === 'info' ? '' : '⚠ '}${ev.message}`, ev.level === 'error' ? 'error' : undefined);
      break;
    case 'status':
      if (ev.text) piStatuses.set(ev.key, ev.text);
      else piStatuses.delete(ev.key);
      renderPiStatus();
      break;
    case 'editor-text':
      input.value = ev.text;
      autosize();
      input.focus();
      break;
    case 'session':
      reloadTranscript();
      refreshPiCommands();
      break;
    default:
  }
});

let piStarted = Promise.resolve();

window.leslie.onDocsAsk(async ({ id, prompt, label }) => {
  await piStarted;
  while (streaming) await turnDone;
  const res = await send(prompt, { display: label, fromDoc: true });
  window.leslie.docsAnswer(id, res || { error: 'the turn did not run' });
});

// Wait for the transcript to load first, or the reload would wipe the greeting.
window.leslie.onAgentSay(async (text) => {
  await piStarted;
  if (streaming || !text) return;
  setExpanded(true);
  beginAssistant();
  finishAssistant(text);
  speech.finish(text);
});

async function startPi() {
  piModelChip.textContent = 'starting pi…';
  try {
    updatePiBar(await pi('state'));
  } catch {
    // The backend already reported why pi could not start.
    piModelChip.textContent = 'pi unavailable';
    return;
  }
  await reloadTranscript();
  refreshPiCommands();
}

// --- Screen recording indicator ---------------------------------------------
const recIndicator = document.getElementById('rec-indicator');
let recTimer = null;

function showRecording(state) {
  clearInterval(recTimer);
  recTimer = null;
  recIndicator.classList.toggle('hidden', !state.recording);
  if (!state.recording) return;
  const startedAt = state.startedAt || Date.now() - (state.seconds || 0) * 1000;
  const tick = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    recIndicator.textContent = `REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  recTimer = setInterval(tick, 1000);
}

window.leslie.onRecording(showRecording);
window.leslie.recordingState().then(showRecording).catch(() => {});
// Keep the click from also toggling the chat panel via the stage handler.
for (const type of ['pointerdown', 'pointerup']) recIndicator.addEventListener(type, (e) => e.stopPropagation());
recIndicator.addEventListener('click', async () => {
  const res = await window.leslie.stopRecording();
  if (res && res.file) systemLine(`🎬 Recording saved: ${res.file}`);
});

// --- Theme ------------------------------------------------------------------

function applyAccent(color) {
  if (color) document.documentElement.style.setProperty('--accent', color);
}
window.leslie.onTheme(applyAccent);

window.addEventListener('DOMContentLoaded', async () => {
  input.focus();
  setSendMode(streaming);
  piStarted = startPi();
  window.leslie.getMode().then(reflectMode);
  window.leslie.getAutoApprove().then(reflectAutoApprove);
  window.leslie.getAccent().then(applyAccent);
});

// --- Guest mode indicator (camera sees someone other than the owner) --------
const guestIndicator = document.getElementById('guest-indicator');
const showPresence = (snap) => {
  guestIndicator.classList.toggle('hidden', !snap.restricted);
  addressName = snap.name || '';
};
window.leslie.onPresence(showPresence);
window.leslie.presence().then(showPresence).catch(() => {});
