'use strict';

// The guided setup: questions first, then one install run. The engine and
// model downloads start as soon as they are chosen (prefetch), so most of the
// waiting is over by the time the last question is answered.

const api = window.setupApi;
const GB = 1024 ** 3;

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
}

const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;
const screenEl = document.getElementById('screen');
const stepsEl = document.getElementById('steps');
const backBtn = document.getElementById('back');
const nextBtn = document.getElementById('next');
const hintEl = document.getElementById('hint');

let info = null;
let choices = null;
let checks = null;
let installing = false;
let installResult = null;
let micStream = null;
const prefetched = new Set();

const persona = { name: '', address: '', preset: 'friendly', custom: '' };
const prefs = {
  voiceEnabled: true,
  wakeWord: 'Leslie',
  ttsEnabled: true,
  ttsVoice: 'af_heart',
  ttsSpeed: 1,
  homeMonitor: '',
  cameraDevice: '',
  searxngUrl: ''
};

// ---------------------------------------------------------------------------
// Steps

const STEPS = [
  { id: 'welcome', title: 'Welcome', render: renderWelcome },
  { id: 'check', title: 'System check', render: renderCheck, canNext: () => checks && !checks.checks.some((c) => c.required && c.status === 'missing') },
  { id: 'computer', title: 'Your computer', render: renderComputer, canNext: engineReady },
  { id: 'brain', title: 'Her brain', render: renderBrain, canNext: brainReady, leave: startPrefetch },
  { id: 'listening', title: 'Listening', render: renderListening, leave: stopMic },
  { id: 'voice', title: 'Her voice', render: renderVoice },
  { id: 'camera', title: 'Camera', render: renderCamera },
  { id: 'desktop', title: 'Desktop', render: renderDesktop, when: () => info.hyprland || info.canInstallApp },
  { id: 'you', title: 'About you', render: renderYou },
  { id: 'install', title: 'Installing', render: renderInstall, canNext: () => Boolean(installResult && installResult.ok) },
  { id: 'ready', title: 'Ready', render: renderReady }
];

let current = 0;
const visible = () => STEPS.filter((s) => !s.when || s.when());

function drawRail() {
  stepsEl.innerHTML = '';
  const list = visible();
  const at = list.indexOf(STEPS[current]);
  list.forEach((s, i) => stepsEl.append(el('li', { class: i < at ? 'done' : i === at ? 'current' : '', text: s.title })));
}

function refreshNav() {
  const step = STEPS[current];
  const list = visible();
  const at = list.indexOf(step);
  backBtn.classList.toggle('hidden', at === 0 || step.id === 'install' || step.id === 'ready');
  nextBtn.classList.toggle('hidden', step.id === 'ready');
  nextBtn.disabled = Boolean(step.canNext && !step.canNext());
  nextBtn.textContent = step.id === 'you' ? 'Install' : step.id === 'welcome' ? 'Get started' : 'Next';
}

async function go(delta) {
  const list = visible();
  const at = list.indexOf(STEPS[current]);
  const leaving = STEPS[current];
  if (leaving.leave) await leaving.leave(delta);
  const target = list[Math.max(0, Math.min(list.length - 1, at + delta))];
  current = STEPS.indexOf(target);
  save();
  show();
}

async function show() {
  drawRail();
  hintEl.textContent = '';
  screenEl.innerHTML = '';
  screenEl.scrollTop = 0;
  const node = await STEPS[current].render();
  if (node) screenEl.append(node);
  refreshNav();
  const focusable = screenEl.querySelector('h1');
  if (focusable) {
    focusable.setAttribute('tabindex', '-1');
    focusable.focus();
  }
}

backBtn.addEventListener('click', () => go(-1));
nextBtn.addEventListener('click', () => go(1));

function save() {
  if (choices) api.save(finalChoices());
}

/** Choices with the per-screen answers folded into the settings LESLIE saves. */
function finalChoices() {
  const settings = {
    voiceEnabled: prefs.voiceEnabled,
    wakeWord: prefs.wakeWord,
    ttsEnabled: prefs.ttsEnabled,
    ttsVoice: prefs.ttsVoice,
    ttsSpeed: prefs.ttsSpeed,
    searxngUrl: prefs.searxngUrl.trim()
  };
  if (info.hyprland) settings.homeMonitor = prefs.homeMonitor;
  if (choices.vision.enabled) settings.cameraDevice = prefs.cameraDevice;
  return { ...choices, settings, persona: { ...persona } };
}

// ---------------------------------------------------------------------------
// Screens

function heading(title, lead) {
  return [el('h1', { text: title }), lead ? el('p', { class: 'lead', text: lead }) : null];
}

function renderWelcome() {
  const wrap = el('div', {}, heading("Hi, I'm LESLIE.",
    'This sets me up on your computer: the AI model I think with, my voice, and what I can see and hear. ' +
    'Everything runs on this machine. It takes a few questions, then a download that can take a while on a slow connection.'));
  if (info.resumed && !info.resumed.finished) {
    wrap.append(el('div', { class: 'card' }, el('h3', { text: 'Picking up where you left off' }),
      el('div', { class: 'sub', text: 'Your earlier answers are filled in, and anything already downloaded is kept.' })));
  } else if (info.existing.any) {
    const keep = el('button', { class: 'btn primary', type: 'button', text: 'Keep my current setup' });
    keep.addEventListener('click', async () => {
      keep.disabled = true;
      await api.adopt();
      api.finish();
    });
    const found = [
      info.existing.router && 'a model server',
      info.existing.models && `${info.existing.models} models in ~/models`,
      (info.existing.whisper || info.existing.speech) && 'speech recognition',
      info.existing.vision && 'camera presence',
      info.existing.pi && 'pi'
    ].filter(Boolean).join(', ');
    wrap.append(el('div', { class: 'card' },
      el('h3', { text: 'LESLIE is already set up here' }),
      el('div', { class: 'sub', text: `Found ${found || 'an earlier setup'}. Keep it as it is, or carry on to set things up again (anything you don't change is left alone).` }),
      el('div', { class: 'row', style: 'margin-top:12px' }, keep)));
  }
  return wrap;
}

async function renderCheck() {
  const wrap = el('div', {}, heading('System check', 'Making sure this computer has what LESLIE needs. Optional pieces can be skipped; the features that use them stay off.'));
  const list = el('ul', { class: 'checks' }, el('li', {}, el('span', { text: '…' }), el('span', { text: 'Checking…' })));
  wrap.append(list);
  const res = await api.checks(choices);
  if (!res.ok) {
    wrap.append(el('p', { class: 'note err', text: res.error }));
    return wrap;
  }
  checks = res.data;
  list.innerHTML = '';
  const marks = { ok: '✓', warn: '!', missing: '✗' };
  for (const c of checks.checks) {
    list.append(el('li', {},
      el('span', { class: `mark ${c.status}`, text: marks[c.status], 'aria-label': c.status }),
      el('span', { text: c.label }),
      el('span', { class: 'detail', text: c.detail || '' })));
  }
  const pkgs = [...new Set(checks.checks.filter((c) => c.status !== 'ok').flatMap((c) => c.packages || []))];
  if (pkgs.length) {
    const btn = el('button', { class: 'btn primary', type: 'button', text: 'Install missing packages' });
    const note = el('p', { class: 'note', text: `Installs ${pkgs.join(', ')}. Your password is asked for once.` });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      note.textContent = 'Installing… (approve the password prompt)';
      const r = await api.installPackages(pkgs);
      note.className = `note ${r.ok ? 'ok' : 'err'}`;
      note.textContent = r.ok ? 'Installed.' : r.error;
      if (r.ok) show();
      else btn.disabled = false;
    });
    wrap.append(el('h2', { text: 'Missing pieces' }), note, btn);
  } else if (!checks.distro) {
    wrap.append(el('p', { class: 'note', text: "This Linux distribution isn't one setup knows how to install packages on; install anything marked ✗ yourself." }));
  }
  return wrap;
}

function engineReady() {
  const e = choices.engine;
  if (e.mode === 'cloud') return true;
  if (e.mode === 'remote') return Boolean(e.url && e.tested);
  if (e.mode === 'existing') return Boolean(e.binary);
  return Boolean(e.build);
}

function radio(name, value, current, label, sub, onPick) {
  const input = el('input', { type: 'radio', name, value });
  input.checked = value === current;
  input.addEventListener('change', () => onPick(value));
  return el('label', { class: 'radio' }, input, el('span', {}, el('strong', { text: label }), sub ? el('div', { class: 'note', text: sub }) : null));
}

function renderComputer() {
  const wrap = el('div', {}, heading('Your computer', 'LESLIE picked the engine and model sizes from what it found. The defaults suit almost everyone.'));
  const usable = info.gpus.filter((g) => !g.integrated && !g.driverMissing);
  if (!info.gpus.length) wrap.append(el('div', { class: 'card' }, el('h3', { text: 'No graphics card found' }), el('div', { class: 'sub', text: 'Models will run on the processor: slower, but it works.' })));
  const grid = el('div', { class: 'grid' });
  for (const g of info.gpus) {
    const tag = g.driverMissing ? el('span', { class: 'tag warn', text: 'driver missing' }) : g.integrated ? el('span', { class: 'tag', text: 'integrated' }) : el('span', { class: 'tag good', text: 'will be used' });
    grid.append(el('div', { class: 'card' }, el('h3', {}, g.name, tag), el('div', { class: 'sub', text: g.vramMiB ? `${(g.vramMiB / 1024).toFixed(0)} GB of video memory` : 'shares system memory' })));
  }
  grid.append(el('div', { class: 'card' }, el('h3', { text: 'Memory' }), el('div', { class: 'sub', text: `${Math.round(info.ramMiB / 1024)} GB` })));
  wrap.append(grid);

  const build = info.builds.find((b) => b.id === info.defaults.engine.build);
  wrap.append(el('p', { class: 'note', text: usable.length
    ? `Models will run with the ${build ? build.label : info.defaults.engine.build} engine${usable.length > 1 ? `, across ${usable.length} GPUs for Power mode` : ''}.`
    : 'Models will run on the CPU.' }));

  const adv = el('details', {}, el('summary', { text: 'Advanced: engine and model server' }));
  const body = el('div', {});
  const redraw = () => {
    body.innerHTML = '';
    const e = choices.engine;
    body.append(radio('engine', 'download', e.mode, 'Download the engine (recommended)', 'A prebuilt llama.cpp matched to your GPUs.', () => setEngine({ mode: 'download', build: info.defaults.engine.build })));
    if (e.mode === 'download') {
      const sel = el('select', {}, info.builds.map((b) => {
        const o = el('option', { value: b.id, text: `${b.label} (${gb(b.bytes)})` });
        o.selected = b.id === e.build;
        return o;
      }));
      sel.addEventListener('change', () => setEngine({ mode: 'download', build: sel.value }));
      body.append(el('label', { class: 'field' }, el('span', { text: 'Engine build' }), sel));
    }
    body.append(radio('engine', 'existing', e.mode, 'Use a llama-server already installed', info.existing.llamaServer || 'For a build you compiled yourself.',
      () => setEngine({ mode: 'existing', binary: info.existing.llamaServer || '' })));
    if (e.mode === 'existing') {
      const input = el('input', { type: 'text', value: e.binary || '', placeholder: '/usr/bin/llama-server' });
      input.addEventListener('input', () => { choices.engine.binary = input.value.trim(); refreshNav(); });
      body.append(el('label', { class: 'field' }, el('span', { text: 'llama-server path' }), input));
    }
    body.append(radio('engine', 'remote', e.mode, 'Use a model server on another computer', 'Any OpenAI-compatible server (llama.cpp, LM Studio, Ollama…).',
      () => setEngine({ mode: 'remote', url: '', tested: false })));
    if (e.mode === 'remote') {
      const input = el('input', { type: 'url', value: e.url || '', placeholder: 'http://192.168.1.20:8080/v1' });
      const note = el('p', { class: 'note' });
      const test = el('button', { class: 'btn small', type: 'button', text: 'Test' });
      input.addEventListener('input', () => { choices.engine.url = input.value.trim(); choices.engine.tested = false; refreshNav(); });
      test.addEventListener('click', async () => {
        note.textContent = 'Connecting…';
        const r = await api.testUrl('server', choices.engine.url);
        choices.engine.tested = r.ok;
        note.className = `note ${r.ok ? 'ok' : 'err'}`;
        note.textContent = r.ok ? `Connected${r.models && r.models.length ? `: ${r.models.slice(0, 3).join(', ')}` : ''}.` : r.error;
        refreshNav();
      });
      body.append(el('div', { class: 'field' }, el('span', { text: 'Server URL (with /v1)' }), el('div', { class: 'row' }, input, test)), note);
    }
  };
  const setEngine = (engine) => {
    choices.engine = engine;
    redraw();
    refreshNav();
  };
  redraw();
  adv.append(body);
  if (choices.engine.mode !== 'download') adv.open = true;
  wrap.append(adv);
  return wrap;
}

function modelCards(tier, selected, onPick, { allowNone, exclude } = {}) {
  const grid = el('div', { class: 'grid', role: 'radiogroup' });
  const card = (id, title, sub, tags) => {
    const node = el('div', { class: `card pick${id === selected ? ' selected' : ''}`, role: 'radio', tabindex: '0', 'aria-checked': String(id === selected) },
      el('h3', {}, title, ...tags), el('div', { class: 'sub', text: sub }));
    const pick = () => onPick(id);
    node.addEventListener('click', pick);
    node.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pick(); } });
    return node;
  };
  for (const m of (info.models[tier] || []).filter((x) => x.id !== exclude)) {
    grid.append(card(m.id, m.label, `${m.blurb} ${gb(m.bytes)} download.`, [
      m.recommended ? el('span', { class: 'tag good', text: 'recommended' }) : null,
      el('span', { class: 'tag', text: m.speed })
    ]));
  }
  if (allowNone) grid.append(card('', 'No Power mode', 'Keep just the Everyday model.', []));
  return grid;
}

function brainReady() {
  const e = choices.engine;
  if (e.mode === 'remote') return true;
  if (e.mode === 'cloud') return Boolean(e.provider && e.apiKey && e.model);
  return Boolean(choices.everyday);
}

let localEngine = null;

async function renderBrain() {
  if (choices.engine.mode === 'remote') {
    return el('div', {}, heading('Her brain', `LESLIE will use the model server at ${choices.engine.url}, so there is nothing to download here.`));
  }
  const wrap = el('div', {}, heading('Her brain', 'The model LESLIE thinks with.'));
  const body = el('div', {});
  const where = (mode) => {
    if (mode === 'cloud' && choices.engine.mode !== 'cloud') {
      localEngine = choices.engine;
      choices.engine = { mode: 'cloud', provider: '', apiKey: '', model: '' };
    } else if (mode === 'local' && choices.engine.mode === 'cloud') {
      choices.engine = localEngine || { ...info.defaults.engine };
    }
    draw();
    refreshNav();
  };
  const draw = () => {
    body.innerHTML = '';
    body.append(choices.engine.mode === 'cloud' ? cloudPicker() : localPicker());
  };
  const mode = choices.engine.mode === 'cloud' ? 'cloud' : 'local';
  wrap.append(
    radio('where', 'local', mode, 'On this computer (recommended)', 'Private, and free to run once the model is downloaded.', () => where('local')),
    radio('where', 'cloud', mode, 'With a cloud provider', 'Needs an API key (Anthropic, OpenAI, Google…). Quick on modest hardware, but conversations go to that provider.', () => where('cloud')),
    body);
  draw();
  return wrap;
}

function cloudPicker() {
  const e = choices.engine;
  const wrap = el('div', {});
  const provider = el('select', {}, el('option', { value: '', text: 'Choose a provider' }));
  const key = el('input', { type: 'password', value: e.apiKey || '', placeholder: 'API key', autocomplete: 'off' });
  const check = el('button', { class: 'btn small', type: 'button', text: 'Show models' });
  const note = el('p', { class: 'note', text: 'The key is kept in your desktop keyring.' });
  const model = el('select', { class: e.model ? '' : 'hidden' }, e.model ? el('option', { value: e.model, text: e.model }) : null);
  api.cloudProviders().then((res) => {
    for (const p of res.data || []) {
      const o = el('option', { value: p.id, text: p.label });
      o.selected = p.id === e.provider;
      provider.append(o);
    }
  });
  const reset = () => {
    e.model = '';
    model.classList.add('hidden');
    refreshNav();
  };
  provider.addEventListener('change', () => { e.provider = provider.value; reset(); });
  key.addEventListener('input', () => { e.apiKey = key.value.trim(); reset(); });
  model.addEventListener('change', () => { e.model = model.value; refreshNav(); });
  check.addEventListener('click', async () => {
    if (!e.provider || !e.apiKey) {
      note.className = 'note err';
      note.textContent = 'Choose a provider and paste its API key first.';
      return;
    }
    check.disabled = true;
    note.className = 'note';
    note.textContent = 'Looking up the models…';
    const res = await api.cloudModels(e.provider, e.apiKey);
    check.disabled = false;
    if (!res.ok || !res.data.length) {
      note.className = 'note err';
      note.textContent = res.ok ? 'pi lists no models for this provider.' : res.error;
      return;
    }
    model.innerHTML = '';
    for (const m of res.data) model.append(el('option', { value: m.id, text: `${m.id}${m.images ? ' (sees images)' : ''}` }));
    e.model = res.data[0].id;
    model.classList.remove('hidden');
    note.className = 'note ok';
    note.textContent = `${res.data.length} models. Pick one; the key is first used when LESLIE answers, so a wrong key shows up then.`;
    refreshNav();
  });
  wrap.append(
    el('label', { class: 'field' }, el('span', { text: 'Provider' }), provider),
    el('div', { class: 'field' }, el('span', { text: 'API key' }), el('div', { class: 'row' }, key, check)),
    note,
    el('label', { class: 'field' }, el('span', { text: 'Model' }), model));
  return wrap;
}

function localPicker() {
  const wrap = el('div', {}, el('p', { class: 'note', text: 'These fit your hardware; the recommended one is the best balance.' }));
  const sizeNote = el('p', { class: 'note' });
  const updateSize = async () => {
    const r = await api.downloadBytes(choices);
    sizeNote.textContent = r.ok && r.data ? `About ${gb(r.data)} to download.` : 'Everything chosen is already downloaded.';
  };
  const redraw = () => {
    wrap.querySelectorAll('.grid, h2').forEach((n) => n.remove());
    wrap.insertBefore(el('h2', { text: 'Everyday' }), sizeNote);
    wrap.insertBefore(modelCards(choices.tiers.everyday, choices.everyday, (id) => {
      choices.everyday = id;
      if (choices.power === id) choices.power = '';
      redraw();
      refreshNav();
    }), sizeNote);
    if (choices.tiers.power) {
      wrap.insertBefore(el('h2', { text: 'Power mode (all your GPUs together)' }), sizeNote);
      wrap.insertBefore(modelCards(choices.tiers.power, choices.power, (id) => {
        choices.power = id === choices.everyday ? '' : id;
        redraw();
      }, { allowNone: true, exclude: choices.everyday }), sizeNote);
    }
    updateSize();
  };
  wrap.append(sizeNote);
  redraw();
  return wrap;
}

function startPrefetch(delta) {
  if (delta < 0 || ['remote', 'cloud'].includes(choices.engine.mode)) return;
  const key = JSON.stringify([choices.engine, choices.everyday, choices.power, choices.modelsDir]);
  if (prefetched.has(key)) return;
  prefetched.add(key);
  api.prefetch(choices);
  hintEl.textContent = 'Downloading in the background while you answer the rest.';
}

function toggle(label, checked, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'toggle' }, input, el('span', { text: label }));
}

function stopMic() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
}

async function micMeter() {
  const bar = el('i');
  const wrap = el('div', {}, el('div', { class: 'meter', role: 'meter', 'aria-label': 'Microphone level' }, bar),
    el('p', { class: 'note', text: 'Say something: the bar should move.' }));
  try {
    stopMic();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(micStream).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const tick = () => {
      if (!micStream) return ctx.close();
      analyser.getFloatTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((n, v) => n + v * v, 0) / data.length);
      bar.style.width = `${Math.min(100, rms * 400)}%`;
      requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    wrap.lastChild.className = 'note err';
    wrap.lastChild.textContent = `No microphone available (${err.message}). Voice can be turned on later.`;
  }
  return wrap;
}

async function renderListening() {
  const wrap = el('div', {}, heading('Listening', 'Say "Hey Leslie" and she wakes up, the way a smart speaker does. Speech is turned into text on this computer.'));
  const body = el('div', {});
  const redraw = async () => {
    body.innerHTML = '';
    if (!prefs.voiceEnabled) {
      stopMic();
      return;
    }
    const wake = el('input', { type: 'text', value: prefs.wakeWord });
    wake.addEventListener('input', () => { prefs.wakeWord = wake.value.trim() || 'Leslie'; });
    body.append(el('label', { class: 'field' }, el('span', { text: 'Wake word' }), wake));
    body.append(el('h2', { text: 'Microphone' }), await micMeter());
    const nvidia = info.gpus.some((g) => g.vendor === 'nvidia' && !g.driverMissing);
    body.append(el('h2', { text: 'Speech recognition' }));
    body.append(radio('stt', 'cuda', choices.speech.runtime, 'On the NVIDIA GPU', 'Fast and accurate (Whisper large-v3-turbo, about 1 GB of video memory).', () => { choices.speech.runtime = 'cuda'; }));
    if (!nvidia) body.lastChild.classList.add('hidden');
    body.append(radio('stt', 'cpu', choices.speech.runtime, 'On the processor', 'Uses no video memory; a little slower and less accurate.', () => { choices.speech.runtime = 'cpu'; }));
  };
  wrap.append(toggle('Listen for the wake word', prefs.voiceEnabled, (on) => {
    prefs.voiceEnabled = on;
    choices.speech.enabled = on;
    redraw();
  }), body);
  await redraw();
  return wrap;
}

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

function renderVoice() {
  const wrap = el('div', {}, heading('Her voice', 'LESLIE can read her replies aloud. The voice runs on the processor; the first preview downloads it (about 300 MB).'));
  const body = el('div', {});
  const redraw = () => {
    body.innerHTML = '';
    if (!prefs.ttsEnabled) return;
    const sel = el('select', {}, info.voices.map((v) => {
      const o = el('option', { value: v.id, text: v.label });
      o.selected = v.id === prefs.ttsVoice;
      return o;
    }));
    sel.addEventListener('change', () => { prefs.ttsVoice = sel.value; });
    const play = el('button', { class: 'btn small', type: 'button', text: '▶ Preview' });
    const note = el('p', { class: 'note' });
    play.addEventListener('click', async () => {
      play.disabled = true;
      note.textContent = 'Generating… (the first time downloads the voice)';
      try {
        const audio = await api.ttsPreview(prefs.ttsVoice);
        if (audio) await playSamples(audio);
        note.textContent = audio ? '' : 'The voice could not be loaded; check the connection.';
      } catch (err) {
        note.textContent = err.message;
      } finally {
        play.disabled = false;
      }
    });
    const speed = el('input', { type: 'range', min: '0.5', max: '2', step: '0.1', value: String(prefs.ttsSpeed), 'aria-label': 'Speaking speed' });
    const speedLabel = el('span', { class: 'note', text: `${prefs.ttsSpeed.toFixed(1)}×` });
    speed.addEventListener('input', () => { prefs.ttsSpeed = Number(speed.value); speedLabel.textContent = `${prefs.ttsSpeed.toFixed(1)}×`; });
    body.append(
      el('div', { class: 'field' }, el('span', { text: 'Voice' }), el('div', { class: 'row' }, sel, play)),
      el('div', { class: 'field' }, el('span', { text: 'Speed' }), el('div', { class: 'row' }, speed, speedLabel)),
      note);
  };
  wrap.append(toggle('Speak replies aloud', prefs.ttsEnabled, (on) => { prefs.ttsEnabled = on; redraw(); }), body);
  redraw();
  return wrap;
}

async function renderCamera() {
  const wrap = el('div', {}, heading('Camera', 'With the camera, LESLIE notices when you sit down, holds news until you are back, and goes quiet for guests. Frames never leave the computer or touch the disk.'));
  const cams = await api.cameras();
  const list = cams.ok ? cams.data : [];
  const body = el('div', {});
  const redraw = () => {
    body.innerHTML = '';
    if (!choices.vision.enabled) return;
    if (!list.length) {
      body.append(el('p', { class: 'note err', text: 'No camera is connected right now. You can plug one in later; LESLIE uses the first one she finds.' }));
      return;
    }
    if (!prefs.cameraDevice) prefs.cameraDevice = list[0].path;
    const sel = el('select', {}, list.map((c) => {
      const o = el('option', { value: c.path, text: c.label });
      o.selected = c.path === prefs.cameraDevice;
      return o;
    }));
    sel.addEventListener('change', () => { prefs.cameraDevice = sel.value; });
    body.append(el('label', { class: 'field' }, el('span', { text: 'Camera' }), sel),
      el('p', { class: 'note', text: `Runs on ${choices.vision.runtime === 'cuda' ? 'the NVIDIA GPU' : 'the processor'}. After setup you will teach her your face (about 10 seconds).` }));
  };
  wrap.append(toggle('Use the camera', choices.vision.enabled, (on) => { choices.vision.enabled = on; redraw(); }), body);
  redraw();
  return wrap;
}

async function renderDesktop() {
  const wrap = el('div', {}, heading('Desktop', 'Where LESLIE lives on your screen and how she starts.'));
  if (info.hyprland) {
    const res = await api.monitors();
    const mons = res.ok ? res.data : [];
    const sel = el('select', {}, el('option', { value: '', text: 'Wherever she opens' }), mons.map((m) => {
      const o = el('option', { value: m.name, text: m.label });
      o.selected = m.name === prefs.homeMonitor;
      return o;
    }));
    sel.addEventListener('change', () => { prefs.homeMonitor = sel.value; });
    wrap.append(el('label', { class: 'field' }, el('span', { text: 'Home display' }), sel),
      el('p', { class: 'note', text: 'She stays on this monitor across its workspaces, and comes back to it when called.' }));
  }
  if (info.canInstallApp) {
    wrap.append(toggle('Start LESLIE when I log in', choices.startAtLogin, (on) => { choices.startAtLogin = on; }));
    if (!info.systemLauncher) wrap.append(toggle('Add LESLIE to my applications menu', choices.launcher, (on) => { choices.launcher = on; }));
  }
  return wrap;
}

function renderYou() {
  const wrap = el('div', {}, heading('About you', 'So LESLIE knows who she is talking to, and how.'));
  const field = (label, value, set, placeholder) => {
    const input = el('input', { type: 'text', value, placeholder });
    input.addEventListener('input', () => set(input.value));
    return el('label', { class: 'field' }, el('span', { text: label }), input);
  };
  wrap.append(field('Your name', persona.name, (v) => { persona.name = v; }, 'Optional'),
    field('What she calls you', persona.address, (v) => { persona.address = v; }, 'Your first name, a nickname…'));
  wrap.append(el('h2', { text: 'Personality' }));
  const custom = el('textarea', { placeholder: 'Describe how LESLIE should behave.' });
  custom.value = persona.custom;
  custom.addEventListener('input', () => { persona.custom = custom.value; });
  const customField = el('label', { class: `field${persona.preset === 'custom' ? '' : ' hidden'}` }, el('span', { text: 'Instructions' }), custom);
  for (const p of [...info.presets, { id: 'custom', label: 'Custom', describe: 'Write your own instructions' }]) {
    wrap.append(radio('persona', p.id, persona.preset, p.label, p.describe, (id) => {
      persona.preset = id;
      customField.classList.toggle('hidden', id !== 'custom');
    }));
  }
  wrap.append(customField);

  wrap.append(el('h2', { text: 'Web search (optional)' }),
    el('p', { class: 'note', text: 'LESLIE searches the web through your own SearXNG instance. Leave blank to skip; search stays off.' }));
  const url = el('input', { type: 'url', value: prefs.searxngUrl, placeholder: 'http://127.0.0.1:8888' });
  const note = el('p', { class: 'note' });
  const test = el('button', { class: 'btn small', type: 'button', text: 'Test' });
  url.addEventListener('input', () => { prefs.searxngUrl = url.value; });
  test.addEventListener('click', async () => {
    note.textContent = 'Searching…';
    const r = await api.testUrl('searxng', prefs.searxngUrl);
    note.className = `note ${r.ok ? 'ok' : 'err'}`;
    note.textContent = r.ok ? 'Search works.' : r.error;
  });
  wrap.append(el('div', { class: 'field' }, el('span', { text: 'SearXNG URL' }), el('div', { class: 'row' }, url, test)), note);
  return wrap;
}

const STATE_TEXT = { pending: 'waiting', running: 'working…', done: 'done', skipped: 'already done', failed: 'failed', blocked: 'waiting on an earlier step' };

function renderInstall() {
  const wrap = el('div', {}, heading('Installing', 'You can leave this running. If it stops part-way, opening LESLIE again picks up where it left off.'));
  const list = el('ul', { class: 'tasks' });
  const actions = el('div', { class: 'row', style: 'margin-top:16px' });
  wrap.append(list, actions);
  const rows = new Map();

  const row = (t) => {
    const state = el('span', { class: 'state', text: STATE_TEXT.pending });
    const text = el('div', { class: 'text hidden' });
    const bar = el('i');
    const meter = el('div', { class: 'meter hidden' }, bar);
    const node = el('li', {}, el('div', { class: 'top' }, el('span', { class: 'label', text: t.label + (t.optional ? ' (optional)' : '') }), state), text, meter);
    rows.set(t.id, { node, state, text, bar, meter });
    list.append(node);
  };

  const off = api.onEvent((ev) => {
    if (ev.type === 'plan') {
      list.innerHTML = '';
      rows.clear();
      ev.tasks.forEach(row);
      return;
    }
    const r = rows.get(ev.id);
    if (!r) return;
    if (ev.type === 'task') {
      r.state.className = `state ${ev.status}`;
      r.state.textContent = STATE_TEXT[ev.status] || ev.status;
      if (ev.status !== 'running') r.meter.classList.add('hidden');
      r.text.classList.toggle('hidden', !ev.error);
      if (ev.error) r.text.textContent = ev.error;
    } else if (ev.type === 'progress') {
      if (ev.text) {
        r.text.classList.remove('hidden');
        r.text.textContent = ev.text + (ev.fraction !== undefined ? ` (${Math.round(ev.fraction * 100)}%)` : '');
      }
      if (ev.fraction !== undefined) {
        r.meter.classList.remove('hidden');
        r.bar.style.width = `${Math.round(ev.fraction * 100)}%`;
      }
    }
  });

  const start = async () => {
    installing = true;
    installResult = null;
    actions.innerHTML = '';
    const cancel = el('button', { class: 'btn', type: 'button', text: 'Pause' });
    cancel.addEventListener('click', () => { cancel.disabled = true; api.cancel(); });
    actions.append(cancel);
    refreshNav();
    const res = await api.run(finalChoices());
    installing = false;
    installResult = res.ok ? res.data : { ok: false };
    actions.innerHTML = '';
    if (installResult.ok) {
      hintEl.textContent = 'All set.';
      go(1);
    } else {
      const retry = el('button', { class: 'btn primary', type: 'button', text: 'Try again' });
      retry.addEventListener('click', start);
      const back = el('button', { class: 'btn', type: 'button', text: 'Change my answers' });
      back.addEventListener('click', () => { off(); current = STEPS.findIndex((s) => s.id === 'computer'); show(); });
      actions.append(retry, back, el('span', { class: 'note', text: res.ok ? 'Some steps did not finish; the reasons are listed above.' : res.error }));
    }
    refreshNav();
  };
  if (!installing) start();
  return wrap;
}

function renderReady() {
  const wrap = el('div', {}, el('div', { class: 'big-tick', text: '✓' }), heading("All set.", 'LESLIE is ready. She will appear on your desktop in a moment.'));
  const startBtn = el('button', { class: 'btn primary', type: 'button', text: 'Start LESLIE' });
  startBtn.addEventListener('click', () => api.finish());
  const row = el('div', { class: 'row' }, startBtn);
  if (choices.vision.enabled) {
    const face = el('button', { class: 'btn', type: 'button', text: 'Start and teach her my face' });
    face.addEventListener('click', () => api.finish('camera'));
    row.append(face);
  }
  wrap.append(row, el('h2', { text: 'Things to try' }), el('ul', {},
    el('li', { text: prefs.voiceEnabled ? `"Hey ${prefs.wakeWord}, what's on my screen?"` : 'Click LESLIE and ask what she can do.' }),
    el('li', { text: 'Right-click the tray icon for settings, modes and models.' }),
    el('li', { text: 'Everything chosen here can be changed in Settings.' })));
  return wrap;
}

// ---------------------------------------------------------------------------

async function init() {
  const res = await api.info();
  if (!res.ok) {
    screenEl.append(el('h1', { text: 'Setup could not start' }), el('p', { class: 'note err', text: res.error }));
    document.getElementById('footer').classList.add('hidden');
    return;
  }
  info = res.data;
  const saved = info.resumed && !info.resumed.finished && info.resumed.choices && info.resumed.choices.engine ? info.resumed.choices : null;
  choices = { ...info.defaults, ...(saved || {}) };
  if (saved && saved.settings) {
    for (const key of Object.keys(prefs)) if (saved.settings[key] !== undefined) prefs[key] = saved.settings[key];
  }
  if (saved && saved.persona) Object.assign(persona, saved.persona);
  prefs.voiceEnabled = choices.speech.enabled;
  show();
}

init();
