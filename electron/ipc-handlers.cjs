'use strict';

const path = require('node:path');

function registerIpc(context) {
  const {
    handleIpc, claudeSetup, storageClosing, getPreviousSnapshot, getCachedSnapshot,
    setPeriodDays, snapshot, EMPTY_SESSION_PAGE, store, refreshAll, databaseJobs,
    invalidateSnapshot, applySettingsEffects, patchSnapshotSettings, updateTray,
    publishAfterWrite, refreshClaudeOnly, log, logRendererError, installClaudeHelper,
    getInboxPath, uninstallClaudeHelper, maintenance, dialog, getWindow, shell, app,
    buildSummaryText, clipboard, setSnooze, updateChecker, renderingMode, renderingForced, relaunch,
  } = context;
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
    if (storageClosing()) return getCachedSnapshot()?.value ?? getPreviousSnapshot() ?? null;
    setPeriodDays(days);
    return snapshot();
  });
  const pageOptions = (options) => (options && typeof options === 'object' ? options : {});
  handleIpc('dashboard:get-sessions', (_event, options) => (storageClosing() ? EMPTY_SESSION_PAGE : store.getSessionPage(pageOptions(options))));
  handleIpc('dashboard:get-tasks', (_event, options) => (storageClosing() ? EMPTY_SESSION_PAGE : store.getTaskPage(pageOptions(options))));
  handleIpc('dashboard:refresh', () => refreshAll());
  handleIpc('dashboard:update-settings', (_event, patch) => databaseJobs.run(() => {
    const settings = store.updateSettings(patch || {});
    // The Fable estimate is projected when the snapshot is built, so a saved
    // allowance change is reflected by the very next snapshot.
    const cheapSettings = new Set(['theme', 'notifyDesktop', 'notifyResets', 'notifyFallback', 'dailyDigest', 'dailyDigestHour', 'alertsSnoozedUntil', 'autoUpdate', 'launchAtLogin', 'refreshIntervalMinutes', 'softwareRendering']);
    const affectsSnapshot = Object.keys(patch || {}).some((key) => !cheapSettings.has(key));
    if (affectsSnapshot) invalidateSnapshot();
    applySettingsEffects();
    const current = affectsSnapshot ? snapshot() : patchSnapshotSettings();
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
      publishAfterWrite(saved, { push: false });
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
    void refreshClaudeOnly().catch((error) => log(`Refresh after helper change: ${error.message}`));
    return { result };
  });
  handleIpc('dashboard:uninstall-claude-helper', async () => {
    const result = uninstallClaudeHelper();
    void refreshClaudeOnly().catch((error) => log(`Refresh after helper change: ${error.message}`));
    return { result };
  });
  handleIpc('dashboard:create-backup', () => databaseJobs.exclusive(async () => {
    const result = await maintenance.request('create-backup');
    invalidateSnapshot();
    return { result };
  }));
  handleIpc('dashboard:restore-backup', async () => {
    const chosen = await dialog.showOpenDialog(getWindow() ?? undefined, {
      title: 'Restore an AI Usage export',
      defaultPath: store.backupDirectory,
      properties: ['openFile'],
      filters: [{ name: 'AI Usage export', extensions: ['json', 'gz'] }],
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
    void refreshAll().catch((error) => log(`Refresh after restore: ${error.message}`));
    return { cancelled: false, result, safetyBackup, snapshot: current };
  });
  handleIpc('dashboard:open-backup-directory', async () => {
    const error = await shell.openPath(store.backupDirectory);
    if (error) throw new Error(`Windows could not open the backup folder: ${error}`);
  });
  handleIpc('dashboard:preview-desktop-export', async () => {
    const chosen = await dialog.showOpenDialog(getWindow() ?? undefined, {
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
    const choice = await dialog.showMessageBox(getWindow() ?? undefined, {
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
    const chosen = await dialog.showSaveDialog(getWindow() ?? undefined, {
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
  handleIpc('app:renderer-error', (_event, detail) => {
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
