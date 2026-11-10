'use strict';

// The dashboard window: creating it, its theme and chrome, releasing it
// while idle in the tray, and opening it on a requested page.

const path = require('node:path');
const { REFRESH_TRIGGERS } = require('../refresh-policy.cjs');
const { createWindowIdleRelease } = require('../window-idle.cjs');
const { createNavigationQueue } = require('../flyout.cjs');
const {
  WINDOW_BOUNDS,
  createDeferredWindowReveal,
  initializeWithVisibleFailure,
  resolveWindowTarget,
  restorableBounds,
  revealWindow,
} = require('../app-lifecycle.cjs');
const { closed } = require('./closed.cjs');

// This file sits one folder below the main process's other modules.
const ELECTRON_DIR = path.join(__dirname, '..');

// Window chrome follows the theme the renderer paints, so the native caption
// buttons never sit on a strip of the other palette.
// Values follow --ground (the glareshield bar) and --text-2 in
// src/styles/tokens.css, night and Daylight; a mismatch shows as a strip of
// the wrong shade.
const CHROME = {
  dark: { background: '#000000', symbol: '#a3a9b2' },
  light: { background: '#eceae4', symbol: '#4b5059' },
};

const appIconPath = path.join(ELECTRON_DIR, '..', 'build', 'icon.png');

/** @param {import('./application.cjs').Application} main */
function createDashboardModule(main) {
  const { app, BrowserWindow, dialog, nativeImage, nativeTheme, screen } = main.electron;
  const dashboard = closed({
    window: /** @type {import('electron').BrowserWindow | null | undefined} */ (undefined),
    windowIdle: /** @type {ReturnType<typeof createWindowIdleRelease> | undefined} */ (undefined),
    savedWindowBounds: /** @type {import('electron').Rectangle | undefined} */ (undefined),
    savedWindowMaximized: false,
    lastDashboardReload: 0,
    navigation: createNavigationQueue(),
    deferredWindowReveal: /** @type {ReturnType<typeof createDeferredWindowReveal>} */ (/** @type {unknown} */ (undefined)),
    isVisible, loadAppIcon, showFatalError, resolvedTheme, applyTheme, applyWindowChrome, loadWindowContents,
    createWindow, showMainWindow, openDashboardAt,
  });

  // On screen, as opposed to released, hidden in the tray or being torn down.
  // Only a visible dashboard is worth a full snapshot or a push.
  function isVisible() {
    return Boolean(dashboard.window && !dashboard.window.isDestroyed() && dashboard.window.isVisible());
  }

  function loadAppIcon() {
    const icon = nativeImage.createFromPath(appIconPath);
    return icon.isEmpty() ? null : icon;
  }

  /**
   * @param {string} title
   * @param {string} message
   * @param {unknown} error whatever was thrown
   */
  function showFatalError(title, message, error) {
    const detail = error instanceof Error ? error.message : String(error || 'Unknown local error.');
    dialog.showErrorBox(title, `${message}\n\n${detail}`);
    main.lifecycle.isQuitting = true;
    app.quit();
  }

  function resolvedTheme() {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }

  /** @param {import('../../src/types').Theme} theme */
  function applyTheme(theme) {
    nativeTheme.themeSource = ['dark', 'light'].includes(theme) ? theme : 'system';
    dashboard.applyWindowChrome();
    main.tray.applyFlyoutChrome();
  }

  function applyWindowChrome() {
    if (!dashboard.window || dashboard.window.isDestroyed()) return;
    const chrome = CHROME[dashboard.resolvedTheme()];
    try {
      dashboard.window.setBackgroundColor(chrome.background);
      dashboard.window.setTitleBarOverlay({ color: chrome.background, symbolColor: chrome.symbol });
    } catch { /* Only Windows exposes the overlay; other platforms ignore it. */ }
  }

  /**
   * @param {import('electron').BrowserWindow} targetWindow
   * @param {ReturnType<typeof resolveWindowTarget>} target
   */
  async function loadWindowContents(targetWindow, target) {
    return initializeWithVisibleFailure({
      initialize: () => (target.kind === 'url'
        ? targetWindow.loadURL(target.value)
        : targetWindow.loadFile(target.value)),
      onFailure: async (/** @type {unknown} */ error) => {
        if (targetWindow.isDestroyed()) return undefined;
        const detail = error instanceof Error ? error.message : String(error || 'Unknown local error.');
        const choice = await dialog.showMessageBox(targetWindow, {
          type: 'error',
          title: 'AI Usage could not load',
          message: 'AI Usage could not load its dashboard.',
          detail,
          buttons: ['Retry', 'Quit'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (choice.response === 0) return 'retry';
        main.lifecycle.isQuitting = true;
        app.quit();
        return undefined;
      },
    });
  }

  function createWindow() {
    const chrome = CHROME[dashboard.resolvedTheme()];
    dashboard.window = new BrowserWindow({
      ...WINDOW_BOUNDS,
      ...restorableBounds(dashboard.savedWindowBounds, screen.getAllDisplays()),
      show: false,
      backgroundColor: chrome.background,
      title: 'AI Usage',
      icon: dashboard.loadAppIcon() ?? undefined,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: chrome.background,
        symbolColor: chrome.symbol,
        // Match --bar-height in src/styles/tokens.css to centre the controls.
        height: 52,
      },
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(ELECTRON_DIR, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Numbers, dates and search terms need no dictionary; skipping the
        // spellcheck service keeps its dictionaries out of memory.
        spellcheck: false,
      },
    });
    const target = resolveWindowTarget({
      isPackaged: app.isPackaged,
      devUrl: main.process.env.VITE_DEV_SERVER_URL,
      filePath: path.join(ELECTRON_DIR, '..', 'dist', 'index.html'),
    });
    const targetWindow = dashboard.window;
    dashboard.windowIdle = createWindowIdleRelease({
      window: targetWindow,
      isBusy: () => main.lifecycle.isQuitting || main.lifecycle.storageClosing() || main.ipc.activeDashboardRequests > 0,
      onRelease: () => {
        dashboard.savedWindowBounds = targetWindow.getNormalBounds();
        dashboard.savedWindowMaximized = targetWindow.isMaximized();
        main.snapshots.releaseDashboardMemory();
      },
    });
    void dashboard.loadWindowContents(targetWindow, target).catch((error) => {
      dashboard.showFatalError('AI Usage could not load', 'The dashboard load failure could not be displayed.', error);
    });
    dashboard.window.on('close', (event) => {
      if (!main.lifecycle.isQuitting) {
        event.preventDefault();
        targetWindow.hide();
      }
    });
    // Reopening from the tray must never present hours-old figures as current.
    dashboard.window.on('show', () => {
      if (main.store && !main.lifecycle.storageClosing()) {
        main.snapshots.invalidateSnapshot();
        // A window that is being shown exists.
        /** @type {import('electron').BrowserWindow} */ (dashboard.window).webContents.send('dashboard:updated', main.snapshots.snapshot());
      }
      main.refresh.refreshIfStale({ trigger: REFRESH_TRIGGERS.WINDOW_SHOW });
    });
    dashboard.window.on('closed', () => { if (dashboard.window === targetWindow) dashboard.window = null; });
    // A crashed renderer leaves a blank window that nothing else recovers. One on
    // screen is reloaded, at most once a minute so a renderer that keeps failing
    // cannot loop; otherwise the window is released as idle release does, and the
    // next open builds a fresh one.
    targetWindow.webContents.on('render-process-gone', (_event, details) => {
      if (main.lifecycle.isQuitting || details?.reason === 'clean-exit' || targetWindow.isDestroyed()) return;
      main.logs.logRendererError(`Dashboard renderer stopped (${details?.reason || 'unknown'}).`);
      if (targetWindow.isVisible() && Date.now() - dashboard.lastDashboardReload > 60_000) {
        dashboard.lastDashboardReload = Date.now();
        targetWindow.webContents.reload();
        return;
      }
      dashboard.savedWindowBounds = targetWindow.getNormalBounds();
      dashboard.savedWindowMaximized = targetWindow.isMaximized();
      main.snapshots.releaseDashboardMemory();
      targetWindow.destroy();
    });
    if (dashboard.savedWindowMaximized) targetWindow.maximize();
    return dashboard.window;
  }

  function showMainWindow() {
    dashboard.window = revealWindow(dashboard.window, dashboard.createWindow);
  }

  // Shows the dashboard on the requested page. The page waits in the main
  // process until the dashboard renderer collects it: a released dashboard is
  // recreated and loading, and only its preload can tell when it is listening.
  /** @param {import('../../src/types').DashboardNavigation} target */
  function openDashboardAt(target) {
    dashboard.navigation.request(target);
    // Shown while the flyout still holds the foreground, so Windows lets the
    // dashboard take focus; the flyout is hidden straight after.
    dashboard.showMainWindow();
    main.tray.flyout?.hide();
    if (dashboard.window && !dashboard.window.isDestroyed()) dashboard.window.webContents.send('dashboard:navigation-pending');
  }

  dashboard.deferredWindowReveal = createDeferredWindowReveal(dashboard.showMainWindow);
  return dashboard;
}

module.exports = { createDashboardModule };
