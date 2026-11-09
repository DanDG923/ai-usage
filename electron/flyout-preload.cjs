'use strict';

// The tray flyout's own bridge. It reaches only the flyout:* channels, which
// the main process accepts from the flyout's main frame alone; the dashboard's
// channels refuse this window. A sandboxed preload cannot require local files,
// so the error clean-up below mirrors preload.cjs.
const { contextBridge, ipcRenderer } = require('electron');

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

// What the flyout sees as window.aiUsageFlyout. It has to provide the
// FlyoutBridge the flyout is written against.
contextBridge.exposeInMainWorld('aiUsageFlyout', /** @satisfies {import('../src/types').FlyoutBridge} */ ({
  getSnapshot: () => invoke('flyout:get-snapshot'),
  onUpdated: (callback) => {
    const listener = (/** @type {import('electron').IpcRendererEvent} */ _event, /** @type {import('../src/types').FlyoutSnapshot} */ snapshot) => callback(snapshot);
    ipcRenderer.on('flyout:updated', listener);
    return () => ipcRenderer.removeListener('flyout:updated', listener);
  },
  refresh: () => invoke('flyout:refresh'),
  openDashboard: (target) => invoke('flyout:open-dashboard', target),
  snooze: (hours) => invoke('flyout:snooze', hours),
  close: () => invoke('flyout:close'),
}));
