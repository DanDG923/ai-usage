'use strict';

// Update checks are opt-out, run only in a packaged build, and only once a
// release feed is configured under `build.publish` in package.json. Nothing
// about local usage leaves the machine: the check fetches a version manifest.
const FIRST_CHECK_DELAY_MS = 45_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function feedConfigured(pkg) {
  const publish = pkg?.build?.publish;
  const entries = Array.isArray(publish) ? publish : publish ? [publish] : [];
  return entries.some((entry) => entry?.provider && Object.values(entry).every((value) => !String(value).startsWith('REPLACE')));
}

function createUpdateChecker({ autoUpdater, enabled, isPackaged, pkg, onLog = () => {} }) {
  const available = Boolean(autoUpdater) && isPackaged && feedConfigured(pkg);
  let timer = null;
  let lastResult = { status: available ? 'idle' : 'unavailable', checkedAt: null, version: null, error: null };

  if (autoUpdater) {
    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available', (info) => {
      lastResult = { status: 'available', checkedAt: new Date().toISOString(), version: info?.version || null, error: null };
    });
    autoUpdater.on('update-not-available', () => {
      lastResult = { status: 'up-to-date', checkedAt: new Date().toISOString(), version: null, error: null };
    });
    autoUpdater.on('error', (error) => {
      lastResult = { status: 'error', checkedAt: new Date().toISOString(), version: null, error: error?.message || String(error) };
      onLog(`Update check failed: ${lastResult.error}`);
    });
  }

  async function check() {
    if (!available) return lastResult;
    lastResult = { ...lastResult, status: 'checking' };
    try {
      await autoUpdater.checkForUpdatesAndNotify();
    } catch (error) {
      lastResult = { status: 'error', checkedAt: new Date().toISOString(), version: null, error: error?.message || String(error) };
    }
    return lastResult;
  }

  function start() {
    stop();
    if (!available || !enabled()) return;
    timer = setTimeout(() => {
      check().catch(() => {});
      timer = setInterval(() => { if (enabled()) check().catch(() => {}); }, CHECK_INTERVAL_MS);
    }, FIRST_CHECK_DELAY_MS);
  }

  function stop() {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }

  return { available, check, start, stop, status: () => ({ ...lastResult, available }) };
}

module.exports = { createUpdateChecker, feedConfigured };
