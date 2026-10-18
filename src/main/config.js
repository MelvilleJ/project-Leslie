'use strict';

// The source checkout's .env, or ~/.config/project-leslie/.env for the installed app.
(function loadDotEnv() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const candidates = [
    path.join(__dirname, '..', '..', '.env'),
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'project-leslie', '.env')
  ];
  let text;
  for (const file of candidates) {
    try {
      text = fs.readFileSync(file, 'utf8');
      break;
    } catch {
    }
  }
  if (text === undefined) return;
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
  piCommand: env.LESLIE_PI_COMMAND || 'pi',
  // Blank uses pi's own default model; 'leslie' uses the server configured below.
  piModel: env.LESLIE_PI_MODEL || '',
  piCwd: env.LESLIE_PI_CWD || '',

  // LESLIE drives the shared llama-router user service and points itself at
  // it; off = use LESLIE_BASE_URL / LESLIE_MODEL as given.
  serverManaged: env.LESLIE_SERVER_MANAGED !== '0',

  // Hyprland monitor the companion lives on (see `hyprctl monitors`); blank = anywhere.
  homeMonitor: env.LESLIE_HOME_MONITOR || '',

  // Monitor that screen_record / screenshot capture (blank = the focused one), and
  // the VAAPI render node wf-recorder hardware-encodes on (blank = detected).
  recordMonitor: env.LESLIE_RECORD_MONITOR || '',
  recordRenderNode: env.LESLIE_RECORD_RENDER_NODE || '',

  // Only used when the model server isn't managed; the managed one sets it.
  baseURL: env.LESLIE_BASE_URL || '',

  model: env.LESLIE_MODEL || 'local-model',

  apiKey: env.LESLIE_API_KEY || '',

  systemPrompt:
    env.LESLIE_SYSTEM_PROMPT ||
    'You are LESLIE, a friendly desktop companion. Reply in a warm, concise, conversational way - usually one or two short sentences. Call the user by their first name when you know it, never "sir".',

  historyLimit: Number(env.LESLIE_HISTORY_LIMIT ?? 20),

  toolsEnabled: env.LESLIE_TOOLS !== '0',

  fsWriteRoots: (env.LESLIE_FS_WRITE_ROOTS
    ? env.LESLIE_FS_WRITE_ROOTS.split(',').map((s) => s.trim()).filter(Boolean)
    : [env.LESLIE_DOCS_DIR || require('node:path').join(require('node:os').homedir(), 'Documents')]),

  planMode: env.LESLIE_PLAN_MODE === '1',

  // Auto mode: run commands and create files without asking unless they look
  // destructive (see tools/lib/destructive.js).
  autoApprove: env.LESLIE_AUTO_APPROVE === '1',

  // Assistant mode: every message is a one-off task with no conversation history.
  taskMode: false,

  learningMode: env.LESLIE_LEARNING !== '0',
  learnEvery: Number(env.LESLIE_LEARN_EVERY ?? 3),

  // Minutes without a message from the user before the chat starts fresh; 0 = never.
  idleResetMinutes: Number(env.LESLIE_IDLE_RESET_MINUTES ?? 30),

  // Blank turns off the search tools.
  searxngUrl: env.LESLIE_SEARXNG_URL || '',
  searchResults: Number(env.LESLIE_SEARCH_RESULTS ?? 5),

  deepSearchPages: Number(env.LESLIE_DEEP_SEARCH_PAGES ?? 3),
  deepSearchChars: Number(env.LESLIE_DEEP_SEARCH_CHARS ?? 4000),
  deepSearchTimeoutMs: Number(env.LESLIE_DEEP_SEARCH_TIMEOUT_MS ?? 8000),

  // --- Deep research (iterative multi-round search + synthesis) -------------
  // Defaults are tuned down from the reference implementation for a single
  // local model on one GPU — fewer rounds and lower concurrency so a run
  // finishes in a few minutes rather than ten.
  // Research calls size themselves against researchContextTokens, which (like
  // contextTokens) is read from the llama.cpp server — see contextWindow.js.
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

  // --- Watch: poll a database and a mailbox, then brief the user ------------
  watchPgUrl: env.LESLIE_WATCH_PG_URL || '',
  watchPgTables: (env.LESLIE_WATCH_PG_TABLES || '').split(',').map((s) => s.trim()).filter(Boolean),
  watchPgIntervalSec: Number(env.LESLIE_WATCH_PG_INTERVAL ?? 60),
  watchImapHost: env.LESLIE_WATCH_IMAP_HOST || '',
  watchImapPort: Number(env.LESLIE_WATCH_IMAP_PORT ?? 993),
  watchImapSecure: env.LESLIE_WATCH_IMAP_SECURE !== '0',
  watchImapUser: env.LESLIE_WATCH_IMAP_USER || '',
  watchImapPassword: env.LESLIE_WATCH_IMAP_PASSWORD || '',
  watchImapMailbox: env.LESLIE_WATCH_IMAP_MAILBOX || 'INBOX',
  watchImapIntervalSec: Number(env.LESLIE_WATCH_IMAP_INTERVAL ?? 120),

  // --- Camera presence (scripts/setup-vision.sh runs the leslie-vision sidecar) ---
  cameraEnabled: env.LESLIE_CAMERA === '1',
  // Blank = the first camera the vision service finds.
  cameraDevice: env.LESLIE_CAMERA_DEVICE || '',
  cameraServerUrl: env.LESLIE_CAMERA_SERVER_URL || 'http://127.0.0.1:8179',
  cameraArriveSec: Number(env.LESLIE_CAMERA_ARRIVE_SEC ?? 3),
  cameraLeaveSec: Number(env.LESLIE_CAMERA_LEAVE_SEC ?? 120),
  cameraGreetAfterMin: Number(env.LESLIE_CAMERA_GREET_AFTER_MIN ?? 10),
  cameraMatchThreshold: Number(env.LESLIE_CAMERA_MATCH_THRESHOLD ?? 0.4),
  cameraOwnerGating: env.LESLIE_CAMERA_OWNER_GATING !== '0',
  // Raise an open palm to make her listen; finger to lips to stop her talking.
  cameraGestures: env.LESLIE_CAMERA_GESTURES !== '0',
  cameraAwayPauseMedia: env.LESLIE_CAMERA_AWAY_PAUSE_MEDIA === '1',
  cameraAwayMuteVoice: env.LESLIE_CAMERA_AWAY_MUTE_VOICE === '1',

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

  // --- Live docs: markdown Leslie and the user edit together in the browser ---
  liveDocsEnabled: env.LESLIE_LIVE_DOCS !== '0',
  liveDocsDir: env.LESLIE_LIVE_DOCS_DIR || require('node:path').join(require('node:os').homedir(), 'Documents', 'Leslie'),
  liveDocsPort: Number(env.LESLIE_LIVE_DOCS_PORT ?? 8191),

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
  // 'server' = an OpenAI-style /audio/transcriptions endpoint (scripts/setup-whisper.sh
  // runs whisper large-v3-turbo there); 'local' = Whisper in the app via WASM (slow, tiny).
  sttBackend: (env.LESLIE_STT_BACKEND || 'server').toLowerCase(),
  sttModel: env.LESLIE_STT_MODEL || 'Xenova/whisper-tiny.en',
  sttServerUrl: env.LESLIE_STT_SERVER_URL || 'http://127.0.0.1:8178/v1',
  sttServerModel: env.LESLIE_STT_SERVER_MODEL || 'large-v3-turbo',
  sttServerApiKey: env.LESLIE_STT_SERVER_API_KEY || '',
  wakeTimeoutMs: Number(env.LESLIE_WAKE_TIMEOUT_MS ?? 8000),
  voiceAutoSend: env.LESLIE_VOICE_AUTOSEND !== '0',

  // Spoken replies: Kokoro-82M on the CPU (model downloads on first use).
  ttsEnabled: env.LESLIE_TTS !== '0',
  ttsVoice: env.LESLIE_TTS_VOICE || 'af_heart',
  ttsSpeed: Number(env.LESLIE_TTS_SPEED ?? 1)
};

require('./contextWindow').install(module.exports);
