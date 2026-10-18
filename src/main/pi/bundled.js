'use strict';

// Runs the bundled pi on Electron's own Node: `electron bundled.js <cli.js> ...`.
// ELECTRON_RUN_AS_NODE only matters at startup; dropping it keeps it out of the
// commands pi runs, where it would make any Electron app (LESLIE included)
// start as bare Node.

const { pathToFileURL } = require('node:url');

delete process.env.ELECTRON_RUN_AS_NODE;
const cli = process.argv[2];
process.argv.splice(1, 2, cli);
import(pathToFileURL(cli).href);
