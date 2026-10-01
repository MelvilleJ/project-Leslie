'use strict';

const config = require('./config');
const contextWindow = require('./contextWindow');
const native = require('./agent/index');

let piLoaded = null;
const piBackend = () => piLoaded || (piLoaded = require('./pi/backend'));

const active = () => (config.engine === 'pi' ? piBackend() : native);

module.exports = {
  async sendMessage(...args) {
    await contextWindow.refresh();
    const engine = active();
    return config.taskMode ? engine.runTask(...args) : engine.sendMessage(...args);
  },
  cancel: () => active().cancel(),
  reset: () => active().reset(),
  resume: (id) => active().resume(id),
  recordResearch: (...args) => active().recordResearch(...args),
  resolveConfirm(id, approved) {
    native.resolveConfirm(id, approved);
    if (piLoaded) piLoaded.resolveConfirm(id, approved);
  },
  /** The pi backend when pi is the engine, else null. */
  pi: () => (config.engine === 'pi' ? piBackend() : null),
  shutdown() {
    if (piLoaded) piLoaded.shutdown();
  }
};
