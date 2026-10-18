'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the module's config dir at a temp folder before it loads, so nothing
// touches the real ~/.config/project-leslie or llama-router presets.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leslie-test-'));
process.env.XDG_CONFIG_HOME = path.join(tmp, 'config');
const { loadSettings, writePresets } = require('../src/main/server/llamaServer');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fixture() {
  const modelsDir = path.join(tmp, `models-${Math.random().toString(36).slice(2)}`);
  const add = (rel) => {
    fs.mkdirSync(path.dirname(path.join(modelsDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(modelsDir, rel), '');
  };
  add('gpt-oss-20b-unsloth/gpt-oss-20b-UD-Q4_K_XL.gguf');
  add('Qwen3.8-27B-UD-Q4_K_M/Qwen3.8-27B-UD-Q4_K_M.gguf');
  add('Qwen3.8-27B-UD-Q4_K_M/mmproj-BF16.gguf');
  add('other-model/other-model.gguf');
  const defaults = loadSettings();
  const profiles = {
    everyday: { ...defaults.profiles.everyday, model: 'gpt-oss-20b-unsloth', devices: 'CUDA0', ctx: 65536 },
    power: {
      ...defaults.profiles.power,
      model: 'Qwen3.8-27B-UD-Q4_K_M',
      devices: 'CUDA0,Vulkan0',
      tensorSplit: '11,17',
      ctx: 131072,
      cacheType: 'q8_0'
    }
  };
  const helper = { ...defaults.helper, model: 'Qwen3.5-4B-Q6_K', devices: 'Vulkan0' };
  return { ...defaults, profiles, helper, modelsDir, presetsFile: path.join(modelsDir, 'presets.ini') };
}

const section = (text, id) => {
  const m = text.match(new RegExp(`^\\[${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^[]*`, 'm'));
  return m ? m[0] : null;
};

test('writes both profiles, with Everyday loaded on startup', () => {
  const settings = fixture();
  assert.equal(writePresets(settings), true);
  const text = fs.readFileSync(settings.presetsFile, 'utf8');
  assert.match(text, /^version = 1/);
  const everyday = section(text, 'gpt-oss-20b-unsloth');
  const power = section(text, 'Qwen3.8-27B-UD-Q4_K_M');
  assert.match(everyday, /load-on-startup = true/);
  assert.match(everyday, /device = CUDA0\n/);
  assert.doesNotMatch(power, /load-on-startup/);
  assert.match(power, /mmproj = .*mmproj-BF16\.gguf/);
  assert.match(power, /tensor-split = 11,17/);
  assert.match(power, /cache-type-k = q8_0/);
});

test("keeps sections that LESLIE doesn't own and is idempotent", () => {
  const settings = fixture();
  fs.writeFileSync(
    settings.presetsFile,
    'version = 1\n\n[*]\njinja = true\n\n[other-model]\nctx-size = 4096\n; my notes\n'
  );
  assert.equal(writePresets(settings), true);
  const text = fs.readFileSync(settings.presetsFile, 'utf8');
  assert.match(section(text, 'other-model'), /ctx-size = 4096\n; my notes/);
  assert.equal((text.match(/^\[\*\]/gm) || []).length, 1);
  assert.equal(writePresets(settings), false, 'second write changes nothing');
});

test('replaces its own stale sections instead of duplicating them', () => {
  const settings = fixture();
  writePresets(settings);
  settings.profiles = { ...settings.profiles, power: { ...settings.profiles.power, ctx: 32768 } };
  writePresets(settings);
  const text = fs.readFileSync(settings.presetsFile, 'utf8');
  assert.equal((text.match(/^\[Qwen3\.8-27B-UD-Q4_K_M\]/gm) || []).length, 1);
  assert.match(section(text, 'Qwen3.8-27B-UD-Q4_K_M'), /ctx-size = 32768/);
});

test('model presets cover models outside the profiles, but profiles win', () => {
  const settings = fixture();
  settings.modelPresets = {
    'other-model': { devices: 'Vulkan0', ctx: 8192, tensorSplit: '', cacheType: '', specType: '', cpuMoeLayers: null },
    'gpt-oss-20b-unsloth': { devices: 'Vulkan0', ctx: 1024, tensorSplit: '', cacheType: '', specType: '', cpuMoeLayers: null }
  };
  writePresets(settings);
  const text = fs.readFileSync(settings.presetsFile, 'utf8');
  assert.match(section(text, 'other-model'), /device = Vulkan0\nctx-size = 8192/);
  assert.match(section(text, 'gpt-oss-20b-unsloth'), /ctx-size = 65536/);
});

test('the helper model gets its own preset on the second GPU, with parallel slots', () => {
  const settings = fixture();
  fs.mkdirSync(path.join(settings.modelsDir, 'Qwen3.5-4B-Q6_K'));
  fs.writeFileSync(path.join(settings.modelsDir, 'Qwen3.5-4B-Q6_K', 'Qwen3.5-4B-Q6_K.gguf'), '');
  writePresets(settings);
  const helper = section(fs.readFileSync(settings.presetsFile, 'utf8'), 'Qwen3.5-4B-Q6_K');
  assert.match(helper, /device = Vulkan0\n/);
  assert.match(helper, /ctx-size = 98304\nparallel = 3/);
  assert.doesNotMatch(helper, /load-on-startup/);
});

test('a fresh install names no models or GPUs, and writes nothing for them', () => {
  const { profiles } = loadSettings();
  for (const p of Object.values(profiles)) {
    assert.equal(p.model, '');
    assert.equal(p.devices, '');
  }
  const settings = { ...fixture(), profiles };
  assert.equal(writePresets(settings), false);
  assert.equal(fs.existsSync(settings.presetsFile), false);
});

test('blank devices leave the device line out so llama.cpp uses every GPU', () => {
  const settings = fixture();
  settings.profiles.everyday = { ...settings.profiles.everyday, devices: '' };
  writePresets(settings);
  const everyday = section(fs.readFileSync(settings.presetsFile, 'utf8'), 'gpt-oss-20b-unsloth');
  assert.doesNotMatch(everyday, /^device =/m);
  assert.match(everyday, /ctx-size = 65536/);
});
