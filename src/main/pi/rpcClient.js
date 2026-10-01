'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');

/**
 * Drives `pi --mode rpc` as a child process: JSONL commands on stdin,
 * responses/events/extension-UI requests on stdout.
 *
 * Emits: 'event' (session events), 'ui-request' (extension_ui_request),
 * 'exit' ({ code, signal, stderr }).
 */
class PiRpcClient extends EventEmitter {
  constructor({ command, args = [], cwd, env }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.proc = null;
    this.pending = new Map();
    this.seq = 0;
    this.stderrTail = '';
  }

  get running() {
    return Boolean(this.proc && this.proc.exitCode === null && !this.proc.killed);
  }

  start() {
    if (this.running) return;
    const proc = spawn(this.command, ['--mode', 'rpc', ...this.args], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.proc = proc;

    // Split only on LF: Node's readline also splits on U+2028/U+2029, which are
    // legal inside JSON strings and would corrupt records.
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line) this._handleLine(line);
      }
    });

    proc.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });

    proc.on('error', (err) => this._teardown({ error: err }));
    proc.on('exit', (code, signal) => this._teardown({ code, signal }));
  }

  _teardown(info) {
    if (!this.proc) return;
    this.proc = null;
    const reason = info.error
      ? info.error.message
      : `pi exited (code ${info.code}${info.signal ? `, ${info.signal}` : ''})`;
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
    this.emit('exit', { ...info, reason, stderr: this.stderrTail });
  }

  _handleLine(line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (record.type === 'response') {
      const waiter = record.id && this.pending.get(record.id);
      if (!waiter) return;
      this.pending.delete(record.id);
      if (record.success) waiter.resolve(record.data);
      else waiter.reject(new Error(record.error || `${record.command} failed`));
      return;
    }
    if (record.type === 'extension_ui_request') {
      this.emit('ui-request', record);
      return;
    }
    this.emit('event', record);
  }

  _write(record) {
    if (!this.running) throw new Error('pi is not running');
    this.proc.stdin.write(`${JSON.stringify(record)}\n`);
  }

  /** Send a command and resolve with its response data. */
  request(type, fields = {}, { timeoutMs = 60000 } = {}) {
    const id = `leslie-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`pi did not answer ${type} within ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
      const settle = (fn) => (value) => {
        if (timer) clearTimeout(timer);
        fn(value);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      try {
        this._write({ ...fields, id, type });
      } catch (err) {
        this.pending.delete(id);
        settle(reject)(err);
      }
    });
  }

  respondUi(id, payload) {
    this._write({ type: 'extension_ui_response', id, ...payload });
  }

  /** Close stdin for an orderly shutdown; force-kill if pi lingers. */
  stop() {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
    }
    const timer = setTimeout(() => {
      if (proc.exitCode === null) proc.kill();
    }, 3000);
    if (timer.unref) timer.unref();
  }
}

module.exports = { PiRpcClient };
