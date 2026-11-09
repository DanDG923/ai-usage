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
  if (code === 'UPDATE_BACKUP_FAILED') return { status: 'error', error: 'The safety backup failed. Check your backup folder and free disk space, then restart the update.' };
  if (code === 'UPDATE_MODULE_UNAVAILABLE') return { status: 'error', error: 'The update component could not be loaded. Reinstall AI Usage from the latest setup file.' };
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || /cannot find latest\.yml/i.test(message)) {
    return { status: 'error', error: 'The latest release is missing its update manifest. Publish the complete release, then check again.' };
  }
  if (code === 'ERR_UPDATER_CHECKSUM_MISMATCH' || code === 'ERR_UPDATER_INVALID_SIGNATURE' || code === 'ERR_UPDATER_INVALID_INSTALLER' || /checksum mismatch/i.test(message)) {
    return { status: 'error', error: 'The download could not be verified. Check again to download a fresh copy.' };
  }
  if (code === 'UPDATE_INSTALLER_LAUNCH_FAILED') {
    return { status: 'error', error: 'The installer could not be started. If antivirus software is scanning the download, wait a moment and try again.' };
  }
  if (/\b403\b|\b404\b|\b429\b/.test(message)) return { status: 'error', error: 'GitHub could not provide this release right now. Try again later.' };
  return { status: 'error', error: 'The update could not finish. Check your connection and free disk space, then try again.' };
}

function notesText(notes) {
  const value = Array.isArray(notes) ? notes.map((entry) => entry?.note || '').join('\n\n') : notes;
  return typeof value === 'string' ? value.slice(0, 20_000) : null;
}

// The manifest may list several files. Verify against the entry that names
// the file actually downloaded; the single-file top-level digest is the fallback.
function fileName(value) {
  return /** @type {string} */ (String(value || '').split(/[/\\]/).pop()).toLowerCase();
}

function manifestDigest(info, downloadedFile) {
  const name = fileName(downloadedFile);
  const files = Array.isArray(info?.files) ? info.files : [];
  const match = name ? files.find((file) => fileName(file?.url) === name) : null;
  if (match?.sha512) return match.sha512;
  if (name && fileName(info?.path) === name && info?.sha512) return info.sha512;
  return files.length === 1 ? files[0]?.sha512 ?? info?.sha512 ?? null : info?.sha512 ?? null;
}

// Error codes are stable identifiers, never request details; anything else is
// omitted from the log rather than risk carrying a header or signed URL.
function safeCode(error) {
  const code = String(error?.code || '');
  return /^[A-Z0-9_]{1,40}$/i.test(code) ? code : null;
}

function createUpdateChecker({
  // Either the electron-updater instance or a function that loads it. The
  // module tree is sizeable, so a build that can never update (development,
  // portable) never loads it, and an installed one loads it for the first
  // check rather than at launch.
  autoUpdater: updaterOption, enabled, isPackaged, pkg,
  isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR),
  platform = process.platform, beforeInstall = async () => {}, onInstallError = /** @type {(message?: string) => void} */ (() => {}),
  // When both are supplied the app verifies and launches the installer itself,
  // retrying a refused launch before it quits; otherwise electron-updater does.
  launchInstaller = /** @type {((options: any) => Promise<any>) | null} */ (null),
  quitForInstall = /** @type {(() => void) | null} */ (null),
  installDirectoryWritable = /** @type {() => boolean} */ (() => false),
  onStatus = /** @type {(status: object) => void} */ (() => {}), onLog = /** @type {(message: string) => void} */ (() => {}),
}) {
  // The feed is a public GitHub repository: checks and downloads are anonymous
  // and carry no credential. electron-updater reads it from app-update.yml.
  const feed = releaseFeed(pkg);
  const lazy = typeof updaterOption === 'function';
  const available = Boolean((lazy || updaterOption) && isPackaged && feed && !isPortable && platform === 'win32');
  let loadedUpdater = lazy ? null : updaterOption;
  let loaded = !lazy;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {any} */
  let operation = null;
  let downloaded = false;
  /** @type {string | null} */
  let downloadedFile = null;
  /** @type {string | null} */
  let downloadedSha512 = null;
  let candidate = false;
  /** @type {any} */
  let lastFailure = null;
  let result = {
    status: available ? 'idle' : 'unavailable', available,
    checkedAt: null, version: null, error: null, progress: null, releaseNotes: null,
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
    const stage = result.status;
    change({ ...failure, ...(downloaded ? { status: 'downloaded' } : {}) });
    const code = safeCode(error);
    onLog(`Failed while ${stage}${code ? ` (${code})` : ''}: ${result.error}`);
  }

  function updater() {
    if (!loaded) {
      loaded = true;
      try { loadedUpdater = updaterOption() || null; } catch { loadedUpdater = null; }
      if (loadedUpdater) configure(loadedUpdater);
    }
    if (!loadedUpdater) throw Object.assign(new Error('The update module could not be loaded.'), { code: 'UPDATE_MODULE_UNAVAILABLE' });
    return loadedUpdater;
  }

  function configure(autoUpdater) {
    autoUpdater.logger = null;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableWebInstaller = true;
    // Always download the complete installer so the file verified against the
    // manifest's SHA-512 is exactly the one published.
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.on('update-available', (info) => {
      candidate = true;
      change({ status: 'available', version: info?.version || null, releaseNotes: notesText(info?.releaseNotes), checkedAt: new Date().toISOString(), error: null });
      onLog(`Update available: ${result.version || 'unknown version'}.`);
    });
    autoUpdater.on('update-not-available', () => {
      candidate = false;
      change({ status: 'up-to-date', version: null, releaseNotes: null, checkedAt: new Date().toISOString(), error: null });
      onLog('Up to date.');
    });
    autoUpdater.on('download-progress', (progress) => {
      if (result.status !== 'downloading') return;
      const percent = Number(progress?.percent);
      change({ progress: Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null });
    });
    autoUpdater.on('update-downloaded', (info) => {
      downloaded = true;
      downloadedFile = typeof info?.downloadedFile === 'string' ? info.downloadedFile : null;
      downloadedSha512 = manifestDigest(info, downloadedFile);
      change({ status: 'downloaded', progress: 100, error: null });
      onLog(`Download complete: ${result.version || 'unknown version'}.`);
    });
    autoUpdater.on('error', (error) => {
      const installing = result.status === 'installing';
      fail(error);
      if (installing) onInstallError();
    });
  }
  if (loadedUpdater) configure(loadedUpdater);

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
      await updater().checkForUpdates();
    });
  }

  function download() {
    if (!available || downloaded || result.status === 'installing') return Promise.resolve(status());
    if (operation) return operation;
    if (!candidate) return Promise.resolve(status());
    return run(async () => {
      change({ status: 'downloading', progress: 0, error: null });
      onLog(`Download started: ${result.version || 'unknown version'}.`);
      await updater().downloadUpdate();
    });
  }

  function install() {
    if (!available || !downloaded || result.status === 'installing') return Promise.resolve(status());
    return run(async () => {
      change({ status: 'installing', error: null });
      onLog(`Install requested: ${result.version || 'unknown version'}.`);
      // NSIS starts its installer before Electron emits before-quit.
      await beforeInstall();
      try {
        if (launchInstaller && quitForInstall && downloadedFile && installDirectoryWritable()) {
          await launchInstaller({ filePath: downloadedFile, sha512: downloadedSha512, onLog });
          onLog('Quitting so the installer can replace the application.');
          quitForInstall();
        } else {
          // The elevation helper launches the cached file without rehashing
          // it. Apply the direct launcher's verification before delegating.
          await require('./installer-launch.cjs').verifyInstaller(downloadedFile, downloadedSha512);
          onLog('Installer launch delegated to electron-updater.');
          updater().quitAndInstall(true, true);
        }
      } catch (error) {
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
    clearTimeout(timer ?? undefined);
    clearInterval(timer ?? undefined);
    timer = null;
  }

  return { available, check, download, install, start, stop, status };
}

module.exports = { createUpdateChecker, feedConfigured, updateError };
