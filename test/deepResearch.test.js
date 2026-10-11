'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/main/config');

const OUT = {
  report: '# Findings\n\nSolar is **cheaper** than coal, per [IEA](https://iea.org/report).',
  findings: [{ url: 'https://iea.org/report', title: 'IEA World Energy Outlook', summary: 'Costs of solar fell sharply since 2010.' }],
  stats: { elapsedMs: 42000, rounds: 3, queries: 6, urls: 5 }
};

// Swap in a researcher that returns a fixed result instead of hitting the web.
require.cache[require.resolve('../src/main/tools/lib/deepResearch/researcher')] = {
  exports: { research: async () => OUT }
};
const deepResearch = require('../src/main/tools/deepResearch');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leslie-research-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function setup(overrides = {}) {
  Object.assign(config, { docsDir: tmp, docsAutoOpen: false, planMode: false, ...overrides });
}

const savedFiles = () => fs.readdirSync(tmp).filter((f) => f.startsWith('Research - solar vs coal'));

test('without save_as nothing is written', async () => {
  setup();
  const result = await deepResearch.run({ query: 'solar vs coal' });
  assert.match(result, /Solar is \*\*cheaper\*\*/);
  assert.match(result, /Research complete/);
  assert.deepEqual(savedFiles(), []);
});

test('save_as md keeps the markdown and sources, without the note to the model', async () => {
  setup();
  const result = await deepResearch.run({ query: 'solar vs coal', save_as: 'md' });
  const [file] = savedFiles().filter((f) => f.endsWith('.md'));
  assert.ok(file, 'markdown file saved');
  assert.match(result, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const text = fs.readFileSync(path.join(tmp, file), 'utf8');
  assert.match(text, /\*\*cheaper\*\*/);
  assert.match(text, /- \[IEA World Energy Outlook\]\(https:\/\/iea\.org\/report\)/);
  assert.doesNotMatch(text, /Research complete/);
});

test('save_as docx and pdf write real documents', async () => {
  setup();
  for (const format of ['docx', 'pdf']) {
    await deepResearch.run({ query: 'solar vs coal', save_as: format });
    const file = savedFiles().find((f) => f.endsWith(`.${format}`));
    assert.ok(file, `${format} saved`);
    assert.ok(fs.statSync(path.join(tmp, file)).size > 500, `${format} has content`);
  }
});

test('html output spells links out instead of raw markdown', async () => {
  setup();
  await deepResearch.run({ query: 'solar vs coal', save_as: 'html' });
  const html = fs.readFileSync(path.join(tmp, savedFiles().find((f) => f.endsWith('.html'))), 'utf8');
  assert.match(html, /Solar is cheaper than coal, per IEA \(https:\/\/iea\.org\/report\)/);
  assert.doesNotMatch(html, /\*\*|\]\(/);
});

test('plan mode never writes the file', async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp);
  setup({ planMode: true });
  const result = await deepResearch.run({ query: 'solar vs coal', save_as: 'docx' });
  assert.match(result, /Not saved: plan mode/);
  assert.deepEqual(savedFiles(), []);
});
