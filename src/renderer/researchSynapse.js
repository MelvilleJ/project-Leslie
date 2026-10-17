'use strict';

// Live SVG visualization of a deep_research run: a central query node with
// sub-question branches (one per round) and source leaves that pop in as pages
// are read. Ported from odysseus's static/js/researchSynapse.js, converted from
// an ES module to a window global (Leslie loads renderer scripts via <script>
// under a strict CSP) and given a fail() state for errored runs.
//
// Exposes window.createResearchSynapse(container, opts) -> controller with
// setPhase / setRound / setSourceCount / complete / fail / destroy.

(function (global) {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const PHASE_LABEL = {
    planning: 'planning strategy',
    searching: 'searching',
    reading: 'reading sources',
    analyzing: 'analyzing findings',
    writing: 'writing report',
    summarizing: 'summarizing',
    error: 'error',
    done: 'complete'
  };

  function rand(a, b) { return Math.random() * (b - a) + a; }

  function trunc(s, n) {
    if (!s) return '';
    s = String(s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function createResearchSynapse(container, opts = {}) {
    const W = 520;
    const H = 220;
    const cx = W / 2;
    const cy = H / 2;

    const wrap = document.createElement('div');
    wrap.className = 'research-synapse' + (opts.compact ? ' research-synapse-compact' : '');
    wrap.innerHTML =
      '<div class="rs-stage">' +
      `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">` +
      '<g class="rs-edges"></g>' +
      '<g class="rs-nodes"></g>' +
      `<circle class="rs-pulse" cx="${cx}" cy="${cy}" r="6"></circle>` +
      '</svg>' +
      '</div>' +
      '<div class="rs-meta">' +
      '<span class="rs-status">starting…</span>' +
      '<span class="rs-sep">·</span>' +
      '<span class="rs-round">round <b>0</b></span>' +
      '<span class="rs-sep">·</span>' +
      '<span class="rs-sources"><b>0</b> sources</span>' +
      '<span class="rs-sep">·</span>' +
      '<span class="rs-timer">00:00</span>' +
      '</div>';
    container.appendChild(wrap);

    const edgesG = wrap.querySelector('.rs-edges');
    const nodesG = wrap.querySelector('.rs-nodes');
    const statusE = wrap.querySelector('.rs-status');
    const roundE = wrap.querySelector('.rs-round b');
    const srcE = wrap.querySelector('.rs-sources b');
    const timerE = wrap.querySelector('.rs-timer');

    // root (query) node
    const root = document.createElementNS(SVG_NS, 'circle');
    root.setAttribute('cx', cx);
    root.setAttribute('cy', cy);
    root.setAttribute('r', 11);
    root.setAttribute('class', 'rs-node rs-node-root');
    nodesG.appendChild(root);
    const rootLabel = document.createElementNS(SVG_NS, 'text');
    rootLabel.setAttribute('x', cx);
    rootLabel.setAttribute('y', cy + 28);
    rootLabel.setAttribute('text-anchor', 'middle');
    rootLabel.setAttribute('class', 'rs-label');
    rootLabel.textContent = trunc(opts.query || 'query', 28);
    nodesG.appendChild(rootLabel);

    const subs = []; // { x, y, count }
    let sourceCount = 0;
    let lastRound = 0;
    let completed = false;

    const startedAt = opts.startedAt || Date.now();
    let timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      timerE.textContent =
        String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0');
    }, 1000);

    function addSub(label) {
      if (subs.length >= 10) return;
      const slot = subs.length;
      const totalSlots = Math.max(6, subs.length + 1);
      const angle = (slot / totalSlots) * Math.PI * 2 - Math.PI / 2;
      const r = 78;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;

      const edge = document.createElementNS(SVG_NS, 'line');
      edge.setAttribute('x1', cx);
      edge.setAttribute('y1', cy);
      edge.setAttribute('x2', x);
      edge.setAttribute('y2', y);
      edge.setAttribute('class', 'rs-edge rs-edge-firing');
      edgesG.appendChild(edge);
      setTimeout(() => edge.classList.remove('rs-edge-firing'), 1100);

      const n = document.createElementNS(SVG_NS, 'circle');
      n.setAttribute('cx', x);
      n.setAttribute('cy', y);
      n.setAttribute('r', 7);
      n.setAttribute('class', 'rs-node rs-node-sub rs-node-new');
      nodesG.appendChild(n);

      if (label) {
        const t = document.createElementNS(SVG_NS, 'text');
        const lx = cx + Math.cos(angle) * (r + 14);
        const ly = cy + Math.sin(angle) * (r + 14);
        t.setAttribute('x', lx);
        t.setAttribute('y', ly + 3);
        t.setAttribute('text-anchor', Math.cos(angle) > 0.15 ? 'start' : Math.cos(angle) < -0.15 ? 'end' : 'middle');
        t.setAttribute('class', 'rs-label rs-label-sub');
        t.textContent = trunc(label, 14);
        nodesG.appendChild(t);
      }

      subs.push({ x, y, count: 0 });
    }

    function addLeaf() {
      if (!subs.length) addSub('');
      const sub = subs[subs.length - 1];
      sub.count++;
      const baseAngle = Math.atan2(sub.y - cy, sub.x - cx);
      const idx = sub.count - 1;
      const perRing = 6;
      const ring = Math.floor(idx / perRing);
      const slot = idx % perRing;
      const arcSpan = 2.4;
      const angle = baseAngle + (slot - (perRing - 1) / 2) * (arcSpan / perRing) + rand(-0.05, 0.05);
      const r = 26 + ring * 14 + rand(-1.5, 1.5);
      const lx = sub.x + Math.cos(angle) * r;
      const ly = sub.y + Math.sin(angle) * r;

      const edge = document.createElementNS(SVG_NS, 'line');
      edge.setAttribute('x1', sub.x);
      edge.setAttribute('y1', sub.y);
      edge.setAttribute('x2', lx);
      edge.setAttribute('y2', ly);
      edge.setAttribute('class', 'rs-edge rs-edge-firing');
      edgesG.appendChild(edge);
      setTimeout(() => edge.classList.remove('rs-edge-firing'), 1100);

      const leaf = document.createElementNS(SVG_NS, 'circle');
      leaf.setAttribute('cx', lx);
      leaf.setAttribute('cy', ly);
      leaf.setAttribute('r', 4);
      leaf.setAttribute('class', 'rs-node rs-node-leaf rs-node-new');
      nodesG.appendChild(leaf);
    }

    function stopTimer() {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    }

    return {
      element: wrap,

      setPhase(phase, extra = {}) {
        if (completed) return;
        const label = PHASE_LABEL[phase] || phase || '';
        let txt = label;
        if (phase === 'searching' && extra.queries) txt += ` · ${extra.queries} queries`;
        else if (phase === 'reading' && extra.title) txt = `reading: ${trunc(extra.title, 32)}`;
        else if (phase === 'analyzing' && extra.total_findings) txt += ` · ${extra.total_findings} findings`;
        statusE.textContent = txt;
        if (phase === 'error') wrap.classList.add('rs-error');
      },

      setRound(round, o = {}) {
        if (completed) return;
        if (typeof round !== 'number' || round < 1) return;
        if (round > lastRound) {
          for (let i = lastRound; i < round && subs.length < 10; i++) addSub(o.label || `R${i + 1}`);
          lastRound = round;
          roundE.textContent = round;
        }
      },

      setSourceCount(total) {
        if (completed) return;
        if (typeof total !== 'number' || total <= sourceCount) return;
        const delta = Math.min(total - sourceCount, 6);
        for (let i = 0; i < delta; i++) setTimeout(addLeaf, i * 110);
        sourceCount = total;
        srcE.textContent = total;
      },

      complete() {
        if (completed) return;
        completed = true;
        wrap.classList.add('rs-complete');
        statusE.textContent = 'complete';
        stopTimer();
      },

      fail(message) {
        if (completed) return;
        completed = true;
        wrap.classList.add('rs-error');
        statusE.textContent = message ? trunc(message, 40) : 'error';
        stopTimer();
      },

      destroy() {
        stopTimer();
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }
    };
  }

  global.createResearchSynapse = createResearchSynapse;
})(window);
