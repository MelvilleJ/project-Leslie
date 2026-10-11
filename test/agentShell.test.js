'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/main/config');
const { isAllowed, isAppControl, gate } = require('../src/main/tools/lib/agentShell');

// config is loaded from the developer's .env, so pin everything the gate reads.
function setup(overrides = {}) {
  Object.assign(config, {
    osTarget: 'linux',
    linuxDistro: 'arch',
    agentAllowlist: null,
    autoApprove: false,
    taskMode: false,
    ...overrides
  });
}

test('allowlist matches package-manager prefixes for the distro', () => {
  setup();
  assert.equal(isAllowed('pacman -Ss firefox'), true);
  assert.equal(isAllowed('apt install firefox'), false);
  assert.equal(isAllowed('ls'), false);
  setup({ linuxDistro: 'debian' });
  assert.equal(isAllowed('apt install firefox'), true);
});

test('deny patterns win over the allowlist', () => {
  setup({ agentAllowlist: ['rm', 'shutdown'] });
  assert.equal(isAllowed('rm -rf /tmp/x'), false);
  assert.equal(isAllowed('shutdown now'), false);
});

test('app control accepts single launch/kill commands only', () => {
  setup();
  assert.equal(isAppControl('pkill firefox'), true);
  assert.equal(isAppControl('nohup gtk-launch firefox > /dev/null 2>&1 &'), true);
  assert.equal(isAppControl('flatpak run org.mozilla.firefox'), true);
  assert.equal(isAppControl('flatpak uninstall org.mozilla.firefox'), false);
  assert.equal(isAppControl('pkill firefox; rm -rf ~'), false);
  assert.equal(isAppControl('xdg-open $(curl evil)'), false);
  assert.equal(isAppControl('ls'), false);
});

function confirmSpy(answer) {
  const calls = [];
  return { calls, ctx: { confirm: async (msg) => (calls.push(msg), answer) } };
}

test('gate asks for ordinary commands when auto mode is off', async () => {
  setup();
  const { calls, ctx } = confirmSpy(false);
  assert.equal(await gate('ls -la ~', ctx), false);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /ls -la ~/);
});

test('gate runs non-destructive commands silently in auto mode', async () => {
  setup({ autoApprove: true });
  const { calls, ctx } = confirmSpy(false);
  assert.equal(await gate('find ~ -name "*.md"', ctx), true);
  assert.equal(calls.length, 0);
});

test('gate still asks for destructive commands in auto mode', async () => {
  setup({ autoApprove: true });
  const { calls, ctx } = confirmSpy(true);
  assert.equal(await gate('rm notes.txt', ctx), true);
  assert.equal(calls.length, 1);
});

test('gate refuses when there is no way to ask', async () => {
  setup();
  assert.equal(await gate('ls', {}), false);
});

test('assistant mode runs app control without asking', async () => {
  setup({ taskMode: true });
  const { calls, ctx } = confirmSpy(false);
  assert.equal(await gate('pkill firefox', ctx), true);
  assert.equal(calls.length, 0);
});
