'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// Point every setup path at a temp folder before the modules load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leslie-setup-test-'));
process.env.XDG_CONFIG_HOME = path.join(tmp, 'config');
process.env.XDG_DATA_HOME = path.join(tmp, 'data');

const hardware = require('../src/main/setup/hardware');
const catalog = require('../src/main/setup/catalog');
const packages = require('../src/main/setup/packages');
const persona = require('../src/main/setup/persona');
const state = require('../src/main/setup/state');
const { download } = require('../src/main/setup/download');
const { Runner, settingsFor } = require('../src/main/setup/tasks');
const { defaultChoices } = require('../src/main/setup/recommend');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeDrm(cards) {
  const drm = fs.mkdtempSync(path.join(tmp, 'drm-'));
  cards.forEach(({ vendor, vramBytes }, i) => {
    const dev = path.join(drm, `card${i}`, 'device');
    fs.mkdirSync(dev, { recursive: true });
    fs.writeFileSync(path.join(dev, 'vendor'), `${vendor}\n`);
    if (vramBytes !== undefined) fs.writeFileSync(path.join(dev, 'mem_info_vram_total'), `${vramBytes}\n`);
  });
  fs.mkdirSync(path.join(drm, 'card0-HDMI-A-1'));
  return drm;
}

const noNvidia = async () => ({ ok: false, stdout: '' });
const nvidia = (rows) => async () => ({ ok: true, stdout: rows.join('\n') });
const GiB = 1024 ** 3;

test('detects an RTX 3060 and an RX 9060 XT, and picks Vulkan for the mix', async () => {
  const drm = fakeDrm([{ vendor: '0x10de' }, { vendor: '0x1002', vramBytes: 16 * GiB }]);
  const gpus = await hardware.detectGpus({ drm, queryNvidia: nvidia(['NVIDIA GeForce RTX 3060, 12288, 8.6, 580.95']) });
  assert.deepEqual(gpus.map((g) => [g.vendor, g.vramMiB]), [['nvidia', 12288], ['amd', 16384]]);
  assert.equal(hardware.chooseBuild(gpus), 'vulkan');
  assert.deepEqual(hardware.tiers(gpus), { everyday: 'medium', power: 'large' });
});

test('NVIDIA alone gets CUDA unless the driver is too old', async () => {
  const drm = fakeDrm([{ vendor: '0x10de' }]);
  const recent = await hardware.detectGpus({ drm, queryNvidia: nvidia(['NVIDIA GeForce RTX 4090, 24564, 8.9, 570.1']) });
  assert.equal(hardware.chooseBuild(recent), 'cuda-12.8');
  assert.equal(hardware.tiers(recent).everyday, 'large');
  const old = await hardware.detectGpus({ drm, queryNvidia: nvidia(['NVIDIA GeForce GTX 1060, 6144, 6.1, 470.2']) });
  assert.equal(hardware.chooseBuild(old), 'vulkan');
});

test('an NVIDIA card without its driver, and integrated graphics, fall back to the CPU', async () => {
  const drm = fakeDrm([{ vendor: '0x10de' }, { vendor: '0x8086' }, { vendor: '0x1002', vramBytes: 512 * 1024 * 1024 }]);
  const gpus = await hardware.detectGpus({ drm, queryNvidia: noNvidia });
  assert.ok(gpus.find((g) => g.vendor === 'nvidia').driverMissing);
  assert.ok(gpus.filter((g) => g.vendor !== 'nvidia').every((g) => g.integrated));
  assert.equal(hardware.chooseBuild(gpus), 'cpu');
  assert.deepEqual(hardware.tiers(gpus), { everyday: 'cpu', power: null });
});

test('AMD uses ROCm only when ROCm is installed', async () => {
  const gpus = await hardware.detectGpus({ drm: fakeDrm([{ vendor: '0x1002', vramBytes: 8 * GiB }]), queryNvidia: noNvidia });
  assert.equal(hardware.chooseBuild(gpus), 'vulkan');
  assert.equal(hardware.chooseBuild(gpus, { rocm: true }), 'rocm');
  assert.equal(hardware.tiers(gpus).everyday, 'small');
});

const LISTING = `WARNING: radv is not a conformant Vulkan implementation, testing use only.
Available devices:
  CUDA0: NVIDIA GeForce RTX 3060 (11962 MiB, 1226 MiB free)
  Vulkan0: AMD Radeon RX 9060 XT (RADV GFX1200) (16304 MiB, 14589 MiB free)
  Vulkan1: NVIDIA GeForce RTX 3060 (12288 MiB, 1226 MiB free)
`;

test('a GPU listed once per backend counts once, keeping the native backend', () => {
  const devices = hardware.parseListDevices(LISTING);
  assert.deepEqual(devices.map((d) => d.id), ['CUDA0', 'Vulkan0', 'Vulkan1']);
  assert.deepEqual(hardware.physicalDevices(devices).map((d) => d.id), ['CUDA0', 'Vulkan0']);
  assert.deepEqual(hardware.profileDevices(devices), { everyday: 'Vulkan0', power: 'CUDA0,Vulkan0' });
});

test('two identical cards on one backend both stay', () => {
  const devices = hardware.parseListDevices('  CUDA0: NVIDIA GeForce RTX 3060 (12288 MiB, 12000 MiB free)\n  CUDA1: NVIDIA GeForce RTX 3060 (12288 MiB, 12000 MiB free)\n');
  assert.deepEqual(hardware.profileDevices(devices), { everyday: 'CUDA0', power: 'CUDA0,CUDA1' });
});

test('one GPU gets no Power device list, and no GPU leaves both blank', () => {
  assert.deepEqual(hardware.profileDevices(hardware.parseListDevices('  Vulkan0: AMD Radeon (8176 MiB, 8000 MiB free)\n')), { everyday: 'Vulkan0', power: '' });
  assert.deepEqual(hardware.profileDevices([]), { everyday: '', power: '' });
});

test('every tier recommends exactly one model, and the catalog files are complete', () => {
  for (const tier of catalog.TIERS) {
    assert.equal(catalog.forTier(tier).filter((m) => m.recommended).length, 1, tier);
    assert.ok(catalog.forTier(tier)[0].recommended, `${tier} lists its recommendation first`);
  }
  for (const m of catalog.models) {
    for (const f of m.files) assert.match(f.sha256, /^[0-9a-f]{64}$/, `${m.id} ${f.name}`);
  }
  assert.deepEqual(catalog.profileFor('Qwen3.5-27B-Q4_K_M', 'large'), { model: 'Qwen3.5-27B-Q4_K_M', ctx: 65536, cacheType: 'q8_0' });
});

test('default choices: a two-GPU desk gets Everyday and a bigger Power model; a laptop gets one CPU model', async () => {
  const desk = defaultChoices(await hardware.detectGpus({
    drm: fakeDrm([{ vendor: '0x10de' }, { vendor: '0x1002', vramBytes: 16 * GiB }]),
    queryNvidia: nvidia(['NVIDIA GeForce RTX 3060, 12288, 8.6, 580.95'])
  }));
  assert.equal(desk.everyday, 'Qwen3.5-9B-Q4_K_M');
  assert.equal(desk.power, 'Qwen3.5-27B-Q4_K_M');
  assert.deepEqual(desk.speech, { enabled: true, runtime: 'cuda' });

  const laptop = defaultChoices(await hardware.detectGpus({ drm: fakeDrm([{ vendor: '0x8086' }]), queryNvidia: noNvidia }));
  assert.equal(laptop.engine.build, 'cpu');
  assert.equal(laptop.everyday, 'Qwen3.5-4B-Q4_K_M');
  assert.equal(laptop.power, '');
  assert.equal(laptop.speech.runtime, 'cpu');
});

test('distro families and their install commands', () => {
  const fam = (text) => packages.family(packages.parseOsRelease(text));
  assert.equal(fam('ID=arch\n'), 'arch');
  assert.equal(fam('ID=cachyos\nID_LIKE=arch\n'), 'arch');
  assert.equal(fam('ID=ubuntu\nID_LIKE=debian\n'), 'debian');
  assert.equal(fam('ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n'), 'suse');
  assert.equal(fam('ID=nixos\n'), null);
  assert.deepEqual(packages.installCommand('arch', ['grim']), ['pacman', '-S', '--needed', '--noconfirm', 'grim']);
  assert.equal(packages.installCommand(null, ['grim']), null);
});

test('persona presets become system prompts that use the name', () => {
  assert.match(persona.systemPrompt({ preset: 'butler', name: 'Josh', address: 'sir' }), /butler.*name is Josh.*"sir"/s);
  assert.match(persona.systemPrompt({ preset: 'friendly' }), /first name when you know it/);
  assert.equal(persona.systemPrompt({ preset: 'custom', custom: '  Be terse.  ' }), 'Be terse.');
});

test('settings follow the choices: managed server, speech server, camera', () => {
  const base = { engine: { mode: 'download' }, speech: { enabled: true }, vision: { enabled: false }, settings: { searxngUrl: 'http://x' } };
  assert.deepEqual(settingsFor(base), {
    searxngUrl: 'http://x', serverManaged: true, sttBackend: 'server', sttServerUrl: 'http://127.0.0.1:8178/v1', cameraEnabled: false
  });
  const remote = settingsFor({ ...base, engine: { mode: 'remote', url: 'http://box:8080/v1' }, speech: { enabled: false } });
  assert.equal(remote.serverManaged, false);
  assert.equal(remote.baseURL, 'http://box:8080/v1');
  assert.equal(remote.sttBackend, 'local');
});

test('the runner follows dependencies, blocks on failures and skips work already done', async () => {
  const order = [];
  const task = (id, deps = [], opts = {}) => ({ id, label: id, deps, optional: false, key: 'k', run: async () => { order.push(id); if (opts.fail) throw new Error(`${id} broke`); }, ...opts });
  const tasks = [task('a'), task('b', ['a']), task('c', ['b'], { fail: true }), task('d', ['c']), task('e', ['x'], { optional: true, fail: true }), task('f', ['e'])];
  fs.rmSync(state.file(), { force: true });
  const first = await new Runner(tasks).runAll();
  assert.equal(first.ok, false);
  assert.ok(order.indexOf('a') < order.indexOf('b'), 'b waits for a');
  assert.equal(first.outcomes.d.status, 'blocked');
  assert.equal(first.outcomes.f.status, 'done', 'a failed optional task does not block');

  order.length = 0;
  const again = await new Runner(tasks.map((t) => ({ ...t, fail: false, run: async () => order.push(t.id) }))).runAll();
  assert.equal(again.ok, true);
  assert.deepEqual(order.sort(), ['c', 'd', 'e'], 'finished tasks are skipped');

  order.length = 0;
  await new Runner(tasks.map((t) => ({ ...t, run: async () => order.push(t.id) })), { force: ['a'] }).runAll(['a']);
  assert.deepEqual(order, ['a']);
});

test('downloads resume from a .part file and check the sha256', async () => {
  const body = crypto.randomBytes(300000);
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  let ranges = 0;
  const srv = http.createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (m) {
      ranges += 1;
      const from = Number(m[1]);
      res.writeHead(206, { 'Content-Length': body.length - from, 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` });
      return res.end(body.subarray(from));
    }
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/f`;
  try {
    const dest = path.join(tmp, 'dl', 'model.gguf');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(`${dest}.part`, body.subarray(0, 100000));
    assert.equal(await download(url, dest, { bytes: body.length, sha256: sha }), 'downloaded');
    assert.equal(ranges, 1);
    assert.deepEqual(fs.readFileSync(dest), body);
    assert.equal(await download(url, dest, { bytes: body.length, sha256: sha }), 'present');

    const bad = path.join(tmp, 'dl', 'bad.gguf');
    await assert.rejects(download(url, bad, { bytes: body.length, sha256: '0'.repeat(64) }), /checksum/);
    assert.equal(fs.existsSync(bad) || fs.existsSync(`${bad}.part`), false);
  } finally {
    srv.close();
  }
});

test('a cloud model points pi at provider/model and keeps the key out of the task keys', () => {
  const c = { engine: { mode: 'cloud', provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-secret' }, speech: { enabled: false }, settings: {} };
  const s = settingsFor(c);
  assert.equal(s.piModel, 'anthropic/claude-sonnet-4-5');
  assert.equal(s.cloudProvider, 'anthropic');
  assert.equal(s.cloudApiKey, 'sk-secret');
  assert.equal(s.serverManaged, false);
  const { buildTasks } = require('../src/main/setup/tasks');
  const tasks = buildTasks({ ...c, everyday: '', power: '', tiers: {}, packages: [], vision: { enabled: false } }, { setSettings() {} });
  assert.deepEqual(tasks.map((t) => t.id), ['settings'], 'no engine, models or router for a cloud model');
  assert.ok(!JSON.stringify(tasks.map((t) => t.key)).includes('sk-secret'));
});
