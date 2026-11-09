'use strict';

// The dashboard snapshot the main process hands out: the selected period,
// a short-lived cache, and the reduced copy notifications compare against.

// Tab switches and settings edits ask for the snapshot far more often than it
// changes. Anything that writes clears this; the TTL bounds the drift of the
// "now"-relative fields (staleness, estimated current balance) between writes.
const SNAPSHOT_TTL_MS = 20_000;

function createSnapshotsModule(main) {
  const snapshots = {
    periodDays: 30,
    previousSnapshot: null,
    cachedSnapshot: null,
    lastFullSnapshot: null,
  };

  // The renderer owns the selected period, so every snapshot the main process
  // emits — refresh, settings change, price edit, backup — has to use it too.
  // Called without a valid period it changes nothing and reports the current one.
  function setPeriodDays(days) {
    const requested = Math.round(Number(days));
    if (Number.isFinite(requested) && requested >= 1 && requested <= 365) snapshots.periodDays = requested;
    return snapshots.periodDays;
  }

  function invalidateSnapshot() {
    snapshots.cachedSnapshot = null;
  }

  function snapshot() {
    const now = Date.now();
    if (snapshots.cachedSnapshot && snapshots.cachedSnapshot.days === snapshots.periodDays && now - snapshots.cachedSnapshot.at < SNAPSHOT_TTL_MS) {
      return snapshots.cachedSnapshot.value;
    }
    const value = main.store.getDashboardSnapshot(snapshots.periodDays, now);
    snapshots.cachedSnapshot = { days: snapshots.periodDays, at: now, value };
    snapshots.lastFullSnapshot = value;
    return value;
  }

  function currentView() {
    return main.dashboard.isVisible() ? snapshots.snapshot() : main.store.getTraySnapshot(Date.now());
  }

  function patchSnapshotSettings() {
    if (snapshots.cachedSnapshot && snapshots.cachedSnapshot.days === snapshots.periodDays && Date.now() - snapshots.cachedSnapshot.at < SNAPSHOT_TTL_MS) {
      snapshots.cachedSnapshot.value = { ...snapshots.cachedSnapshot.value, settings: main.store.getSettings() };
      snapshots.lastFullSnapshot = snapshots.cachedSnapshot.value;
      return snapshots.cachedSnapshot.value;
    }
    return snapshots.snapshot();
  }

  function releaseDashboardMemory() {
    snapshots.cachedSnapshot = null;
    snapshots.lastFullSnapshot = null;
    // Notifications compare only the old bucket identity/reset/usage and source
    // status. Do not retain charts, ledger summaries or forecast series for it.
    if (snapshots.previousSnapshot) {
      snapshots.previousSnapshot = {
        quotas: Object.fromEntries(Object.entries(snapshots.previousSnapshot.quotas || {}).map(([key, quota]) => [key, quota && {
          windows: (quota.windows?.length ? quota.windows : [quota]).map(({ bucketId, resetsAt, usedPercent }) => ({ bucketId, resetsAt, usedPercent })),
        }])),
        sources: (snapshots.previousSnapshot.sources || []).map(({ id, status }) => ({ id, status })),
      };
    }
    main.store?.releaseDashboardCaches();
  }

  Object.assign(snapshots, { setPeriodDays, invalidateSnapshot, snapshot, currentView, patchSnapshotSettings, releaseDashboardMemory });
  return snapshots;
}

module.exports = { createSnapshotsModule };
