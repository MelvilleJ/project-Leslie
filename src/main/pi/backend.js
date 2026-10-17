'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const config = require('../config');
const settings = require('../settings');
const memory = require('../memory');
const presence = require('../presence/status');
const { createTagRouter, FORMAT_INSTRUCTIONS } = require('../agent/replyTags');
const { PLAN_MODE_DIRECTIVE, TASK_MODE_DIRECTIVE } = require('../agent/directives');
const { toolDetail } = require('../agent/toolDetail');
const { extractMemories } = require('../agent/reflect');
const { PiRpcClient } = require('./rpcClient');
const { createBridge } = require('./bridge');
const policy = require('./policy');
const sessions = require('./sessions');

// pi loads the extension from disk, so the packaged build keeps it outside app.asar.
const EXTENSION_PATH = path
  .join(__dirname, '..', '..', 'pi-extension', 'leslie.ts')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const TOOL_OUTPUT_CHARS = 6000;

let client = null;
let clientSignature = '';
let starting = null;
let bridge = null;
let turn = null;
let history = [];
let turnCount = 0;
let lastSessionFile = settings.get('piSessionFile', null);
let broadcast = () => {};

const pendingConfirms = new Map();
let confirmSeq = 0;

/** Receive pi state/dialog/queue events for the UI (set once by main). */
function onUiEvent(fn) {
  broadcast = fn;
}

function resolveConfirm(id, approved) {
  const done = pendingConfirms.get(id);
  if (done) done(Boolean(approved));
}

function askUser(onEvent, message) {
  return new Promise((resolve) => {
    const id = `pi-c${++confirmSeq}`;
    const done = (approved) => {
      if (!pendingConfirms.has(id)) return;
      pendingConfirms.delete(id);
      resolve(Boolean(approved));
    };
    pendingConfirms.set(id, done);
    const timer = setTimeout(() => done(false), CONFIRM_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    onEvent({ type: 'confirm', id, message });
  });
}

function makeCtx(onEvent) {
  return {
    openUrl: (url) => onEvent({ type: 'open-url', url }),
    setMode: (mode) => onEvent({ type: 'set-mode', mode }),
    confirm: (message) => askUser(onEvent, message)
  };
}

function systemSections() {
  const sections = { leslie_persona: config.systemPrompt };
  if (config.learningMode && !presence.restricted()) {
    const remembered = memory.format();
    if (remembered) sections.leslie_memory = remembered;
  }
  const seen = presence.format();
  if (seen) sections.leslie_presence = seen;
  if (config.detailedResponses) sections.leslie_reply_format = FORMAT_INSTRUCTIONS;
  if (config.planMode) sections.leslie_plan_mode = PLAN_MODE_DIRECTIVE;
  if (config.taskMode) sections.leslie_task_mode = TASK_MODE_DIRECTIVE;
  return sections;
}

// Offered to pi as the "leslie" provider so Leslie's own server stays selectable.
function leslieProvider() {
  const contextWindow = Math.max(2048, config.contextTokens);
  return {
    name: 'LESLIE server',
    baseUrl: config.baseURL,
    apiKey: config.apiKey || 'none',
    api: 'openai-completions',
    models: [
      {
        id: config.model,
        name: config.model,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: Math.min(8192, Math.floor(contextWindow / 4))
      }
    ]
  };
}

function writeManifest() {
  const file = path.join(app.getPath('userData'), 'pi-manifest.json');
  // With the managed server, pi's own llama.cpp provider already lists the model.
  const offerLeslie = !config.serverManaged || config.piModel === 'leslie';
  const manifest = { provider: offerLeslie ? leslieProvider() : null, tools: policy.bridgedSpecs() };
  fs.writeFileSync(file, JSON.stringify(manifest));
  return file;
}

function piArgs({ task = false } = {}) {
  const args = ['--extension', EXTENSION_PATH];
  // With no pinned model, start on whatever the managed llama.cpp server has loaded.
  const model =
    config.piModel === 'leslie' ? `leslie/${config.model}` : config.piModel || (config.serverModel && `llama.cpp/${config.serverModel}`);
  if (model) args.push('--model', model);
  // Assistant-mode tasks never touch the chat session or write session files.
  if (task) args.push('--no-session');
  else if (lastSessionFile && fs.existsSync(lastSessionFile)) args.push('--session', lastSessionFile);
  return args;
}

// Settings that require restarting pi. Leslie's own server details only matter
// when pi uses the "leslie" provider built from them.
function signature() {
  const leslieServer = config.piModel === 'leslie' ? [config.baseURL, config.model, config.apiKey, config.contextTokens] : [];
  return JSON.stringify([config.piCommand, config.piModel, policy.cwd(), ...leslieServer]);
}

function friendlyError(reason) {
  if (/ENOENT/.test(reason)) {
    return `pi was not found ("${config.piCommand}"). Install pi or set the pi command in Settings.`;
  }
  return reason;
}

// --- Extension UI sub-protocol ----------------------------------------------

// Which pi process (chat or task) asked each open dialog.
const uiOwners = new Map();

function respondUi(id, payload) {
  const owner = uiOwners.get(id) || client;
  uiOwners.delete(id);
  if (owner && owner.running) owner.respondUi(id, payload || { cancelled: true });
}

function handleUiRequest(req) {
  switch (req.method) {
    case 'select':
    case 'confirm':
    case 'input':
    case 'editor':
      broadcast({ type: 'ui', request: req });
      return;
    case 'notify':
      broadcast({ type: 'notify', level: req.notifyType || 'info', message: req.message });
      return;
    case 'setStatus':
      broadcast({ type: 'status', key: req.statusKey, text: req.statusText });
      return;
    case 'setWidget':
      broadcast({ type: 'status', key: req.widgetKey, text: (req.widgetLines || []).join(' · ') || undefined });
      return;
    case 'set_editor_text':
      broadcast({ type: 'editor-text', text: req.text || '' });
      return;
    default:
  }
}

// Session-level events the UI shows regardless of which turn is running.
function forwardEvent(ev) {
  switch (ev.type) {
    case 'queue_update':
      broadcast({ type: 'queue', steering: ev.steering || [], followUp: ev.followUp || [] });
      break;
    case 'compaction_start':
      broadcast({ type: 'compaction', phase: 'start', reason: ev.reason });
      break;
    case 'compaction_end':
      broadcast({
        type: 'compaction',
        phase: 'end',
        reason: ev.reason,
        aborted: ev.aborted,
        error: ev.errorMessage,
        tokensBefore: ev.result && ev.result.tokensBefore,
        tokensAfter: ev.result && ev.result.estimatedTokensAfter
      });
      break;
    case 'auto_retry_start':
      broadcast({ type: 'retry', attempt: ev.attempt, maxAttempts: ev.maxAttempts, error: ev.errorMessage });
      break;
    case 'extension_error':
      broadcast({ type: 'notify', level: 'error', message: `Extension error (${path.basename(ev.extensionPath || '')}): ${ev.error}` });
      break;
    case 'session_info_changed':
    case 'thinking_level_changed':
    case 'agent_settled':
      pushState();
      break;
    default:
  }
}

// --- Process lifecycle ------------------------------------------------------

function newClient(opts) {
  const c = new PiRpcClient({
    command: config.piCommand,
    args: piArgs(opts),
    cwd: policy.cwd(),
    env: { ...process.env, LESLIE_BRIDGE: bridge.address, LESLIE_PI_MANIFEST: writeManifest() }
  });
  c.on('ui-request', (req) => {
    uiOwners.set(req.id, c);
    handleUiRequest(req);
  });
  return c;
}

async function ensureBridge() {
  if (bridge) return;
  bridge = createBridge({ getTurn: () => turn, systemSections });
  await bridge.listen();
}

async function spawnPi() {
  client = newClient();
  const spawned = client;
  client.on('event', forwardEvent);
  client.on('exit', (info) => {
    if (client !== spawned) return;
    broadcast({ type: 'notify', level: 'error', message: friendlyError(`${info.reason}${info.stderr ? ` — ${info.stderr.trim().slice(-300)}` : ''}`) });
    broadcast({ type: 'state', state: null });
  });
  client.start();
  const state = await client.request('get_state', {}, { timeoutMs: 30000 });
  rememberSession(state);
  return state;
}

async function startPi() {
  const sig = signature();
  if (client && client.running && (sig === clientSignature || turn)) return client;
  if (client) client.stop();
  await ensureBridge();
  try {
    await spawnPi();
  } catch (err) {
    throw new Error(friendlyError(err.message));
  }
  clientSignature = sig;
  pushState();
  return client;
}

function ensureStarted() {
  if (!starting) starting = startPi().finally(() => { starting = null; });
  return starting;
}

/** Restart pi (picks up new extensions, skills, settings). */
async function reload() {
  if (client) client.stop();
  client = null;
  await ensureStarted();
  broadcast({ type: 'session' });
}

async function rpc(type, fields, opts) {
  const c = await ensureStarted();
  return c.request(type, fields, opts);
}

// --- State for the footer ---------------------------------------------------

// Reopened on the next launch, like `pi --continue`.
function rememberSession(state) {
  if (!state || !state.sessionFile || state.sessionFile === lastSessionFile) return;
  lastSessionFile = state.sessionFile;
  settings.set('piSessionFile', lastSessionFile);
}

async function getState() {
  const [state, stats] = await Promise.all([rpc('get_state'), rpc('get_session_stats').catch(() => null)]);
  rememberSession(state);
  const model = state && state.model;
  const usage = stats && stats.contextUsage;
  return {
    model: model ? { provider: model.provider, id: model.id, name: model.name || model.id, reasoning: Boolean(model.reasoning) } : null,
    thinkingLevel: state && state.thinkingLevel,
    sessionFile: state && state.sessionFile,
    sessionName: state && state.sessionName,
    isStreaming: Boolean(state && state.isStreaming),
    autoCompaction: state && state.autoCompactionEnabled,
    context: {
      tokens: usage ? usage.tokens : null,
      window: (usage && usage.contextWindow) || (model && model.contextWindow) || null,
      percent: usage ? usage.percent : null
    },
    tokens: stats && stats.tokens,
    cost: stats && stats.cost,
    counts: stats && { user: stats.userMessages, assistant: stats.assistantMessages, tools: stats.toolCalls }
  };
}

function pushState() {
  getState()
    .then((state) => broadcast({ type: 'state', state }))
    .catch(() => {});
}

// --- Running prompts --------------------------------------------------------

function textOf(result) {
  const content = (result && result.content) || [];
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return text.length > TOOL_OUTPUT_CHARS ? `${text.slice(0, TOOL_OUTPUT_CHARS)}\n…(truncated)` : text;
}

/** Translate one pi run into Leslie's thinking/summary/details/tool events. */
function followRun(c, onEvent) {
  let summary = '';
  let details = '';
  let router = null;
  let aborted = false;

  const emit = (channel, text) => {
    if (!text) return;
    if (channel === 'summary') summary += text;
    else if (channel === 'details') details += text;
    onEvent({ type: channel, text });
  };

  let settle;
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  const onPiEvent = (ev) => {
    switch (ev.type) {
      case 'message_start':
        if (ev.message && ev.message.role === 'assistant') {
          if (router) router.flush();
          summary = '';
          details = '';
          router = createTagRouter(emit);
        } else if (ev.message && ev.message.role === 'user' && ev.message.content !== undefined) {
          onEvent({ type: 'user-message', message: ev.message });
        }
        break;
      case 'message_update': {
        const u = ev.assistantMessageEvent || {};
        if (u.type === 'text_delta' && router) router.feed(u.delta || '');
        else if (u.type === 'thinking_delta') emit('thinking', u.delta);
        break;
      }
      case 'message_end':
        if (router) router.flush();
        if (ev.message && ev.message.stopReason === 'aborted') aborted = true;
        if (ev.message && ev.message.stopReason === 'error' && ev.message.errorMessage && !summary) {
          emit('summary', `Error: ${ev.message.errorMessage}`);
        }
        break;
      case 'tool_execution_start':
        onEvent({ type: 'tool', phase: 'start', id: ev.toolCallId, name: ev.toolName, detail: toolDetail(ev.toolName, ev.args || {}), args: ev.args });
        break;
      case 'tool_execution_update':
        onEvent({ type: 'tool', phase: 'output', id: ev.toolCallId, name: ev.toolName, output: textOf(ev.partialResult) });
        break;
      case 'tool_execution_end':
        onEvent({ type: 'tool', phase: 'end', id: ev.toolCallId, name: ev.toolName, ok: !ev.isError, output: textOf(ev.result) });
        break;
      case 'agent_settled':
        settle.resolve();
        break;
      default:
    }
  };

  const onExit = (info) => settle.reject(new Error(friendlyError(info.reason)));

  c.on('event', onPiEvent);
  c.once('exit', onExit);

  return {
    done,
    result: () => ({ summary, details, aborted }),
    dispose() {
      c.off('event', onPiEvent);
      c.off('exit', onExit);
    }
  };
}

let activeClient = null;

async function runPrompt(c, message, images, onEvent) {
  turn = { onEvent, ctx: makeCtx(onEvent) };
  activeClient = c;
  const run = followRun(c, onEvent);
  try {
    const fields = { message };
    if (images && images.length) fields.images = images;
    const accepted = await c.request('prompt', fields);
    if (!(accepted && accepted.disposition === 'handled')) await run.done;
    return run.result();
  } finally {
    run.dispose();
    turn = null;
    activeClient = null;
  }
}

async function sendMessage(text, onEvent, contextText, images) {
  const c = await ensureStarted();
  const message = [contextText, text].filter(Boolean).join('\n\n');

  const outcome = await runPrompt(c, message, images, onEvent);

  const stored = [outcome.summary.trim(), outcome.details.trim()].filter(Boolean).join('\n\n') || outcome.summary;
  learnFrom(text, stored);
  return { reply: outcome.summary.trim(), aborted: outcome.aborted };
}

function learnFrom(text, reply) {
  history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
  if (history.length > config.historyLimit) history = history.slice(-config.historyLimit);
  turnCount++;
  if (config.learningMode && !presence.restricted() && config.learnEvery > 0 && turnCount % config.learnEvery === 0) {
    extractMemories(history.slice()).catch(() => {});
  }
}

/** Queue input while pi is working: steer lands after the current turn, followUp after the run. */
function queueMessage(kind, text) {
  return rpc(kind === 'followUp' ? 'follow_up' : 'steer', { message: text });
}

function cancel() {
  const c = activeClient || client;
  if (c && c.running) c.request('abort').catch(() => {});
}

// --- Assistant mode: one-off tasks in a separate, sessionless pi ------------

let taskClient = null;
let taskSignature = '';
let taskStarting = null;

async function startTaskPi() {
  const sig = JSON.stringify([signature(), config.serverModel]);
  if (taskClient && taskClient.running && sig === taskSignature) return taskClient;
  if (taskClient) taskClient.stop();
  await ensureBridge();
  const c = newClient({ task: true });
  c.on('exit', () => {
    if (taskClient === c) taskClient = null;
  });
  c.start();
  taskClient = c;
  taskSignature = sig;
  try {
    await c.request('get_state', {}, { timeoutMs: 30000 });
  } catch (err) {
    throw new Error(friendlyError(err.message));
  }
  return c;
}

/** Run one task with a blank context; nothing is kept for later messages. */
async function runTask(text, onEvent, contextText, images) {
  if (!taskStarting) taskStarting = startTaskPi().finally(() => { taskStarting = null; });
  const c = await taskStarting;
  await c.request('new_session');
  const message = [contextText, text].filter(Boolean).join('\n\n');
  const outcome = await runPrompt(c, message, images, onEvent);
  return { reply: outcome.summary.trim(), aborted: outcome.aborted };
}

/** Run `!command` the way pi's editor does; output streams through onChunk. */
async function runBash(command, excludeFromContext, onChunk) {
  const c = await ensureStarted();
  const onPiEvent = (ev) => {
    if (ev.type === 'bash_execution_update' && ev.delta) onChunk(ev.delta);
  };
  c.on('event', onPiEvent);
  try {
    return await c.request('bash', { command, excludeFromContext: Boolean(excludeFromContext) }, { timeoutMs: 0 });
  } finally {
    c.off('event', onPiEvent);
  }
}

// --- Sessions ---------------------------------------------------------------

function sessionChanged() {
  history = [];
  turnCount = 0;
  broadcast({ type: 'session' });
  pushState();
}

function reset() {
  if (config.learningMode && !presence.restricted() && config.learnEvery > 0 && history.length) {
    extractMemories(history.slice()).catch(() => {});
  }
  return rpc('new_session').then(sessionChanged).catch(() => {});
}

function resume(sessionFile) {
  if (!sessionFile || !fs.existsSync(sessionFile)) return false;
  rpc('switch_session', { sessionPath: sessionFile })
    .then(sessionChanged)
    .catch((err) => broadcast({ type: 'notify', level: 'error', message: `Could not open session: ${err.message}` }));
  return true;
}

async function fork(entryId) {
  const res = await rpc('fork', { entryId });
  if (!res || !res.cancelled) sessionChanged();
  return res;
}

async function clone() {
  const res = await rpc('clone');
  if (!res || !res.cancelled) sessionChanged();
  return res;
}

async function sessionDir() {
  if (!lastSessionFile) await getState().catch(() => null);
  return lastSessionFile ? path.dirname(lastSessionFile) : null;
}

async function listSessions() {
  const dir = await sessionDir();
  return dir ? sessions.list(dir, lastSessionFile) : [];
}

async function getSession(file) {
  const dir = await sessionDir();
  return dir && sessions.isIn(dir, file) ? sessions.read(file) : null;
}

async function sessionFileFor(file) {
  const dir = await sessionDir();
  return dir && sessions.isIn(dir, file) && file !== lastSessionFile ? file : null;
}

// --- Commands the UI calls directly -----------------------------------------

const commands = {
  state: getState,
  models: async () => ((await rpc('get_available_models')) || {}).models || [],
  setModel: async ({ provider, id }) => {
    await rpc('set_model', { provider, modelId: id });
    pushState();
  },
  thinkingLevels: async () => ((await rpc('get_available_thinking_levels')) || {}).levels || ['off'],
  setThinking: async ({ level }) => {
    await rpc('set_thinking_level', { level });
    pushState();
  },
  compact: async ({ instructions } = {}) => {
    const res = await rpc('compact', instructions ? { customInstructions: instructions } : {}, { timeoutMs: 0 });
    pushState();
    return res;
  },
  setAutoCompaction: async ({ enabled }) => {
    await rpc('set_auto_compaction', { enabled: Boolean(enabled) });
    pushState();
  },
  setSessionName: async ({ name }) => {
    await rpc('set_session_name', { name });
    pushState();
  },
  forkMessages: async () => ((await rpc('get_fork_messages')) || {}).messages || [],
  fork: ({ entryId }) => fork(entryId),
  clone,
  exportHtml: async () => ((await rpc('export_html')) || {}).path,
  commands: async () => (((await rpc('get_commands')) || {}).commands || []).filter((c) => !c.name.startsWith('leslie-')),
  messages: async () => (((await rpc('get_messages')) || {}).messages || []).filter((m) => m.role !== 'system'),
  lastReply: async () => ((await rpc('get_last_assistant_text')) || {}).text || '',
  /** Point pi at a model the server just loaded; the provider may need a moment to list it. */
  useModel: async ({ provider, id }) => {
    let lastError;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        if (provider === 'llama.cpp') await rpc('prompt', { message: '/leslie-sync-models' });
        await rpc('set_model', { provider, modelId: id });
        pushState();
        return;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastError;
  },
  steer: ({ text }) => queueMessage('steer', text),
  followUp: ({ text }) => queueMessage('followUp', text),
  clearQueue: () => rpc('clear_queue'),
  abortBash: () => rpc('abort_bash'),
  newSession: async () => reset(),
  reload
};

async function command(name, args) {
  const fn = commands[name];
  if (!fn) throw new Error(`Unknown pi command: ${name}`);
  return fn(args || {});
}

function shutdown() {
  if (client) client.stop();
  if (taskClient) taskClient.stop();
  taskClient = null;
  if (bridge) bridge.close();
  client = null;
  bridge = null;
}

module.exports = {
  sendMessage,
  runTask,
  reset,
  resolveConfirm,
  resume,
  cancel,
  shutdown,
  onUiEvent,
  respondUi,
  command,
  runBash,
  listSessions,
  getSession,
  sessionFileFor
};
