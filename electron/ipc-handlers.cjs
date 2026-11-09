'use strict';

const path = require('node:path');
const { CLAUDE, providerById } = require('./providers.mjs');
const { REFRESH_TRIGGERS, refreshOptionsFor } = require('./refresh-policy.cjs');

/** @typedef {import('./app/application.cjs').Application} Application */
/** @typedef {import('electron').BrowserWindow} BrowserWindow */

/**
 * What the dashboard's channels reach. electron/app/ipc.cjs builds it from the
 * application once the store and the services exist, which is why the Claude
 * Code mod is always present here.
 *
 * @typedef {object} IpcContext
 * @property {Application['ipc']['handleIpc']} handleIpc
 * @property {import('electron').App} app
 * @property {import('electron').Clipboard} clipboard
 * @property {import('electron').Dialog} dialog
 * @property {import('electron').Shell} shell
 * @property {import('./types').Store} store
 * @property {Application['maintenance']} maintenance
 * @property {Application['databaseJobs']} databaseJobs
 * @property {Application['claudeSetup']} claudeSetup
 * @property {NonNullable<Application['claudeCodeMod']>} claudeCodeMod
 * @property {Application['updateChecker']} updateChecker absent in a build that cannot update
 * @property {typeof import('./claude-collector.cjs').installClaudeHelper} installClaudeHelper
 * @property {typeof import('./claude-collector.cjs').uninstallClaudeHelper} uninstallClaudeHelper
 * @property {typeof import('./notifications.cjs').buildSummaryText} buildSummaryText
 * @property {Readonly<import('./types').SessionPage>} EMPTY_SESSION_PAGE what a page request gets while storage is closing
 * @property {() => Application['dashboard']['window']} getWindow
 * @property {Application['paths']['getInboxPath']} getInboxPath
 * @property {Application['logs']['log']} log
 * @property {Application['logs']['logRendererError']} logRendererError
 * @property {Application['snapshots']['snapshot']} snapshot
 * @property {Application['snapshots']['currentView']} currentView
 * @property {Application['snapshots']['setPeriodDays']} setPeriodDays
 * @property {Application['snapshots']['invalidateSnapshot']} invalidateSnapshot
 * @property {Application['snapshots']['patchSnapshotSettings']} patchSnapshotSettings
 * @property {() => Application['snapshots']['cachedSnapshot']} getCachedSnapshot
 * @property {() => Application['snapshots']['lastFullSnapshot']} getPreviousSnapshot
 * @property {Application['refresh']['refreshAll']} refreshAll
 * @property {Application['refresh']['refreshClaudeOnly']} refreshClaudeOnly
 * @property {Application['refresh']['publishAfterWrite']} publishAfterWrite
 * @property {Application['tray']['updateTray']} updateTray
 * @property {Application['tray']['setSnooze']} setSnooze
 * @property {Application['lifecycle']['storageClosing']} storageClosing
 * @property {Application['lifecycle']['applySettingsEffects']} applySettingsEffects
 * @property {Application['lifecycle']['renderingMode']} renderingMode
 * @property {Application['lifecycle']['renderingForced']} renderingForced
 * @property {() => void} relaunch
 */

// What a renderer sends arrives as `unknown` (see IpcHandler in
// electron/app/ipc.cjs), so each handler below checks an argument before it
// uses it, or hands it to a store function that does.

/** @param {IpcContext} context */
function registerIpc(context) {
  const {
    handleIpc, claudeSetup, storageClosing, getPreviousSnapshot, getCachedSnapshot,
    setPeriodDays, snapshot, EMPTY_SESSION_PAGE, store, refreshAll, databaseJobs,
    invalidateSnapshot, applySettingsEffects, patchSnapshotSettings, updateTray,
    publishAfterWrite, refreshClaudeOnly, log, logRendererError, installClaudeHelper,
    getInboxPath, uninstallClaudeHelper, claudeCodeMod, maintenance, dialog, getWindow, shell, app,
    buildSummaryText, currentView, clipboard, setSnooze, updateChecker, renderingMode, renderingForced, relaunch,
  } = context;
  handleIpc('claude-setup:status', () => claudeSetup.status());
  handleIpc('claude-setup:dismissed', () => claudeSetup.dismissed());
  handleIpc('claude-setup:cancel', () => { claudeSetup.cancel(); });
  handleIpc('claude-setup:configure', async (_event, action, enableHelper) => {
    switch (action) {
      case 'check': return claudeSetup.status();
      case 'install': return claudeSetup.install();
      case 'login': return claudeSetup.login();
      case 'finish': {
        const finished = await claudeSetup.finish({ enableHelper: enableHelper === true });
        // Finishing setup is not a refresh request: import local Claude activity
        // (and the helper inbox) now, but never read plan usage.
        void refreshClaudeOnly().catch((error) => log(`Refresh after Claude setup: ${error.message}`));
        return finished;
      }
      case 'skip': claudeSetup.skip(); return claudeSetup.status();
      default: throw new Error('Unknown Claude setup step.');
    }
  });
  handleIpc('dashboard:get-snapshot', (_event, days = 30) => {
    // The window outlives the database handle briefly while an update installs.
    if (storageClosing()) return getCachedSnapshot()?.value ?? getPreviousSnapshot() ?? null;
    // A failed read keeps the previous period. The renderer stays on it, and
    // every later update would otherwise be built for the period it rejected.
    const previous = setPeriodDays();
    setPeriodDays(days);
    try {
      return snapshot();
    } catch (error) {
      setPeriodDays(previous);
      throw error;
    }
  });
  /** @param {unknown} options */
  const pageOptions = (options) => (options && typeof options === 'object' ? options : {});
  handleIpc('dashboard:get-sessions', (_event, options) => (storageClosing() ? EMPTY_SESSION_PAGE : store.getSessionPage(pageOptions(options))));
  handleIpc('dashboard:get-tasks', (_event, options) => (storageClosing() ? EMPTY_SESSION_PAGE : store.getTaskPage(pageOptions(options))));
  // The dashboard's Refresh button: an explicit request, so it reads Claude plan usage.
  handleIpc('dashboard:refresh', () => refreshAll(refreshOptionsFor(REFRESH_TRIGGERS.DASHBOARD_REFRESH)));
  handleIpc('dashboard:update-settings', (_event, patch) => databaseJobs.run(() => {
    const settings = store.updateSettings(patch || {});
    // The Fable estimate is projected when the snapshot is built, so a saved
    // allowance change is reflected by the very next snapshot.
    // The refresh interval is not cheap: it sets how long a lower status-line
    // reading waits for confirmation, which the forecasts depend on.
    const cheapSettings = new Set(['theme', 'notifyDesktop', 'notifyResets', 'notifyFallback', 'notifyDigest', 'digestHour', 'alertsSnoozedUntil', 'autoUpdate', 'launchAtLogin', 'softwareRendering']);
    const affectsSnapshot = Object.keys(patch || {}).some((key) => !cheapSettings.has(key));
    if (affectsSnapshot) invalidateSnapshot();
    applySettingsEffects();
    const current = affectsSnapshot ? snapshot() : patchSnapshotSettings();
    updateTray(current);
    return { settings, snapshot: current };
  }));
  handleIpc('dashboard:update-price', (_event, price) => databaseJobs.run(() => {
    // The store checks every field of a price and refuses one it cannot use.
    store.updatePrice(/** @type {Parameters<typeof store.updatePrice>[0]} */ (price || {}));
    invalidateSnapshot();
    return { snapshot: snapshot() };
  }));
  // The observation is taken apart field by field, each checked before use.
  handleIpc('dashboard:add-manual-observation', async (_event, /** @type {any} */ observation) => {
    if (!observation || typeof observation !== 'object') throw new Error('An observation is required.');
    const provider = providerById(observation.sourceId);
    const usedPercent = Number(observation.usedPercent);
    const resetsAt = new Date(observation.resetsAt);
    if (!provider) throw new Error('Unknown source.');
    const sourceId = provider.id;
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) throw new Error('Usage percentage must be between 0 and 100.');
    if (!Number.isFinite(resetsAt.getTime()) || resetsAt.getTime() <= Date.now()) throw new Error('Reset time must be a valid time in the future.');
    // Only the fields the renderer's form sends are accepted; bucket, window,
    // plan, and observation time are fixed here rather than taken from IPC.
    const note = typeof observation.note === 'string' ? observation.note.slice(0, 500) : null;
    const current = await databaseJobs.run(() => {
      store.recordObservation({
        sourceId,
        bucketId: store.getManualBucketId(sourceId),
        bucketName: provider.weeklyBucketName,
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
      publishAfterWrite(saved, { push: false });
      return saved;
    });
    // The observation is committed. Provider availability must not turn that
    // successful save into an error or hold the form open for a network call.
    // Claude's derived view refreshes through the normal snapshot push. A
    // Fable entry counts: the Claude collector derives Fable's view too.
    if (provider.collector === CLAUDE.collector) void refreshClaudeOnly().catch((error) => log(`Refresh after manual observation: ${error.message}`));
    return current;
  });
  handleIpc('dashboard:install-claude-helper', async () => {
    const result = installClaudeHelper(getInboxPath());
    void refreshClaudeOnly().catch((error) => log(`Refresh after helper change: ${error.message}`));
    return { result };
  });
  handleIpc('dashboard:uninstall-claude-helper', async () => {
    const result = uninstallClaudeHelper();
    void refreshClaudeOnly().catch((error) => log(`Refresh after helper change: ${error.message}`));
    return { result };
  });
  // The Claude Code mod. Installing runs the user's own `claude plugin`
  // commands; the collection after it writes the first glance.
  handleIpc('claude-code-mod:status', () => claudeCodeMod.status());
  handleIpc('claude-code-mod:install', async () => {
    const status = await claudeCodeMod.install();
    // The first glance comes from what the app already shows, so the mod has
    // figures even if the collection after it fails.
    if (!storageClosing()) {
      try {
        await databaseJobs.run(() => claudeCodeMod.publish(currentView()));
      } catch (error) {
        log(`Claude Code glance after install: ${/** @type {Error | null | undefined} */ (error)?.message}`);
      }
    }
    void refreshClaudeOnly().catch((error) => log(`Refresh after the Claude Code mod was installed: ${error.message}`));
    return status;
  });
  handleIpc('claude-code-mod:uninstall', () => claudeCodeMod.uninstall());
  handleIpc('dashboard:create-backup', () => databaseJobs.exclusive(async () => {
    const result = await maintenance.request('create-backup');
    invalidateSnapshot();
    return { result };
  }));
  handleIpc('dashboard:restore-backup', async () => {
    // Electron shows a dialog without a parent when the window is missing.
    const chosen = await dialog.showOpenDialog(/** @type {BrowserWindow} */ (getWindow() ?? undefined), {
      title: 'Restore an AI Usage backup',
      defaultPath: store.backupDirectory,
      properties: ['openFile'],
      // A .sqlite backup restores any ledger size; exports stop at 64 MB.
      filters: [{ name: 'AI Usage backup', extensions: ['sqlite', 'gz', 'json'] }],
    });
    if (chosen.canceled || !chosen.filePaths?.length) return { cancelled: true };
    const { result, safetyBackup } = await databaseJobs.exclusive(async () => {
      const restored = await maintenance.request('restore-backup', { filePath: chosen.filePaths[0] });
      invalidateSnapshot();
      // Settings effects belong in the main process. Publish immediately so
      // imported history appears while the sources refresh in the background.
      applySettingsEffects();
      publishAfterWrite(snapshot(), { push: false });
      return restored;
    });
    const current = snapshot();
    // Automatic: the user asked for a restore, not for plan usage to be read.
    void refreshAll(refreshOptionsFor(REFRESH_TRIGGERS.BACKUP_RESTORE)).catch((error) => log(`Refresh after restore: ${error.message}`));
    return { cancelled: false, result, safetyBackup, snapshot: current };
  });
  handleIpc('dashboard:open-backup-directory', async () => {
    const error = await shell.openPath(store.backupDirectory);
    if (error) throw new Error(`Windows could not open the backup folder: ${error}`);
  });
  handleIpc('dashboard:preview-desktop-export', async () => {
    // Electron shows a dialog without a parent when the window is missing.
    const chosen = await dialog.showOpenDialog(/** @type {BrowserWindow} */ (getWindow() ?? undefined), {
      title: 'Choose conversations.json from your Claude export', properties: ['openFile'],
      filters: [{ name: 'Claude conversation export', extensions: ['json'] }],
    });
    if (chosen.canceled || !chosen.filePaths?.length) return null;
    return maintenance.request('preview-desktop-export', { filePath: chosen.filePaths[0] });
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
      publishAfterWrite(current, { push: false });
      return { result, snapshot: current };
    });
  });
  handleIpc('dashboard:clear-desktop-estimates', async () => {
    // Electron shows a dialog without a parent when the window is missing.
    const choice = await dialog.showMessageBox(/** @type {BrowserWindow} */ (getWindow() ?? undefined), {
      type: 'question', title: 'Remove imported chat estimates?',
      message: 'Remove all imported Claude chat estimates?',
      detail: 'A backup is created first. Recorded token usage and quota history are kept.',
      buttons: ['Cancel', 'Remove estimates'], defaultId: 0, cancelId: 0,
    });
    if (choice.response !== 1) return { cancelled: true };
    return databaseJobs.exclusive(async () => {
      await maintenance.request('clear-desktop-estimates');
      invalidateSnapshot();
      const current = snapshot();
      publishAfterWrite(current, { push: false });
      return { cancelled: false, snapshot: current };
    });
  });
  handleIpc('dashboard:export-csv', async (_event, days = 90) => {
    const period = Math.min(365, Math.max(1, Math.round(Number(days)) || 90));
    const stamp = new Date().toISOString().slice(0, 10);
    // Electron shows a dialog without a parent when the window is missing.
    const chosen = await dialog.showSaveDialog(/** @type {BrowserWindow} */ (getWindow() ?? undefined), {
      title: 'Export the token ledger',
      defaultPath: path.join(app.getPath('documents'), `ai-usage-ledger-${stamp}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (chosen.canceled || !chosen.filePath) return { cancelled: true };
    const exported = await maintenance.request('export-csv', { filePath: chosen.filePath, days: period });
    return { cancelled: false, ...exported };
  });
  handleIpc('dashboard:copy-summary', () => {
    const text = buildSummaryText(snapshot());
    clipboard.writeText(text);
    return { text };
  });
  handleIpc('dashboard:snooze-alerts', async (_event, hours) => {
    const parsed = Number(hours);
    const current = await setSnooze(Number.isFinite(parsed) && parsed > 0 ? Math.min(72, parsed) : 0, { push: false });
    return { snapshot: current };
  });
  // Both fields are checked to be text before anything is logged.
  handleIpc('app:renderer-error', (_event, /** @type {any} */ detail) => {
    if (!detail || typeof detail.message !== 'string' || (detail.componentStack != null && typeof detail.componentStack !== 'string')) throw new Error('Invalid renderer error.');
    logRendererError(`Renderer error: ${detail.message.slice(0, 1000).replace(/[\r\n]+/g, ' ')} ${String(detail.componentStack || '').slice(0, 3000).replace(/[\r\n]+/g, ' ')}`);
  });
  handleIpc('app:get-version', () => app.getVersion());
  // Chromium fixes the rendering path at launch; the renderer compares the
  // saved preference with the running instance to offer a restart. An
  // environment override wins on every launch, so a restart could not apply
  // the preference and the renderer must not offer one.
  handleIpc('app:rendering-mode', () => ({
    active: renderingMode === 'software' ? 'software' : 'hardware',
    requested: store.getSettings().softwareRendering ? 'software' : 'hardware',
    forced: Boolean(renderingForced),
  }));
  handleIpc('app:relaunch', () => { relaunch(); });
  handleIpc('app:check-updates', async () => {
    if (!updateChecker) return { status: 'unavailable', available: false };
    await updateChecker.check();
    return updateChecker.status();
  });
  handleIpc('app:update-status', () => (updateChecker ? updateChecker.status() : { status: 'unavailable', available: false }));
  handleIpc('app:download-update', () => updateChecker?.download() || { status: 'unavailable', available: false });
  handleIpc('app:install-update', () => updateChecker?.install() || { status: 'unavailable', available: false });
}

module.exports = { registerIpc };
