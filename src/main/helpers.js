'use strict';

// Helper Leslies: each is a separate pi process on the small helper model (on
// the GPU Everyday leaves free), started by the delegate tool. They load the
// same extension as the main pi, and the bridge holds them to read-only tools.

const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { toolDetail } = require('./agent/toolDetail');
const { verifyReport } = require('./helperReport');

// Required lazily: both load the tools, and policy loads this module.
const backend = () => require('./pi/backend');
const controller = () => require('./server/controller');
const policy = () => require('./pi/policy');

const MAX_HELPERS = 3;
const MAX_TURNS = 12;
const TIMEOUT_MS = 5 * 60000;
// Prose kept from a helper that never reported, so LESLIE can see what went wrong.
const PARTIAL_CHARS = 2000;
// Long enough for the sprite to show its result before it fades out.
const LINGER_MS = 8000;

const VERDICT_STEP = { verified: 'Verified', partly: 'Partly backed', unverified: 'Not backed by sources' };

const helpers = new Map();
let seq = 0;
let listener = () => {};
let idleTimer = null;
let serverReady = false;

function onUpdate(fn) {
  listener = fn;
}

function snapshot(h) {
  return { id: h.id, label: h.label, state: h.state, step: h.step, turns: h.turns, maxTurns: MAX_TURNS, verdict: h.check && h.check.verdict };
}

function publish() {
  listener([...helpers.values()].map(snapshot));
}

/** Kept current by the server controller: helpers need Everyday loaded and the helper model on disk. */
function noteServerStatus(st) {
  serverReady = Boolean(st && st.reachable && st.activeProfile === 'everyday' && st.helper && st.helper.state !== 'missing');
}

function available() {
  return serverReady;
}

function running() {
  return [...helpers.values()].filter((h) => h.state === 'starting' || h.state === 'working');
}

function textOf(message) {
  return (message.content || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

/** Fold one event from a helper's `pi --mode json` output into its state. */
function applyEvent(h, ev) {
  switch (ev.type) {
    case 'turn_start':
      h.turns++;
      h.state = 'working';
      h.step = h.turns === 1 ? 'Thinking…' : h.step;
      return h.turns > MAX_TURNS ? 'too-many-turns' : null;
    case 'tool_execution_start': {
      // The report's arguments are the result; nothing after it matters.
      if (ev.toolName === 'report') {
        h.report = ev.args || {};
        h.step = 'Reporting…';
        return 'finished';
      }
      const detail = toolDetail(ev.toolName, ev.args || {});
      h.step = detail ? `${ev.toolName}: ${detail}` : ev.toolName;
      return null;
    }
    case 'tool_execution_end':
      if (!ev.isError && ev.result) h.sources.push(textOf(ev.result));
      return null;
    // pi stays alive after its run while the extension's bridge socket is open.
    case 'agent_end':
      return 'finished';
    case 'message_end':
      if (ev.message && ev.message.role === 'assistant') {
        const text = textOf(ev.message);
        if (text) h.output = text;
        if (ev.message.stopReason === 'error') h.error = ev.message.errorMessage || 'the model returned an error';
      }
      return null;
    default:
      return null;
  }
}

function scheduleIdleUnload() {
  if (idleTimer) clearTimeout(idleTimer);
  const minutes = controller().loadSettings().helper.idleMinutes;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!running().length) controller().unloadHelper().catch((err) => console.warn('[helpers] unload failed:', err.message));
  }, minutes * 60000);
  if (idleTimer.unref) idleTimer.unref();
}

/** The helper model is loaded: make sure it unloads once idle, whoever loaded it. */
function noteHelperModelLoaded() {
  if (!idleTimer && !running().length) scheduleIdleUnload();
}

function finish(h, state) {
  if (h.state === 'done' || h.state === 'failed' || h.state === 'stopped') return;
  h.state = state;
  h.step = state === 'done' ? VERDICT_STEP[h.check.verdict] : state === 'stopped' ? 'Stopped' : h.error || 'Failed';
  publish();
  setTimeout(() => {
    helpers.delete(h.id);
    publish();
  }, LINGER_MS).unref();
  if (!running().length) scheduleIdleUnload();
}

function runOne(h, launch, model, signal) {
  return new Promise((resolve) => {
    if (h.aborted || (signal && signal.aborted)) {
      finish(h, 'stopped');
      return resolve(h);
    }
    const args = [
      '--mode', 'json', '-p', '--no-session',
      '--extension', launch.extension,
      '--model', `llama.cpp/${model}`,
      // An allowlist: the extension can only enable tools named here.
      '--tools', policy().helperSelection().activeTools.join(',') || 'none',
      h.task
    ];
    const proc = spawn(launch.command, [...(launch.prefix || []), ...args], {
      cwd: launch.cwd,
      env: { ...launch.env, LESLIE_HELPER: h.id },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    h.proc = proc;
    let stderr = '';
    const kill = (reason) => {
      if (reason && !h.error) h.error = reason;
      proc.kill('SIGTERM');
      setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => kill('Took too long'), TIMEOUT_MS);
    const onAbort = () => {
      h.aborted = true;
      kill();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    // LF only, as in rpcClient: U+2028 is legal inside JSON strings.
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const outcome = applyEvent(h, ev);
        if (outcome === 'too-many-turns') kill(`Ran out of steps (${MAX_TURNS})`);
        if (outcome === 'finished') {
          h.finished = true;
          kill();
        }
        publish();
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const done = (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      h.proc = null;
      if (h.aborted) finish(h, 'stopped');
      else if (h.report && !h.error) {
        h.check = verifyReport(h.report, h.sources, h.task);
        finish(h, 'done');
      } else {
        if (!h.error && (code === 0 || h.finished)) h.error = 'Finished without a report';
        if (!h.error) h.error = stderr.trim().split('\n').pop() || `pi exited with code ${code}`;
        finish(h, 'failed');
      }
      resolve(h);
    };
    proc.on('close', done);
    proc.on('error', (err) => {
      h.error = err.message;
      done(1);
    });
  });
}

function report(h) {
  if (h.state !== 'done') {
    return { label: h.label, ok: false, error: h.error || h.state, partial: (h.output || '').slice(0, PARTIAL_CHARS) || undefined };
  }
  const { verdict, evidence } = h.check;
  return {
    label: h.label,
    ok: true,
    answer: String(h.report.answer || ''),
    verification: verdict,
    confidence: h.report.confidence,
    evidence: evidence.map((e) => ({ url: e.url, quote: e.quote, found_in_sources: e.found })),
    unknowns: h.report.unknowns || undefined
  };
}

/** The helper's prompt: the task plus, when given, the shape of answer wanted. */
function taskPrompt({ task, answer_format: format }) {
  return format ? `${task}\n\nReport the answer as: ${format}` : String(task);
}

/** Run up to MAX_HELPERS tasks in parallel; resolves with each helper's report. */
async function delegate(tasks, { signal, onProgress } = {}) {
  if (!available()) throw new Error('Helpers only run in Everyday mode, with the helper model downloaded.');
  const free = MAX_HELPERS - running().length;
  if (tasks.length > free) throw new Error(`At most ${MAX_HELPERS} helpers can work at once (${free} free now).`);
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;

  const batch = tasks.map((t) => {
    const h = {
      id: `helper-${++seq}`,
      label: String(t.label || t.task).slice(0, 40),
      task: taskPrompt(t),
      state: 'starting',
      step: 'Waking up…',
      turns: 0,
      output: '',
      error: null,
      sources: [],
      report: null,
      check: null
    };
    helpers.set(h.id, h);
    return h;
  });
  publish();

  let model;
  try {
    model = await controller().loadHelper((text) => onProgress && onProgress(text));
  } catch (err) {
    for (const h of batch) {
      h.error = err.message;
      finish(h, 'failed');
    }
    throw err;
  }
  const launch = await backend().helperLaunch();
  onProgress && onProgress(`${batch.length} helper${batch.length === 1 ? '' : 's'} working…`);
  const results = await Promise.all(batch.map((h) => runOne(h, launch, model, signal)));
  return results.map(report);
}

function stopAll() {
  for (const h of running()) {
    h.aborted = true;
    if (h.proc) h.proc.kill('SIGTERM');
  }
}

/** The full report of a helper still on screen, for the detail window. */
function output(id) {
  const h = helpers.get(id);
  return h ? { label: h.label, task: h.task, state: h.state, error: h.error, output: h.output, report: h.state === 'done' ? report(h) : null } : null;
}

module.exports = { MAX_HELPERS, MAX_TURNS, onUpdate, noteServerStatus, noteHelperModelLoaded, available, delegate, stopAll, output, applyEvent };
