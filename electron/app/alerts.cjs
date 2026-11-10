'use strict';

// Desktop notifications: the decisions after a collection, the state that
// keeps them from repeating, and the update-available notice.

const fs = require('node:fs');
const { decideNotifications, emptyState } = require('../notifications.cjs');
const { closed } = require('./closed.cjs');

/** @param {import('./application.cjs').Application} main */
function createAlertsModule(main) {
  const { Notification } = main.electron;
  const alerts = closed({
    notificationState: emptyState(),
    notifiedUpdates: new Set(),
    loadNotificationState, saveNotificationState, showNotifications, publishUpdateStatus,
  });

  function loadNotificationState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(main.paths.notificationStatePath(), 'utf8'));
      return parsed && typeof parsed === 'object' ? { ...emptyState(), ...parsed } : emptyState();
    } catch {
      return emptyState();
    }
  }

  /** @param {ReturnType<typeof emptyState>} state */
  function saveNotificationState(state) {
    try {
      fs.writeFileSync(main.paths.notificationStatePath(), JSON.stringify(state), 'utf8');
    } catch { /* A digest repeated after a crash is the worst case. */ }
  }

  /** @param {import('../types').TraySnapshot} current a tray snapshot, or a full one, which has the same fields */
  function showNotifications(current) {
    const decided = decideNotifications({
      previous: main.snapshots.previousSnapshot,
      current,
      state: alerts.notificationState,
      nowMs: Date.now(),
    });
    alerts.notificationState = decided.state;
    alerts.saveNotificationState(alerts.notificationState);
    if (!Notification.isSupported()) return;
    for (const item of decided.notifications) {
      try {
        const toast = new Notification({ title: item.title, body: item.body });
        toast.on('click', () => main.dashboard.showMainWindow());
        toast.show();
      } catch { /* A notification the OS refuses must not fail the refresh. */ }
    }
  }

  /** @param {import('../../src/types').UpdateStatus} status */
  function publishUpdateStatus(status) {
    if (main.dashboard.window && !main.dashboard.window.isDestroyed()) main.dashboard.window.webContents.send('app:update-status-changed', status);
    if (status.status !== 'available' || !status.version || alerts.notifiedUpdates.has(status.version)) return;
    alerts.notifiedUpdates.add(status.version);
    if (Notification.isSupported()) {
      try {
        const notification = new Notification({ title: 'AI Usage update available', body: `Version ${status.version} is ready to download in Settings, under Appearance & updates.` });
        notification.on('click', () => main.dashboard.deferredWindowReveal.request());
        notification.show();
      } catch { /* Windows notification settings must not break updates. */ }
    }
  }

  return alerts;
}

module.exports = { createAlertsModule };
