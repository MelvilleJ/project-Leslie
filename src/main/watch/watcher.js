'use strict';

/**
 * @typedef {{ title: string, detail?: string }} WatchItem
 * @typedef {{
 *   name: string,
 *   noun: string,
 *   intervalMs: number,
 *   poll: (cursor: any) => Promise<{ items: WatchItem[], cursor: any }>
 * }} WatchSource
 *
 * A source called with no cursor returns where things stand now and no items,
 * so the first run after install (or a reset) never reads out the backlog.
 */

function createWatcher({ sources, state, save, summarize, announce, log = console }) {
  const timers = [];
  const busy = new Set();

  async function poll(source) {
    // A slow server must not stack polls on top of each other.
    if (busy.has(source.name)) return;
    busy.add(source.name);
    try {
      const { items, cursor } = await source.poll(state[source.name]);
      state[source.name] = cursor;
      save(state);
      if (items.length) await announce(await summarize(source, items), source, items);
    } catch (err) {
      log.warn(`[watch:${source.name}]`, err.message);
    } finally {
      busy.delete(source.name);
    }
  }

  function start() {
    for (const source of sources) {
      poll(source);
      const timer = setInterval(() => poll(source), source.intervalMs);
      timer.unref?.();
      timers.push(timer);
    }
  }

  function stop() {
    for (const timer of timers.splice(0)) clearInterval(timer);
  }

  return { start, stop, poll };
}

module.exports = { createWatcher };
