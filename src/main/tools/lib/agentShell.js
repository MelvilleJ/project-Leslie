'use strict';

const { exec } = require('node:child_process');
const config = require('../../config');

const DENY_WINDOWS = [
  /\bformat\b/i,
  /\brmdir\s+\/s/i,
  /\brd\s+\/s/i,
  /\bdel\s+\/[a-z]*q/i,
  /Remove-Item\b[^\n]*-Recurse/i,
  /\bdiskpart\b/i,
  /\breg\s+delete\b/i,
  /\bRestart-Computer\b/i,
  /\bStop-Computer\b/i
];

const DENY_LINUX = [
  /\brm\s+-[a-z]*r/i,
  /\bdd\b/i,
  /\bmkfs\b/i,
  /\bfdisk\b/i,
  /\bparted\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i
];

const DENY_COMMON = [/\bshutdown\b/i, /\breboot\b/i];

function getDenyPatterns() {
  const os = config.osTarget === 'linux' ? DENY_LINUX : DENY_WINDOWS;
  return [...DENY_COMMON, ...os];
}

function getEffectiveShell() {
  if (config.agentShell) return config.agentShell;
  return config.osTarget === 'linux' ? 'bash' : 'powershell';
}

function getEffectiveAllowlist() {
  if (config.agentAllowlist) return config.agentAllowlist;
  if (config.osTarget !== 'linux') {
    return ['winget install', 'winget search', 'winget upgrade', 'winget list', 'winget show'];
  }
  switch (config.linuxDistro) {
    case 'fedora': return ['dnf install', 'dnf search', 'dnf list', 'dnf info'];
    case 'arch': return ['pacman -s', 'pacman -ss', 'pacman -q', 'pacman -si', 'pacman -syu'];
    default: return ['apt install', 'apt-get install', 'apt search', 'apt list', 'apt show'];
  }
}

/** True if `command` may run without asking the user. */
function isAllowed(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (getDenyPatterns().some((re) => re.test(cmd))) return false;
  const lower = cmd.toLowerCase();
  return getEffectiveAllowlist().some((prefix) => lower.startsWith(prefix));
}

// Commands that only open or close applications. Assistant mode runs these
// without asking; they must be a single command (no chaining, pipes or
// substitution) and still pass the deny list.
const APP_CONTROL = new Set(['pkill', 'killall', 'kill', 'gtk-launch', 'xdg-open', 'steam']);

function isAppControl(command) {
  let cmd = String(command || '').trim();
  if (!cmd || getDenyPatterns().some((re) => re.test(cmd))) return false;
  // Allow the usual "detach and silence" wrapping around a launch.
  cmd = cmd
    .replace(/^(nohup|setsid)\s+/, '')
    .replace(/\s*(>\s*\/dev\/null)?\s*(2>&1|2>\s*\/dev\/null)?\s*&?\s*$/, '')
    .trim();
  if (/[;&|<>`\n]|\$\(/.test(cmd)) return false;
  const [bin, sub] = cmd.split(/\s+/);
  if (bin === 'flatpak') return sub === 'run' || sub === 'kill';
  return APP_CONTROL.has(bin);
}

/**
 * Decide whether `command` is cleared to run. Allowlisted commands pass
 * immediately, as do open/close-app commands in assistant mode; anything else
 * asks the user through ctx.confirm and resolves to their choice. Returns false
 * if there's no way to ask (no confirm channel).
 */
async function gate(command, ctx, explanation) {
  if (isAllowed(command)) return true;
  if (config.taskMode && isAppControl(command)) return true;
  if (!ctx || typeof ctx.confirm !== 'function') return false;
  const lines = ['LESLIE wants to run this command:', '', command];
  if (explanation) lines.push('', explanation);
  return ctx.confirm(lines.join('\n'));
}

/**
 * Run a shell command, capturing stdout+stderr. Never rejects on a non-zero
 * exit — it reports the code so the model can react instead of throwing.
 */
function execShell(command) {
  return new Promise((resolve) => {
    exec(
      command,
      {
        shell: getEffectiveShell(),
        timeout: config.agentTimeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        const combined = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();
        let output = combined || '(no output)';
        if (output.length > config.agentMaxOutput) {
          output = `${output.slice(0, config.agentMaxOutput)}\n…(truncated)`;
        }
        let exitCode = 0;
        if (err) exitCode = typeof err.code === 'number' ? err.code : 1;
        if (err && err.killed) output = `(timed out after ${config.agentTimeoutMs}ms)\n${output}`;
        resolve({ exitCode, output });
      }
    );
  });
}

module.exports = { isAllowed, isAppControl, gate, execShell };
