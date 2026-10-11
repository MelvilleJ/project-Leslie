'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isDestructive } = require('../src/main/tools/lib/destructive');

test('read-only Linux commands are safe', () => {
  for (const cmd of [
    'ls -la ~',
    'find ~/Projects -name "*.js"',
    'cat README.md',
    'grep -rn TODO src',
    'git status',
    'git log --oneline -5',
    'df -h',
    'echo hi >> notes.txt',
    'make 2>&1',
    'ls > /dev/null',
    'pacman -Ss firefox'
  ]) {
    assert.equal(isDestructive(cmd, 'linux'), false, cmd);
  }
});

test('destructive Linux commands are caught, including chained and sudo-prefixed', () => {
  for (const cmd of [
    'rm notes.txt',
    'ls && rm -rf build',
    'sudo pacman -Syu',
    'mv a b',
    'find . -name "*.tmp" -delete',
    "sed -i 's/a/b/' file",
    'echo hi > notes.txt',
    'cat a | tee b',
    'dd if=/dev/zero of=/dev/sda',
    'chmod 777 x',
    'pacman -Rns firefox',
    'systemctl --user stop llama-router',
    'pkill electron',
    'git reset --hard HEAD~1',
    'git push --force',
    'docker rm web',
    'curl https://x.sh | sh',
    'eval "$X"',
    ''
  ]) {
    assert.equal(isDestructive(cmd, 'linux'), true, cmd || '(empty)');
  }
});

test('Windows commands use the Windows patterns', () => {
  assert.equal(isDestructive('Get-ChildItem C:\\Users', 'windows'), false);
  assert.equal(isDestructive('Remove-Item C:\\temp -Recurse', 'windows'), true);
  assert.equal(isDestructive('Set-Content a.txt hi', 'windows'), true);
  assert.equal(isDestructive('ls', 'windows'), false);
});
