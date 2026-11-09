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

/**
 * The application object every module receives as `main`.
 *
 * @typedef {object} Application
 * @property {typeof import('electron')} electron
 * @property {NodeJS.Process} process
 * @property {Record<string, any>} pkg package.json
 * @property {NodeJS.ProcessEnv} launchEnvironment
 * @property {typeof systemTimers} timers
 * @property {import('../store.cjs').Store | undefined} store
 * @property {ReturnType<typeof import('../collector-host.cjs').createCollectorHost> | undefined} collectors
 * @property {ReturnType<typeof import('../maintenance-host.cjs').createMaintenanceHost> | undefined} maintenance
 * @property {ReturnType<typeof import('../updater.cjs').createUpdateChecker> | undefined} updateChecker
 * @property {ReturnType<typeof import('../claude-setup.cjs').createClaudeSetup> | undefined} claudeSetup
 * @property {ReturnType<typeof import('../claude-code-mod.cjs').createClaudeCodeMod> | null} claudeCodeMod
 * @property {ReturnType<typeof createDatabaseQueue>} databaseJobs
 * @property {ReturnType<typeof createPathsModule>} paths
 * @property {ReturnType<typeof createLogsModule>} logs
 * @property {ReturnType<typeof createSnapshotsModule>} snapshots
 * @property {ReturnType<typeof createDashboardModule>} dashboard
 * @property {ReturnType<typeof createTrayModule>} tray
 * @property {ReturnType<typeof createAlertsModule>} alerts
 * @property {ReturnType<typeof createRefreshModule>} refresh
 * @property {ReturnType<typeof createIpcModule>} ipc
 * @property {ReturnType<typeof createLifecycleModule>} lifecycle
 */

function createApplication({ electron, process, pkg, launchEnvironment, timers = systemTimers }) {
  /** @type {Application} */
  const main = /** @type {any} */ ({
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
  });
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
