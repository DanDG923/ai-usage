'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification,
  powerMonitor, shell, Tray, utilityProcess,
} = require('electron');
const { UsageStore } = require('./store.cjs');
const { installClaudeHelper, uninstallClaudeHelper } = require('./claude-collector.cjs');
const { createCollectorHost, createInlineCollectorHost } = require('./collector-host.cjs');
const { createCollectorService } = require('./collector-service.cjs');
const { buildSummaryText, buildTrayTooltip, decideNotifications, emptyState } = require('./notifications.cjs');
const { paintStateDot } = require('./tray-icon.cjs');
const { createUpdateChecker } = require('./updater.cjs');
const {
  WINDOW_BOUNDS,
  createDeferredWindowReveal,
  initializeWithVisibleFailure,
  registerSingleInstance,
  resolveWindowTarget,
  revealWindow,
} = require('./app-lifecycle.cjs');

const pkg = require('../package.json');

if (process.env.AI_USAGE_DISABLE_GPU === '1') app.disableHardwareAcceleration();

let window;
let tray;
let store;
let collectors;
let updateChecker;
let refreshPromise;
let refreshTimer;
let lastRefreshAt = 0;
let isQuitting = false;
let periodDays = 30;
let previousSnapshot = null;
let notificationState = emptyState();
let cachedSnapshot = null;

const STALE_AFTER_MS = 5 * 60_000;
// Tab switches and settings edits ask for the snapshot far more often than it
// changes. Anything that writes clears this; the TTL bounds the drift of the
// "now"-relative fields (staleness, estimated current balance) between writes.
const SNAPSHOT_TTL_MS = 20_000;
const TRAY_SIZE = 32;

// Window chrome follows the theme the renderer paints, so the native caption
// buttons never sit on a strip of the other palette.
const CHROME = {
  dark: { background: '#0f1113', symbol: '#c8cbd0' },
  light: { background: '#f5f5f6', symbol: '#3a3d43' },
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
  return value;
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
    backgroundColor: chrome.background,
    title: 'AI Usage',
    icon: loadAppIcon() ?? undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: chrome.background,
      symbolColor: chrome.symbol,
    },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const target = resolveWindowTarget({
    isPackaged: app.isPackaged,
    devUrl: process.env.VITE_DEV_SERVER_URL,
    filePath: path.join(__dirname, '..', 'dist', 'index.html'),
  });
  const targetWindow = window;
  void loadWindowContents(targetWindow, target).catch((error) => {
    showFatalError('AI Usage could not load', 'The dashboard load failure could not be displayed.', error);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  // Reopening from the tray must never present hours-old figures as current.
  window.on('show', () => refreshIfStale());
  window.on('closed', () => { window = null; });
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

function buildTrayMenu() {
  const snoozed = alertsSnoozed();
  return Menu.buildFromTemplate([
    { label: 'Open AI Usage', click: () => showMainWindow() },
    { label: 'Refresh local data', click: () => { refreshAll().catch(() => {}); } },
    { label: 'Copy usage summary', click: () => { try { clipboard.writeText(buildSummaryText(snapshot())); } catch { /* Clipboard denied. */ } } },
    { type: 'separator' },
    snoozed
      ? { label: 'Resume alerts', click: () => { setSnooze(0); } }
      : { label: 'Snooze alerts for 6 hours', click: () => { setSnooze(6); } },
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
}

function setSnooze(hours) {
  const until = hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null;
  store.updateSettings({ alertsSnoozedUntil: until });
  invalidateSnapshot();
  const current = snapshot();
  updateTray(current);
  if (window && !window.isDestroyed()) window.webContents.send('dashboard:updated', current);
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
  clearInterval(refreshTimer);
  refreshTimer = null;
  const minutes = Number(store.getSettings().refreshIntervalMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  refreshTimer = setInterval(() => { refreshAll().catch(() => {}); }, minutes * 60_000);
}

// Every setting whose effect lives outside the database is reconciled here, so
// the two write paths — the settings screen and a restore — cannot diverge, and
// so a value repaired at startup takes effect rather than only being displayed.
function applySettingsEffects() {
  const settings = store.getSettings();
  app.setLoginItemSettings({ openAtLogin: Boolean(settings.launchAtLogin), path: process.execPath });
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
function publishAfterWrite(current) {
  if (window && !window.isDestroyed()) window.webContents.send('dashboard:updated', current);
  updateTray(current);
  try {
    showNotifications(current);
  } catch { /* Notification decisions must never fail a refresh. */ }
  previousSnapshot = current;
}

async function refreshAll() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    let outcomes;
    try {
      outcomes = await collectors.refreshAll();
    } catch (error) {
      const detail = `Local collection failed: ${error?.message || 'Unknown local error.'}`;
      outcomes = {
        codex: { status: 'rejected', reason: { message: detail } },
        claude: { status: 'rejected', reason: { message: detail } },
      };
    }
    // Quitting stops the collectors, which rejects the in-flight run; that is
    // not a source failure and must not be written as one for the next launch.
    if (isQuitting) return { snapshot: previousSnapshot, backupError: null, collectors: {} };
    const { codex, claude } = outcomes;
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
    const current = snapshot();
    lastRefreshAt = Date.now();
    publishAfterWrite(current);
    let backupError = null;
    try {
      store.maybeCreateScheduledBackup();
    } catch (error) {
      backupError = error.message;
    }
    return {
      snapshot: current,
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
  const outcomes = await collectors.refreshClaude();
  if (outcomes?.claude?.status === 'rejected') {
    throw new Error(outcomes.claude.reason?.message || 'Claude refresh failed.');
  }
  invalidateSnapshot();
  const current = snapshot();
  publishAfterWrite(current);
  return current;
}

function registerIpc() {
  ipcMain.handle('dashboard:get-snapshot', (_event, days = 30) => {
    setPeriodDays(days);
    return snapshot();
  });
  ipcMain.handle('dashboard:refresh', () => refreshAll());
  ipcMain.handle('dashboard:update-settings', (_event, patch) => {
    const settings = store.updateSettings(patch || {});
    invalidateSnapshot();
    applySettingsEffects();
    const current = snapshot();
    updateTray(current);
    return { settings, snapshot: current };
  });
  ipcMain.handle('dashboard:update-price', (_event, price) => {
    store.updatePrice(price || {});
    invalidateSnapshot();
    return { snapshot: snapshot() };
  });
  ipcMain.handle('dashboard:add-manual-observation', async (_event, observation) => {
    if (!observation || typeof observation !== 'object') throw new Error('An observation is required.');
    const sourceId = observation.sourceId;
    const usedPercent = Number(observation.usedPercent);
    const resetsAt = new Date(observation.resetsAt);
    if (!['codex', 'claude', 'claude-fable'].includes(sourceId)) throw new Error('Unknown source.');
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) throw new Error('Usage percentage must be between 0 and 100.');
    if (!Number.isFinite(resetsAt.getTime()) || resetsAt.getTime() <= Date.now()) throw new Error('Reset time must be a valid time in the future.');
    // Only the fields the renderer's form sends are accepted; bucket, window,
    // plan, and observation time are fixed here rather than taken from IPC.
    const note = typeof observation.note === 'string' ? observation.note.slice(0, 500) : null;
    store.recordObservation({
      sourceId,
      bucketId: store.getManualBucketId(sourceId),
      bucketName: sourceId === 'claude-fable' ? 'Fable 5 weekly' : 'Weekly',
      observedAt: new Date().toISOString(),
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: resetsAt.toISOString(),
      windowMinutes: 10_080,
      planType: null,
      provenance: 'manual-official',
      confidence: 0.98,
      metadata: { note, sharedWithOverall: false },
    });
    invalidateSnapshot();
    return refreshClaudeOnly();
  });
  ipcMain.handle('dashboard:install-claude-helper', async () => {
    const result = installClaudeHelper(getInboxPath());
    const current = await refreshClaudeOnly();
    return { result, snapshot: current };
  });
  ipcMain.handle('dashboard:uninstall-claude-helper', async () => {
    const result = uninstallClaudeHelper();
    const current = await refreshClaudeOnly();
    return { result, snapshot: current };
  });
  ipcMain.handle('dashboard:create-backup', () => {
    const result = store.createBackup();
    invalidateSnapshot();
    return { result, snapshot: snapshot() };
  });
  ipcMain.handle('dashboard:restore-backup', async () => {
    const chosen = await dialog.showOpenDialog(window ?? undefined, {
      title: 'Restore an AI Usage export',
      defaultPath: store.backupDirectory,
      properties: ['openFile'],
      filters: [{ name: 'AI Usage export', extensions: ['json'] }],
    });
    if (chosen.canceled || !chosen.filePaths?.length) return { cancelled: true, snapshot: snapshot() };
    // Read the export before taking the safety backup. Creating one prunes the
    // oldest sets, and the dialog opens in that very folder — so backing up
    // first could delete the file the user had just chosen.
    const payload = store.readExport(chosen.filePaths[0]);
    const safetyBackup = store.createBackup({ keep: chosen.filePaths[0] });
    const result = store.restoreFromExport(payload);
    invalidateSnapshot();
    // Restored settings are only live once their effects are reapplied, and
    // restored history means nothing until the sources describe themselves.
    applySettingsEffects();
    const refreshed = await refreshAll().catch(() => null);
    return { cancelled: false, result, safetyBackup, snapshot: refreshed?.snapshot ?? snapshot() };
  });
  ipcMain.handle('dashboard:open-backup-directory', async () => {
    const error = await shell.openPath(store.backupDirectory);
    if (error) throw new Error(`Windows could not open the backup folder: ${error}`);
  });
  ipcMain.handle('dashboard:export-csv', async (_event, days = 90) => {
    const period = Math.min(365, Math.max(1, Math.round(Number(days)) || 90));
    const stamp = new Date().toISOString().slice(0, 10);
    const chosen = await dialog.showSaveDialog(window ?? undefined, {
      title: 'Export the token ledger',
      defaultPath: path.join(app.getPath('documents'), `ai-usage-ledger-${stamp}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (chosen.canceled || !chosen.filePath) return { cancelled: true };
    const exported = store.exportLedgerCsv(period);
    fs.writeFileSync(chosen.filePath, exported.csv, 'utf8');
    return { cancelled: false, filePath: chosen.filePath, rows: exported.rows, days: period };
  });
  ipcMain.handle('dashboard:copy-summary', () => {
    const text = buildSummaryText(snapshot());
    clipboard.writeText(text);
    return { text };
  });
  ipcMain.handle('dashboard:snooze-alerts', (_event, hours) => {
    const parsed = Number(hours);
    setSnooze(Number.isFinite(parsed) && parsed > 0 ? Math.min(72, parsed) : 0);
    return { snapshot: snapshot() };
  });
  ipcMain.handle('app:get-version', () => app.getVersion());
  ipcMain.handle('app:check-updates', async () => {
    if (!updateChecker) return { status: 'unavailable', available: false };
    await updateChecker.check();
    return updateChecker.status();
  });
  ipcMain.handle('app:update-status', () => (updateChecker ? updateChecker.status() : { status: 'unavailable', available: false }));
}

function loadAutoUpdater() {
  try {
    return require('electron-updater').autoUpdater;
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
      const databasePath = testRoot ? path.join(testRoot, 'ai-usage.sqlite') : path.join(app.getPath('userData'), 'ai-usage.sqlite');
      const backupDirectory = testRoot ? path.join(testRoot, 'Backups') : path.join(app.getPath('documents'), 'AI Usage', 'Backups');
      store = new UsageStore(databasePath, backupDirectory);
      collectors = createCollectors();
      notificationState = loadNotificationState();
      updateChecker = createUpdateChecker({
        autoUpdater: loadAutoUpdater(),
        enabled: () => Boolean(store.getSettings().autoUpdate),
        isPackaged: app.isPackaged,
        pkg,
        onLog: log,
      });
      registerIpc();
      applyTheme(store.getSettings().theme);
      createWindow();
      createTray();
      updateTray(snapshot());
      nativeTheme.on('updated', () => applyWindowChrome());
      deferredWindowReveal.markReady();
      // A launch always earns one collection, whether or not automatic collection
      // is on. Showing the window fires first in practice; the staleness guard
      // makes whichever arrives second a no-op rather than a second full scan.
      setTimeout(() => refreshIfStale({ ignoreSchedule: true }), 900);
      applySettingsEffects();
      // A sleeping PC collects nothing, so waking is the moment the local records
      // are most likely to be behind.
      powerMonitor.on('resume', () => refreshIfStale());
    },
    onFailure: (error) => {
      showFatalError('AI Usage could not start', 'Startup did not complete.', error);
    },
  });

  app.on('activate', () => deferredWindowReveal.request());
  app.on('window-all-closed', () => {
    // The dashboard remains available from the tray on Windows.
  });
  app.on('before-quit', () => {
    isQuitting = true;
    clearInterval(refreshTimer);
    refreshTimer = null;
    updateChecker?.stop();
    // The collector process owns its own database handle; stopping it first
    // means no write can land after the main handle closes.
    try { collectors?.stop(); } catch { /* Already gone. */ }
    if (store && !refreshPromise) store.close();
  });
}
