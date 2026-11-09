'use strict';

// Starting, quitting and installing an update: the order things come up
// in, the effects of settings outside the database, and closing storage
// without losing accepted work.

const path = require('node:path');
const { UsageStore, DEFAULT_SETTINGS } = require('../store.cjs');
const { readStartupPreferences } = require('../startup-preferences.cjs');
const { helperPaths, installClaudeHelper, isClaudeHelperInstalled, readClaudeSettings, uninstallClaudeHelper } = require('../claude-collector.cjs');
const { createClaudeCodeMod } = require('../claude-code-mod.cjs');
const { createClaudeSetup } = require('../claude-setup.cjs');
const { createMaintenanceHost } = require('../maintenance-host.cjs');
const { createUpdateChecker } = require('../updater.cjs');
const { installDirectoryWritable, launchInstaller, relaunchApplication, preserveInstallerEnvironment } = require('../installer-launch.cjs');
const { initializeWithVisibleFailure, registerSingleInstance, createDeadline, settleWithin } = require('../app-lifecycle.cjs');
const { closed } = require('./closed.cjs');

// This file sits one folder below the main process's other modules.
const ELECTRON_DIR = path.join(__dirname, '..');

// A stalled restore, backup or collector must not hold Quit or an update open.
const SHUTDOWN_TIMEOUT_MS = 15_000;

/** @param {import('./application.cjs').Application} main */
function createLifecycleModule(main) {
  const { app, dialog, nativeTheme, powerMonitor, session } = main.electron;
  const lifecycle = closed({
    renderingForced: /** @type {boolean | undefined} */ (undefined),
    renderingMode: /** @type {'software' | 'hardware' | undefined} */ (undefined),
    isQuitting: false,
    shutdownPromise: /** @type {Promise<void> | undefined} */ (undefined),
    shutdownComplete: false,
    preparingUpdate: false,
    quitRequestedDuringUpdate: false,
    appliedLoginItem: /** @type {string | null} */ (null),
    applyLoginItem, applySettingsEffects, stopForShutdown, storageClosing, closeStorage, prepareUpdateInstall,
    recoverFromUpdateInstallFailure, loadAutoUpdater, start,
  });

  // The portable build runs from a temporary extraction directory, so
  // process.execPath would register an autostart entry that is gone by the next
  // boot; the launcher the user actually ran is what belongs there. The registry
  // write is skipped when nothing changed: this runs on every settings save.
  /** @param {boolean} enabled */
  function applyLoginItem(enabled) {
    const executable = main.launchEnvironment.PORTABLE_EXECUTABLE_FILE || main.process.execPath;
    const key = `${enabled}|${executable}`;
    if (lifecycle.appliedLoginItem === key) return;
    lifecycle.appliedLoginItem = key;
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, path: executable, args: ['--hidden'] });
    } catch { /* A refused registry write must not fail the settings save. */ }
  }

  // Every setting whose effect lives outside the database is reconciled here, so
  // the two write paths — the settings screen and a restore — cannot diverge, and
  // so a value repaired at startup takes effect rather than only being displayed.
  function applySettingsEffects() {
    // Accepted settings or restore jobs may finish while shutdown drains them.
    // Apply their saved settings on the next launch without restarting timers.
    if (lifecycle.isQuitting) return;
    const settings = main.store.getSettings();
    lifecycle.applyLoginItem(Boolean(settings.launchAtLogin));
    main.dashboard.applyTheme(settings.theme);
    main.refresh.scheduleAutomaticRefresh();
    main.updateChecker?.start();
  }

  function stopForShutdown() {
    lifecycle.isQuitting = true;
    main.dashboard.windowIdle?.cancel();
    // Its snapshot, refresh and snooze all need the storage that is closing.
    main.tray.flyout?.destroy();
    main.claudeSetup?.cancel();
    main.claudeCodeMod?.stop();
    main.timers.clearInterval(main.refresh.refreshTimer ?? undefined);
    main.timers.clearTimeout(main.tray.snoozeTimer);
    main.timers.clearTimeout(main.refresh.resumeTimer);
    main.refresh.refreshTimer = null;
    main.updateChecker?.stop();
    try { main.collectors?.stop(); } catch { /* Already gone. */ }
  }

  function storageClosing() {
    return Boolean(lifecycle.shutdownPromise || lifecycle.preparingUpdate);
  }

  function closeStorage() {
    if (!lifecycle.shutdownPromise) {
      lifecycle.shutdownPromise = (async () => {
        await main.databaseJobs.close();
        try { await main.maintenance?.close(); } finally { main.store?.close(); }
        lifecycle.shutdownComplete = true;
      })();
    }
    return lifecycle.shutdownPromise;
  }

  async function prepareUpdateInstall() {
    if (lifecycle.shutdownPromise || lifecycle.preparingUpdate) throw new Error('Application is already closing.');
    lifecycle.preparingUpdate = true;
    lifecycle.stopForShutdown();
    // One deadline spans the drain, the backup and the close. Quit is refused
    // while this runs, so the sequence itself has to be bounded.
    const deadline = createDeadline(SHUTDOWN_TIMEOUT_MS, 'Update preparation did not finish in time.');
    let backedUp = false;
    try {
      // Freeze new writes, drain accepted work, then back up the final database
      // state. A failed backup releases the queue and resumes the application.
      await Promise.race([
        main.databaseJobs.prepareToClose(async () => {
          // The SQLite copy alone: the JSON export is most of a backup's time,
          // grows with the ledger, and would otherwise outgrow this deadline.
          const backup = await main.maintenance.request('create-backup', { exportJson: false });
          backedUp = true;
          main.logs.updateLog('Safety backup complete.');
          return backup;
        }),
        deadline.expiry,
      ]);
    } catch (error) {
      main.logs.updateLog(`Preparation failed${deadline.expired ? ' (timed out)' : ''}: ${error?.message || 'unknown error'}`);
      if (deadline.expired) {
        // Accepted work or the backup is still running in the worker, so writes
        // cannot safely resume and nothing may install: reopen without updating.
        lifecycle.recoverFromUpdateInstallFailure(backedUp
          ? 'Your safety backup has been saved, but storage did not settle in time. AI Usage will reopen without updating; please try again.'
          : 'The safety backup did not finish in time. AI Usage will reopen without updating; please try again.');
        throw Object.assign(new Error('Update preparation timed out.'), { code: 'UPDATE_BACKUP_FAILED' });
      }
      deadline.cancel();
      lifecycle.preparingUpdate = false;
      lifecycle.isQuitting = lifecycle.quitRequestedDuringUpdate;
      if (lifecycle.quitRequestedDuringUpdate) { app.quit(); throw Object.assign(new Error("Update cancelled while quitting."), { code: "UPDATE_BACKUP_FAILED" }); }
      main.collectors = main.refresh.createCollectors();
      lifecycle.applySettingsEffects();
      main.claudeCodeMod?.start();
      throw Object.assign(new Error('Update safety backup failed.'), { code: 'UPDATE_BACKUP_FAILED' });
    }
    if (lifecycle.quitRequestedDuringUpdate) {
      deadline.cancel();
      lifecycle.preparingUpdate = false;
      app.quit();
      throw Object.assign(new Error('Update cancelled while quitting.'), { code: 'UPDATE_BACKUP_FAILED' });
    }
    try {
      await Promise.race([lifecycle.closeStorage(), deadline.expiry]);
      main.logs.updateLog('Storage closed; ready for the installer.');
    } catch (error) {
      if (deadline.expired) {
        // Every accepted write is drained and backed up; only the close itself
        // stalled. The installer replaces the process, so let it proceed.
        main.logs.updateLog('Storage did not close in time; installing with the backup taken.');
        lifecycle.shutdownComplete = true;
      } else {
        main.logs.updateLog(`Storage close failed: ${error?.message || 'unknown error'}`);
        lifecycle.recoverFromUpdateInstallFailure();
        throw error;
      }
    } finally {
      deadline.cancel();
    }
    if (lifecycle.quitRequestedDuringUpdate) {
      lifecycle.preparingUpdate = false;
      lifecycle.shutdownComplete = true;
      app.quit();
      throw Object.assign(new Error('Update cancelled while quitting.'), { code: 'UPDATE_BACKUP_FAILED' });
    }
  }

  function recoverFromUpdateInstallFailure(message = 'Your safety backup has been saved. AI Usage will reopen; please try the update again.') {
    // Storage may already be closed. Relaunch the existing version rather than
    // leave a visible dashboard attached to a closed database.
    if (!lifecycle.preparingUpdate) return;
    lifecycle.preparingUpdate = false;
    main.logs.updateLog(`Recovery: ${message} Relaunching the current version.`);
    dialog.showErrorBox('AI Usage update could not start', message);
    lifecycle.shutdownComplete = true;
    if (!lifecycle.quitRequestedDuringUpdate) relaunchApplication({ app, environment: main.launchEnvironment });
    app.quit();
  }

  function loadAutoUpdater() {
    try {
      return preserveInstallerEnvironment(require('electron-updater').autoUpdater, main.launchEnvironment);
    } catch {
      return null;
    }
  }

  // Everything that runs at launch, in order. Nothing above has a side effect
  // until this is called.
  function start() {
    // With hardware acceleration Chromium's GPU process keeps roughly 200 MiB of
    // private memory after the dashboard has been drawn once, even with the window
    // released to the tray; software rendering keeps it near 30 MiB. Chromium only
    // honours the choice before the app is ready, so it is read ahead of the store.
    lifecycle.renderingForced = main.process.env.AI_USAGE_DISABLE_GPU === '1';

    lifecycle.renderingMode = (() => {
      if (lifecycle.renderingForced) return 'software';
      let softwareRendering = DEFAULT_SETTINGS.softwareRendering;
      try { softwareRendering = readStartupPreferences(main.paths.storagePaths().databasePath).softwareRendering; } catch { /* Default applies. */ }
      return softwareRendering ? 'software' : 'hardware';
    })();

    if (lifecycle.renderingMode === 'software') app.disableHardwareAcceleration?.();

    // Every promise chain here is caught; this is the last resort so a missed one
    // is logged rather than surfaced by Electron as a modal dialog.
    main.process.on('unhandledRejection', (reason) => {
      main.logs.log(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    });

    const isPrimaryInstance = registerSingleInstance(app, () => {
      main.dashboard.deferredWindowReveal.request();
    });

    if (isPrimaryInstance) {
      void initializeWithVisibleFailure({
        initialize: async () => {
          await app.whenReady();
          const testRoot = main.process.env.AI_USAGE_TEST_ROOT;
          const { databasePath, backupDirectory } = main.paths.storagePaths();
          main.store = new UsageStore(databasePath, backupDirectory);
          main.maintenance = createMaintenanceHost({ databasePath, backupDirectory });
          main.claudeSetup = createClaudeSetup({
            statePath: path.join(testRoot || app.getPath('userData'), 'claude-setup.json'),
            installHelper: () => installClaudeHelper(main.paths.getInboxPath()),
            uninstallHelper: uninstallClaudeHelper,
            helperInstalled: isClaudeHelperInstalled,
            environment: main.launchEnvironment,
            log: main.logs.log,
          });
          main.claudeCodeMod = createClaudeCodeMod({
            root: main.paths.claudeCodeRoot(),
            sourceDirectory: path.join(ELECTRON_DIR, '..', 'claude-code-mod'),
            readClaudeSettings: () => readClaudeSettings(helperPaths().settingsPath),
            appVersion: app.getVersion(),
            environment: main.launchEnvironment,
            onRequest: main.refresh.answerClaudeCodeRequest,
            onReading: main.refresh.importClaudeCodeReading,
            getSnapshot: () => lifecycle.storageClosing() ? null : main.store.getTraySnapshot(Date.now()),
            log: main.logs.log,
          });
          main.collectors = main.refresh.createCollectors();
          main.alerts.notificationState = main.alerts.loadNotificationState();
          main.updateChecker = createUpdateChecker({
            autoUpdater: lifecycle.loadAutoUpdater,
            enabled: () => Boolean(main.store.getSettings().autoUpdate),
            isPackaged: app.isPackaged,
            pkg: main.pkg,
            beforeInstall: lifecycle.prepareUpdateInstall,
            onInstallError: lifecycle.recoverFromUpdateInstallFailure,
            launchInstaller: (options) => launchInstaller({ ...options, environment: main.launchEnvironment }),
            quitForInstall: () => app.quit(),
            installDirectoryWritable,
            onStatus: main.alerts.publishUpdateStatus,
            onLog: main.logs.updateLog,
          });
          main.logs.updateLog(`Application started: version ${app.getVersion()}${app.isPackaged ? '' : ' (development)'}.`);
          // The renderer is local, offline content: it needs no notification,
          // media, geolocation or other web permissions, so none are granted.
          session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
          session.defaultSession.setPermissionCheckHandler(() => false);
          app.on('web-contents-created', (_event, contents) => main.ipc.hardenWebContents(contents));
          main.ipc.registerIpc();
          main.dashboard.applyTheme(main.store.getSettings().theme);
          if (!main.process.argv.includes('--hidden')) main.dashboard.showMainWindow();
          main.tray.createTray();
          main.claudeCodeMod.start();
          main.tray.updateTray(main.snapshots.currentView());
          if (main.store.recoveredFrom) {
            main.logs.log(`Storage: unreadable database moved to ${main.store.recoveredFrom}.`);
            void dialog.showMessageBox({
              type: 'warning',
              title: 'AI Usage started with an empty database',
              message: 'The local database could not be read, so it was set aside and a new one was created.',
              detail: `The unreadable file was moved to:\n${main.store.recoveredFrom}\n\nRestore your latest backup from Settings to bring the history back.`,
            });
          }
          nativeTheme.on('updated', () => {
            main.dashboard.applyWindowChrome();
            main.tray.applyFlyoutChrome();
          });
          main.dashboard.deferredWindowReveal.markReady();
          main.refresh.scheduleLaunchRefresh();
          lifecycle.applySettingsEffects();
          powerMonitor.on('resume', main.refresh.onResume);
        },
        onFailure: (/** @type {unknown} */ error) => {
          main.dashboard.showFatalError('AI Usage could not start', 'Startup did not complete.', error);
        },
      });

      app.on('activate', () => main.dashboard.deferredWindowReveal.request());
      app.on('window-all-closed', () => {
        // The dashboard remains available from the tray on Windows.
      });
      app.on('before-quit', (event) => {
        if (lifecycle.shutdownComplete) return;
        event.preventDefault();
        if (lifecycle.preparingUpdate) { lifecycle.quitRequestedDuringUpdate = true; return; }
        if (lifecycle.shutdownPromise) return;
        lifecycle.stopForShutdown();
        // Cancel provider calls, then drain database jobs and close the maintenance
        // connection gracefully. A running backup or restore must finish before
        // Electron tears down its worker and the main SQLite handle.
        // Electron does not raise before-quit for a Windows shutdown or sign-out;
        // this bounds the tray Quit and an app-initiated quit only.
        void settleWithin(lifecycle.closeStorage(), SHUTDOWN_TIMEOUT_MS, 'Storage did not close in time; quitting anyway.')
          .catch((error) => main.logs.log(`Shutdown: ${error.message}`))
          .finally(() => {
            lifecycle.shutdownComplete = true;
            app.quit();
          });
      });
    }
  }

  return lifecycle;
}

module.exports = { createLifecycleModule };
