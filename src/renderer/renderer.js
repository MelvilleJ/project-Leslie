'use strict';

const companion = document.getElementById('companion');
const thought = document.getElementById('thought');
const thoughtText = document.getElementById('thought-text');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const inputRow = document.getElementById('input-row');
const input = document.getElementById('input');
const mic = document.getElementById('mic');
const confirmBox = document.getElementById('confirm');
const confirmText = document.getElementById('confirm-text');
const confirmYes = document.getElementById('confirm-yes');
const confirmNo = document.getElementById('confirm-no');
const agentToggle = document.getElementById('agent-toggle');
const settingsBtn = document.getElementById('settings-btn');

// --- Animation engine -------------------------------------------------------
// A small state machine: the active character STATE (resolved by priority from
// a set of flags) maps through user-configurable BINDINGS to a CLIP, which the
// frame loop plays. The library + bindings come from the main process
// (window.leslie.getAnimations) and update live on 'animations:changed'.

// Built-in clips reference the sheets bundled in assets/; uploaded clips are
// served from userData over the leslie-sprite:// protocol.
function clipSheetUrl(clip) {
  if (!clip) return '';
  if (clip.builtin) return `../../assets/animations/${clip.sheet}/spritesheet.png`;
  return `leslie-sprite://clips/${clip.file}`;
}

// State priority, highest first. `idle` is the implicit fallback (always last).
// `talking` sits above `thinking` so a bound talking clip takes over while the
// answer streams; when talking is UNBOUND it's transparent and the still-active
// `thinking` shows through — so by default the thinking animation plays for the
// whole turn (matching the original behaviour) until a talking clip is assigned.
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
  companion.style.backgroundPosition = `-${col * clip.frameW}px -${row * clip.frameH}px`;
}

function playClip(clip) {
  if (!clip || clip === currentClip) return;
  currentClip = clip;
  frame = 0;
  companion.style.backgroundImage = `url('${clipSheetUrl(clip)}')`;
  companion.style.backgroundRepeat = 'no-repeat';
  companion.style.width = `${clip.frameW}px`;
  companion.style.height = `${clip.frameH}px`;
  drawFrame(clip, 0);
  if (animTimer) clearInterval(animTimer);
  animTimer = setInterval(() => {
    frame = (frame + 1) % currentClip.frames;
    drawFrame(currentClip, frame);
  }, clip.frameMs || 140);
}

// The highest-priority state that is both active AND actually has a clip bound.
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

// Idle variants rotate on a ~10s timer (only while idle and >1 variant exists).
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
  currentClip = null; // force a replay even if the clip object identity changed
  resolveAnimation();
}

// Seed with built-in defaults so the companion animates instantly, then pull the
// real (possibly customised) config from the main process.
applyAnimConfig({
  clips: [
    { id: 'builtin:idle', builtin: true, sheet: 'idle', frameW: 228, frameH: 537, cols: 4, frames: 25, frameMs: 140 },
    { id: 'builtin:thinking', builtin: true, sheet: 'thinking', frameW: 247, frameH: 537, cols: 4, frames: 12, frameMs: 140 }
  ],
  bindings: { idle: ['builtin:idle'], thinking: ['builtin:thinking'] }
});
window.leslie.getAnimations().then(applyAnimConfig).catch(() => {});
window.leslie.onAnimations(applyAnimConfig);

// Transient-state drivers (tool call flashes; drag reverts shortly after motion
// stops; long-think kicks in if a reply is slow).
let toolFlashTimer = null;
window.leslie.onToolCall(() => {
  setFlag('toolCall', true);
  if (toolFlashTimer) clearTimeout(toolFlashTimer);
  toolFlashTimer = setTimeout(() => setFlag('toolCall', false), 1200);
});

let moveTimer = null;
window.leslie.onWindowMoved(() => {
  setFlag('moving', true);
  if (moveTimer) clearTimeout(moveTimer);
  moveTimer = setTimeout(() => setFlag('moving', false), 600);
});

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
}

const FIT_PAD = 14;
let lastFitHeight = 0;
let fitScheduled = false;

function topElement() {
  if (!thought.classList.contains('hidden')) return thought;
  if (!bubble.classList.contains('hidden')) return bubble;
  if (!confirmBox.classList.contains('hidden')) return confirmBox;
  return companion;
}

function measureContentHeight() {
  const bottomEl = inputRow.classList.contains('hidden') ? companion : inputRow;
  const top = topElement().getBoundingClientRect().top;
  const bottom = bottomEl.getBoundingClientRect().bottom;
  return Math.ceil(bottom - top + FIT_PAD);
}

function fitWindow() {
  const height = measureContentHeight();
  if (Math.abs(height - lastFitHeight) < 3) return;
  lastFitHeight = height;
  window.leslie.fitHeight(height);
}

function scheduleFit() {
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => {
    fitScheduled = false;
    fitWindow();
  });
}

let hideTimer = null;

function clearHideTimer() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function hideThought() {
  thought.classList.add('hidden');
}

function hideAll() {
  bubble.classList.add('hidden');
  hideThought();
  scheduleFit();
}

function showBubble(text, { thinking = false, autoHideMs = 0 } = {}) {
  bubbleText.textContent = text;
  bubble.classList.remove('hidden');
  bubble.classList.toggle('thinking', thinking);
  bubbleText.scrollTop = 0;
  clearHideTimer();
  scheduleFit();
  if (autoHideMs > 0) {
    hideTimer = setTimeout(hideAll, autoHideMs);
  }
}

let streaming = false;

window.leslie.onAgentThink((delta) => {
  if (!streaming) return;
  if (thought.classList.contains('hidden')) {
    thought.classList.remove('hidden', 'collapsed');
    thoughtText.textContent = '';
  }
  thoughtText.textContent += delta;
  thoughtText.scrollTop = thoughtText.scrollHeight;
  scheduleFit();
});

window.leslie.onAgentChunk((delta) => {
  if (!streaming) return;
  // The answer has started: drop the long-think timer and enter "talking".
  // `thinking` stays set (it's lower priority) so it still shows if talking is
  // unbound; endTurn() clears both when the reply finishes.
  if (longThinkTimer) { clearTimeout(longThinkTimer); longThinkTimer = null; }
  setFlag('longThink', false);
  setFlag('talking', true);
  if (bubble.classList.contains('thinking')) {
    bubble.classList.remove('thinking');
    bubbleText.textContent = '';
    if (!thought.classList.contains('hidden')) thought.classList.add('collapsed');
  }
  bubbleText.textContent += delta;
  bubbleText.scrollTop = bubbleText.scrollHeight;
  scheduleFit();
});

const DETAILS_POINTER = '📄 Full answer in the details window.';
function detailsTeaser(teaser) {
  return (teaser ? `${teaser}\n\n` : '') + DETAILS_POINTER;
}

window.leslie.onToDetails(({ teaser }) => {
  if (!streaming) return;
  bubble.classList.remove('thinking');
  bubbleText.textContent = detailsTeaser(teaser);
  bubbleText.scrollTop = 0;
  scheduleFit();
});

async function send(text) {
  text = text.trim();
  if (!text || streaming) return;

  streaming = true;
  startThinking();
  thoughtText.textContent = '';
  thought.classList.add('hidden');
  thought.classList.remove('collapsed');
  showBubble('…', { thinking: true });

  const res = await window.leslie.sendMessage(text);
  streaming = false;
  endTurn();

  if (res && res.error) {
    showBubble(`⚠ ${res.error}`, { autoHideMs: 12000 });
  } else if (res && res.openedInDetails) {
    showBubble(detailsTeaser(res.teaser), { autoHideMs: 10000 });
  } else {
    showBubble((res && res.reply) || bubbleText.textContent, { autoHideMs: 10000 });
  }
}

let confirmId = null;

function hideConfirm() {
  confirmBox.classList.add('hidden');
  confirmId = null;
  scheduleFit();
}

function answerConfirm(approved) {
  if (confirmId == null) return;
  window.leslie.confirmResponse(confirmId, approved);
  hideConfirm();
}

window.leslie.onConfirm(({ id, message }) => {
  confirmId = id;
  confirmText.textContent = message || 'Run this command?';
  confirmBox.classList.remove('hidden');
  clearHideTimer();
  scheduleFit();
});

confirmYes.addEventListener('click', () => answerConfirm(true));
confirmNo.addEventListener('click', () => answerConfirm(false));

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
  if (announce) showBubble(MODE_META[mode].say, { autoHideMs: 3500 });
}

agentToggle.addEventListener('click', () => {
  setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
});
window.leslie.onMode((next) => reflectMode(next));

function clearReasoning() {
  thoughtText.textContent = '';
  thought.classList.add('hidden');
}

const COMMANDS = {
  hide: () => window.leslie.hide(),
  close: () => window.leslie.quit(),
  quit: () => window.leslie.quit(),
  exit: () => window.leslie.quit(),
  reset: () => {
    window.leslie.resetChat();
    clearReasoning();
    showBubble('Conversation cleared.', { autoHideMs: 3000 });
  },
  clear: () => COMMANDS.reset(),
  listen: () => {
    window.leslie.voiceListenOnce();
    showBubble('Listening…', { autoHideMs: 4000 });
  },
  mic: () => COMMANDS.listen(),
  settings: () => {
    window.leslie.openSettings();
    showBubble('⚙ Opening settings…', { autoHideMs: 2500 });
  },
  voice: (arg) => {
    const on = !/^(off|0|false|stop|no)$/i.test(arg.trim());
    window.leslie.setVoiceActive(on);
    showBubble(on ? 'Voice on.' : 'Voice off.', { autoHideMs: 3000 });
  },
  mode: (arg) => {
    const m = arg.trim().toLowerCase();
    if (MODES.includes(m)) setMode(m);
    else showBubble('Usage: /mode chat|plan|agent', { autoHideMs: 5000 });
  },
  plan: (arg) => {
    const off = /^(off|0|false|stop|no)$/i.test(arg.trim());
    setMode(off ? 'chat' : 'plan');
  },
  agent: (arg) => {
    const off = /^(off|0|false|stop|no)$/i.test(arg.trim());
    setMode(off ? 'chat' : 'agent');
  },
  help: () =>
    showBubble(
      'Commands: /hide, /close, /reset, /settings, /voice on|off, /mode chat|plan|agent, /plan, /agent on|off, /listen, /help',
      { autoHideMs: 9000 }
    )
};

function runCommand(raw) {
  const parts = raw.slice(1).trim().split(/\s+/);
  const name = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');
  const command = COMMANDS[name];
  if (command) command(arg);
  else showBubble(`Unknown command: /${name}`, { autoHideMs: 5000 });
}

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    const text = input.value.trim();
    input.value = '';
    if (text.startsWith('/')) runCommand(text);
    else send(text);
  } else if (event.key === 'Escape') {
    inputRow.classList.add('hidden');
    input.blur();
    scheduleFit();
  }
});

thought.addEventListener('click', () => {
  thought.classList.toggle('collapsed');
  scheduleFit();
});

companion.addEventListener('click', () => {
  inputRow.classList.toggle('hidden');
  if (!inputRow.classList.contains('hidden')) input.focus();
  scheduleFit();
});

mic.addEventListener('click', () => window.leslie.voiceListenOnce());

settingsBtn.addEventListener('click', () => window.leslie.openSettings());

function revealInput() {
  inputRow.classList.remove('hidden');
  scheduleFit();
}

let typingTimer = null;
function typeText(text, autoSend) {
  if (typingTimer) clearInterval(typingTimer);
  revealInput();
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
  revealInput();
  mic.classList.add('listening');
  if (!command) showBubble('Listening…', { autoHideMs: 4000 });
});

window.leslie.onVoiceFinal(({ text, autoSend }) => {
  mic.classList.remove('listening');
  if (text && text.trim()) typeText(text.trim(), autoSend !== false);
});

window.leslie.onVoiceStatus(({ state, message }) => {
  const hearing = state === 'listening' || state === 'transcribing';
  mic.classList.toggle('listening', hearing);
  mic.classList.toggle('off', state === 'off');
  setFlag('listening', hearing);
  if (state === 'loading') showBubble('Loading speech model…', { autoHideMs: 0 });
  else if (state === 'error') showBubble(`⚠ voice: ${message || 'error'}`, { autoHideMs: 8000 });
});

// Theme accent: applied as a CSS variable; chosen from the details window and
// synced here so the companion's accents follow the system theme.
function applyAccent(color) {
  if (color) document.documentElement.style.setProperty('--accent', color);
}
window.leslie.onTheme(applyAccent);

window.addEventListener('DOMContentLoaded', () => {
  showBubble('Hi, I’m LESLIE — type below to chat.', { autoHideMs: 6000 });
  input.focus();
  window.leslie.getMode().then(reflectMode);
  window.leslie.getAccent().then(applyAccent);
});
