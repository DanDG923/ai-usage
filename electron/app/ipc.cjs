'use strict';

// The bridge to the two renderers: which frame may call it, the count of
// requests in flight, and the hardening every web contents receives.

const { installClaudeHelper, uninstallClaudeHelper } = require('../claude-collector.cjs');
const { REFRESH_TRIGGERS, refreshOptionsFor } = require('../refresh-policy.cjs');
const { buildSummaryText } = require('../notifications.cjs');
const { flyoutPayload, normalizeNavigationTarget } = require('../flyout.cjs');
const { relaunchApplication } = require('../installer-launch.cjs');
const { closed } = require('./closed.cjs');

/** @typedef {import('electron').IpcMainInvokeEvent} IpcMainInvokeEvent */

/**
 * A channel's handler. What a renderer sends is not trusted, so each argument
 * arrives as `unknown` and the handler checks it before use.
 *
 * @typedef {(event: IpcMainInvokeEvent, ...args: unknown[]) => unknown} IpcHandler
 */

const EMPTY_SESSION_PAGE = Object.freeze({ rows: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });

/** @param {import('./application.cjs').Application} main */
function createIpcModule(main) {
  const { app, clipboard, dialog, ipcMain: electronIpcMain, shell } = main.electron;
  const ipc = closed({
    activeDashboardRequests: 0,
    assertDashboardSender, handleIpc, assertFlyoutSender, handleFlyoutIpc, registerFlyoutIpc, hardenWebContents,
    registerIpc,
  });

  // Only the dashboard's own main frame may invoke the bridge. Every handler is
  // wrapped, not just setup: a restore or helper install changes files outside
  // the app, and a future embedded frame must never be able to request either.
  /** @param {IpcMainInvokeEvent} event */
  function assertDashboardSender(event) {
    const { window } = main.dashboard;
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('This action is only available from the AI Usage window.');
    }
  }

  /**
   * @param {string} channel
   * @param {IpcHandler} handler
   */
  function handleIpc(channel, handler) {
    electronIpcMain.handle(channel, (event, ...args) => {
      ipc.assertDashboardSender(event);
      ipc.activeDashboardRequests++;
      try {
        const result = handler(event, ...args);
        if (result && typeof /** @type {{ then?: unknown }} */ (result).then === 'function') {
          return Promise.resolve(result).finally(() => { ipc.activeDashboardRequests--; });
        }
        ipc.activeDashboardRequests--;
        return result;
      } catch (error) {
        ipc.activeDashboardRequests--;
        throw error;
      }
    });
  }

  // The flyout's channels mirror the dashboard's rule: only the flyout's own main
  // frame may call them, and assertDashboardSender refuses the flyout in turn.
  /** @param {IpcMainInvokeEvent} event */
  function assertFlyoutSender(event) {
    if (!main.tray.flyout?.isSender(event)) {
      throw new Error('This action is only available from the AI Usage tray flyout.');
    }
  }

  /**
   * @param {string} channel
   * @param {IpcHandler} handler
   */
  function handleFlyoutIpc(channel, handler) {
    electronIpcMain.handle(channel, (event, ...args) => {
      ipc.assertFlyoutSender(event);
      return handler(event, ...args);
    });
  }

  function registerFlyoutIpc() {
    ipc.handleFlyoutIpc('flyout:get-snapshot', () => main.tray.flyoutSnapshot());
    // The same collection the tray menu starts; its publish also reaches the
    // flyout as flyout:updated, and the reply carries the result for this click.
    ipc.handleFlyoutIpc('flyout:refresh', async () => {
      await main.refresh.refreshAll(refreshOptionsFor(REFRESH_TRIGGERS.FLYOUT_REFRESH));
      return main.tray.flyoutSnapshot();
    });
    ipc.handleFlyoutIpc('flyout:open-dashboard', (_event, value) => {
      const target = normalizeNavigationTarget(value === undefined ? { tab: 'overview' } : value);
      if (!target) throw new Error('Unknown dashboard page.');
      main.dashboard.openDashboardAt(target);
    });
    ipc.handleFlyoutIpc('flyout:snooze', async (_event, hours) => {
      const parsed = Number(hours);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Invalid snooze duration.');
      // Zero resumes alerts, as in the tray menu and the settings screen.
      return flyoutPayload(await main.tray.setSnooze(parsed > 0 ? Math.min(72, parsed) : 0));
    });
    ipc.handleFlyoutIpc('flyout:close', () => { main.tray.flyout?.hide(); });
  }

  /** @param {import('electron').WebContents} contents */
  function hardenWebContents(contents) {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // A page reloading itself is the only navigation allowed: Electron raises
    // will-navigate for location.reload(), which the error screen offers.
    contents.on('will-navigate', (event, url) => {
      if ((event.url ?? url) !== contents.getURL()) event.preventDefault();
    });
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
  }

  function registerIpc() {
    ipc.handleIpc('dashboard:sleep-ready', (_event, token, allowed) => {
      // This handler itself is the one active request; the idle controller's
      // final check runs after its reply, when the count has returned to zero.
      ipc.activeDashboardRequests--;
      try { return main.dashboard.windowIdle?.reply(token, allowed) ?? false; }
      finally { ipc.activeDashboardRequests++; }
    });
    // The dashboard collects a page requested from the tray flyout, once.
    ipc.handleIpc('dashboard:take-navigation', () => main.dashboard.navigation.take());
    ipc.registerFlyoutIpc();
    require('../ipc-handlers.cjs').registerIpc({
      handleIpc: ipc.handleIpc,
      app, clipboard, dialog, shell,
      store: main.store,
      maintenance: main.maintenance,
      databaseJobs: main.databaseJobs,
      claudeSetup: main.claudeSetup,
      // Startup creates the mod before it registers these channels.
      claudeCodeMod: /** @type {NonNullable<typeof main.claudeCodeMod>} */ (main.claudeCodeMod),
      updateChecker: main.updateChecker,
      installClaudeHelper, uninstallClaudeHelper, buildSummaryText, EMPTY_SESSION_PAGE,
      getWindow: () => main.dashboard.window,
      getInboxPath: main.paths.getInboxPath,
      log: main.logs.log,
      logRendererError: main.logs.logRendererError,
      snapshot: main.snapshots.snapshot,
      currentView: main.snapshots.currentView,
      setPeriodDays: main.snapshots.setPeriodDays,
      invalidateSnapshot: main.snapshots.invalidateSnapshot,
      patchSnapshotSettings: main.snapshots.patchSnapshotSettings,
      getCachedSnapshot: () => main.snapshots.cachedSnapshot,
      getPreviousSnapshot: () => main.snapshots.lastFullSnapshot,
      refreshAll: main.refresh.refreshAll,
      refreshClaudeOnly: main.refresh.refreshClaudeOnly,
      publishAfterWrite: main.refresh.publishAfterWrite,
      updateTray: main.tray.updateTray,
      setSnooze: main.tray.setSnooze,
      storageClosing: main.lifecycle.storageClosing,
      applySettingsEffects: main.lifecycle.applySettingsEffects,
      renderingMode: main.lifecycle.renderingMode,
      renderingForced: main.lifecycle.renderingForced,
      relaunch: () => {
        if (main.lifecycle.isQuitting) return;
        // Quit drains storage and the maintenance worker first; the new
        // instance starts once this one has exited and released its lock.
        relaunchApplication({ app, environment: main.launchEnvironment });
        app.quit();
      },
    });
  }

  return ipc;
}

module.exports = { createIpcModule };
