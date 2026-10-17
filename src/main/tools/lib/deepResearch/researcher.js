'use strict';

// IterResearch-style deep research engine, ported from odysseus's
// src/deep_research.py (DeepResearcher). Each round: LLM generates queries →
// SearXNG search → LLM extracts from top pages → LLM synthesizes into an
// evolving report → LLM decides continue/stop.

const config = require('../../../config');
const { readPage } = require('../webContent');
const { llmCall, parseJsonArray, parseJsonObject, estimateTokens, charsForTokens } = require('../llmCall');
const { wrapUntrusted } = require('../untrusted');
const prompts = require('./prompts');

const LOW_QUALITY_RE = /^(n\/a|none|nothing relevant|no relevant|not found|not applicable)/i;

function isLowQuality(summary) {
  const s = String(summary || '').trim();
  if (!s) return true;
  if (s.length < 20) return true;
  return LOW_QUALITY_RE.test(s);
}

// Every call below is sized against cfg.contextTokens (the target model's
// context window) so research stays usable on small local-model setups
// instead of throwing "exceeds context size" once the prompt + evidence text
// grows. MARGIN_TOKENS covers per-request overhead (role wrappers, JSON
// formatting instructions the estimator doesn't see directly).
const MARGIN_TOKENS = 100;

/** How many completion tokens are safe to request given this prompt text. */
function completionBudget(promptText, cfg, desiredMaxTokens) {
  const available = cfg.contextTokens - estimateTokens(promptText) - MARGIN_TOKENS;
  return Math.max(64, Math.min(desiredMaxTokens, available));
}

/** Truncate variable-length text (report/findings) to fit the remaining context budget. */
function clampToBudget(text, cfg, reserveTokens) {
  const s = String(text || '');
  const budgetChars = charsForTokens(cfg.contextTokens - reserveTokens - MARGIN_TOKENS);
  if (s.length <= budgetChars) return s;
  return s.slice(0, Math.max(0, budgetChars)) + '\n\n[...older content truncated to fit context...]';
}

/** Small counting semaphore — no dependency needed for this. */
function makeLimiter(concurrency) {
  let active = 0;
  const queue = [];
  function pump() {
    if (active >= concurrency || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      pump();
    });
  }
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  };
}

async function searxngSearch(query, count, timeoutMs, signal) {
  const base = config.searxngUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ q: query, format: 'json' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(`${base}/search?${params}`, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal
    });
    if (!res.ok) return { results: [], error: `SearXNG returned ${res.status} ${res.statusText}` };
    const data = await res.json();
    const results = (data.results || [])
      .filter((r) => r && r.url)
      .slice(0, count)
      .map((r) => ({ url: r.url, title: r.title || r.url }));
    // SearXNG answers 200 with an empty list when its upstream engines are
    // rate-limited or CAPTCHA'd; surface why instead of a silent "no results".
    const blocked = (data.unresponsive_engines || []).map(([name, reason]) => `${name} (${reason})`);
    if (!results.length && blocked.length) return { results, error: `SearXNG engines unavailable: ${blocked.join(', ')}` };
    return { results };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? `search timed out after ${timeoutMs}ms` : err && err.message ? err.message : String(err);
    return { results: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function formatFindings(findings) {
  return findings
    .map((f, i) => {
      const content = f.summary || (f.evidence ? f.evidence.slice(0, 1000) : '(no content)');
      return `${i + 1}. [${f.title || f.url}](${f.url})\n${content}`;
    })
    .join('\n\n');
}

function fallbackReport(question, findings) {
  return `## Findings on: ${question}\n\n${formatFindings(findings)}`;
}

async function createPlan(question, cfg) {
  const prompt = prompts.dateContext() + prompts.researchPlan(question);
  const response = await llmCall([{ role: 'user', content: prompt }], {
    temperature: 0.3,
    maxTokens: completionBudget(prompt, cfg, 512),
    timeoutMs: cfg.queryTimeoutMs,
    signal: cfg.signal
  });
  const parsed = parseJsonObject(response);
  if (!parsed) return response;
  const parts = [];
  if (Array.isArray(parsed.sub_questions) && parsed.sub_questions.length) {
    parts.push('Sub-questions: ' + parsed.sub_questions.join('; '));
  }
  if (Array.isArray(parsed.key_topics) && parsed.key_topics.length) {
    parts.push('Key topics: ' + parsed.key_topics.join(', '));
  }
  if (parsed.success_criteria) parts.push('Success: ' + parsed.success_criteria);
  return parts.length ? parts.join('\n') : response;
}

async function generateQueries(question, report, round, plan, queriesUsed, cfg) {
  const numQueries = round === 1 ? 4 : 3;
  const roundInstruction =
    round === 1
      ? 'This is the first round — generate broad, diverse queries that explore the key facets of the question.'
      : "We already have partial findings. Generate targeted follow-up queries to fill gaps, verify claims, or explore specific aspects that the report doesn't yet cover well.";

  // Query gen only needs to know the gist of what's covered so far, not the
  // full report — keep its share of the budget small so most of the context
  // window stays free for the model's own output.
  const reportForPrompt = clampToBudget(report || '(No findings yet.)', cfg, Math.floor(cfg.contextTokens * 0.3));
  const prompt =
    prompts.dateContext() +
    prompts.queryGen({
      question,
      researchPlan: plan || '(No plan — search broadly.)',
      report: reportForPrompt,
      round,
      numQueries,
      roundInstruction
    });

  const response = await llmCall([{ role: 'user', content: prompt }], {
    temperature: 0.5,
    maxTokens: completionBudget(prompt, cfg, 512),
    timeoutMs: cfg.queryTimeoutMs,
    signal: cfg.signal
  });
  const queries = parseJsonArray(response);
  const fresh = queries.filter((q) => !queriesUsed.has(q));
  fresh.forEach((q) => queriesUsed.add(q));
  return fresh;
}

async function extractFromUrl(item, question, cfg, emit) {
  emit({ phase: 'reading', url: item.url, title: item.title });
  const extractionMaxTokens = 512;
  const prompt = prompts.extractor(question);
  // Wrap-and-overhead tokens for the untrusted-content delimiter text aren't
  // in `prompt` itself, so fold in a fixed allowance before sizing the page
  // content that actually fits the remaining budget.
  const contentBudgetTokens = cfg.contextTokens - estimateTokens(prompt) - extractionMaxTokens - MARGIN_TOKENS - 60;
  const contentChars = Math.max(500, Math.min(cfg.maxContentChars, charsForTokens(contentBudgetTokens)));

  const page = await readPage(item.url, contentChars, cfg.extractionTimeoutMs, cfg.signal);
  if (page.error || !page.text) return null;

  const wrapped = wrapUntrusted('webpage', page.text);
  let response;
  try {
    response = await llmCall(
      [
        { role: 'user', content: prompt },
        { role: 'user', content: wrapped }
      ],
      { temperature: 0.2, maxTokens: extractionMaxTokens, timeoutMs: cfg.extractionTimeoutMs, signal: cfg.signal }
    );
  } catch {
    return null;
  }

  const parsed = parseJsonObject(response);
  if (parsed) {
    parsed.url = item.url;
    parsed.title = item.title || parsed.title || '';
    if (isLowQuality(parsed.summary)) return null;
    return parsed;
  }
  // Non-JSON reply: treat the whole thing as raw evidence rather than
  // discarding the round's work over a formatting slip.
  if (isLowQuality(response)) return null;
  return { url: item.url, title: item.title, evidence: response.slice(0, 3000), summary: response.slice(0, 500) };
}

async function searchAndExtract(queries, question, { cfg, urlsFetched, analyzedUrls, signal, emit, onError }) {
  const searchResults = await Promise.all(queries.map((q) => searxngSearch(q, cfg.searchCount, cfg.searchTimeoutMs, cfg.signal)));

  const urlsToFetch = [];
  for (const r of searchResults) {
    if (r.error) onError(r.error);
    for (const item of r.results) {
      if (!item.url || urlsFetched.has(item.url)) continue;
      urlsFetched.add(item.url);
      analyzedUrls.push({ url: item.url, title: item.title });
      urlsToFetch.push(item);
      if (urlsToFetch.length >= cfg.maxUrlsPerRound * queries.length) break;
    }
  }

  if ((signal && signal.aborted) || !urlsToFetch.length) return [];

  const limit = makeLimiter(cfg.extractionConcurrency);
  const results = await Promise.all(urlsToFetch.map((item) => limit(() => extractFromUrl(item, question, cfg, emit))));
  return results.filter(Boolean);
}

async function synthesize(question, findings, currentReport, cfg) {
  const window = findings.slice(-10);
  // Split the remaining (non-report) budget between the existing report and
  // the new findings text — both can be large, and the completion itself
  // still needs room within cfg.contextTokens.
  const half = Math.floor(cfg.contextTokens * 0.3);
  const reportForPrompt = clampToBudget(currentReport || '(First round — no report yet.)', cfg, half);
  const findingsText = clampToBudget(formatFindings(window), cfg, half);
  const prompt = prompts.synthesize({ question, report: reportForPrompt, newFindings: findingsText });
  try {
    return await llmCall([{ role: 'user', content: prompt }], {
      temperature: 0.3,
      maxTokens: completionBudget(prompt, cfg, cfg.maxReportTokens),
      timeoutMs: cfg.synthesisTimeoutMs,
      signal: cfg.signal
    });
  } catch {
    return currentReport; // keep the old report on failure
  }
}

async function shouldStop(question, report, round, maxRounds, cfg) {
  const reportForPrompt = clampToBudget(report, cfg, 64);
  const prompt = prompts.stopDecision({ question, report: reportForPrompt, round, maxRounds });
  try {
    const response = await llmCall([{ role: 'user', content: prompt }], {
      temperature: 0.1,
      maxTokens: 64,
      timeoutMs: 30000,
      signal: cfg.signal
    });
    // Tolerate "**YES**", "Yes.", quotes, etc.
    const clean = response.trim().replace(/^[\s*_`"'>#-]+/, '').toUpperCase();
    return clean.startsWith('YES');
  } catch {
    return false; // continue on error
  }
}

async function finalReport(question, report, cfg) {
  const reportForPrompt = clampToBudget(report, cfg, cfg.maxReportTokens);
  const prompt = prompts.finalReport({ question, report: reportForPrompt });
  const maxTokens = completionBudget(prompt, cfg, cfg.maxReportTokens);
  let result;
  try {
    result = await llmCall([{ role: 'user', content: prompt }], {
      temperature: 0.3,
      maxTokens,
      timeoutMs: cfg.synthesisTimeoutMs,
      signal: cfg.signal
    });
  } catch {
    return report;
  }

  const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;
  if (wordCount(result) < 300) {
    try {
      const expandPrompt = [
        { role: 'user', content: prompt },
        { role: 'assistant', content: result },
        { role: 'user', content: prompts.expandRequest() }
      ];
      const expandBudget = completionBudget(expandPrompt.map((m) => m.content).join('\n'), cfg, cfg.maxReportTokens);
      const expanded = await llmCall(expandPrompt, { temperature: 0.4, maxTokens: expandBudget, timeoutMs: cfg.synthesisTimeoutMs, signal: cfg.signal });
      if (wordCount(expanded) > wordCount(result)) return expanded;
    } catch {
      // keep `result` below
    }
  }
  return result;
}

const SUMMARY_TOKENS = 400;

// Used when the model can't summarize: the report's opening paragraph is its
// executive summary.
function leadParagraph(report) {
  const para = String(report)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('#'));
  return para ? para.slice(0, 800) : String(report).slice(0, 800);
}

async function summarize(question, report, cfg) {
  const prompt = prompts.summary({ question, report: clampToBudget(report, cfg, SUMMARY_TOKENS) });
  try {
    const result = await llmCall([{ role: 'user', content: prompt }], {
      temperature: 0.2,
      maxTokens: completionBudget(prompt, cfg, SUMMARY_TOKENS),
      timeoutMs: cfg.synthesisTimeoutMs,
      signal: cfg.signal
    });
    if (result.trim()) return result.trim();
  } catch {}
  return leadParagraph(report);
}

function resolveConfig(overrides) {
  return {
    contextTokens: config.researchContextTokens,
    maxRounds: config.researchMaxRounds,
    minRounds: config.researchMinRounds,
    maxEmptyRounds: config.researchMaxEmptyRounds,
    maxTimeMs: config.researchMaxTimeMs,
    maxUrlsPerRound: config.researchMaxUrlsPerRound,
    searchCount: config.researchSearchCount,
    searchTimeoutMs: config.researchSearchTimeoutMs,
    maxContentChars: config.researchMaxContentChars,
    extractionConcurrency: config.researchExtractionConcurrency,
    maxReportTokens: config.researchMaxReportTokens,
    extractionTimeoutMs: config.researchExtractionTimeoutMs,
    synthesisTimeoutMs: config.researchSynthesisTimeoutMs,
    queryTimeoutMs: config.researchQueryTimeoutMs,
    ...overrides
  };
}

/**
 * Run iterative deep research and return a full report + findings.
 * @param {string} question
 * @param {{emit?:(e:object)=>void, signal?:AbortSignal, cfg?:object}} [opts]
 */
async function research(question, opts = {}) {
  const cfg = resolveConfig(opts.cfg);
  const signal = opts.signal;
  cfg.signal = signal;
  const startTime = Date.now();

  // Log every phase to the terminal with elapsed time so a stall is visible
  // (you can see exactly which step it hung on). Wraps the caller's emit.
  const userEmit = opts.emit || (() => {});
  const emit = (e) => {
    const secs = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[deep_research +${secs}s] ${JSON.stringify(e)}`);
    userEmit(e);
  };

  const timeExceeded = () => Date.now() - startTime > cfg.maxTimeMs;
  const aborted = () => Boolean(signal && signal.aborted);
  const statsFor = (rounds) => ({
    rounds,
    queries: queriesUsed.size,
    urls: urlsFetched.size,
    elapsedMs: Date.now() - startTime
  });

  const queriesUsed = new Set();
  const urlsFetched = new Set();
  const analyzedUrls = [];
  const findings = [];
  let lastSearchError = '';

  emit({ phase: 'planning' });
  const plan = await createPlan(question, cfg).catch(() => '');

  let report = '';
  let emptyRounds = 0;
  let roundsCompleted = 0;

  for (let round = 1; round <= cfg.maxRounds; round++) {
    if (aborted() || timeExceeded()) break;
    roundsCompleted = round;
    emit({ phase: 'searching', round });

    let queries = await generateQueries(question, report, round, plan, queriesUsed, cfg).catch(() => []);
    // Safety net for weak local models that never emit a clean query list: on
    // the first round, fall back to searching the question itself so research
    // still gathers something instead of returning "no information".
    if (!queries.length && round === 1 && !queriesUsed.has(question)) {
      queries = [question];
      queriesUsed.add(question);
    }
    if (!queries.length) break;
    emit({ phase: 'searching', round, queryPreview: queries[0], queries: queries.length });

    const roundFindings = await searchAndExtract(queries, question, {
      cfg,
      urlsFetched,
      analyzedUrls,
      signal,
      emit,
      onError: (e) => (lastSearchError = e)
    });

    if (roundFindings.length) {
      findings.push(...roundFindings);
      emptyRounds = 0;
      emit({ phase: 'reading', round, newSources: roundFindings.length, totalFindings: findings.length });
    } else {
      emptyRounds++;
      if (emptyRounds >= cfg.maxEmptyRounds) {
        const detail = lastSearchError || 'no results from the search provider';
        emit({ phase: 'error', message: `Search unavailable: ${detail}` });
        if (!findings.length) {
          const failure =
            `**Search unavailable** — Web search failed after ${roundsCompleted} round(s). ` +
            `Error: ${detail}\n\nPlease check your search provider settings and ensure the service is running.`;
          return {
            report: failure,
            summary: failure,
            findings: [],
            analyzedUrls: [],
            stats: statsFor(roundsCompleted)
          };
        }
        break;
      }
    }

    if (findings.length) {
      emit({ phase: 'analyzing', round, totalFindings: findings.length });
      report = await synthesize(question, findings, report, cfg);
    }

    if (round >= cfg.minRounds) {
      const stop = await shouldStop(question, report, round, cfg.maxRounds, cfg);
      if (stop) break;
    }
  }

  emit({ phase: 'writing' });

  if (!report && !findings.length) {
    const none = 'No information could be gathered for this question.';
    return { report: none, summary: none, findings: [], analyzedUrls: [], stats: statsFor(roundsCompleted) };
  }

  const final = report ? await finalReport(question, report, cfg).catch(() => report) : fallbackReport(question, findings);
  emit({ phase: 'summarizing' });
  const summary = await summarize(question, final, cfg);
  return { report: final, summary, findings, analyzedUrls, stats: statsFor(roundsCompleted) };
}

module.exports = { research };
