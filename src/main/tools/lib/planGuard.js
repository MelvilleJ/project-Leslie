'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../config');

// Plan mode may look at anything but change nothing, except markdown files in
// the live docs folder. Shell commands are lexed and every command in the line
// must be read-only; output may only be redirected to /dev/null or a doc.

const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'file', 'stat', 'du', 'df', 'free',
  'uname', 'whoami', 'id', 'hostname', 'hostnamectl', 'date', 'pwd', 'echo', 'printf', 'which', 'whereis',
  'type', 'realpath', 'readlink', 'basename', 'dirname', 'tree', 'sort', 'uniq', 'cut', 'tr', 'column',
  'jq', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'ps', 'pgrep', 'lsblk', 'lscpu', 'lsusb', 'lspci',
  'lsmod', 'ss', 'uptime', 'printenv', 'nproc', 'locale', 'fc-list', 'nvidia-smi', 'sensors', 'true', 'test',
  'tee'
]);

const SUBCOMMANDS = {
  git: ['status', 'log', 'diff', 'show', 'blame', 'ls-files', 'rev-parse', 'describe', 'shortlog'],
  systemctl: ['status', 'show', 'cat', 'list-units', 'list-unit-files', 'list-timers', 'is-active', 'is-enabled', 'is-failed'],
  hyprctl: ['clients', 'monitors', 'activewindow', 'workspaces', 'activeworkspace', 'devices', 'version', 'getoption', 'layers', 'binds'],
  npm: ['ls', 'list', 'view', 'outdated'],
  pip: ['list', 'show', 'freeze'],
  flatpak: ['list', 'info', 'search'],
  ip: ['addr', 'a', 'route', 'r', 'link', 'l']
};

// Flags that turn an otherwise read-only command into one that writes or runs things.
const FORBIDDEN_FLAGS = {
  git: /^--output/,
  find: /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/,
  sort: /^(-o|--output)/,
  tree: /^-o$/,
  journalctl: /^--(vacuum|rotate|flush|sync|relinquish)/,
  pacman: /^-(?!Q|S[si]+$|F[^y]*$)|^--(sync|remove|upgrade|database)/,
  ip: /^(add|del|delete|set|flush|change|replace)$/
};

const ALSO_READ_ONLY = ['find', 'journalctl', 'pacman'];

const REDIRECT = /^(\d*|&)(>>?|>\|)$/;

function home(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

function realDir(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True for a top-level .md file in the live docs folder (no symlinks out of it). */
function writableInPlan(target, cwd = os.homedir()) {
  if (!config.liveDocsEnabled || !target) return false;
  const abs = path.resolve(cwd, home(String(target)));
  if (path.extname(abs).toLowerCase() !== '.md' || path.basename(abs).startsWith('.')) return false;
  if (realDir(path.dirname(abs)) !== realDir(config.liveDocsDir)) return false;
  try {
    return !fs.lstatSync(abs).isSymbolicLink();
  } catch {
    return true;
  }
}

// Heredoc bodies are data, not commands: drop them, but a body bash expands
// (unquoted delimiter) must not hide a command substitution.
function stripHeredocs(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = lines[i].match(/<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/);
    if (!m) continue;
    const [, dash, quote, tag] = m;
    for (i++; i < lines.length; i++) {
      const line = dash ? lines[i].replace(/^\t+/, '') : lines[i];
      if (line === tag) break;
      if (!quote && /`|\$\(/.test(lines[i])) return null;
    }
  }
  return out.join('\n');
}

/** Splits a command line into words and operators; null when it can't be judged safely. */
function lex(src) {
  const tokens = [];
  let word = null;
  const push = () => {
    if (word !== null) tokens.push({ word });
    word = null;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return null;
      word = (word || '') + src.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let text = '';
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '`' || (src[j] === '$' && src[j + 1] === '(')) return null;
        if (src[j] === '\\') j++;
        text += src[j];
      }
      if (j >= src.length) return null;
      word = (word || '') + text;
      i = j;
    } else if (c === '\\') {
      word = (word || '') + (src[++i] || '');
    } else if (c === '`' || (c === '$' && src[i + 1] === '(') || ((c === '<' || c === '>') && src[i + 1] === '(')) {
      return null;
    } else if (/\s/.test(c) && c !== '\n') {
      push();
    } else if ('|&;\n<>'.includes(c)) {
      const fd = word !== null && /^\d+$/.test(word) && (c === '>' || c === '<') ? word : '';
      if (fd) word = null;
      push();
      const op = src.slice(i).match(/^(\|\||&&|&>>|&>|>>|>\||>&\d|<<<|<<|[|&;\n<>])/)[0];
      i += op.length - 1;
      tokens.push({ op: fd + op });
    } else {
      word = (word || '') + c;
    }
  }
  push();
  return tokens;
}

function commandAllowed(words, redirects, cwd) {
  if (!words.length) return redirects.length === 0;
  if (/^\w+=/.test(words[0])) return false;
  const bin = path.basename(words[0]);
  const args = words.slice(1);
  if (bin === 'cd') return redirects.length === 0 && args.length <= 1 && !/^-|[*?[$]/.test(args[0] || '');
  if (SUBCOMMANDS[bin]) {
    const sub = args.find((a) => !a.startsWith('-'));
    if (!SUBCOMMANDS[bin].includes(sub)) return false;
  } else if (!READ_ONLY.has(bin) && !ALSO_READ_ONLY.includes(bin)) {
    return false;
  }
  if (FORBIDDEN_FLAGS[bin] && args.some((a) => FORBIDDEN_FLAGS[bin].test(a))) return false;
  if (bin === 'pacman' && !args.some((a) => /^-[QSF]/.test(a))) return false;
  if (bin === 'tee' && !args.filter((a) => !a.startsWith('-')).every((a) => writableInPlan(a, cwd))) return false;
  return redirects.every((t) => t === '/dev/null' || (!/[*?[$]/.test(t) && writableInPlan(t, cwd)));
}

/** True when every command in `command` only reads, or writes a live doc. */
function commandInPlan(command, cwd = os.homedir()) {
  const src = stripHeredocs(String(command || '').trim());
  if (!src) return false;
  const tokens = lex(src);
  if (!tokens) return false;
  let words = [];
  let redirects = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.word !== undefined) {
      words.push(t.word);
    } else if (REDIRECT.test(t.op)) {
      const target = tokens[++i];
      if (!target || target.word === undefined) return false;
      redirects.push(target.word);
    } else if (/^\d*>&\d$/.test(t.op) || /^\d*<<(<)?$/.test(t.op)) {
      if (t.op.includes('<')) i++;
    } else if (/^\d*<$/.test(t.op)) {
      i++;
    } else {
      if (!commandAllowed(words, redirects, cwd)) return false;
      // Later redirects land relative to wherever a cd moved the shell.
      if (words[0] === 'cd') cwd = path.resolve(cwd, home(words[1] || '~'));
      words = [];
      redirects = [];
    }
  }
  return commandAllowed(words, redirects, cwd);
}

function planWriteRefusal() {
  return config.liveDocsEnabled
    ? `Plan mode only changes .md files directly in the live docs folder (${config.liveDocsDir}). Put this in the plan instead.`
    : 'Plan mode changes nothing on the computer. Put this in the plan instead.';
}

function planCommandRefusal() {
  return (
    'Plan mode only runs read-only commands (ls, cat, grep, find, git log, systemctl status, pacman -Q…)' +
    (config.liveDocsEnabled ? `, and may write .md files in ${config.liveDocsDir}` : '') +
    '. Put this command in the plan instead.'
  );
}

module.exports = { writableInPlan, commandInPlan, planWriteRefusal, planCommandRefusal };
