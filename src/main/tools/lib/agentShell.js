'use strict';

// Shared plumbing for the agent-mode tools (run_command, install_software):
//   - isAllowed : does a command auto-run, or must the user approve it?
//   - gate      : enforce that decision via ctx.confirm (the bubble prompt)
//   - execShell : actually run the command, capturing output safely
//
// Everything here runs in the main process, so it has full child_process access.

const { exec } = require('node:child_process');
const config = require('../../config');

// Catastrophic patterns that ALWAYS require confirmation, even if they happen to
// match an allowlist prefix. Heuristic, case-insensitive — a backstop, not a
// security boundary (the real guard is that the user sees and approves commands).
const DENY_PATTERNS = [
  /\bformat\b/i,
  /\brmdir\s+\/s/i,
  /\brd\s+\/s/i,
  /\bdel\s+\/[a-z]*q/i,
  /Remove-Item\b[^\n]*-Recurse/i,
  /\bdiskpart\b/i,
  /\breg\s+delete\b/i,
  /\bshutdown\b/i,
  /\bRestart-Computer\b/i,
  /\bStop-Computer\b/i
];

/** True if `command` may run without asking the user. */
function isAllowed(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (DENY_PATTERNS.some((re) => re.test(cmd))) return false;
  const lower = cmd.toLowerCase();
  return config.agentAllowlist.some((prefix) => lower.startsWith(prefix));
}

/**
 * Decide whether `command` is cleared to run. Allowlisted commands pass
 * immediately; anything else asks the user through ctx.confirm and resolves to
 * their choice. Returns false if there's no way to ask (no confirm channel).
 * @param {string} command
 * @param {{ confirm?: (msg: string) => Promise<boolean> }} ctx
 * @param {string} [explanation] shown to the user alongside the command
 * @returns {Promise<boolean>}
 */
async function gate(command, ctx, explanation) {
  if (isAllowed(command)) return true;
  if (!ctx || typeof ctx.confirm !== 'function') return false;
  const lines = ['LESLIE wants to run this command:', '', command];
  if (explanation) lines.push('', explanation);
  return ctx.confirm(lines.join('\n'));
}

/**
 * Run a shell command, capturing stdout+stderr. Never rejects on a non-zero
 * exit — it reports the code so the model can react instead of throwing.
 * @param {string} command
 * @returns {Promise<{ exitCode: number, output: string }>}
 */
function execShell(command) {
  return new Promise((resolve) => {
    exec(
      command,
      {
        shell: config.agentShell,
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
        // err.code is the process exit code for normal failures; err.killed is
        // set when the timeout fired.
        let exitCode = 0;
        if (err) exitCode = typeof err.code === 'number' ? err.code : 1;
        if (err && err.killed) output = `(timed out after ${config.agentTimeoutMs}ms)\n${output}`;
        resolve({ exitCode, output });
      }
    );
  });
}

module.exports = { isAllowed, gate, execShell };
