'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app, BrowserWindow, clipboard, dialog, ipcMain: electronIpcMain, Menu, nativeImage, nativeTheme, Notification,
  powerMonitor, session, shell, Tray, utilityProcess,
} = require('electron');
const { UsageStore, DEFAULT_SETTINGS } = require('./store.cjs');
const { readStartupPreferences } = require('./startup-preferences.cjs');
const { installClaudeHelper, uninstallClaudeHelper, isClaudeHelperInstalled } = require('./claude-collector.cjs');
const { createClaudeSetup } = require('./claude-setup.cjs');
const { createCollectorHost, createInlineCollectorHost } = require('./collector-host.cjs');
const { createCollectorService } = require('./collector-service.cjs');
const { createWindowIdleRelease } = require('./window-idle.cjs');
const { createMaintenanceHost, createDatabaseQueue } = require('./maintenance-host.cjs');
const { buildSummaryText, buildTrayTooltip, decideNotifications, emptyState } = require('./notifications.cjs');
const { paintStateDot } = require('./tray-icon.cjs');
const { createUpdateChecker } = require('./updater.cjs');
const { installDirectoryWritable, launchInstaller, relaunchApplication, preserveInstallerEnvironment } = require('./installer-launch.cjs');
const { createGitHubUpdateAuth } = require('./update-auth.cjs');
const {
  WINDOW_BOUNDS,
  createDeferredWindowReveal,
  initializeWithVisibleFailure,
  registerSingleInstance,
  resolveWindowTarget,
  revealWindow,
  createDeadline,
  settleWithin,
} = require('./app-lifecycle.cjs');

const pkg = require('../package.json');

// The environment the app was launched with, taken before anything runs. The
// update check deletes GH_TOKEN and GITHUB_TOKEN from process.env so that
// electron-updater cannot prefer them to the GitHub CLI sign-in; the Claude
// and Codex executables the app spawns must still see the user's own values.
const launchEnvironment = Object.freeze({ ...process.env });

function storagePaths() {
  const root = process.env.AI_USAGE_TEST_ROOT || app.getPath('userData');
  return { databasePath: path.join(root, 'ai-usage.sqlite'), backupDirectory: path.join(root, 'Backups') };
}

// With hardware acceleration Chromium's GPU process keeps roughly 200 MiB of
// private memory after the dashboard has been drawn once, even with the window
// released to the tray; software rendering keeps it near 30 MiB. Chromium only
// honours the choice before the app is ready, so it is read ahead of the store.
const renderingForced = process.env.AI_USAGE_DISABLE_GPU === '1';
const renderingMode = (() => {
  if (renderingForced) return 'software';
  let softwareRendering = DEFAULT_SETTINGS.softwareRendering;
  try { softwareRendering = readStartupPreferences(storagePaths().databasePath).softwareRendering; } catch { /* Default applies. */ }
  return softwareRendering ? 'software' : 'hardware';
})();
if (renderingMode === 'software') app.disableHardwareAcceleration?.();

let window;
let windowIdle;
let savedWindowBounds;
let savedWindowMaximized = false;
let activeDashboardRequests = 0;
let tray;
let store;
let collectors;
let maintenance;
let updateChecker;
let claudeSetup;
let refreshPromise;
let refreshTimer;
let lastRefreshAt = 0;
let isQuitting = false;
let periodDays = 30;
let previousSnapshot = null;
let notificationState = emptyState();
let cachedSnapshot = null;
let lastFullSnapshot = null;
let shutdownPromise;
let shutdownComplete = false;
let preparingUpdate = false;
let quitRequestedDuringUpdate = false;
let snoozeTimer;
let resumeTimer;
let refreshIntervalMs = 0;
const notifiedUpdates = new Set();
const databaseJobs = createDatabaseQueue();

const STALE_AFTER_MS = 5 * 60_000;
// Tab switches and settings edits ask for the snapshot far more often than it
// changes. Anything that writes clears this; the TTL bounds the drift of the
// "now"-relative fields (staleness, estimated current balance) between writes.
const SNAPSHOT_TTL_MS = 20_000;
const TRAY_SIZE = 32;
// A stalled restore, backup or collector must not hold Quit or an update open.
const SHUTDOWN_TIMEOUT_MS = 15_000;
const EMPTY_SESSION_PAGE = Object.freeze({ rows: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });

// Window chrome follows the theme the renderer paints, so the native caption
// buttons never sit on a strip of the other palette.
// Values follow --header-bg and --text-2 in src/professional.css, the
// stylesheet that wins; a mismatch shows as a strip of the wrong shade.
const CHROME = {
  dark: { background: '#0c1116', symbol: '#cbd3da' },
  light: { background: '#f4f6f8', symbol: '#3b4854' },
};

const appIconPath = path.join(__dirname, '..', 'build', 'icon.png');

function loadAppIcon() {
  const icon = nativeImage.createFromPath(appIconPath);
  return icon.isEmpty() ? null : icon;
}

function getInboxPath() {
  return path.join(app.getPath('userData'), 'inbox', 'claude-statusline.jsonl');
}

function notificationStatePath() {
  return path.join(app.getPath('userData'), 'notification-state.json');
}

function loadNotificationState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(notificationStatePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? { ...emptyState(), ...parsed } : emptyState();
  } catch {
    return emptyState();
  }
}

function saveNotificationState(state) {
  try {
    fs.writeFileSync(notificationStatePath(), JSON.stringify(state), 'utf8');
  } catch { /* A digest repeated after a crash is the worst case. */ }
}

function log(message) {
  if (process.env.AI_USAGE_DEBUG === '1') process.stderr.write(`[ai-usage] ${message}\n`);
}

function logRendererError(message) {
  log(message);
  try {
    const file = path.join(app.getPath('userData'), 'renderer-errors.log');
    try { if (fs.statSync(file).size > 64 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* First log or unavailable rotation. */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch { /* Reporting must not fail the renderer recovery. */ }
}

// Every promise chain here is caught; this is the last resort so a missed one
// is logged rather than surfaced by Electron as a modal dialog.
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

// A failed update used to leave no trace once the app had quit. Stage changes
// and the sanitised failure messages the updater already shows are appended
// here; request details, URLs and credentials never reach this file.
const UPDATE_LOG_MAX_BYTES = 256 * 1024;

function updateLogPath() {
  return path.join(app.getPath('userData'), 'update.log');
}

function updateLog(message) {
  const line = String(message).replace(/[\r\n\t]+/g, ' ').trim();
  log(`Update: ${line}`);
  try {
    const file = updateLogPath();
    try {
      if (fs.statSync(file).size > UPDATE_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* No log yet, or rotation is not possible; append anyway. */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch { /* Diagnostics must never affect the update itself. */ }
}

// The renderer owns the selected period, so every snapshot the main process
// emits — refresh, settings change, price edit, backup — has to use it too.
function setPeriodDays(days) {
  const requested = Math.round(Number(days));
  if (Number.isFinite(requested) && requested >= 1 && requested <= 365) periodDays = requested;
  return periodDays;
}

function invalidateSnapshot() {
  cachedSnapshot = null;
}

function snapshot() {
  const now = Date.now();
  if (cachedSnapshot && cachedSnapshot.days === periodDays && now - cachedSnapshot.at < SNAPSHOT_TTL_MS) {
    return cachedSnapshot.value;
  }
  const value = store.getDashboardSnapshot(periodDays, now);
  cachedSnapshot = { days: periodDays, at: now, value };
  lastFullSnapshot = value;
  return value;
}

function currentView() {
  return window && !window.isDestroyed() && window.isVisible()
    ? snapshot() : store.getTraySnapshot(Date.now());
}

function patchSnapshotSettings() {
  if (cachedSnapshot && cachedSnapshot.days === periodDays && Date.now() - cachedSnapshot.at < SNAPSHOT_TTL_MS) {
    cachedSnapshot.value = { ...cachedSnapshot.value, settings: store.getSettings() };
    lastFullSnapshot = cachedSnapshot.value;
    return cachedSnapshot.value;
  }
  return snapshot();
}

function releaseDashboardMemory() {
  cachedSnapshot = null;
  lastFullSnapshot = null;
  // Notifications compare only the old bucket identity/reset/usage and source
  // status. Do not retain charts, ledger summaries or forecast series for it.
  if (previousSnapshot) {
    previousSnapshot = {
      quotas: Object.fromEntries(Object.entries(previousSnapshot.quotas || {}).map(([key, quota]) => [key, quota && {
        windows: (quota.windows?.length ? quota.windows : [quota]).map(({ bucketId, resetsAt, usedPercent }) => ({ bucketId, resetsAt, usedPercent })),
      }])),
      sources: (previousSnapshot.sources || []).map(({ id, status }) => ({ id, status })),
    };
  }
  store?.releaseDashboardCaches();
}

function showFatalError(title, message, error) {
  const detail = error instanceof Error ? error.message : String(error || 'Unknown local error.');
  dialog.showErrorBox(title, `${message}\n\n${detail}`);
  isQuitting = true;
  app.quit();
}

function resolvedTheme() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function applyTheme(theme) {
  nativeTheme.themeSource = ['dark', 'light'].includes(theme) ? theme : 'system';
  applyWindowChrome();
}

function applyWindowChrome() {
  if (!window || window.isDestroyed()) return;
  const chrome = CHROME[resolvedTheme()];
  try {
    window.setBackgroundColor(chrome.background);
    window.setTitleBarOverlay({ color: chrome.background, symbolColor: chrome.symbol });
  } catch { /* Only Windows exposes the overlay; other platforms ignore it. */ }
}

async function loadWindowContents(targetWindow, target) {
  return initializeWithVisibleFailure({
    initialize: () => (target.kind === 'url'
      ? targetWindow.loadURL(target.value)
      : targetWindow.loadFile(target.value)),
    onFailure: async (error) => {
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
      isQuitting = true;
      app.quit();
      return undefined;
    },
  });
}

function createWindow() {
  const chrome = CHROME[resolvedTheme()];
  window = new BrowserWindow({
    ...WINDOW_BOUNDS,
    ...savedWindowBounds,
    show: false,
    backgroundColor: chrome.background,
    title: 'AI Usage',
    icon: loadAppIcon() ?? undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: chrome.background,
      symbolColor: chrome.symbol,
      // Match --command-height in src/professional.css to centre the controls.
      height: 56,
    },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
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
    devUrl: process.env.VITE_DEV_SERVER_URL,
    filePath: path.join(__dirname, '..', 'dist', 'index.html'),
  });
  const targetWindow = window;
  windowIdle = createWindowIdleRelease({
    window: targetWindow,
    isBusy: () => isQuitting || storageClosing() || activeDashboardRequests > 0,
    onRelease: () => {
      savedWindowBounds = targetWindow.getNormalBounds();
      savedWindowMaximized = targetWindow.isMaximized();
      releaseDashboardMemory();
    },
  });
  void loadWindowContents(targetWindow, target).catch((error) => {
    showFatalError('AI Usage could not load', 'The dashboard load failure could not be displayed.', error);
  });
  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      targetWindow.hide();
    }
  });
  // Reopening from the tray must never present hours-old figures as current.
  window.on('show', () => {
    if (store && !storageClosing()) {
      invalidateSnapshot();
      window.webContents.send('dashboard:updated', snapshot());
    }
    refreshIfStale();
  });
  window.on('closed', () => { if (window === targetWindow) window = null; });
  if (savedWindowMaximized) targetWindow.maximize();
  return window;
}

function showMainWindow() {
  window = revealWindow(window, createWindow);
}

const deferredWindowReveal = createDeferredWindowReveal(showMainWindow);

function trayIconFor(state) {
  // The tray needs a raster image: Electron's nativeImage cannot rasterise
  // SVG data URLs on Windows, which leaves an invisible tray entry.
  const base = loadAppIcon();
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
  const until = store?.getSettings().alertsSnoozedUntil;
  return Boolean(until) && Date.parse(until) > Date.now();
}

function traySummary() {
  if (window && !window.isDestroyed() && window.isVisible()) return buildSummaryText(snapshot());
  // An explicit copy still includes its cost summary. Build it transiently so
  // this tray action cannot pin a full dashboard in memory until the next open.
  try { return buildSummaryText(store.getDashboardSnapshot(periodDays)); }
  finally { store.releaseDashboardCaches(); }
}

function buildTrayMenu() {
  const snoozed = alertsSnoozed();
  return Menu.buildFromTemplate([
    { label: 'Open AI Usage', click: () => showMainWindow() },
    { label: 'Refresh local data', click: () => { refreshAll().catch(() => {}); } },
    { label: 'Copy usage summary', click: () => { try { clipboard.writeText(traySummary()); } catch { /* Clipboard denied. */ } } },
    { type: 'separator' },
    snoozed
      ? { label: 'Resume alerts', click: () => { setSnooze(0).catch(() => {}); } }
      : { label: 'Snooze alerts for 6 hours', click: () => { setSnooze(6).catch(() => {}); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(trayIconFor('unknown'));
  tray.setToolTip('AI Usage');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => showMainWindow());
}

let trayState = '';
let trayMenuSnoozed = null;

function updateTray(current) {
  if (!tray) return;
  const state = current?.dashboardVerdict?.state || 'unknown';
  if (state !== trayState) {
    trayState = state;
    tray.setImage(trayIconFor(state));
  }
  tray.setToolTip(buildTrayTooltip(current));
  // Only the snooze entry ever changes, so the native menu is rebuilt when
  // that flips rather than on every publish.
  const snoozed = alertsSnoozed();
  if (snoozed !== trayMenuSnoozed) {
    trayMenuSnoozed = snoozed;
    tray.setContextMenu(buildTrayMenu());
  }
  scheduleSnoozeEnd();
}

function scheduleSnoozeEnd() {
  clearTimeout(snoozeTimer);
  const until = Date.parse(store?.getSettings().alertsSnoozedUntil || "");
  if (!Number.isFinite(until) || until <= Date.now() || isQuitting) return;
  snoozeTimer = setTimeout(() => {
    if (tray && !isQuitting) {
      trayMenuSnoozed = alertsSnoozed();
      tray.setContextMenu(buildTrayMenu());
      if (trayMenuSnoozed) scheduleSnoozeEnd();
    }
  }, Math.min(2_147_483_647, Math.max(1, until - Date.now())));
  snoozeTimer.unref?.();
}

function setSnooze(hours, { push = true } = {}) {
  return databaseJobs.run(() => {
    const until = hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null;
    store.updateSettings({ alertsSnoozedUntil: until });
    const current = push && (!window || window.isDestroyed() || !window.isVisible())
      ? store.getTraySnapshot(Date.now()) : patchSnapshotSettings();
    updateTray(current);
    if (push && window && !window.isDestroyed() && window.isVisible()) window.webContents.send('dashboard:updated', current);
    return current;
  });
}

function showNotifications(current) {
  const decided = decideNotifications({
    previous: previousSnapshot,
    current,
    state: notificationState,
    nowMs: Date.now(),
  });
  notificationState = decided.state;
  saveNotificationState(notificationState);
  if (!Notification.isSupported()) return;
  for (const item of decided.notifications) {
    try {
      const toast = new Notification({ title: item.title, body: item.body });
      toast.on('click', () => showMainWindow());
      toast.show();
    } catch { /* A notification the OS refuses must not fail the refresh. */ }
  }
}

function automaticCollectionEnabled() {
  return Number(store?.getSettings().refreshIntervalMinutes) > 0;
}

// Collection used to happen only at launch and on an explicit click, so the
// pace notification could fire only while the dashboard was already open, and
// a "daily" backup was skipped on any day nobody pressed Refresh.
function scheduleAutomaticRefresh() {
  const minutes = Number(store.getSettings().refreshIntervalMinutes);
  const intervalMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
  if (intervalMs === refreshIntervalMs && (refreshTimer || intervalMs === 0)) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
  refreshIntervalMs = intervalMs;
  if (!intervalMs) return;
  refreshTimer = setInterval(() => {
    if (Date.now() - lastRefreshAt >= intervalMs) refreshAll().catch(() => {});
  }, Math.min(intervalMs, 60_000));
}

// Every setting whose effect lives outside the database is reconciled here, so
// the two write paths — the settings screen and a restore — cannot diverge, and
// so a value repaired at startup takes effect rather than only being displayed.
// The portable build runs from a temporary extraction directory, so
// process.execPath would register an autostart entry that is gone by the next
// boot; the launcher the user actually ran is what belongs there. The registry
// write is skipped when nothing changed: this runs on every settings save.
let appliedLoginItem = null;

function applyLoginItem(enabled) {
  const executable = launchEnvironment.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const key = `${enabled}|${executable}`;
  if (appliedLoginItem === key) return;
  appliedLoginItem = key;
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: executable, args: ['--hidden'] });
  } catch { /* A refused registry write must not fail the settings save. */ }
}

function applySettingsEffects() {
  // Accepted settings or restore jobs may finish while shutdown drains them.
  // Apply their saved settings on the next launch without restarting timers.
  if (isQuitting) return;
  const settings = store.getSettings();
  applyLoginItem(Boolean(settings.launchAtLogin));
  applyTheme(settings.theme);
  scheduleAutomaticRefresh();
  updateChecker?.start();
}

// `ignoreSchedule` is for the one collection a launch always earns. Turning
// automatic collection off has to silence the show and resume triggers too,
// or the setting means nothing.
function refreshIfStale({ ignoreSchedule = false } = {}) {
  if (!store || refreshPromise) return;
  if (!ignoreSchedule && !automaticCollectionEnabled()) return;
  if (Date.now() - lastRefreshAt < STALE_AFTER_MS) return;
  refreshAll().catch(() => {});
}

function createCollectors() {
  const config = {
    databasePath: store.databasePath,
    backupDirectory: store.backupDirectory,
    inboxPath: getInboxPath(),
  };
  const inline = process.env.AI_USAGE_INLINE_COLLECTORS === '1' || typeof utilityProcess?.fork !== 'function';
  if (inline) return createInlineCollectorHost(createCollectorService(config));
  return createCollectorHost({
    fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
    modulePath: path.join(__dirname, 'collector-service.cjs'),
    config,
    forkOptions: { env: { ...launchEnvironment } },
    onLog: log,
  });
}

function collectorOutcome(entry) {
  if (!entry) return { error: 'The collector did not report.' };
  if (entry.status === 'fulfilled') return entry.value;
  return { error: entry.reason?.message || 'Unknown local error.' };
}

// Everything that has to happen after collectors write: publish the new
// snapshot, then the things that can fail. A backup error used to skip the
// publish, silently freezing an open window for the life of the process.
function publishAfterWrite(current, { push = true } = {}) {
  if (push && window && !window.isDestroyed() && window.isVisible()) window.webContents.send('dashboard:updated', current);
  updateTray(current);
  try {
    showNotifications(current);
  } catch { /* Notification decisions must never fail a refresh. */ }
  previousSnapshot = current;
}

async function refreshAll() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    if (isQuitting) return { snapshot: undefined, backupError: null, collectors: {} };
    let outcomes;
    try {
      outcomes = await databaseJobs.collect(() => collectors.refreshAll());
    } catch (error) {
      const detail = `Local collection failed: ${error?.message || 'Unknown local error.'}`;
      outcomes = {
        codex: { status: 'rejected', reason: { message: detail } },
        claude: { status: 'rejected', reason: { message: detail } },
      };
    }
    // Quitting stops the collectors, which rejects the in-flight run; that is
    // not a source failure and must not be written as one for the next launch.
    if (isQuitting) return { snapshot: undefined, backupError: null, collectors: {} };
    const { codex, claude } = outcomes;
    await databaseJobs.run(() => {
      if (codex?.status === 'rejected') store.setSourceStatus('codex', 'error', `Codex refresh failed: ${codex.reason?.message || 'Unknown local error.'}`);
      if (claude?.status === 'rejected') {
        const detail = `Claude refresh failed: ${claude.reason?.message || 'Unknown local error.'}`;
        store.setSourceStatus('claude', 'error', detail);
        store.setSourceStatus('claude-fable', 'error', detail);
      }
      try {
        store.compactObservations();
      } catch { /* Housekeeping is best effort. */ }
      invalidateSnapshot();
      const updated = currentView();
      lastRefreshAt = Date.now();
      publishAfterWrite(updated);
      return updated;
    });
    let backupError = null;
    try {
      const backup = await databaseJobs.exclusive(() => maintenance.request('scheduled-backup'));
      if (backup) invalidateSnapshot();
    } catch (error) {
      backupError = error.message;
    }
    return {
      // Collection publishes once. Returning a second snapshot repeats renders
      // and could replace a newer settings or restore result.
      snapshot: undefined,
      backupError,
      collectors: {
        codex: collectorOutcome(codex),
        claude: collectorOutcome(claude),
      },
    };
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function refreshClaudeOnly() {
  if (isQuitting) return previousSnapshot;
  const outcomes = await databaseJobs.collect(() => collectors.refreshClaude());
  if (outcomes?.claude?.status === 'rejected') {
    throw new Error(outcomes.claude.reason?.message || 'Claude refresh failed.');
  }
  return databaseJobs.run(() => {
    invalidateSnapshot();
    const current = currentView();
    publishAfterWrite(current);
    return current;
  });
}

// Only the dashboard's own main frame may invoke the bridge. Every handler is
// wrapped, not just setup: a restore or helper install changes files outside
// the app, and a future embedded frame must never be able to request either.
function assertDashboardSender(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('This action is only available from the AI Usage window.');
  }
}

function handleIpc(channel, handler) {
  electronIpcMain.handle(channel, (event, ...args) => {
    assertDashboardSender(event);
    activeDashboardRequests++;
    try {
      const result = handler(event, ...args);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(() => { activeDashboardRequests--; });
      }
      activeDashboardRequests--;
      return result;
    } catch (error) {
      activeDashboardRequests--;
      throw error;
    }
  });
}

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
  handleIpc('dashboard:sleep-ready', (_event, token, allowed) => {
    // This handler itself is the one active request; the idle controller's
    // final check runs after its reply, when the count has returned to zero.
    activeDashboardRequests--;
    try { return windowIdle?.reply(token, allowed) ?? false; }
    finally { activeDashboardRequests++; }
  });
  require('./ipc-handlers.cjs').registerIpc({
    handleIpc, claudeSetup, storageClosing, getPreviousSnapshot: () => lastFullSnapshot,
    getCachedSnapshot: () => cachedSnapshot, setPeriodDays, snapshot, EMPTY_SESSION_PAGE,
    store, refreshAll, databaseJobs, invalidateSnapshot, applySettingsEffects, patchSnapshotSettings,
    updateTray, publishAfterWrite, refreshClaudeOnly, log, logRendererError, installClaudeHelper, getInboxPath,
    uninstallClaudeHelper, maintenance, dialog, getWindow: () => window, shell, app,
    buildSummaryText, currentView, clipboard, setSnooze, updateChecker, renderingMode, renderingForced,
    relaunch: () => {
      if (isQuitting) return;
      // Quit drains storage and the maintenance worker first; the new
      // instance starts once this one has exited and released its lock.
      relaunchApplication({ app, environment: launchEnvironment });
      app.quit();
    },
  });
}

function publishUpdateStatus(status) {
  if (window && !window.isDestroyed()) window.webContents.send('app:update-status-changed', status);
  if (status.status !== 'available' || !status.version || notifiedUpdates.has(status.version)) return;
  notifiedUpdates.add(status.version);
  if (Notification.isSupported()) {
    try {
      const notification = new Notification({ title: 'AI Usage update available', body: `Version ${status.version} is ready to download in Settings, under Appearance & updates.` });
      notification.on('click', () => deferredWindowReveal.request());
      notification.show();
    } catch { /* Windows notification settings must not break updates. */ }
  }
}

function stopForShutdown() {
  isQuitting = true;
  windowIdle?.cancel();
  claudeSetup?.cancel();
  clearInterval(refreshTimer);
  clearTimeout(snoozeTimer);
  clearTimeout(resumeTimer);
  refreshTimer = null;
  updateChecker?.stop();
  try { collectors?.stop(); } catch { /* Already gone. */ }
}

function storageClosing() {
  return Boolean(shutdownPromise || preparingUpdate);
}

function closeStorage() {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      await databaseJobs.close();
      try { await maintenance?.close(); } finally { store?.close(); }
      shutdownComplete = true;
    })();
  }
  return shutdownPromise;
}

async function prepareUpdateInstall() {
  if (shutdownPromise || preparingUpdate) throw new Error('Application is already closing.');
  preparingUpdate = true;
  stopForShutdown();
  // One deadline spans the drain, the backup and the close. Quit is refused
  // while this runs, so the sequence itself has to be bounded.
  const deadline = createDeadline(SHUTDOWN_TIMEOUT_MS, 'Update preparation did not finish in time.');
  let backedUp = false;
  try {
    // Freeze new writes, drain accepted work, then back up the final database
    // state. A failed backup releases the queue and resumes the application.
    await Promise.race([
      databaseJobs.prepareToClose(async () => {
        // The SQLite copy alone: the JSON export is most of a backup's time,
        // grows with the ledger, and would otherwise outgrow this deadline.
        const backup = await maintenance.request('create-backup', { exportJson: false });
        backedUp = true;
        updateLog('Safety backup complete.');
        return backup;
      }),
      deadline.expiry,
    ]);
  } catch (error) {
    updateLog(`Preparation failed${deadline.expired ? ' (timed out)' : ''}: ${error?.message || 'unknown error'}`);
    if (deadline.expired) {
      // Accepted work or the backup is still running in the worker, so writes
      // cannot safely resume and nothing may install: reopen without updating.
      recoverFromUpdateInstallFailure(backedUp
        ? 'Your safety backup has been saved, but storage did not settle in time. AI Usage will reopen without updating; please try again.'
        : 'The safety backup did not finish in time. AI Usage will reopen without updating; please try again.');
      throw Object.assign(new Error('Update preparation timed out.'), { code: 'UPDATE_BACKUP_FAILED' });
    }
    deadline.cancel();
    preparingUpdate = false;
    isQuitting = quitRequestedDuringUpdate;
    if (quitRequestedDuringUpdate) { app.quit(); throw Object.assign(new Error("Update cancelled while quitting."), { code: "UPDATE_BACKUP_FAILED" }); }
    collectors = createCollectors();
    applySettingsEffects();
    throw Object.assign(new Error('Update safety backup failed.'), { code: 'UPDATE_BACKUP_FAILED' });
  }
  if (quitRequestedDuringUpdate) {
    deadline.cancel();
    preparingUpdate = false;
    app.quit();
    throw Object.assign(new Error('Update cancelled while quitting.'), { code: 'UPDATE_BACKUP_FAILED' });
  }
  try {
    await Promise.race([closeStorage(), deadline.expiry]);
    updateLog('Storage closed; ready for the installer.');
  } catch (error) {
    if (deadline.expired) {
      // Every accepted write is drained and backed up; only the close itself
      // stalled. The installer replaces the process, so let it proceed.
      updateLog('Storage did not close in time; installing with the backup taken.');
      shutdownComplete = true;
    } else {
      updateLog(`Storage close failed: ${error?.message || 'unknown error'}`);
      recoverFromUpdateInstallFailure();
      throw error;
    }
  } finally {
    deadline.cancel();
  }
  if (quitRequestedDuringUpdate) {
    preparingUpdate = false;
    shutdownComplete = true;
    app.quit();
    throw Object.assign(new Error('Update cancelled while quitting.'), { code: 'UPDATE_BACKUP_FAILED' });
  }
}

function recoverFromUpdateInstallFailure(message = 'Your safety backup has been saved. AI Usage will reopen; please try the update again.') {
  // Storage may already be closed. Relaunch the existing version rather than
  // leave a visible dashboard attached to a closed database.
  if (!preparingUpdate) return;
  preparingUpdate = false;
  updateLog(`Recovery: ${message} Relaunching the current version.`);
  dialog.showErrorBox('AI Usage update could not start', message);
  shutdownComplete = true;
  if (!quitRequestedDuringUpdate) relaunchApplication({ app, environment: launchEnvironment });
  app.quit();
}

function loadAutoUpdater() {
  try {
    return preserveInstallerEnvironment(require('electron-updater').autoUpdater, launchEnvironment);
  } catch {
    return null;
  }
}

const isPrimaryInstance = registerSingleInstance(app, () => {
  deferredWindowReveal.request();
});

if (isPrimaryInstance) {
  void initializeWithVisibleFailure({
    initialize: async () => {
      await app.whenReady();
      const testRoot = process.env.AI_USAGE_TEST_ROOT;
      const { databasePath, backupDirectory } = storagePaths();
      store = new UsageStore(databasePath, backupDirectory);
      maintenance = createMaintenanceHost({ databasePath, backupDirectory });
      claudeSetup = createClaudeSetup({
        statePath: path.join(testRoot || app.getPath('userData'), 'claude-setup.json'),
        installHelper: () => installClaudeHelper(getInboxPath()),
        uninstallHelper: uninstallClaudeHelper,
        helperInstalled: isClaudeHelperInstalled,
        environment: launchEnvironment,
      });
      collectors = createCollectors();
      notificationState = loadNotificationState();
      updateChecker = createUpdateChecker({
        autoUpdater: loadAutoUpdater,
        enabled: () => Boolean(store.getSettings().autoUpdate),
        isPackaged: app.isPackaged,
        pkg,
        getToken: createGitHubUpdateAuth().getToken,
        beforeInstall: prepareUpdateInstall,
        onInstallError: recoverFromUpdateInstallFailure,
        launchInstaller: (options) => launchInstaller({ ...options, environment: launchEnvironment }),
        quitForInstall: () => app.quit(),
        installDirectoryWritable,
        onStatus: publishUpdateStatus,
        onLog: updateLog,
      });
      updateLog(`Application started: version ${app.getVersion()}${app.isPackaged ? '' : ' (development)'}.`);
      // The renderer is local, offline content: it needs no notification,
      // media, geolocation or other web permissions, so none are granted.
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      session.defaultSession.setPermissionCheckHandler(() => false);
      app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));
      registerIpc();
      applyTheme(store.getSettings().theme);
      if (!process.argv.includes('--hidden')) showMainWindow();
      createTray();
      updateTray(currentView());
      if (store.recoveredFrom) {
        log(`Storage: unreadable database moved to ${store.recoveredFrom}.`);
        void dialog.showMessageBox({
          type: 'warning',
          title: 'AI Usage started with an empty database',
          message: 'The local database could not be read, so it was set aside and a new one was created.',
          detail: `The unreadable file was moved to:\n${store.recoveredFrom}\n\nRestore your latest backup from Settings to bring the history back.`,
        });
      }
      nativeTheme.on('updated', () => applyWindowChrome());
      deferredWindowReveal.markReady();
      // A launch always earns one collection, whether or not automatic collection
      // is on. Showing the window fires first in practice; the staleness guard
      // makes whichever arrives second a no-op rather than a second full scan.
      setTimeout(() => refreshIfStale({ ignoreSchedule: true }), 900);
      applySettingsEffects();
      // A sleeping PC collects nothing, so waking is the moment the local records
      // are most likely to be behind.
      powerMonitor.on('resume', () => {
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => { if (!isQuitting) refreshIfStale(); }, 15_000);
        resumeTimer.unref?.();
      });
    },
    onFailure: (error) => {
      showFatalError('AI Usage could not start', 'Startup did not complete.', error);
    },
  });

  app.on('activate', () => deferredWindowReveal.request());
  app.on('window-all-closed', () => {
    // The dashboard remains available from the tray on Windows.
  });
  app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (preparingUpdate) { quitRequestedDuringUpdate = true; return; }
    if (shutdownPromise) return;
    stopForShutdown();
    // Cancel provider calls, then drain database jobs and close the maintenance
    // connection gracefully. A running backup or restore must finish before
    // Electron tears down its worker and the main SQLite handle.
    // Electron does not raise before-quit for a Windows shutdown or sign-out;
    // this bounds the tray Quit and an app-initiated quit only.
    void settleWithin(closeStorage(), SHUTDOWN_TIMEOUT_MS, 'Storage did not close in time; quitting anyway.')
      .catch((error) => log(`Shutdown: ${error.message}`))
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  });
}
