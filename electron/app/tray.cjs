'use strict';

// The tray icon, its menu and tooltip, the flyout window beside it, and
// snoozing alerts from either.

const path = require('node:path');
const { REFRESH_TRIGGERS, refreshOptionsFor } = require('../refresh-policy.cjs');
const { buildSummaryText, buildTrayTooltip } = require('../notifications.cjs');
const { paintStateDot } = require('../tray-icon.cjs');
const { FLYOUT_BACKGROUND, FLYOUT_DOUBLE_CLICK_HOLD_MS, createTrayFlyout, flyoutPayload } = require('../flyout.cjs');
const { resolveWindowTarget } = require('../app-lifecycle.cjs');
const { closed } = require('./closed.cjs');

// This file sits one folder below the main process's other modules.
const ELECTRON_DIR = path.join(__dirname, '..');

const TRAY_SIZE = 32;

/** @param {import('./application.cjs').Application} main */
function createTrayModule(main) {
  const { app, BrowserWindow, clipboard, Menu, nativeImage, screen, Tray } = main.electron;
  const tray = closed({
    icon: /** @type {import('electron').Tray} */ (undefined),
    // The tray flyout controller; its window exists only while shown or recently hidden.
    flyout: /** @type {ReturnType<typeof createTrayFlyout> | null} */ (null),
    snoozeTimer: /** @type {NodeJS.Timeout} */ (undefined),
    trayState: '',
    trayMenuSnoozed: /** @type {boolean | null} */ (null),
    applyFlyoutChrome, trayIconFor, alertsSnoozed, traySummary, buildTrayMenu, createTray, flyoutAnchor,
    flyoutLoadTarget, createFlyoutWindow, flyoutSnapshot, pushFlyout, updateTray, scheduleSnoozeEnd, setSnooze,
  });

  function applyFlyoutChrome() {
    const flyout = tray.flyout?.window();
    if (!flyout) return;
    try { flyout.setBackgroundColor(FLYOUT_BACKGROUND[main.dashboard.resolvedTheme()]); } catch { /* Cosmetic only. */ }
  }

  function trayIconFor(state) {
    // The tray needs a raster image: Electron's nativeImage cannot rasterise
    // SVG data URLs on Windows, which leaves an invisible tray entry.
    const base = main.dashboard.loadAppIcon();
    if (!base) return nativeImage.createEmpty();
    const resized = base.resize({ width: TRAY_SIZE, height: TRAY_SIZE });
    try {
      const bitmap = Buffer.from(resized.toBitmap());
      if (bitmap.length !== TRAY_SIZE * TRAY_SIZE * 4) return resized;
      paintStateDot(bitmap, TRAY_SIZE, TRAY_SIZE, state);
      return nativeImage.createFromBitmap(bitmap, { width: TRAY_SIZE, height: TRAY_SIZE });
    } catch {
      return resized;
    }
  }

  function alertsSnoozed() {
    const until = main.store?.getSettings().alertsSnoozedUntil;
    return Boolean(until) && Date.parse(until) > Date.now();
  }

  function traySummary() {
    if (main.dashboard.isVisible()) return buildSummaryText(main.snapshots.snapshot());
    // An explicit copy still includes its cost summary. Build it transiently so
    // this tray action cannot pin a full dashboard in memory until the next open.
    try { return buildSummaryText(main.store.getDashboardSnapshot(main.snapshots.periodDays)); }
    finally { main.store.releaseDashboardCaches(); }
  }

  function buildTrayMenu() {
    const snoozed = tray.alertsSnoozed();
    return Menu.buildFromTemplate([
      { label: 'Open AI Usage', click: () => main.dashboard.showMainWindow() },
      { label: 'Refresh', click: () => { main.refresh.refreshAll(refreshOptionsFor(REFRESH_TRIGGERS.TRAY_MENU_REFRESH)).catch(() => {}); } },
      { label: 'Copy usage summary', click: () => { try { clipboard.writeText(tray.traySummary()); } catch { /* Clipboard denied. */ } } },
      { type: 'separator' },
      snoozed
        ? { label: 'Resume alerts', click: () => { tray.setSnooze(0).catch(() => {}); } }
        : { label: 'Snooze alerts for 6 hours', click: () => { tray.setSnooze(6).catch(() => {}); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { main.lifecycle.isQuitting = true; app.quit(); } },
    ]);
  }

  function createTray() {
    tray.icon = new Tray(tray.trayIconFor('unknown'));
    tray.icon.setToolTip('AI Usage');
    tray.icon.setContextMenu(tray.buildTrayMenu());
    tray.flyout = createTrayFlyout({
      createWindow: tray.createFlyoutWindow,
      getAnchor: tray.flyoutAnchor,
      onReveal: ({ reused }) => {
        // A reused window may have been hidden for up to a minute; a new one
        // asks for its first snapshot itself.
        if (reused) tray.pushFlyout(tray.flyoutSnapshot());
        main.refresh.refreshIfStale({ trigger: REFRESH_TRIGGERS.FLYOUT_SHOW });
      },
    });
    // Left click toggles the flyout; right click keeps the context menu.
    tray.icon.on('click', () => { tray.flyout?.toggle(); });
    // Windows raises 'click' first, so a double click has already opened the
    // flyout; close it and ignore the clicks that belong to the double click.
    tray.icon.on('double-click', () => {
      tray.flyout?.hide({ holdMs: FLYOUT_DOUBLE_CLICK_HOLD_MS });
      main.dashboard.showMainWindow();
    });
  }

  function flyoutAnchor() {
    if (!tray.icon || tray.icon.isDestroyed?.()) return null;
    let trayBounds = tray.icon.getBounds();
    // Windows can report an empty rectangle for the icon. The pointer is on the
    // icon when it has just been clicked, so it stands in for the icon.
    if (!(trayBounds?.width > 0 && trayBounds?.height > 0)) {
      const point = screen.getCursorScreenPoint();
      trayBounds = { x: point.x, y: point.y, width: 1, height: 1 };
    }
    const display = screen.getDisplayMatching(trayBounds);
    return { trayBounds, workArea: display.workArea, displayBounds: display.bounds };
  }

  function flyoutLoadTarget() {
    const devUrl = main.process.env.VITE_DEV_SERVER_URL;
    return resolveWindowTarget({
      isPackaged: app.isPackaged,
      devUrl: devUrl ? new URL('flyout.html', devUrl.endsWith('/') ? devUrl : `${devUrl}/`).href : undefined,
      filePath: path.join(ELECTRON_DIR, '..', 'dist', 'flyout.html'),
    });
  }

  // The same hardening as the dashboard: the session refuses every permission
  // and 'web-contents-created' denies navigation, pop-ups, redirects and web
  // views for this window too. Only its own preload and flyout:* channels exist.
  function createFlyoutWindow({ width, height }) {
    const flyout = new BrowserWindow({
      width,
      height,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'AI Usage',
      backgroundColor: FLYOUT_BACKGROUND[main.dashboard.resolvedTheme()],
      webPreferences: {
        preload: path.join(ELECTRON_DIR, 'flyout-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // Reports the page's natural height so the window fits its content.
        enablePreferredSizeMode: true,
      },
    });
    const target = tray.flyoutLoadTarget();
    const loading = target.kind === 'url' ? flyout.loadURL(target.value) : flyout.loadFile(target.value);
    loading.catch((error) => {
      // A flyout that cannot load is dropped; the next click tries again and
      // the dashboard and tray menu are unaffected.
      main.logs.log(`Tray flyout could not load: ${error instanceof Error ? error.message : String(error)}`);
      if (!flyout.isDestroyed()) flyout.destroy();
    });
    return flyout;
  }

  // The flyout shows the tray's lightweight snapshot, never a full dashboard build.
  function flyoutSnapshot() {
    if (!main.store || main.lifecycle.storageClosing()) return null;
    return flyoutPayload(main.store.getTraySnapshot(Date.now()));
  }

  function pushFlyout(current) {
    if (!tray.flyout?.window() || !current) return;
    tray.flyout.send('flyout:updated', flyoutPayload(current));
  }

  function updateTray(current) {
    if (!tray.icon) return;
    tray.pushFlyout(current);
    // The Claude Code mod draws what the tray shows, from the same snapshot.
    main.claudeCodeMod?.publish(current);
    const state = current?.dashboardVerdict?.state || 'unknown';
    if (state !== tray.trayState) {
      tray.trayState = state;
      tray.icon.setImage(tray.trayIconFor(state));
    }
    tray.icon.setToolTip(buildTrayTooltip(current));
    // Only the snooze entry ever changes, so the native menu is rebuilt when
    // that flips rather than on every publish.
    const snoozed = tray.alertsSnoozed();
    if (snoozed !== tray.trayMenuSnoozed) {
      tray.trayMenuSnoozed = snoozed;
      tray.icon.setContextMenu(tray.buildTrayMenu());
    }
    tray.scheduleSnoozeEnd();
  }

  function scheduleSnoozeEnd() {
    main.timers.clearTimeout(tray.snoozeTimer);
    const until = Date.parse(main.store?.getSettings().alertsSnoozedUntil || "");
    if (!Number.isFinite(until) || until <= Date.now() || main.lifecycle.isQuitting) return;
    tray.snoozeTimer = main.timers.setTimeout(() => {
      if (tray.icon && !main.lifecycle.isQuitting) {
        tray.trayMenuSnoozed = tray.alertsSnoozed();
        tray.icon.setContextMenu(tray.buildTrayMenu());
        if (tray.trayMenuSnoozed) tray.scheduleSnoozeEnd();
      }
    }, Math.min(2_147_483_647, Math.max(1, until - Date.now())));
    tray.snoozeTimer.unref?.();
  }

  function setSnooze(hours, { push = true } = {}) {
    return main.databaseJobs.run(() => {
      const until = hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null;
      main.store.updateSettings({ alertsSnoozedUntil: until });
      const current = push && !main.dashboard.isVisible()
        ? main.store.getTraySnapshot(Date.now()) : main.snapshots.patchSnapshotSettings();
      tray.updateTray(current);
      if (push && main.dashboard.isVisible()) main.dashboard.window.webContents.send('dashboard:updated', current);
      return current;
    });
  }

  return tray;
}

module.exports = { createTrayModule };
