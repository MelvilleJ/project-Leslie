'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DocError } = require('./store');

const WEB = path.join(__dirname, '..', '..', 'docs-web');
const STATIC = {
  'app.js': [path.join(WEB, 'app.js'), 'text/javascript'],
  'app.css': [path.join(WEB, 'app.css'), 'text/css'],
  'markdown.js': [path.join(__dirname, '..', '..', 'renderer', 'markdown.js'), 'text/javascript']
};
const MAX_BODY = 4 * 1024 * 1024;

/**
 * The docs web app on 127.0.0.1. The page carries a per-run token that every
 * API call must send back; other sites can't read the page (no CORS) and the
 * Host check stops DNS rebinding, so only a tab this server served can edit.
 */
function createDocsServer({ store, port, onAsk = () => {} }) {
  const token = crypto.randomBytes(24).toString('hex');
  const streams = new Set();
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new DocError('Request too large.'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new DocError('Bad JSON.'));
        }
      });
      req.on('error', reject);
    });

  const page = () =>
    fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replace('__TOKEN__', token);

  function broadcast(event, data, doc = null) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of streams) if (!doc || s.doc === doc) s.res.write(frame);
  }

  const onChange = ({ name, by, doc }) => broadcast('doc', { by, doc }, name);
  const onList = () => broadcast('list', store.list());
  store.on('change', onChange);
  store.on('list', onList);

  async function api(req, res, parts, url) {
    const method = req.method;
    if (parts[0] === 'events' && method === 'GET') {
      if (url.searchParams.get('t') !== token) return send(res, 403, { error: 'forbidden' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const doc = url.searchParams.get('doc') || null;
      const s = { res, doc: doc ? store.resolve(doc) : null };
      streams.add(s);
      res.write(`event: hello\ndata: ${JSON.stringify(s.doc ? { doc: store.get(s.doc) } : { list: store.list() })}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        streams.delete(s);
      });
      return;
    }
    if (req.headers['x-leslie-token'] !== token) return send(res, 403, { error: 'forbidden' });
    if (parts[0] !== 'docs') return send(res, 404, { error: 'not found' });

    const body = method === 'POST' ? await readBody(req) : {};
    const [, rawName, sub, subId, action] = parts;
    if (!rawName) {
      if (method === 'GET') return send(res, 200, store.list());
      if (method === 'POST') return send(res, 200, store.create(body.title, body.markdown));
    }
    const name = store.resolve(decodeURIComponent(rawName || ''));
    if (!sub) {
      if (method === 'GET') return send(res, 200, store.get(name));
      if (method === 'DELETE') {
        store.remove(name);
        return send(res, 200, { ok: true });
      }
    }
    if (sub === 'raw' && method === 'GET') return send(res, 200, store.markdown(name), 'text/markdown; charset=utf-8');
    if (sub === 'ops' && method === 'POST') {
      const { rev, results } = store.apply(name, body.ops, 'user');
      return send(res, 200, { rev, results });
    }
    if (sub === 'typing' && method === 'POST') {
      store.setTyping(name, body.id || null, String(body.client || ''));
      return send(res, 200, { ok: true });
    }
    if (sub === 'history') {
      if (!subId && method === 'GET') return send(res, 200, store.history(name));
      if (subId && !action && method === 'GET') return send(res, 200, store.version(name, subId), 'text/markdown; charset=utf-8');
      if (subId && action === 'restore' && method === 'POST') return send(res, 200, store.restore(name, subId));
    }
    if (sub === 'threads' && method === 'POST') {
      let thread;
      if (!subId) thread = store.comment(name, { ...body, author: 'user' });
      else if (action === 'reply') thread = store.reply(name, subId, { ...body, author: 'user' });
      else thread = store.setThread(name, subId, { resolved: body.resolved });
      if (thread.asked && (!subId || action === 'reply')) onAsk(name, thread);
      return send(res, 200, thread);
    }
    return send(res, 404, { error: 'not found' });
  }

  async function handle(req, res) {
    if (!hosts.has(req.headers.host)) return send(res, 421, { error: 'wrong host' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts[0] === 'api') return await api(req, res, parts.slice(1), url);
      if (parts[0] === 'static' && STATIC[parts[1]]) {
        const [file, type] = STATIC[parts[1]];
        return send(res, 200, fs.readFileSync(file), type);
      }
      if (req.method === 'GET' && (parts.length === 0 || parts[0] === 'd')) return send(res, 200, page(), 'text/html; charset=utf-8');
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof DocError) return send(res, 400, { error: err.message });
      console.warn('[docs] request failed:', err);
      return send(res, 500, { error: 'Something went wrong.' });
    }
  }

  const server = http.createServer(handle);

  return {
    url: (name) => `http://127.0.0.1:${port}${name ? `/d/${encodeURIComponent(name)}` : '/'}`,
    isOpen: (name) => [...streams].some((s) => s.doc === name),
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      }),
    close() {
      store.off('change', onChange);
      store.off('list', onList);
      for (const s of streams) s.res.end();
      server.close();
    }
  };
}

module.exports = { createDocsServer };
