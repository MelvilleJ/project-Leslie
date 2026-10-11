'use strict';

const config = require('./config');
const contextWindow = require('./contextWindow');
const pi = require('./pi/backend');

module.exports = {
  async sendMessage(...args) {
    await contextWindow.refresh();
    return config.taskMode ? pi.runTask(...args) : pi.sendMessage(...args);
  },
  cancel: () => pi.cancel(),
  reset: () => pi.reset(),
  resume: (id) => pi.resume(id),
  resolveConfirm: (id, approved) => pi.resolveConfirm(id, approved),
  pi: () => pi,
  shutdown: () => pi.shutdown()
};
