'use strict';

// The main process as one object. Each part of it (the dashboard window, the
// tray, collection, the bridge, startup and shutdown) is a module that owns
// its own state and reaches the others through this object, so a test can
// build the application around stand-ins for Electron, the process and the
// timers, and replace any one function, without evaluating source text.
//
// Building it has no side effects. lifecycle.start() is what launches.

const { createDatabaseQueue } = require('../maintenance-host.cjs');
const { createPathsModule } = require('./paths.cjs');
const { createLogsModule } = require('./logs.cjs');
const { createSnapshotsModule } = require('./snapshots.cjs');
const { createDashboardModule } = require('./dashboard.cjs');
const { createTrayModule } = require('./tray.cjs');
const { createAlertsModule } = require('./alerts.cjs');
const { createRefreshModule } = require('./refresh.cjs');
const { createIpcModule } = require('./ipc.cjs');
const { createLifecycleModule } = require('./lifecycle.cjs');

const systemTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

function createApplication({ electron, process, pkg, launchEnvironment, timers = systemTimers }) {
  const main = {
    electron,
    process,
    pkg,
    // The environment the app was launched with, taken before anything runs, so
    // the Claude and Codex executables, the installer and a relaunch see the
    // user's own values whatever later changes process.env.
    launchEnvironment,
    timers,
    // Created at startup, once Electron is ready.
    store: undefined,
    collectors: undefined,
    maintenance: undefined,
    updateChecker: undefined,
    claudeSetup: undefined,
    claudeCodeMod: null,
    databaseJobs: createDatabaseQueue(),
  };
  main.paths = createPathsModule(main);
  main.logs = createLogsModule(main);
  main.snapshots = createSnapshotsModule(main);
  main.dashboard = createDashboardModule(main);
  main.tray = createTrayModule(main);
  main.alerts = createAlertsModule(main);
  main.refresh = createRefreshModule(main);
  main.ipc = createIpcModule(main);
  main.lifecycle = createLifecycleModule(main);
  return main;
}

module.exports = { createApplication };
