'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiUsage', {
  getClaudeSetup: () => ipcRenderer.invoke('claude-setup:status'),
  configureClaude: (action, enableHelper) => ipcRenderer.invoke('claude-setup:configure', action, enableHelper),
  cancelClaudeSetup: () => ipcRenderer.invoke('claude-setup:cancel'),
  getSnapshot: (days) => ipcRenderer.invoke('dashboard:get-snapshot', days),
  refresh: () => ipcRenderer.invoke('dashboard:refresh'),
  updateSettings: (patch) => ipcRenderer.invoke('dashboard:update-settings', patch),
  updatePrice: (price) => ipcRenderer.invoke('dashboard:update-price', price),
  addManualObservation: (observation) => ipcRenderer.invoke('dashboard:add-manual-observation', observation),
  installClaudeHelper: () => ipcRenderer.invoke('dashboard:install-claude-helper'),
  uninstallClaudeHelper: () => ipcRenderer.invoke('dashboard:uninstall-claude-helper'),
  createBackup: () => ipcRenderer.invoke('dashboard:create-backup'),
  restoreBackup: () => ipcRenderer.invoke('dashboard:restore-backup'),
  openBackupDirectory: () => ipcRenderer.invoke('dashboard:open-backup-directory'),
  exportCsv: (days) => ipcRenderer.invoke('dashboard:export-csv', days),
  copySummary: () => ipcRenderer.invoke('dashboard:copy-summary'),
  snoozeAlerts: (hours) => ipcRenderer.invoke('dashboard:snooze-alerts', hours),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  checkForUpdates: () => ipcRenderer.invoke('app:check-updates'),
  getUpdateStatus: () => ipcRenderer.invoke('app:update-status'),
  onUpdated: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('dashboard:updated', listener);
    return () => ipcRenderer.removeListener('dashboard:updated', listener);
  },
});
