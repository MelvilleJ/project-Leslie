'use strict';

const config = require('../config');
const memory = require('../memory');

const RECENT_MESSAGES = 6;

const EXTRACT_SYSTEM = [
  'You extract durable, reusable facts about the USER from a conversation, for a',
  'desktop assistant\'s long-term memory. Output ONLY a JSON array of short',
  'third-person statements (strings). Include a fact ONLY if it is a lasting',
  'preference or trait worth recalling in future sessions — name, preferred units,',
  'language, tone, recurring interests, profession, how they like answers.',
  'EXCLUDE one-off task details, transient context, and anything already known.',
  'If there is nothing new worth saving, output []. No prose, just the JSON array.'
].join(' ');

function parseArray(text) {
  if (!text) return [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function chatOnce(messages) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const res = await fetch(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: false,
      temperature: 0,
      max_tokens: 256
    })
  });
  if (!res.ok) throw new Error(`extract HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * Inspect the recent conversation and save any new durable preferences.
 * @param {{role:string, content:string}[]} history full conversation history
 * @returns {Promise<number>} how many new memories were saved
 */
async function extractMemories(history) {
  if (!config.learningMode) return 0;
  const recent = (history || []).filter((m) => m.role === 'user' || m.role === 'assistant').slice(-RECENT_MESSAGES);
  if (!recent.length) return 0;

  const known = memory.format() || '(nothing remembered yet)';
  const transcript = recent.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  const messages = [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: `Already known:\n${known}\n\nRecent conversation:\n${transcript}\n\nReturn the JSON array of NEW facts.` }
  ];

  const content = await chatOnce(messages);
  let saved = 0;
  for (const text of parseArray(content)) {
    if (memory.add(text, 'auto')) saved++;
  }
  return saved;
}

module.exports = { extractMemories };
