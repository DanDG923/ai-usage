'use strict';

const { EventEmitter } = require('node:events');
const { createApplication } = require('../../electron/app/application.cjs');

// The real main-process application around stand-ins for Electron, the
// process and, where a test supplies them, the timers. Nothing launches:
// lifecycle.start() is never called, so a test sets the state it needs and
// calls the function it is about.
function mainApplication({ electron = {}, env = {}, timers = {} } = {}) {
  const handlers = new Map();
  const app = new EventEmitter();
  app.quit = () => {};
  const main = createApplication({
    electron: { app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, ...electron },
    process: { env, argv: [], on() {}, execPath: process.execPath, stderr: process.stderr },
    pkg: require('../../package.json'),
    launchEnvironment: Object.freeze({}),
    timers: { setTimeout, clearTimeout, setInterval, clearInterval, ...timers },
  });
  return { main, handlers, app };
}

module.exports = { mainApplication };
