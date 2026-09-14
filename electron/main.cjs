'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app, BrowserWindow, clipboard, dialog, ipcMain: electronIpcMain, Menu, nativeImage, nativeTheme, Notification,
  powerMonitor, session, shell, Tray, utilityProcess,
} = require('electron');
const { UsageStore } = require('./store.cjs');
const { installClaudeHelper, uninstallClaudeHelper, isClaudeHelperInstalled, rederiveFableEstimate } = require('./claude-collector.cjs');
const { createClaudeSetup } = require('./claude-setup.cjs');
const { createCollectorHost, createInlineCollectorHost } = require('./collector-host.cjs');
const { createCollectorService } = require('./collector-service.cjs');
const { createMaintenanceHost, createDatabaseQueue } = require('./maintenance-host.cjs');
const { buildSummaryText, buildTrayTooltip, decideNotifications, emptyState } = require('./notifications.cjs');
const { paintStateDot } = require('./tray-icon.cjs');
const { createUpdateChecker } = require('./updater.cjs');
const { installDirectoryWritable, launchInstaller } = require('./installer-launch.cjs');
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

if (process.env.AI_USAGE_DISABLE_GPU === '1') app.disableHardwareAcceleration();

let window;
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
let shutdownPromise;
let shutdownComplete = false;
let preparingUpdate = false;
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
  hardenWebContents(window.webContents);
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
}

function setSnooze(hours) {
  return databaseJobs.run(() => {
    const until = hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null;
    store.updateSettings({ alertsSnoozedUntil: until });
    invalidateSnapshot();
    const current = snapshot();
    updateTray(current);
    if (window && !window.isDestroyed()) window.webContents.send('dashboard:updated', current);
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
  clearInterval(refreshTimer);
  refreshTimer = null;
  const minutes = Number(store.getSettings().refreshIntervalMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  refreshTimer = setInterval(() => { refreshAll().catch(() => {}); }, minutes * 60_000);
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
    app.setLoginItemSettings({ openAtLogin: enabled, path: executable });
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
    if (isQuitting) return { snapshot: previousSnapshot, backupError: null, collectors: {} };
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
    if (isQuitting) return { snapshot: previousSnapshot, backupError: null, collectors: {} };
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
      const updated = snapshot();
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
      // Settings or a restore may have landed while the scheduled backup
      // waited for other collectors. Never return an older published view.
      snapshot: isQuitting ? previousSnapshot : snapshot(),
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
  if (isQuitting) return snapshot();
  const outcomes = await databaseJobs.collect(() => collectors.refreshClaude());
  if (outcomes?.claude?.status === 'rejected') {
    throw new Error(outcomes.claude.reason?.message || 'Claude refresh failed.');
  }
  return databaseJobs.run(() => {
    invalidateSnapshot();
    const current = snapshot();
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
    return handler(event, ...args);
  });
}

function hardenWebContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function registerIpc() {
  handleIpc('claude-setup:status', () => claudeSetup.status());
  handleIpc('claude-setup:dismissed', () => claudeSetup.dismissed());
  handleIpc('claude-setup:cancel', () => { claudeSetup.cancel(); });
  handleIpc('claude-setup:configure', async (_event, action, enableHelper) => {
    switch (action) {
      case 'check': return claudeSetup.status();
      case 'install': return claudeSetup.install();
      case 'login': return claudeSetup.login();
      case 'finish': return claudeSetup.finish({ enableHelper: enableHelper === true });
      case 'skip': claudeSetup.skip(); return claudeSetup.status();
      default: throw new Error('Unknown Claude setup step.');
    }
  });
  handleIpc('dashboard:get-snapshot', (_event, days = 30) => {
    // The window outlives the database handle briefly while an update installs.
    if (storageClosing()) return previousSnapshot ?? cachedSnapshot?.value ?? null;
    setPeriodDays(days);
    return snapshot();
  });
  const pageOptions = (options) => (options && typeof options === 'object' ? options : {});
  handleIpc('dashboard:get-sessions', (_event, options) => (storageClosing() ? EMPTY_SESSION_PAGE : store.getSessionPage(pageOptions(options))));
  handleIpc('dashboard:get-tasks', (_event, options) => (storageClosing() ? EMPTY_SESSION_PAGE : store.getTaskPage(pageOptions(options))));
  handleIpc('dashboard:refresh', () => refreshAll());
  handleIpc('dashboard:update-settings', (_event, patch) => databaseJobs.run(() => {
    const before = JSON.stringify(store.getSettings().allowanceChanges);
    const settings = store.updateSettings(patch || {});
    // Allowance changes rescale the Claude history the local Fable estimate is
    // built from; the persisted estimate must follow the setting immediately.
    if (JSON.stringify(settings.allowanceChanges) !== before) rederiveFableEstimate(store);
    invalidateSnapshot();
    applySettingsEffects();
    const current = snapshot();
    updateTray(current);
    return { settings, snapshot: current };
  }));
  handleIpc('dashboard:update-price', (_event, price) => databaseJobs.run(() => {
    store.updatePrice(price || {});
    invalidateSnapshot();
    return { snapshot: snapshot() };
  }));
  handleIpc('dashboard:add-manual-observation', async (_event, observation) => {
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
    const current = await databaseJobs.run(() => {
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
      const saved = snapshot();
      publishAfterWrite(saved);
      return saved;
    });
    // The observation is committed. Provider availability must not turn that
    // successful save into an error or hold the form open for a network call.
    // Claude's derived view refreshes through the normal snapshot push.
    if (sourceId !== 'codex') void refreshClaudeOnly().catch((error) => log(`Refresh after manual observation: ${error.message}`));
    return current;
  });
  handleIpc('dashboard:install-claude-helper', async () => {
    const result = installClaudeHelper(getInboxPath());
    const current = await refreshClaudeOnly();
    return { result, snapshot: current };
  });
  handleIpc('dashboard:uninstall-claude-helper', async () => {
    const result = uninstallClaudeHelper();
    const current = await refreshClaudeOnly();
    return { result, snapshot: current };
  });
  handleIpc('dashboard:create-backup', () => databaseJobs.exclusive(async () => {
    const result = await maintenance.request('create-backup');
    invalidateSnapshot();
    return { result, snapshot: snapshot() };
  }));
  handleIpc('dashboard:restore-backup', async () => {
    const chosen = await dialog.showOpenDialog(window ?? undefined, {
      title: 'Restore an AI Usage export',
      defaultPath: store.backupDirectory,
      properties: ['openFile'],
      filters: [{ name: 'AI Usage export', extensions: ['json'] }],
    });
    if (chosen.canceled || !chosen.filePaths?.length) return { cancelled: true, snapshot: snapshot() };
    const { result, safetyBackup } = await databaseJobs.exclusive(async () => {
      const restored = await maintenance.request('restore-backup', { filePath: chosen.filePaths[0] });
      invalidateSnapshot();
      // Settings effects belong in the main process. Publish immediately so
      // imported history appears while the sources refresh in the background.
      applySettingsEffects();
      publishAfterWrite(snapshot());
      return restored;
    });
    const refreshed = await refreshAll().catch(() => null);
    return { cancelled: false, result, safetyBackup, snapshot: refreshed?.snapshot ?? snapshot() };
  });
  handleIpc('dashboard:open-backup-directory', async () => {
    const error = await shell.openPath(store.backupDirectory);
    if (error) throw new Error(`Windows could not open the backup folder: ${error}`);
  });
  handleIpc('dashboard:preview-desktop-export', async () => {
    const chosen = await dialog.showOpenDialog(window ?? undefined, {
      title: 'Choose conversations.json from your Claude export', properties: ['openFile'],
      filters: [{ name: 'Claude conversation export', extensions: ['json'] }],
    });
    if (chosen.canceled || !chosen.filePaths?.length) return null;
    return databaseJobs.exclusive(() => maintenance.request('preview-desktop-export', { filePath: chosen.filePaths[0] }));
  });
  handleIpc('dashboard:cancel-desktop-export', async (_event, previewId) => {
    await maintenance.request('cancel-desktop-export', { previewId });
  });
  handleIpc('dashboard:import-desktop-export', async (_event, previewId, assumedModel) => {
    if (typeof previewId !== 'string' || previewId.length > 100
      || (assumedModel != null && (typeof assumedModel !== 'string' || assumedModel.length > 120))) {
      throw new Error('Invalid desktop import selection.');
    }
    return databaseJobs.exclusive(async () => {
      const result = await maintenance.request('import-desktop-export', { previewId, assumedModel });
      invalidateSnapshot();
      const current = snapshot();
      publishAfterWrite(current);
      return { result, snapshot: current };
    });
  });
  handleIpc('dashboard:clear-desktop-estimates', async () => {
    const choice = await dialog.showMessageBox(window ?? undefined, {
      type: 'question', title: 'Remove imported chat estimates?',
      message: 'Remove all imported Claude chat estimates?',
      detail: 'A backup is created first. Recorded token usage and quota history are kept.',
      buttons: ['Cancel', 'Remove estimates'], defaultId: 0, cancelId: 0,
    });
    if (choice.response !== 1) return { cancelled: true, snapshot: snapshot() };
    return databaseJobs.exclusive(async () => {
      await maintenance.request('clear-desktop-estimates');
      invalidateSnapshot();
      const current = snapshot();
      publishAfterWrite(current);
      return { cancelled: false, snapshot: current };
    });
  });
  handleIpc('dashboard:export-csv', async (_event, days = 90) => {
    const period = Math.min(365, Math.max(1, Math.round(Number(days)) || 90));
    const stamp = new Date().toISOString().slice(0, 10);
    const chosen = await dialog.showSaveDialog(window ?? undefined, {
      title: 'Export the token ledger',
      defaultPath: path.join(app.getPath('documents'), `ai-usage-ledger-${stamp}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (chosen.canceled || !chosen.filePath) return { cancelled: true };
    const exported = await databaseJobs.exclusive(() => maintenance.request('export-csv', { filePath: chosen.filePath, days: period }));
    return { cancelled: false, ...exported };
  });
  handleIpc('dashboard:copy-summary', () => {
    const text = buildSummaryText(snapshot());
    clipboard.writeText(text);
    return { text };
  });
  handleIpc('dashboard:snooze-alerts', async (_event, hours) => {
    const parsed = Number(hours);
    const current = await setSnooze(Number.isFinite(parsed) && parsed > 0 ? Math.min(72, parsed) : 0);
    return { snapshot: current };
  });
  handleIpc('app:get-version', () => app.getVersion());
  handleIpc('app:check-updates', async () => {
    if (!updateChecker) return { status: 'unavailable', available: false };
    await updateChecker.check();
    return updateChecker.status();
  });
  handleIpc('app:update-status', () => (updateChecker ? updateChecker.status() : { status: 'unavailable', available: false }));
  handleIpc('app:download-update', () => updateChecker?.download() || { status: 'unavailable', available: false });
  handleIpc('app:install-update', () => updateChecker?.install() || { status: 'unavailable', available: false });
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
  claudeSetup?.cancel();
  clearInterval(refreshTimer);
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
        const backup = await maintenance.request('create-backup');
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
    isQuitting = false;
    collectors = createCollectors();
    applySettingsEffects();
    throw Object.assign(new Error('Update safety backup failed.'), { code: 'UPDATE_BACKUP_FAILED' });
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
      return;
    }
    updateLog(`Storage close failed: ${error?.message || 'unknown error'}`);
    recoverFromUpdateInstallFailure();
    throw error;
  } finally {
    deadline.cancel();
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
  app.relaunch();
  app.quit();
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
        autoUpdater: loadAutoUpdater(),
        enabled: () => Boolean(store.getSettings().autoUpdate),
        isPackaged: app.isPackaged,
        pkg,
        getToken: createGitHubUpdateAuth().getToken,
        beforeInstall: prepareUpdateInstall,
        onInstallError: recoverFromUpdateInstallFailure,
        launchInstaller,
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
      createWindow();
      createTray();
      updateTray(snapshot());
      if (store.recoveredFrom) {
        log(`Storage: unreadable database moved to ${store.recoveredFrom}.`);
        void dialog.showMessageBox({
          type: 'warning',
          title: 'AI Usage started with an empty database',
          message: 'The local database could not be read, so it was set aside and a new one was created.',
          detail: `The unreadable file was moved to:\n${store.recoveredFrom}\n\nRestore your latest export from Settings to bring the history back.`,
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
  app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (preparingUpdate) return;
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
