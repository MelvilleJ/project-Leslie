'use strict';

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const config = require('../config');
const { gate } = require('../tools/lib/agentShell');
const { underRoots } = require('../tools/lib/osPaths');
const policy = require('./policy');

function socketPath() {
  const name = `leslie-pi-${process.pid}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

function formatResult(result) {
  if (result && typeof result === 'object' && typeof result.output === 'string') return result.output;
  return typeof result === 'string' ? result : JSON.stringify(result);
}

/**
 * Local JSONL socket the pi extension calls back into, so Leslie's own tools,
 * memory and confirm UI keep running inside the Electron main process.
 *
 * `getTurn()` returns the active turn's `{ ctx, onEvent }`, or null when idle.
 */
function createBridge({ getTurn, systemSections }) {
  const address = socketPath();
  const inflight = new Map();

  const idleCtx = { confirm: async () => false, openUrl() {}, setMode() {} };
  const turnCtx = () => (getTurn() && getTurn().ctx) || idleCtx;
  const emit = (ev) => {
    const turn = getTurn();
    if (turn) turn.onEvent(ev);
  };

  const methods = {
    context: () => ({ sections: systemSections(), ...policy.toolSelection() }),

    async tool({ callId, name, args }, send) {
      const tool = policy.bridgedTool(name);
      if (!tool) throw new Error(`"${name}" is not available in the current mode.`);
      const controller = new AbortController();
      inflight.set(callId, controller);
      const onProgress = (p) => {
        const label = typeof p === 'string' ? p : (p && p.label) || '';
        const research = p && typeof p === 'object' ? p.event : undefined;
        emit({ type: 'tool', phase: 'progress', id: callId, name, detail: label, research });
        if (label) send({ progress: label });
      };
      try {
        const result = await tool.run(args || {}, { ...turnCtx(), signal: controller.signal, onProgress });
        return { output: formatResult(result) };
      } finally {
        inflight.delete(callId);
      }
    },

    cancel({ callId }) {
      const controller = inflight.get(callId);
      if (controller) controller.abort();
      return {};
    },

    async gateCommand({ command }) {
      return { allowed: await gate(String(command || ''), turnCtx()) };
    },

    async gateWrite({ path: target, toolName }) {
      if (config.agentMode && !config.taskMode) return { allowed: true };
      if (underRoots(path.resolve(policy.cwd(), String(target || '')), config.fsWriteRoots)) return { allowed: true };
      const approved = await turnCtx().confirm(
        `LESLIE wants to ${toolName === 'edit' ? 'edit' : 'write'} a file outside your allowed folders:\n\n${target}`
      );
      return { allowed: Boolean(approved) };
    }
  };

  function serveConnection(socket) {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    const reply = (msg) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`);
    };

    const handle = async (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const fn = methods[msg.method];
      if (!fn) return reply({ id: msg.id, error: `unknown method ${msg.method}` });
      try {
        const result = await fn(msg.params || {}, (extra) => reply({ id: msg.id, ...extra }));
        reply({ id: msg.id, result });
      } catch (err) {
        reply({ id: msg.id, error: err && err.message ? err.message : String(err) });
      }
    };

    socket.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) handle(line);
      }
    });
    socket.on('error', () => {});
  }

  const server = net.createServer(serveConnection);

  return {
    address,
    listen() {
      if (process.platform !== 'win32') {
        try {
          fs.unlinkSync(address);
        } catch {
        }
      }
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(address, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    close() {
      for (const controller of inflight.values()) controller.abort();
      server.close();
    }
  };
}

module.exports = { createBridge };
