'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/main/config');
const { commandInPlan, writableInPlan } = require('../src/main/tools/lib/planGuard');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leslie-plan-'));
const docsDir = path.join(home, 'Documents', 'Leslie');
fs.mkdirSync(docsDir, { recursive: true });
Object.assign(config, { liveDocsEnabled: true, liveDocsDir: docsDir });

test('plan mode writes only top-level .md files in the live docs folder', () => {
  assert.ok(writableInPlan(path.join(docsDir, 'Plan.md')));
  assert.ok(writableInPlan('Documents/Leslie/Plan.md', home));
  assert.ok(!writableInPlan(path.join(docsDir, 'notes.txt')));
  assert.ok(!writableInPlan(path.join(docsDir, '.leslie', 'Plan.md')));
  assert.ok(!writableInPlan(path.join(docsDir, '..', 'Plan.md')));
  assert.ok(!writableInPlan(path.join(home, '.bashrc')));
  fs.symlinkSync(path.join(home, 'outside.md'), path.join(docsDir, 'Link.md'));
  assert.ok(!writableInPlan(path.join(docsDir, 'Link.md')), 'no symlinks out');
});

test('plan mode runs read-only commands', () => {
  for (const cmd of [
    'ls -la ~/.config',
    'cat /etc/os-release | grep NAME',
    'git log --oneline -5 && git status',
    'systemctl --user status leslie 2>&1 | head -20',
    'pacman -Qi firefox',
    'pacman -Ss neovim',
    'find . -name "*.js" -not -path "*/node_modules/*"',
    'grep -r "planMode" src 2>/dev/null',
    'cd ~/Projects && ls',
    'hyprctl monitors'
  ]) {
    assert.ok(commandInPlan(cmd, home), cmd);
  }
});

test('plan mode refuses commands that change things', () => {
  for (const cmd of [
    'rm -rf /tmp/x',
    'sudo pacman -S neovim',
    'pacman -Syu',
    'pacman -S neovim',
    'mkdir ~/new',
    'echo hi > ~/.bashrc',
    'echo hi >> /etc/hosts',
    'ls; touch x',
    'cat $(echo /etc/passwd)',
    'echo `whoami`',
    'find . -name x -delete',
    'find . -exec rm {} \;',
    'sort -o out.txt in.txt',
    'git commit -m x',
    'git diff --output=x.patch',
    'systemctl restart leslie',
    'journalctl --vacuum-time=1d',
    'ip link set eth0 down',
    'tee /etc/hosts',
    'PATH=/tmp ls',
    'xargs rm < list',
    'cd /tmp && echo x > Documents/Leslie/Plan.md',
    'cat <(ls)',
    'hyprctl dispatch exec kitty'
  ]) {
    assert.ok(!commandInPlan(cmd, home), cmd);
  }
});

test('plan mode may write live docs from the shell', () => {
  assert.ok(commandInPlan(`echo "# Plan" > ${docsDir}/Plan.md`, home));
  assert.ok(commandInPlan(`ls | tee -a ${docsDir}/Files.md`, home));
  assert.ok(commandInPlan(`cat > ${docsDir}/Plan.md << 'EOF'\n# Plan\n\n1. rm -rf old; $(not run)\nEOF`, home));
  assert.ok(!commandInPlan(`cat > ${docsDir}/Plan.md << EOF\n$(rm -rf ~)\nEOF`, home), 'unquoted heredoc expands');
  assert.ok(!commandInPlan(`cat > ${docsDir}/Plan.md << 'EOF'\nok\nEOF\nrm -rf ~`, home), 'commands after the heredoc are checked');
});

test('plan mode keeps doc tools and gated shell, drops the rest', (t) => {
  const policy = require('../src/main/pi/policy');
  const saved = { toolsEnabled: config.toolsEnabled, agentMode: config.agentMode, planMode: config.planMode, fsReadEnabled: config.fsReadEnabled };
  t.after(() => Object.assign(config, saved));
  Object.assign(config, { toolsEnabled: true, agentMode: false, planMode: true, fsReadEnabled: false });
  const active = policy.toolSelection().activeTools;
  for (const name of ['read', 'grep', 'bash', 'web_search', 'set_mode']) assert.ok(active.includes(name), `${name} on in plan mode`);
  for (const name of ['open_app', 'install_software', 'close_app', 'edit', 'write']) assert.ok(!active.includes(name), `${name} off in plan mode`);
});
