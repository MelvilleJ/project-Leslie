'use strict';

// The systemd user units LESLIE runs on. An existing unit is kept unless the
// caller asks to replace it (repair), so a hand-written one is never overwritten.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { run, must } = require('./exec');

const PORTS = { router: 8080, speech: 8178, vision: 8179 };

const NAMES = {
  router: 'llama-router.service',
  speech: 'leslie-speech.service',
  vision: 'leslie-vision.service',
  app: 'leslie.service'
};

// Waits for the port so a unit counts as started only once it answers.
const waitFor = (url, tries) =>
  `ExecStartPost=/bin/sh -c 'for i in $(seq 1 ${tries}); do curl -sf -o /dev/null ${url} && exit 0; sleep 0.5; done; exit 1'`;

function router({ binary, modelsDir, presetsFile = paths.ROUTER_PRESETS, port = PORTS.router }) {
  return `[Unit]
Description=llama.cpp model router
After=network.target

[Service]
ExecStart=${binary} --models-dir ${modelsDir} --models-preset ${presetsFile} --no-models-autoload --host 127.0.0.1 --port ${port}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

function vision({ venv, modelsDir, port = PORTS.vision }) {
  return `[Unit]
Description=LESLIE camera presence (face detection + recognition)
# Before the model server, so llama.cpp's --fit sizes the model around the GPU memory this keeps.
Before=${NAMES.router}

[Service]
ExecStart=${venv}/bin/leslie-vision --host 127.0.0.1 --port ${port} --models ${modelsDir}
${waitFor(`http://127.0.0.1:${port}/health`, 120)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function speech({ venv, modelsDir, runtime, port = PORTS.speech }) {
  return `[Unit]
Description=LESLIE speech recognition (faster-whisper, ${runtime})
Before=${NAMES.router}

[Service]
ExecStart=${venv}/bin/leslie-speech --host 127.0.0.1 --port ${port} --models ${modelsDir} --device ${runtime === 'cuda' ? 'cuda' : 'cpu'}
${waitFor(`http://127.0.0.1:${port}/health`, 240)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function app({ exec }) {
  return `[Unit]
Description=LESLIE desktop companion
PartOf=graphical-session.target
# The voice window opens the mic at startup, so wait for PipeWire to be up.
After=graphical-session.target ${NAMES.router} pipewire.service pipewire-pulse.service wireplumber.service
Wants=${NAMES.router} pipewire.service wireplumber.service

[Service]
ExecStart=${exec}
Restart=on-failure
RestartSec=3
# SIGTERM only Electron's main process; signalling the whole cgroup kills the
# GPU process first and Chromium aborts with a core dump on every stop.
KillMode=mixed
TimeoutStopSec=15

[Install]
WantedBy=graphical-session.target
`;
}

const unitPath = (name) => path.join(paths.UNITS, name);
const exists = (name) => fs.existsSync(unitPath(name));

/** 'kept' when a unit was already there (and replace is off), 'written' otherwise. */
function write(name, text, { replace = false } = {}) {
  const file = unitPath(name);
  if (fs.existsSync(file) && !replace) return 'kept';
  fs.mkdirSync(paths.UNITS, { recursive: true });
  fs.writeFileSync(file, text);
  return 'written';
}

const systemctl = (...args) => run('systemctl', ['--user', ...args], { timeout: 120000 });

async function enable(name) {
  await must('systemctl', ['--user', 'daemon-reload']);
  await must('systemctl', ['--user', 'enable', name]);
}

async function restart(name) {
  await must('systemctl', ['--user', 'restart', name], { timeout: 300000 });
}

/** Stop, disable and delete units LESLIE wrote. */
async function remove(names) {
  for (const name of names) {
    if (!exists(name)) continue;
    await systemctl('disable', '--now', name);
    fs.rmSync(unitPath(name), { force: true });
  }
  await systemctl('daemon-reload');
}

module.exports = { NAMES, PORTS, router, vision, speech, app, write, exists, unitPath, enable, restart, remove, systemctl };
