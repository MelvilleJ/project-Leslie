'use strict';

(function loadDotEnv() {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', '..', '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
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
  baseURL: env.LESLIE_BASE_URL || 'http://192.168.100.224:8081/v1',

  model: env.LESLIE_MODEL || 'local-model',

  apiKey: env.LESLIE_API_KEY || '',

  systemPrompt:
    env.LESLIE_SYSTEM_PROMPT ||
    'You are LESLIE, a friendly desktop companion. Reply in a warm, concise, conversational way - usually one or two short sentences.',

  temperature: Number(env.LESLIE_TEMPERATURE ?? 0.7),

  // Agent loop trims requests to fit; set to your server's actual n_ctx.
  contextTokens: Number(env.LESLIE_CONTEXT_TOKENS ?? 4096),

  historyLimit: Number(env.LESLIE_HISTORY_LIMIT ?? 20),

  toolsEnabled: env.LESLIE_TOOLS !== '0',
  maxToolCalls: Number(env.LESLIE_MAX_TOOL_CALLS ?? 5),

  llmMaxRetries: Number(env.LESLIE_LLM_MAX_RETRIES ?? 2),
  llmRetryDelayMs: Number(env.LESLIE_LLM_RETRY_DELAY_MS ?? 600),

  permissionAsk: env.LESLIE_PERMISSION_ASK
    ? env.LESLIE_PERMISSION_ASK.split(',').map((s) => s.trim()).filter(Boolean)
    : [],

  fsWriteEnabled: env.LESLIE_FS_WRITE === '1',
  fsWriteRoots: (env.LESLIE_FS_WRITE_ROOTS
    ? env.LESLIE_FS_WRITE_ROOTS.split(',').map((s) => s.trim()).filter(Boolean)
    : [env.LESLIE_DOCS_DIR || require('node:path').join(require('node:os').homedir(), 'Documents')]),
  fsWriteMaxBytes: Number(env.LESLIE_FS_WRITE_MAX_BYTES ?? 524288),

  planMode: env.LESLIE_PLAN_MODE === '1',

  learningMode: env.LESLIE_LEARNING !== '0',
  learnEvery: Number(env.LESLIE_LEARN_EVERY ?? 3),

  toolRag: env.LESLIE_TOOL_RAG !== '0',
  toolRagEmbeddings: env.LESLIE_TOOL_RAG_EMBEDDINGS === '1',
  toolRagTopK: Number(env.LESLIE_TOOL_RAG_TOPK ?? 4),
  toolRagModel: env.LESLIE_TOOL_RAG_MODEL || 'Xenova/all-MiniLM-L6-v2',

  loopStuckRounds: Number(env.LESLIE_LOOP_STUCK_ROUNDS ?? 4),
  loopRunawayLimit: Number(env.LESLIE_LOOP_RUNAWAY_LIMIT ?? 15),
  maxIntentNudges: Number(env.LESLIE_MAX_INTENT_NUDGES ?? 2),

  searxngUrl: env.LESLIE_SEARXNG_URL || 'http://192.168.100.226:8080',
  searchResults: Number(env.LESLIE_SEARCH_RESULTS ?? 5),

  deepSearchPages: Number(env.LESLIE_DEEP_SEARCH_PAGES ?? 3),
  deepSearchChars: Number(env.LESLIE_DEEP_SEARCH_CHARS ?? 4000),
  deepSearchTimeoutMs: Number(env.LESLIE_DEEP_SEARCH_TIMEOUT_MS ?? 8000),

  // --- Deep research (iterative multi-round search + synthesis) -------------
  // Defaults are tuned down from the reference implementation for a single
  // local model on one GPU — fewer rounds and lower concurrency so a run
  // finishes in a few minutes rather than ten.
  //
  // researchContextTokens is the target model's context window. Every
  // internal call (query gen, extraction, synthesis, final report) sizes its
  // prompt content and requested completion length against this, so research
  // stays usable on small local-model context windows instead of throwing
  // "exceeds context size" errors. Set it to match your actual server's n_ctx.
  researchContextTokens: Number(env.LESLIE_RESEARCH_CONTEXT_TOKENS ?? 4096),
  researchMaxRounds: Number(env.LESLIE_RESEARCH_MAX_ROUNDS ?? 6),
  researchMinRounds: Number(env.LESLIE_RESEARCH_MIN_ROUNDS ?? 2),
  researchMaxEmptyRounds: Number(env.LESLIE_RESEARCH_MAX_EMPTY_ROUNDS ?? 2),
  researchMaxTimeMs: Number(env.LESLIE_RESEARCH_MAX_TIME_MS ?? 300000),
  researchMaxUrlsPerRound: Number(env.LESLIE_RESEARCH_URLS_PER_ROUND ?? 3),
  researchSearchCount: Number(env.LESLIE_RESEARCH_SEARCH_COUNT ?? 8),
  researchSearchTimeoutMs: Number(env.LESLIE_RESEARCH_SEARCH_TIMEOUT_MS ?? 15000),
  // Upper bound on extracted page text; the engine further clamps this per
  // call to whatever actually fits the configured context window.
  researchMaxContentChars: Number(env.LESLIE_RESEARCH_CONTENT_CHARS ?? 8000),
  researchExtractionConcurrency: Number(env.LESLIE_RESEARCH_CONCURRENCY ?? 3),
  // Completion budget for synthesis/final-report calls. Also clamped per call
  // to fit researchContextTokens — this default only matters on larger-context
  // servers where the clamp doesn't kick in.
  researchMaxReportTokens: Number(env.LESLIE_RESEARCH_MAX_TOKENS ?? 1200),
  researchExtractionTimeoutMs: Number(env.LESLIE_RESEARCH_EXTRACT_TIMEOUT_MS ?? 90000),
  researchSynthesisTimeoutMs: Number(env.LESLIE_RESEARCH_SYNTH_TIMEOUT_MS ?? 180000),
  researchQueryTimeoutMs: Number(env.LESLIE_RESEARCH_QUERY_TIMEOUT_MS ?? 60000),

  osTarget: env.LESLIE_OS_TARGET || (process.platform === 'linux' ? 'linux' : 'windows'),
  linuxDistro: env.LESLIE_LINUX_DISTRO || 'debian',

  // DANGER: lets the model execute shell commands on this machine. OFF unless
  agentMode: env.LESLIE_AGENT_MODE === '1',
  agentShell: env.LESLIE_AGENT_SHELL || null,
  agentAllowlist: env.LESLIE_AGENT_ALLOWLIST
    ? env.LESLIE_AGENT_ALLOWLIST.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : null,
  agentTimeoutMs: Number(env.LESLIE_AGENT_TIMEOUT_MS ?? 120000),
  agentMaxOutput: Number(env.LESLIE_AGENT_MAX_OUTPUT ?? 4000),

  detailedResponses: env.LESLIE_DETAILED !== '0',

  detailSentenceThreshold: Number(env.LESLIE_DETAIL_SENTENCE_THRESHOLD ?? 3),

  docsDir: env.LESLIE_DOCS_DIR || require('node:path').join(require('node:os').homedir(), 'Documents'),
  docsAutoOpen: env.LESLIE_DOCS_AUTO_OPEN !== '0',

  // --- Filesystem reading (read-only) ---------------------------------------
  // OS-aware list_directory / read_file tools. On by default; set LESLIE_FS_READ=0
  // to remove them entirely. Caps bound how much a single read/list returns.
  fsReadEnabled: env.LESLIE_FS_READ !== '0',
  fsReadMaxBytes: Number(env.LESLIE_FS_READ_MAX_BYTES ?? 262144),
  fsListMaxEntries: Number(env.LESLIE_FS_LIST_MAX_ENTRIES ?? 200),
  // Max characters of extracted text returned by read_document (Word/PDF/Excel/…).
  fsDocMaxChars: Number(env.LESLIE_FS_DOC_MAX_CHARS ?? 20000),

  voiceEnabled: env.LESLIE_VOICE !== '0',
  wakeWord: env.LESLIE_WAKE_WORD || 'hey leslie',
  sttBackend: (env.LESLIE_STT_BACKEND || 'local').toLowerCase(),
  sttModel: env.LESLIE_STT_MODEL || 'Xenova/whisper-tiny.en',
  sttServerUrl: env.LESLIE_STT_SERVER_URL || 'http://localhost:8080/v1',
  sttServerModel: env.LESLIE_STT_SERVER_MODEL || 'whisper-1',
  sttServerApiKey: env.LESLIE_STT_SERVER_API_KEY || '',
  wakeTimeoutMs: Number(env.LESLIE_WAKE_TIMEOUT_MS ?? 8000),
  voiceAutoSend: env.LESLIE_VOICE_AUTOSEND !== '0'
};
