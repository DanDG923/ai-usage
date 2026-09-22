'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  try { return await ipcRenderer.invoke(channel, ...args); } catch (error) {
    const message = String(error?.message || error).replace(/^Error invoking remote method ['"].+?['"]:\s*(?:Error:\s*)?/, '');
    throw new Error(message);
  }
}

contextBridge.exposeInMainWorld('aiUsage', {
  getClaudeSetup: () => invoke('claude-setup:status'),
  isClaudeSetupDismissed: () => invoke('claude-setup:dismissed'),
  configureClaude: (action, enableHelper) => invoke('claude-setup:configure', action, enableHelper),
  cancelClaudeSetup: () => invoke('claude-setup:cancel'),
  getSnapshot: (days) => invoke('dashboard:get-snapshot', days),
  getTasks: (options) => invoke('dashboard:get-tasks', options),
  getSessions: (options) => invoke('dashboard:get-sessions', options),
  refresh: () => invoke('dashboard:refresh'),
  updateSettings: (patch) => invoke('dashboard:update-settings', patch),
  updatePrice: (price) => invoke('dashboard:update-price', price),
  addManualObservation: (observation) => invoke('dashboard:add-manual-observation', observation),
  installClaudeHelper: () => invoke('dashboard:install-claude-helper'),
  uninstallClaudeHelper: () => invoke('dashboard:uninstall-claude-helper'),
  createBackup: () => invoke('dashboard:create-backup'),
  restoreBackup: () => invoke('dashboard:restore-backup'),
  previewDesktopExport: () => invoke('dashboard:preview-desktop-export'),
  cancelDesktopExport: (previewId) => invoke('dashboard:cancel-desktop-export', previewId),
  importDesktopExport: (previewId, assumedModel) => invoke('dashboard:import-desktop-export', previewId, assumedModel),
  clearDesktopEstimates: () => invoke('dashboard:clear-desktop-estimates'),
  openBackupDirectory: () => invoke('dashboard:open-backup-directory'),
  exportCsv: (days) => invoke('dashboard:export-csv', days),
  copySummary: () => invoke('dashboard:copy-summary'),
  snoozeAlerts: (hours) => invoke('dashboard:snooze-alerts', hours),
  reportRendererError: (detail) => invoke('app:renderer-error', detail),
  getVersion: () => invoke('app:get-version'),
  getRenderingMode: () => invoke('app:rendering-mode'),
  relaunch: () => invoke('app:relaunch'),
  checkForUpdates: () => invoke('app:check-updates'),
  getUpdateStatus: () => invoke('app:update-status'),
  downloadUpdate: () => invoke('app:download-update'),
  installUpdate: () => invoke('app:install-update'),
  onPrepareSleep: (callback) => {
    const listener = (_event, token) => {
      let allowed = false;
      try { allowed = callback() === true; } catch { /* Keep unfinished UI alive. */ }
      void invoke('dashboard:sleep-ready', token, allowed).catch(() => {});
    };
    ipcRenderer.on('dashboard:prepare-sleep', listener);
    return () => ipcRenderer.removeListener('dashboard:prepare-sleep', listener);
  },
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('app:update-status-changed', listener);
    return () => ipcRenderer.removeListener('app:update-status-changed', listener);
  },
  onUpdated: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('dashboard:updated', listener);
    return () => ipcRenderer.removeListener('dashboard:updated', listener);
  },
});
