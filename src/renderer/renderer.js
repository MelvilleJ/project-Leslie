'use strict';

// Renderer process: drives the companion's animation, the chat input, the
// streaming answer bubble, and the reasoning ("thought") bubble. Talks to the
// agent only through `window.leslie`.

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

// --- Sprite animations ------------------------------------------------------
// Each animation is its own spritesheet (PNG + grid). We drive the current frame
// via inline styles rather than per-sheet CSS classes, so multiple sheets can
// coexist without their identical .sprite-N class names colliding. All frames are
// 537px tall so switching animations doesn't change LESLIE's size.
const ANIMATIONS = {
  idle: {
    sheet: '../../assets/animations/idle/spritesheet.png',
    frameW: 228, frameH: 537, cols: 4, frames: 25, frameMs: 140
  },
  thinking: {
    sheet: '../../assets/animations/thinking/spritesheet.png',
    frameW: 247, frameH: 537, cols: 4, frames: 12, frameMs: 140
  }
};

let currentAnim = null;
let frame = 0;
let animTimer = null;

function drawFrame(anim, n) {
  const col = n % anim.cols;
  const row = Math.floor(n / anim.cols);
  companion.style.backgroundPosition = `-${col * anim.frameW}px -${row * anim.frameH}px`;
}

function playAnimation(name) {
  const anim = ANIMATIONS[name];
  if (!anim || anim === currentAnim) return;
  currentAnim = anim;
  frame = 0;
  companion.style.backgroundImage = `url('${anim.sheet}')`;
  companion.style.backgroundRepeat = 'no-repeat';
  companion.style.width = `${anim.frameW}px`;
  companion.style.height = `${anim.frameH}px`;
  drawFrame(anim, 0);
  if (animTimer) clearInterval(animTimer);
  animTimer = setInterval(() => {
    frame = (frame + 1) % currentAnim.frames;
    drawFrame(currentAnim, frame);
  }, anim.frameMs);
}

playAnimation('idle');

// --- Window auto-fit --------------------------------------------------------
// Measure the visible content and ask the main process to resize the window
// (bottom-pinned) so tall bubbles grow the window UPWARD instead of shoving the
// sprite around. Coalesced to one request per animation frame.
const FIT_PAD = 14; // breathing room above the topmost element
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
  if (Math.abs(height - lastFitHeight) < 3) return; // ignore sub-pixel jitter
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

// --- Bubbles ----------------------------------------------------------------
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

// Hiding the answer dismisses the whole exchange, reasoning included.
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

// --- Chat ------------------------------------------------------------------
let streaming = false;

// Reasoning tokens flow into the thought bubble.
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

// Answer tokens flow into the speech bubble. The first one ends the "thinking"
// placeholder and folds the reasoning away so the answer takes focus.
window.leslie.onAgentChunk((delta) => {
  if (!streaming) return;
  if (bubble.classList.contains('thinking')) {
    bubble.classList.remove('thinking');
    bubbleText.textContent = '';
    if (!thought.classList.contains('hidden')) thought.classList.add('collapsed');
  }
  bubbleText.textContent += delta;
  bubbleText.scrollTop = bubbleText.scrollHeight; // keep newest text in view
  scheduleFit();
});

// A long answer was diverted to the details window mid-stream: collapse the
// bubble to a short teaser + pointer so it isn't a wall of text.
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
  playAnimation('thinking'); // LESLIE is working on the reply
  // Reset the reasoning bubble for the new exchange.
  thoughtText.textContent = '';
  thought.classList.add('hidden');
  thought.classList.remove('collapsed');
  showBubble('…', { thinking: true });

  const res = await window.leslie.sendMessage(text);
  streaming = false;
  playAnimation('idle'); // back to resting once the turn is done

  if (res && res.error) {
    showBubble(`⚠ ${res.error}`, { autoHideMs: 12000 });
  } else if (res && res.openedInDetails) {
    // Long answer lives in the details window — keep only the teaser in the bubble.
    showBubble(detailsTeaser(res.teaser), { autoHideMs: 10000 });
  } else {
    // Ensure the bubble holds the complete reply, then let it linger.
    showBubble((res && res.reply) || bubbleText.textContent, { autoHideMs: 10000 });
  }
}

// --- Confirmation prompts (agent mode) --------------------------------------
// Agent-mode tools ask before running a non-allowlisted command. We show the
// command with Approve/Deny buttons and reply with the user's choice. Multiple
// requests are unlikely mid-turn, but we track the current id to stay correct.
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
  clearHideTimer(); // don't let the lingering answer bubble's timer fire
  scheduleFit();
});

confirmYes.addEventListener('click', () => answerConfirm(true));
confirmNo.addEventListener('click', () => answerConfirm(false));

// --- Mode switcher ----------------------------------------------------------
// LESLIE has three operating modes; the input-row button cycles between them
// (Chat → Plan → Agent) and reflects the current one. The tray can also switch
// mode, so we listen for changes too.
const MODES = ['chat', 'plan', 'agent'];
const MODE_META = {
  chat: { icon: '💬', label: 'Chat', say: '💬 Chat mode — just conversation.' },
  plan: { icon: '📋', label: 'Plan', say: "📋 Plan mode — I'll investigate read-only and propose a plan." },
  agent: { icon: '🤖', label: 'Agent', say: '🤖 Agent mode — I can run commands.' }
};
let mode = 'chat';

function reflectMode(next) {
  mode = MODES.includes(next) ? next : 'chat';
  const meta = MODE_META[mode];
  agentToggle.textContent = meta.icon;
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
window.leslie.onMode((next) => reflectMode(next)); // synced from the tray

// --- Slash commands ---------------------------------------------------------
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

// --- Input & interaction ----------------------------------------------------
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

// Click the thought bubble to collapse / expand the reasoning.
thought.addEventListener('click', () => {
  thought.classList.toggle('collapsed');
  scheduleFit();
});

// Click the companion to toggle / focus the input.
companion.addEventListener('click', () => {
  inputRow.classList.toggle('hidden');
  if (!inputRow.classList.contains('hidden')) input.focus();
  scheduleFit();
});

// Mic button: dictate a single utterance (no wake word needed).
mic.addEventListener('click', () => window.leslie.voiceListenOnce());

// Gear button: open the settings / application-menu window.
settingsBtn.addEventListener('click', () => window.leslie.openSettings());

// --- Voice ------------------------------------------------------------------
function revealInput() {
  inputRow.classList.remove('hidden');
  scheduleFit();
}

// "Type" recognised speech into the input, then (optionally) send it.
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
      if (!autoSend) return; // leave it in the input to edit/send manually
      input.value = '';
      if (text.startsWith('/')) runCommand(text.trim());
      else send(text);
    }
  }, 28);
}

// Wake word heard -> the window is already being shown by main; reveal input.
window.leslie.onVoiceWake(({ command }) => {
  revealInput();
  mic.classList.add('listening');
  if (!command) showBubble('Listening…', { autoHideMs: 4000 });
});

// A dictated command -> type it in and (per config) send.
window.leslie.onVoiceFinal(({ text, autoSend }) => {
  mic.classList.remove('listening');
  if (text && text.trim()) typeText(text.trim(), autoSend !== false);
});

// Status feedback (model loading, listening, errors).
window.leslie.onVoiceStatus(({ state, message }) => {
  mic.classList.toggle('listening', state === 'listening' || state === 'transcribing');
  mic.classList.toggle('off', state === 'off');
  if (state === 'loading') showBubble('Loading speech model…', { autoHideMs: 0 });
  else if (state === 'error') showBubble(`⚠ voice: ${message || 'error'}`, { autoHideMs: 8000 });
});

// Greet on load so it's obvious the companion is alive.
window.addEventListener('DOMContentLoaded', () => {
  showBubble('Hi, I’m LESLIE — type below to chat.', { autoHideMs: 6000 });
  input.focus();
  // Reflect the persisted mode in the switcher button.
  window.leslie.getMode().then(reflectMode);
});
