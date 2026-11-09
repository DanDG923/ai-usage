'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** @typedef {import('electron').IpcRendererEvent} IpcRendererEvent */
/** @typedef {import('../src/types').DashboardNavigation} DashboardNavigation */

/**
 * @param {string} channel
 * @param {...unknown} args
 * @returns {Promise<any>} what the main process answered; each bridge method says what that is
 */
async function invoke(channel, ...args) {
  try { return await ipcRenderer.invoke(channel, ...args); } catch (error) {
    const message = String(error?.message || error).replace(/^Error invoking remote method ['"].+?['"]:\s*(?:Error:\s*)?/, '');
    throw new Error(message);
  }
}

// A page requested from the tray flyout waits in the main process until this
// page collects it, so a dashboard that is still loading, or was released and
// recreated, still lands on it. The main process hands each request out once;
// one collected while no listener is subscribed is held for the next.
/** @type {Set<(target: DashboardNavigation) => void>} */
const navigationListeners = new Set();
/** @type {DashboardNavigation | null} */
let heldNavigation = null;
let navigationSignal = false;

/** @param {DashboardNavigation | null} target */
function deliverNavigation(target) {
  if (!target || typeof target !== 'object') return;
  if (!navigationListeners.size) {
    heldNavigation = target;
    return;
  }
  for (const listener of navigationListeners) {
    try { listener(target); } catch { /* One listener must not stop the others. */ }
  }
}

function collectNavigation() {
  void invoke('dashboard:take-navigation').then(deliverNavigation, () => {});
}

// What the dashboard sees as window.aiUsage. It has to provide the Bridge the
// renderer is written against.
contextBridge.exposeInMainWorld('aiUsage', /** @satisfies {import('../src/types').Bridge} */ ({
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
  getClaudeCodeMod: () => invoke('claude-code-mod:status'),
  installClaudeCodeMod: () => invoke('claude-code-mod:install'),
  uninstallClaudeCodeMod: () => invoke('claude-code-mod:uninstall'),
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
    const listener = (/** @type {IpcRendererEvent} */ _event, /** @type {number} */ token) => {
      let allowed = false;
      try { allowed = callback() === true; } catch { /* Keep unfinished UI alive. */ }
      void invoke('dashboard:sleep-ready', token, allowed).catch(() => {});
    };
    ipcRenderer.on('dashboard:prepare-sleep', listener);
    return () => ipcRenderer.removeListener('dashboard:prepare-sleep', listener);
  },
  onUpdateStatus: (callback) => {
    const listener = (/** @type {IpcRendererEvent} */ _event, /** @type {import('../src/types').UpdateStatus} */ status) => callback(status);
    ipcRenderer.on('app:update-status-changed', listener);
    return () => ipcRenderer.removeListener('app:update-status-changed', listener);
  },
  onUpdated: (callback) => {
    const listener = (/** @type {IpcRendererEvent} */ _event, /** @type {import('../src/types').Snapshot} */ snapshot) => callback(snapshot);
    ipcRenderer.on('dashboard:updated', listener);
    return () => ipcRenderer.removeListener('dashboard:updated', listener);
  },
  onNavigate: (callback) => {
    const listener = (/** @type {DashboardNavigation} */ target) => callback(target);
    navigationListeners.add(listener);
    if (!navigationSignal) {
      navigationSignal = true;
      ipcRenderer.on('dashboard:navigation-pending', () => collectNavigation());
    }
    if (heldNavigation) {
      const target = heldNavigation;
      heldNavigation = null;
      // Delivered after subscribing returns, to whichever listeners remain.
      void Promise.resolve().then(() => deliverNavigation(target));
    }
    collectNavigation();
    return () => { navigationListeners.delete(listener); };
  },
}));
