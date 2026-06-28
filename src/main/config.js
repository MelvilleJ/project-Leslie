'use strict';

// LESLIE agent configuration.
//
// Talks to any OpenAI-compatible /v1/chat/completions endpoint (llama.cpp's
// llama-server, LM Studio, Ollama, vLLM, text-generation-webui, …).
// Edit the defaults below, or override any of them with environment variables
// at launch — e.g.  LESLIE_BASE_URL=http://localhost:1234/v1 npm start

// Load a project-root ".env" into process.env (without overriding vars already
// set in the shell). Tiny zero-dependency parser — keeps deps minimal.
(function loadDotEnv() {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', '..', '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env — defaults below apply
  }
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue; // shell vars win
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
})();

const env = process.env;

module.exports = {
  // Base URL of the OpenAI-compatible server, INCLUDING the /v1 suffix.
  // llama-server default is port 8080; LM Studio 1234; Ollama 11434.
  baseURL: env.LESLIE_BASE_URL || 'http://192.168.100.224:8081/v1',

  // Model name. llama.cpp/LM Studio generally ignore this and use whatever
  // model is loaded, so any string works. vLLM/Ollama need the real id.
  model: env.LESLIE_MODEL || 'local-model',

  // Most local servers need no key; some accept a dummy. Leave empty to omit
  // the Authorization header entirely.
  apiKey: env.LESLIE_API_KEY || '',

  // Persona. Kept short because replies appear in a small speech bubble.
  systemPrompt:
    env.LESLIE_SYSTEM_PROMPT ||
    'You are LESLIE, a friendly desktop companion. Reply in a warm, concise, conversational way - usually one or two short sentences.',

  temperature: Number(env.LESLIE_TEMPERATURE ?? 0.7),
  maxTokens: Number(env.LESLIE_MAX_TOKENS ?? 512),

  // How many past messages (user+assistant) to keep as context.
  historyLimit: Number(env.LESLIE_HISTORY_LIMIT ?? 20),

  // --- Tools -----------------------------------------------------------------
  // Master switch for tool-calling (web search, …). Requires a model + server
  // that support the OpenAI tools API. Set LESLIE_TOOLS=0 to disable.
  toolsEnabled: env.LESLIE_TOOLS !== '0',
  // Max tool round-trips per message before forcing a final answer.
  maxToolCalls: Number(env.LESLIE_MAX_TOOL_CALLS ?? 5),

  // --- Agent workflow (Odysseus-style layers) --------------------------------
  // Plan mode: investigate with read-only tools only, then propose a plan
  // instead of executing. Effectful tools (run_command, install_software,
  // open_app) are hidden + rejected while on. Toggle with LESLIE_PLAN_MODE=1.
  planMode: env.LESLIE_PLAN_MODE === '1',

  // --- Learning mode ---------------------------------------------------------
  // Remember durable user preferences across sessions (the `remember` tool +
  // background extraction), and inject them into the system prompt. On by
  // default; disable with LESLIE_LEARNING=0. Runtime-toggleable from the tray.
  learningMode: env.LESLIE_LEARNING !== '0',
  // Run background preference-extraction once every N user turns (cost control
  // for local models). 1 = every turn. Set LESLIE_LEARN_EVERY=0 to disable
  // auto-extraction entirely (the `remember` tool still works).
  learnEvery: Number(env.LESLIE_LEARN_EVERY ?? 3),

  // Tool RAG: advertise only the tools relevant to each request instead of all
  // of them. Keyword-based by default; set LESLIE_TOOL_RAG=0 to send all tools.
  toolRag: env.LESLIE_TOOL_RAG !== '0',
  // Use local embeddings (transformers.js) for tool selection instead of
  // keywords. Downloads a small model on first use; falls back to keywords on
  // any error. Off by default. Enable with LESLIE_TOOL_RAG_EMBEDDINGS=1.
  toolRagEmbeddings: env.LESLIE_TOOL_RAG_EMBEDDINGS === '1',
  // How many tools the embedding path keeps for a query.
  toolRagTopK: Number(env.LESLIE_TOOL_RAG_TOPK ?? 4),
  // transformers.js model used for embedding-based tool selection.
  toolRagModel: env.LESLIE_TOOL_RAG_MODEL || 'Xenova/all-MiniLM-L6-v2',

  // Reliability guards (for weak local models).
  // Force a tool-free "just answer" round after this many circling rounds
  // (same tool call repeated with no new answer text).
  loopStuckRounds: Number(env.LESLIE_LOOP_STUCK_ROUNDS ?? 4),
  // Hard backstop: one identical call repeated this many times = runaway.
  loopRunawayLimit: Number(env.LESLIE_LOOP_RUNAWAY_LIMIT ?? 15),
  // How many times to nudge a model that announces an action but emits no call.
  maxIntentNudges: Number(env.LESLIE_MAX_INTENT_NUDGES ?? 2),

  // SearXNG instance backing the web_search tool. JSON output must be enabled
  // (add "json" to search.formats in SearXNG's settings.yml).
  searxngUrl: env.LESLIE_SEARXNG_URL || 'http://192.168.100.226:8080',
  // How many search results to feed back to the model.
  searchResults: Number(env.LESLIE_SEARCH_RESULTS ?? 5),

  // deep_search reads the full text of the top result pages (not just snippets).
  // How many pages to fetch, characters kept per page, and per-page fetch timeout.
  deepSearchPages: Number(env.LESLIE_DEEP_SEARCH_PAGES ?? 3),
  deepSearchChars: Number(env.LESLIE_DEEP_SEARCH_CHARS ?? 4000),
  deepSearchTimeoutMs: Number(env.LESLIE_DEEP_SEARCH_TIMEOUT_MS ?? 8000),

  // --- Agent mode (run system commands / install software) -------------------
  // DANGER: lets the model execute shell commands on this machine. OFF unless
  // explicitly enabled. Non-allowlisted commands still require a click to run.
  agentMode: env.LESLIE_AGENT_MODE === '1',
  // Shell used to run commands. PowerShell is Windows' default; winget works in it.
  agentShell: env.LESLIE_AGENT_SHELL || 'powershell',
  // Command prefixes (case-insensitive) that run WITHOUT asking. Everything else
  // pops an Approve/Deny prompt. Override with a comma-separated list.
  agentAllowlist: (env.LESLIE_AGENT_ALLOWLIST
    ? env.LESLIE_AGENT_ALLOWLIST.split(',')
    : ['winget install', 'winget search', 'winget upgrade', 'winget list', 'winget show']
  )
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // Per-command timeout and how much stdout/stderr is fed back to the model.
  agentTimeoutMs: Number(env.LESLIE_AGENT_TIMEOUT_MS ?? 120000),
  agentMaxOutput: Number(env.LESLIE_AGENT_MAX_OUTPUT ?? 4000),

  // Ask the model for a short summary + optional details; long answers open the
  // separate detail window automatically. Set LESLIE_DETAILED=0 to disable.
  detailedResponses: env.LESLIE_DETAILED !== '0',

  // Hard rule: any answer longer than this many sentences is moved out of the
  // small speech bubble into the details window (a short teaser stays in the
  // bubble). Applies even when the model didn't use <details> tags.
  detailSentenceThreshold: Number(env.LESLIE_DETAIL_SENTENCE_THRESHOLD ?? 3),

  // --- Documents (create_document tool) --------------------------------------
  // Where created documents (docx/pdf/xlsx/txt/md/html/csv) are saved. Defaults
  // to the user's Documents folder. Override with LESLIE_DOCS_DIR.
  docsDir: env.LESLIE_DOCS_DIR || require('node:path').join(require('node:os').homedir(), 'Documents'),
  // Open a document in its default app after creating it. LESLIE_DOCS_AUTO_OPEN=0 to disable.
  docsAutoOpen: env.LESLIE_DOCS_AUTO_OPEN !== '0',

  // --- Voice (wake word + in-app dictation) ---------------------------------
  // Always-listening wake word + bundled Whisper dictation, all local.
  // Set LESLIE_VOICE=0 to disable the whole voice pipeline.
  voiceEnabled: env.LESLIE_VOICE !== '0',
  // Wake phrase; matching is fuzzy and keys on the last word ("leslie").
  wakeWord: env.LESLIE_WAKE_WORD || 'hey leslie',
  // Speech-to-text backend: 'local' runs Whisper in-process via transformers.js;
  // 'server' offloads transcription to an external whisper server (see below).
  sttBackend: (env.LESLIE_STT_BACKEND || 'local').toLowerCase(),
  // transformers.js Whisper model (downloaded once from HF, then cached).
  // Used only when sttBackend === 'local'.
  sttModel: env.LESLIE_STT_MODEL || 'Xenova/whisper-tiny.en',
  // Whisper server (used only when sttBackend === 'server'). Any OpenAI-compatible
  // /audio/transcriptions endpoint: whisper.cpp's whisper-server, faster-whisper-
  // server, speaches, LocalAI, OpenAI itself, … Give the base URL INCLUDING /v1.
  sttServerUrl: env.LESLIE_STT_SERVER_URL || 'http://localhost:8080/v1',
  // Model id the server should use. Most local whisper servers ignore this.
  sttServerModel: env.LESLIE_STT_SERVER_MODEL || 'whisper-1',
  // Optional bearer token. Leave empty to omit the Authorization header.
  sttServerApiKey: env.LESLIE_STT_SERVER_API_KEY || '',
  // After the wake word, how long (ms) to listen for the spoken command.
  wakeTimeoutMs: Number(env.LESLIE_WAKE_TIMEOUT_MS ?? 8000),
  // Auto-send dictated text (vs leaving it in the input to edit). LESLIE_VOICE_AUTOSEND=0.
  voiceAutoSend: env.LESLIE_VOICE_AUTOSEND !== '0'
};
