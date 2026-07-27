# Deep Research — Implementation Plan

How to bring odysseus's **IterResearch-style deep research** into project-Leslie,
reusing what Leslie already has and fitting the agent-loop + sidebar UI.

---

## 1. How odysseus's deep research works

Source: `src/SampleRepos/odysseus/src/deep_research.py` (the `DeepResearcher`
class) and `services/research/research_handler.py` (task registry + report
formatting).

It's an **LLM-in-the-loop iterative loop** — the model drives every decision.
One `research(question)` call runs:

```
PLAN ─────────────────────────────────────────────────────────────────────┐
  _create_plan(question)      → LLM returns {sub_questions, key_topics,     │
                                 success_criteria} (JSON)                   │
  _classify_category(question)→ LLM picks product|comparison|howto|         │
                                 factcheck|general (shapes final format)    │
                                                                           │
LOOP for round in 1..max_rounds (default 8), until stop / time / empty: ───┤
  THINK    _generate_queries()   → LLM emits 3-4 search queries (JSON       │
                                    array), deduped against queries_used    │
  SEARCH   _search(q)            → SearXNG (+ provider fallback chain),     │
                                    run for all queries in parallel         │
  EXTRACT  _fetch_and_extract()  → fetch each new URL, HTML→text, truncate  │
                                    to ~15k chars, LLM extracts             │
                                    {summary, evidence, url, title} (JSON); │
                                    concurrency-bounded by a semaphore;     │
                                    low-quality extractions dropped         │
  SYNTHESIZE _synthesize()       → LLM folds the last N findings into an    │
                                    evolving markdown report                │
  DECIDE   _should_stop()        → after min_rounds, LLM answers YES/NO on  │
                                    "is this comprehensive enough?"         │
                                                                           │
FINAL ─────────────────────────────────────────────────────────────────────┤
  _final_report()  → LLM writes a long (≥1500-word) report from the        │
                     evolving report; auto-expands if too short;           │
                     category prompt appended for format override          │
```

Key supporting behavior:

- **Progress events** — `_emit(phase=..., round=..., url=...)` fires a
  `progress_callback` at every phase (`planning`, `searching`, `reading`,
  `analyzing`, `writing`, `error`). The web UI renders these live.
- **Guards** — cooperative `cancel()`, `max_time` wall clock, `max_empty_rounds`
  (bail if search is down), `min_rounds` (don't stop too early).
- **Resilience** — every phase is wrapped: planning failure → search broadly;
  synthesis failure → keep previous report; no report but findings exist →
  compile findings as fallback; whole engine fails → legacy engine → basic
  web search.
- **Report assembly** — `research_handler._format_research_report()` wraps the
  report with a stats line, a filtered **Sources** list, an **Analyzed URLs**
  list, and an expandable `<details>` block of raw per-source findings.
- **Untrusted content** — page text is wrapped via
  `untrusted_context_message("webpage", content)` before being fed to the LLM
  (prompt-injection hardening).
- **Date grounding** — every planning/query prompt is prefixed with
  `current_date_context()` so the model doesn't search for a stale year.

---

## 2. What Leslie already has (building blocks)

Leslie already ships the primitives odysseus's engine needs:

| Need | odysseus | Leslie equivalent (reuse) |
|------|----------|---------------------------|
| Web search | `_search` → SearXNG + providers | [webSearch.js](../src/main/tools/webSearch.js) — SearXNG JSON at `config.searxngUrl` |
| Fetch + HTML→text | `fetch_webpage_content` | [deepSearch.js](../src/main/tools/deepSearch.js) `readPage()` + `htmlToText()` |
| LLM chat calls | `llm_call_async` | [streamTurn.js](../src/main/agent/streamTurn.js) hits `config.baseURL/chat/completions` |
| Untrusted wrapping | `untrusted_context_message` | [toolPolicy.js](../src/main/agent/toolPolicy.js) `wrapUntrusted()` |
| Tool registration | tool_index | [tools/index.js](../src/main/tools/index.js) `{name, description, parameters, run, readOnly}` |
| Tool activity UI | web progress panel | **new sidebar tool cards** (loop.js `agent:tool` start/end) |

**The gap:** Leslie's `deep_search` is a *single-shot* tool — one SearXNG query,
read N pages, dump text. It has **no LLM-in-the-loop orchestration** (no plan,
query generation, extraction, iterative synthesis, or stop decision). That
orchestration is exactly what we port.

---

## 3. Design for Leslie

Port the engine to a Node module and expose it as a new tool, `deep_research`,
that the agent can call. Keep `deep_search` as the fast single-shot option.

### 3.1 New/changed files

```
src/main/tools/lib/
  webContent.js        NEW  — extracted htmlToText() + readPage() from deepSearch.js
  llmCall.js           NEW  — non-streaming chat-completions helper (see 3.2)
  deepResearch/
    researcher.js      NEW  — the DeepResearcher port (the loop)
    prompts.js         NEW  — ported prompts (plan, query, extract, synth, stop, final, category)
    report.js          NEW  — _format_research_report() equivalent
src/main/tools/
  deepResearch.js      NEW  — the tool wrapper (name: 'deep_research')
  deepSearch.js        EDIT — import htmlToText/readPage from lib/webContent.js
  index.js             EDIT — register deepResearch in `base`
src/main/config.js     EDIT — new research.* config knobs (see 3.5)
src/main/agent/loop.js EDIT — pass a progress callback into ctx (see 3.4)
docs/deep-research-plan.md  (this file)
```

### 3.2 The LLM helper (`lib/llmCall.js`)

The engine makes many **discrete, non-streaming** calls (plan, per-query,
per-URL extraction, synthesis, stop, final). `streamTurn.js` is streaming and
tool-oriented, so add a small sibling:

```js
// POST config.baseURL/chat/completions, stream:false, return assistant text.
async function llmCall({ messages, temperature = 0.3, maxTokens = 2048, timeoutMs = 60000 })
```

- Reuse the header/auth logic from `streamTurn.js` (`config.apiKey`).
- `AbortController` for per-phase timeouts (planning/query/extraction/synthesis).
- Strip `<think>…</think>` (odysseus `strip_thinking`) — local reasoning models
  wrap output in think tags; the stop-decision parser breaks without this.
- JSON helpers: `parseJsonObject`, `parseJsonArray`, `stripCodeBlock` (port from
  `deep_research.py` `_parse_json_*`).

### 3.3 The researcher (`lib/deepResearch/researcher.js`)

A near-direct port of `DeepResearcher.research()`. Async/await maps 1:1 from
Python. Structure:

```js
async function research(question, { emit, signal, cfg }) {
  // PLAN
  emit({ phase: 'planning' });
  const plan = await createPlan(question);
  const category = await classifyCategory(question);

  const findings = [];
  let report = '';
  let emptyRounds = 0;

  for (let round = 1; round <= cfg.maxRounds; round++) {
    if (signal.aborted || timeExceeded()) break;
    emit({ phase: 'searching', round });

    const queries = await generateQueries(question, report, round, plan);   // THINK
    if (!queries.length) break;

    const roundFindings = await searchAndExtract(queries, question);        // SEARCH+EXTRACT
    if (roundFindings.length) { findings.push(...roundFindings); emptyRounds = 0; }
    else if (++emptyRounds >= cfg.maxEmptyRounds) break;

    if (findings.length) report = await synthesize(question, findings, report); // SYNTHESIZE
    if (round >= cfg.minRounds && await shouldStop(question, report, round)) break; // DECIDE
  }

  emit({ phase: 'writing' });
  const final = await finalReport(question, report, category);
  return { report: final, findings, analyzedUrls, stats };
}
```

Concrete mappings:

- **Search** → SearXNG fetch (copy `webSearch.js`), run all queries with
  `Promise.all`. Dedupe URLs via a `Set` (`urlsFetched`).
- **Extract** → `readPage()` from `lib/webContent.js`, truncate to
  `cfg.maxContentChars` on a paragraph boundary, then `llmCall` with the
  extractor prompt. Bound concurrency with a small semaphore (port the
  `asyncio.Semaphore(extraction_concurrency)` — a simple `p-limit`-style counter,
  no dependency needed). **Wrap page text with `wrapUntrusted('deep_research', content)`** before sending to the model.
- **Synthesize / stop / final** → `llmCall` with ported prompts; keep odysseus's
  timeouts (synthesis/final 180s — local models are slow) and the
  too-short-report auto-expand retry.
- **Guards** → `signal` (AbortController) for cancel, `Date.now()` wall clock for
  `maxTime`, `emptyRounds`/`minRounds` as above.

### 3.4 Progress → the sidebar UI

The new sidebar already renders **tool cards** with a live detail line and a
start/end status (loop.js emits `agent:tool` `{phase, id, name, detail, ok}`;
renderer's `toolCardStart/End`). Extend this so a long tool can push interim
updates:

1. **loop.js** — when running a tool, pass a progress emitter in `ctx`:
   ```js
   const onProgress = (text) =>
     onEvent({ type: 'tool', phase: 'progress', id: toolId, name: call.name, detail: text });
   const result = await tools.run(call.name, args, { ...ctx, onProgress });
   ```
2. **main.js** — the `case 'tool'` already forwards the whole event object to
   `agent:tool`; no change needed.
3. **renderer.js** — add a `phase === 'progress'` branch to `onToolCall` that
   updates the existing card's `.tc-detail` text (and keeps it spinning).
4. **researcher `emit`** — map phases to short strings the card can show:
   `planning` → "Planning…", `searching` (round n) → "Round n · searching",
   `reading` (url) → "Reading example.com", `analyzing` → "Synthesizing…",
   `writing` → "Writing report…".

Result: one `deep_research` card that live-narrates the run, then flips to ✓.
(The full reasoning also still lands in the collapsible "Reasoning" block via the
existing per-tool `thinking` line.)

### 3.5 Config (`config.js`)

Add a `research` group (env-overridable, matching the existing style):

```js
research: {
  maxRounds:            Number(env.LESLIE_RESEARCH_MAX_ROUNDS  ?? 6),
  minRounds:            Number(env.LESLIE_RESEARCH_MIN_ROUNDS  ?? 2),
  maxEmptyRounds:       Number(env.LESLIE_RESEARCH_MAX_EMPTY   ?? 2),
  maxTimeMs:            Number(env.LESLIE_RESEARCH_MAX_TIME_MS ?? 300000),
  maxUrlsPerRound:      Number(env.LESLIE_RESEARCH_URLS_ROUND  ?? 3),
  maxContentChars:      Number(env.LESLIE_RESEARCH_CONTENT_CHARS ?? 15000),
  extractionConcurrency:Number(env.LESLIE_RESEARCH_CONCURRENCY ?? 3),
  maxReportTokens:      Number(env.LESLIE_RESEARCH_MAX_TOKENS  ?? 4096),
  extractionTimeoutMs:  Number(env.LESLIE_RESEARCH_EXTRACT_MS  ?? 90000),
  synthesisTimeoutMs:   Number(env.LESLIE_RESEARCH_SYNTH_MS    ?? 180000),
}
```

Tune defaults **down** from odysseus for a local model on one GPU (fewer rounds,
lower concurrency) so a run finishes in a couple of minutes, not ten.

### 3.6 The tool wrapper (`tools/deepResearch.js`)

```js
module.exports = {
  name: 'deep_research',
  readOnly: true,
  description:
    'Deeply research a topic: iteratively search the web, read and extract from ' +
    'many sources over several rounds, and synthesize a long, cited report. Use ' +
    'for open-ended, multi-faceted questions that need comprehensive analysis. ' +
    'Much slower than web_search/deep_search — prefer those for quick facts.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'The research question.' } },
    required: ['query'],
  },
  async run({ query }, ctx) {
    const out = await research(query, {
      emit: (e) => ctx.onProgress?.(phaseLabel(e)),
      signal: ctx.signal ?? new AbortController().signal,
      cfg: config.research,
    });
    return formatReport(query, out); // report.js — stats + Sources + Analyzed URLs + <details>
  },
};
```

Register in `tools/index.js` `base` so it's available in every mode (it's
read-only). Tool-RAG selection (`selectTools`) will surface it for research-shaped
questions automatically.

---

## 4. Phasing

**Phase 1 — core engine (synchronous).**
`lib/webContent.js`, `lib/llmCall.js`, `lib/deepResearch/*`, `tools/deepResearch.js`,
register it, add config. The tool blocks the agent turn until the report is ready
(fine for a desktop app). Ship the plan→loop→synthesize→final pipeline + the
sources/analyzed-URLs/details report format. Fallback on total failure: return
`deep_search` output.

**Phase 2 — live progress in the sidebar.**
The `ctx.onProgress` plumbing (3.4) and the renderer `phase:'progress'` card
update. Big UX win — the card narrates rounds/reads live.

**Phase 3 — cancellation.**
Thread an `AbortController` from a UI "Stop" affordance through `ctx.signal` into
the researcher's guards (`signal.aborted` checks each round + between extracts).
Mirrors odysseus `cancel()`.

**Phase 4 (optional) — background task + persistence.**
Only if we want research to survive a window collapse/reopen or run detached.
Port `research_handler`'s task registry (in-memory map keyed by an id, JSON
persistence under `userData/research/`), plus status/result IPC. Likely
unnecessary for a single-window desktop app; revisit if runs get long.

---

## 5. Risks & considerations

- **Local-model speed.** The engine makes ~15-30 LLM calls per run. On one local
  GPU that's minutes. Mitigate with the reduced defaults (§3.5), bounded
  extraction concurrency, and the generous synthesis/final timeouts odysseus
  learned the hard way (their #1551).
- **Weak-model JSON.** Query/plan/extract rely on JSON output. Port odysseus's
  tolerant parsers (`_parse_json_array/object`, code-block stripping) and the
  raw-response fallbacks (treat non-JSON as evidence; scan for a category word).
- **Prompt injection.** Fetched pages are untrusted. Route all page text through
  `wrapUntrusted()` — Leslie already does this for tool output; do it *inside* the
  researcher before extraction too.
- **Blocking the turn (Phase 1).** A multi-minute `tools.run` holds the agent
  turn open. The sidebar shows the spinning tool card, so it reads as "working,"
  but there's no cancel until Phase 3. Acceptable to start.
- **SearXNG dependency.** Same as today's `deep_search` — needs `config.searxngUrl`
  reachable with JSON output enabled. Keep the single-shot `deep_search` fallback.
- **Report size vs. sidebar.** Final reports are long (≥1500 words). They render
  fine in the scrollable transcript via `markdown.render`; no detail-window
  needed.

---

## 6. Verification

- Unit-test the JSON parsers and `phaseLabel` mapping (pure functions).
- Mock `llmCall` + SearXNG to test one full `research()` run deterministically
  (plan → 2 rounds → stop → final), asserting findings dedupe and report
  assembly — mirrors odysseus's `tests/test_deep_research_*`.
- Manual: ask a broad question in agent mode, watch the `deep_research` tool card
  narrate rounds and produce a cited report in the transcript.
