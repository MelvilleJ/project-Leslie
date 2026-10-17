'use strict';

// Prompts for the deep_research engine, ported from odysseus's
// src/deep_research.py (RESEARCH_PLAN_PROMPT, QUERY_GEN_PROMPT, etc).

/**
 * Preamble that grounds planning/query-generation LLMs in the real current
 * date. Without it, a local model falls back to its training-cutoff year and
 * emits queries like "best X 2024" when the year is actually later.
 */
function dateContext() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const iso = now.toISOString().slice(0, 10);
  const year = String(now.getFullYear());
  return (
    `Today's date is ${dateStr} (${iso}). When a search query needs a year or refers to ` +
    `'latest'/'current'/'this year', use ${year} or relative wording — never a year inferred ` +
    `from training data.\n\n`
  );
}

function researchPlan(question) {
  return `You are a research strategist. Before searching, analyze this question and create a research plan.

**Question:** ${question}

Break this question down:
1. What are the key sub-topics that need to be covered for a comprehensive answer?
2. What specific data points, facts, or perspectives should we look for?
3. What would a complete, high-quality answer include?

Return a JSON object with:
- "sub_questions": Array of 3-6 specific sub-questions to investigate
- "key_topics": Array of key topics/angles to cover
- "success_criteria": One sentence describing what a complete answer looks like

Example:
{"sub_questions": ["What is the cost of living in X?", "How is the healthcare system?"], "key_topics": ["economy", "healthcare"], "success_criteria": "A balanced comparison covering cost, quality of life, and practical considerations."}
`;
}

function queryGen({ question, researchPlan: plan, report, round, numQueries, roundInstruction }) {
  return `You are a research assistant planning web searches.

**Original question:** ${question}

**Research plan:**
${plan}

**What we know so far:**
${report}

**Round:** ${round}

Generate ${numQueries} focused search queries that will help answer the question.
${roundInstruction}

Return ONLY a JSON array of query strings, nothing else.
Example: ["query one", "query two", "query three"]
`;
}

function extractor(goal) {
  return `You are extracting information relevant to this research goal: "${goal}"

Read the webpage content below and extract only what's relevant. Return a JSON object with:
- "summary": 2-4 sentence summary of the relevant information found (empty or "not relevant" if the page has nothing useful)
- "evidence": Key quotes, data points, or facts from the page that support the summary

Return ONLY the JSON object, nothing else.`;
}

function synthesize({ question, report, newFindings }) {
  return `You are updating an evolving research report.

**Original question:** ${question}

**Current report:**
${report}

**New findings from this round:**
${newFindings}

Integrate the new findings into the existing report. Produce an updated, well-organized report that answers the original question as completely as possible given all evidence so far. Remove redundancy, resolve contradictions, and maintain logical flow. Keep source URLs as inline citations where relevant.

Write only the updated report — no preamble or meta-commentary.`;
}

function stopDecision({ question, report, round, maxRounds }) {
  return `You are deciding whether a research report is comprehensive enough.

**Original question:** ${question}

**Current report:**
${report}

**Rounds completed:** ${round} of ${maxRounds}

Based on the report so far, do we have enough information to answer the question comprehensively? Consider:
- Are the key aspects of the question addressed?
- Are there obvious gaps or unanswered sub-questions?
- Is the evidence sufficient and from multiple sources?

If rounds completed is well below the target, prefer continuing unless the report is already exhaustive.

Reply with ONLY "YES" or "NO" followed by a brief one-sentence reason.
Example: "YES — The report covers all major aspects with evidence from multiple sources."
Example: "NO — We still lack information about the economic impact."`;
}

function finalReport({ question, report }) {
  return `Write a **long, detailed, comprehensive** research report answering this question:

**Question:** ${question}

**All collected evidence and analysis:**
${report}

Requirements:
- Write at MINIMUM 1000 words — this should be a thorough, well-researched article
- Use clear ## headings and ### subheadings to organize into logical sections
- Each section should have multiple detailed paragraphs, not just bullet points
- Synthesize and analyze the information — explain WHY things matter, draw comparisons, provide context
- Include specific data points, numbers, and statistics from the evidence
- Include source URLs as inline citations [like this](url)
- Note where sources agree and where they disagree
- Add a brief executive summary at the top
- End with a clear conclusion that directly answers the question
- Write in an engaging, informative style — not dry or robotic`;
}

function summary({ question, report }) {
  return `Summarize this research report for someone who asked: ${question}

${report}

Write 3-6 short markdown bullet points giving the direct answer and the key findings. Keep the numbers that matter. No heading, no preamble.`;
}

function expandRequest() {
  return (
    'This report is too brief. Please expand it significantly:\n' +
    '- Add detailed paragraphs for each section (not just bullet points)\n' +
    '- Include specific data, numbers, and comparisons from the evidence\n' +
    "- Explain context and significance — don't just list facts\n" +
    '- Use ## headings and ### subheadings\n' +
    '- Target at least 800 words\n' +
    'Write the full expanded report now.'
  );
}

module.exports = {
  dateContext,
  researchPlan,
  queryGen,
  extractor,
  synthesize,
  stopDecision,
  finalReport,
  summary,
  expandRequest
};
