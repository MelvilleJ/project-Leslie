#!/usr/bin/env node
'use strict';

// Scores helper Leslies on look-ups with known, stable answers. Each case runs
// as a real helper through the running LESLIE (its bridge runs the tools and
// sets the helper's instructions), so this measures the installed build.
//
//   node scripts/helper-eval.js [--out results.json] [--only 1,4]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { applyEvent, MAX_TURNS } = require('../src/main/helpers');
const { verifyReport } = require('../src/main/helperReport');
const llama = require('../src/main/server/llamaServer');

// `trap`: a common wrong answer; an answer containing it counts as wrong.
const CASES = [
  { task: 'Find the date the Linux kernel 6.0 was released.', expect: /2 october 2022|october 2,? 2022|2022-10-02/i },
  { task: 'Find the release date of Python 3.12.0.', expect: /2 october 2023|october 2,? 2023|2023-10-02/i },
  { task: 'Find the date Rust 1.0 was released.', expect: /15 may 2015|may 15,? 2015|2015-05-15/i },
  // nodejs.org lists Apr 17, 2023; the GitHub release is stamped 2023-04-18 (UTC).
  { task: 'Find the date Node.js 20 was first released.', expect: /1[78] april 2023|april 1[78],? 2023|2023-04-1[78]/i },
  { task: 'Find the default TCP port Redis listens on.', expect: /\b6379\b/ },
  { task: 'Find the default page size of a new SQLite database, in bytes.', expect: /\b4096\b|\b4,096\b/, trap: /\b1,?024\b/ },
  { task: 'Find the number of the current IETF RFC that defines the JSON data interchange format.', expect: /\b8259\b/ },
  { task: 'Find the year Arch Linux had its first release.', expect: /\b2002\b/ },
  { task: 'Find the date of the first release of Git.', expect: /7 april 2005|april 7,? 2005|2005-04-07/i },
  { task: 'Find what the HTTP status code 418 means.', expect: /teapot/i }
];

const SLOTS = 3;
const TIMEOUT_MS = 5 * 60000;
const TOOLS = 'read,grep,find,ls,web_search,deep_search,read_document,doc_list,doc_read,read_page,report';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

function launchInfo() {
  const pid = execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', 'leslie'], { encoding: 'utf8' }).trim();
  if (!pid || pid === '0') throw new Error('LESLIE is not running (systemctl --user start leslie).');
  const appDir = path.dirname(fs.readlinkSync(`/proc/${pid}/exe`));
  return {
    extension: path.join(appDir, 'resources', 'app.asar.unpacked', 'src', 'pi-extension', 'leslie.ts'),
    env: {
      ...process.env,
      LESLIE_BRIDGE: path.join(os.tmpdir(), `leslie-pi-${pid}.sock`),
      LESLIE_PI_MANIFEST: path.join(os.homedir(), '.config', 'project-leslie', 'pi-manifest.json')
    }
  };
}

function runCase(c, index, launch, model) {
  return new Promise((resolve) => {
    const h = { id: `eval-${index}`, turns: 0, state: 'starting', step: '', output: '', error: null, sources: [] };
    const started = Date.now();
    const proc = spawn('pi', ['--mode', 'json', '-p', '--no-session', '--extension', launch.extension, '--model', `llama.cpp/${model}`, '--tools', TOOLS, c.task], {
      cwd: os.homedir(),
      env: { ...launch.env, LESLIE_HELPER: h.id },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => {
      h.error = 'timeout';
      proc.kill('SIGTERM');
    }, TIMEOUT_MS);
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const outcome = applyEvent(h, ev);
        if (outcome === 'finished') proc.kill('SIGTERM');
        if (outcome === 'too-many-turns') {
          h.error = `ran out of steps (${MAX_TURNS})`;
          proc.kill('SIGTERM');
        }
      }
    });
    proc.on('close', () => {
      clearTimeout(timer);
      const answer = h.report ? String(h.report.answer || '') : h.output;
      const check = h.report ? verifyReport(h.report, h.sources, c.task) : null;
      resolve({
        task: c.task,
        // A trap is a known wrong answer; only the opening sentence counts, so "changed from 1024" is fine.
        correct: c.expect.test(answer) && !(c.trap && c.trap.test(answer.split(/(?<=[.!?])\s/)[0])),
        answer: answer.slice(0, 300),
        verdict: check ? check.verdict : 'no report',
        evidence: check ? check.evidence : [],
        report: h.report,
        sources: h.sources,
        turns: h.turns,
        seconds: Math.round((Date.now() - started) / 1000),
        error: h.error
      });
    });
  });
}

async function main() {
  const only = arg('--only') ? new Set(arg('--only').split(',').map(Number)) : null;
  const cases = CASES.map((c, i) => ({ ...c, n: i + 1 })).filter((c) => !only || only.has(c.n));
  const launch = launchInfo();
  const model = await llama.loadHelper((t) => process.stderr.write(`${t}\n`));

  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SLOTS, cases.length) }, async () => {
      while (next < cases.length) {
        const c = cases[next++];
        const r = await runCase(c, c.n, launch, model);
        results[cases.indexOf(c)] = { n: c.n, ...r };
        console.log(`${String(c.n).padStart(2)} ${r.correct ? 'RIGHT' : 'WRONG'} ${r.verdict.padEnd(10)} ${String(r.seconds).padStart(3)}s  ${r.answer.replace(/\s+/g, ' ').slice(0, 90)}${r.error ? `  [${r.error}]` : ''}`);
      }
    })
  );

  const count = (f) => results.filter(f).length;
  console.log(
    `\nright ${count((r) => r.correct)}/${results.length}` +
      ` · verified ${count((r) => r.verdict === 'verified')}` +
      ` · wrong but verified ${count((r) => !r.correct && r.verdict === 'verified')}` +
      ` · errors ${count((r) => r.error)}`
  );
  if (arg('--out')) fs.writeFileSync(arg('--out'), `${JSON.stringify(results, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
