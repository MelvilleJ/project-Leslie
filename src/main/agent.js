'use strict';

// The agent has been refactored into a layered package under ./agent/
// (Odysseus-style: streaming, tool parsing/resolution, tool RAG, policy, and
// reliability guards). This shim preserves `require('./agent')` for existing
// importers (main.js IPC) — the public surface is unchanged.
module.exports = require('./agent/index');
