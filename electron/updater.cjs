'use strict';

const FIRST_CHECK_DELAY_MS = 45_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function releaseFeed(pkg) {
  // electron-builder strips build from the packaged package.json.
  const publish = pkg?.updateFeed || pkg?.build?.publish;
  const entries = Array.isArray(publish) ? publish : publish ? [publish] : [];
  return entries.find((entry) => entry?.provider && Object.values(entry).every((value) => !String(value).startsWith('REPLACE')));
}

function feedConfigured(pkg) {
  return Boolean(releaseFeed(pkg));
}

// HTTP errors may include request headers and signed asset URLs. Only stable,
// user-facing messages may reach the renderer or application log.
function updateError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (code === 'UPDATE_AUTH_REQUIRED' || /\b401\b|bad credentials/i.test(message)) {
    return { status: 'auth-required', error: 'GitHub sign-in is unavailable. Sign in with GitHub CLI on this PC, then check again.' };
  }
  if (code === 'UPDATE_BACKUP_FAILED') return { status: 'error', error: 'The safety backup failed. Check your backup folder and free disk space, then restart the update.' };
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || /cannot find latest\.yml/i.test(message)) {
    return { status: 'error', error: 'The latest private release is missing its update manifest. Publish the complete release, then check again.' };
  }
  if (code === 'ERR_UPDATER_CHECKSUM_MISMATCH' || code === 'ERR_UPDATER_INVALID_SIGNATURE' || /checksum mismatch/i.test(message)) {
    return { status: 'error', error: 'The download could not be verified. Check again to download a fresh copy.' };
  }
  if (/\b403\b|\b404\b/.test(message)) return { status: 'error', error: 'GitHub could not provide this private release. Check repository access and try again later.' };
  return { status: 'error', error: 'The update could not finish. Check your connection and free disk space, then try again.' };
}

function notesText(notes) {
  const value = Array.isArray(notes) ? notes.map((entry) => entry?.note || '').join('\n\n') : notes;
  return typeof value === 'string' ? value.slice(0, 20_000) : null;
}

// electron-updater prefers these over the token it is handed whenever the feed
// is private. Only the GitHub CLI sign-in may authenticate an update check.
const ENVIRONMENT_TOKEN_KEYS = /^(?:GH_TOKEN|GITHUB_TOKEN)$/i;

function clearEnvironmentTokens(environment) {
  for (const key of Object.keys(environment)) {
    if (ENVIRONMENT_TOKEN_KEYS.test(key)) delete environment[key];
  }
}

function createUpdateChecker({
  autoUpdater, enabled, isPackaged, pkg, getToken,
  isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR),
  platform = process.platform, environment = process.env, beforeInstall = async () => {}, onInstallError = () => {},
  onStatus = () => {}, onLog = () => {},
}) {
  const feed = releaseFeed(pkg);
  const available = Boolean(autoUpdater && isPackaged && feed && !isPortable && platform === 'win32');
  let timer = null;
  let operation = null;
  let downloaded = false;
  let candidate = false;
  let lastFailure = null;
  let result = {
    status: available ? 'idle' : 'unavailable', available,
    checkedAt: null, version: null, error: null, progress: null, releaseNotes: null, auth: null,
    reason: isPortable ? 'Use the installed Windows version for in-app updates.' : !available ? 'Updates are available in the installed Windows app with a configured release feed.' : null,
  };
  const status = () => ({ ...result });
  function change(patch) {
    result = { ...result, ...patch };
    onStatus(status());
  }
  function fail(error) {
    // electron-updater both emits 'error' and rejects the operation with the
    // same object; report each failure once.
    if (error && error === lastFailure) return;
    lastFailure = error;
    const failure = updateError(error);
    change({ ...failure, ...(downloaded ? { status: 'downloaded' } : {}) });
    onLog(result.error);
  }

  if (autoUpdater) {
    autoUpdater.logger = null;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableWebInstaller = true;
    // Private GitHub assets use API URLs that lack filename-based blockmap
    // lookup. Full downloads still receive SHA-512 verification.
    autoUpdater.disableDifferentialDownload = Boolean(feed?.private);
    autoUpdater.on('update-available', (info) => {
      candidate = true;
      change({ status: 'available', version: info?.version || null, releaseNotes: notesText(info?.releaseNotes), checkedAt: new Date().toISOString(), error: null });
    });
    autoUpdater.on('update-not-available', () => {
      candidate = false;
      change({ status: 'up-to-date', version: null, releaseNotes: null, checkedAt: new Date().toISOString(), error: null });
    });
    autoUpdater.on('download-progress', (progress) => {
      if (result.status !== 'downloading') return;
      const percent = Number(progress?.percent);
      change({ progress: Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null });
    });
    autoUpdater.on('update-downloaded', () => {
      downloaded = true;
      change({ status: 'downloaded', progress: 100, error: null });
    });
    autoUpdater.on('error', (error) => {
      const installing = result.status === 'installing';
      fail(error);
      if (installing) onInstallError();
    });
  }

  function run(task) {
    if (operation) return operation;
    lastFailure = null;
    operation = Promise.resolve().then(task).catch(fail).then(status).finally(() => { operation = null; });
    return operation;
  }

  function check() {
    if (!available || downloaded || result.status === 'installing') return Promise.resolve(status());
    return run(async () => {
      candidate = false;
      change({ status: 'checking', error: null, progress: null, version: null, releaseNotes: null });
      if (feed.provider === 'github' && feed.private) {
        if (!getToken) throw Object.assign(new Error(), { code: 'UPDATE_AUTH_REQUIRED' });
        const token = await getToken();
        clearEnvironmentTokens(environment);
        // Keep the authenticated feed in main-process memory. Never persist it
        // or pass it to logs, a command line, or the renderer.
        autoUpdater.setFeedURL({ ...feed, token });
        change({ auth: 'github-cli' });
      }
      await autoUpdater.checkForUpdates();
    });
  }

  function download() {
    if (!available || downloaded || result.status === 'installing') return Promise.resolve(status());
    if (operation) return operation;
    if (!candidate) return Promise.resolve(status());
    return run(async () => {
      change({ status: 'downloading', progress: 0, error: null });
      await autoUpdater.downloadUpdate();
    });
  }

  function install() {
    if (!available || !downloaded || result.status === 'installing') return Promise.resolve(status());
    return run(async () => {
      change({ status: 'installing', error: null });
      // NSIS starts its installer before Electron emits before-quit.
      await beforeInstall();
      try { autoUpdater.quitAndInstall(true, true); } catch (error) {
        onInstallError();
        throw error;
      }
    });
  }

  // Settings changes call this repeatedly. An existing schedule is kept, so a
  // theme edit cannot bring the next check forward.
  function start() {
    if (!available || !enabled()) {
      stop();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      if (enabled()) void check();
      timer = setInterval(() => { if (enabled()) void check(); }, CHECK_INTERVAL_MS);
      timer.unref?.();
    }, FIRST_CHECK_DELAY_MS);
    timer.unref?.();
  }

  function stop() {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }

  return { available, check, download, install, start, stop, status };
}

module.exports = { createUpdateChecker, feedConfigured, updateError };
