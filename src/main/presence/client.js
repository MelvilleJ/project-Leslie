'use strict';

// HTTP client for the leslie-vision sidecar (vision/leslie_vision/server.py).

const MAX_BACKOFF_MS = 30000;

/** Split a growing SSE buffer into complete `data:` payloads and the unfinished rest. */
function parseSse(buffer) {
  const events = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop();
  for (const block of blocks) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // A malformed event is dropped rather than ending the stream.
    }
  }
  return { events, rest };
}

function createClient(baseUrl) {
  const url = (path) => `${baseUrl().replace(/\/+$/, '')}${path}`;

  async function json(path, init = {}, timeoutMs = 5000) {
    const res = await fetch(url(path), {
      ...init,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && body.ok === undefined) throw new Error(body.error || `${res.status} ${res.statusText}`);
    return body;
  }

  /** Follow the event stream until stopped, reconnecting with backoff. */
  function follow({ onEvent, onConnect, onDisconnect, log = console }) {
    let stopped = false;
    let controller = null;
    let backoff = 1000;
    let warned = false;

    (async () => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const res = await fetch(url('/events'), { signal: controller.signal });
          if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
          backoff = 1000;
          if (warned) log.log?.('[presence] vision service connected');
          warned = false;
          onConnect?.();
          let buffer = '';
          const decoder = new TextDecoder();
          for await (const chunk of res.body) {
            buffer += decoder.decode(chunk, { stream: true });
            const parsed = parseSse(buffer);
            buffer = parsed.rest;
            for (const event of parsed.events) onEvent(event);
          }
        } catch (err) {
          if (stopped) break;
          if (!warned) log.warn(`[presence] vision service unavailable: ${err.message}`);
          warned = true;
        }
        if (stopped) break;
        onDisconnect?.();
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    })();

    return () => {
      stopped = true;
      controller?.abort();
    };
  }

  return {
    follow,
    health: () => json('/health'),
    devices: async () => (await json('/devices')).devices || [],
    camera: (body) => json('/camera', { method: 'POST', body: JSON.stringify(body) }),
    enroll: (personId, samples = 15) =>
      json('/enroll', { method: 'POST', body: JSON.stringify({ personId, samples, timeout: 30 }) }, 40000),
    removePerson: (id) => json(`/people/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** A fresh frame, plus a close-up of anything pointed at just now: base64 JPEGs `{ image, crop }`. */
    look: () => json('/look', {}, 8000),
    async preview() {
      const res = await fetch(url('/preview.jpg'), { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      return `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    }
  };
}

module.exports = { createClient, parseSse };
