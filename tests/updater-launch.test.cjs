'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createUpdateChecker, updateError } = require('../electron/updater.cjs');

const pkg = { updateFeed: { provider: 'github', owner: 'DanDG923', repo: 'ai-usage', private: true } };
const DOWNLOADED = {
  version: '1.0.27', downloadedFile: 'C:\\Users\\tester\\AppData\\Local\\ai-usage-updater\\pending\\AI-Usage-Setup-1.0.27-x64.exe',
  files: [{ url: 'AI-Usage-Setup-1.0.27-x64.exe', sha512: 'manifest-digest' }],
};

function fixture(options = {}) {
  const updater = new EventEmitter();
  updater.installs = 0;
  updater.setFeedURL = () => {};
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '1.0.27' });
  updater.downloadUpdate = async () => updater.emit('update-downloaded', options.downloadedEvent ?? DOWNLOADED);
  updater.quitAndInstall = () => { updater.installs++; };
  const launches = [];
  const logs = [];
  let quits = 0;
  let recoveries = 0;
  const checker = createUpdateChecker({
    autoUpdater: updater, enabled: () => true, isPackaged: true, isPortable: false, platform: 'win32', pkg,
    getToken: async () => 'secret-for-test',
    launchInstaller: async (request) => { launches.push(request); if (options.launchError) throw options.launchError; return { attempt: 1, pid: 1 }; },
    quitForInstall: () => { quits++; },
    installDirectoryWritable: () => options.writable ?? true,
    onInstallError: () => { recoveries++; },
    onLog: (line) => logs.push(line),
    ...options.checker,
  });
  return { updater, checker, launches, logs, quit: () => quits, recoveries: () => recoveries };
}

test('the app verifies and launches the downloaded installer itself, then quits, logging each stage', async () => {
  const f = fixture();
  await f.checker.check();
  await f.checker.download();
  await f.checker.install();
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].filePath, DOWNLOADED.downloadedFile);
  assert.equal(f.launches[0].sha512, 'manifest-digest');
  assert.equal(typeof f.launches[0].onLog, 'function');
  assert.equal(f.quit(), 1);
  assert.equal(f.updater.installs, 0, 'electron-updater must not also launch the installer');
  assert.deepEqual(f.logs, [
    'Update available: 1.0.27.',
    'Download started: 1.0.27.',
    'Download complete: 1.0.27.',
    'Install requested: 1.0.27.',
    'Quitting so the installer can replace the application.',
  ]);
  assert.ok(!JSON.stringify(f.logs).includes('secret-for-test'));
});

test('a launch that fails after retries triggers recovery, keeps the download, and shows a safe message', async () => {
  const f = fixture({ launchError: Object.assign(new Error('spawn EACCES'), { code: 'UPDATE_INSTALLER_LAUNCH_FAILED' }) });
  await f.checker.check();
  await f.checker.download();
  const status = await f.checker.install();
  assert.equal(f.quit(), 0);
  assert.equal(f.recoveries(), 1);
  assert.equal(status.status, 'downloaded');
  assert.match(status.error, /installer could not be started/i);
  assert.ok(f.logs.some((line) => line === `Failed while installing (UPDATE_INSTALLER_LAUNCH_FAILED): ${status.error}`));
});

test('electron-updater performs the launch when the file path is unknown or the install needs elevation', async () => {
  for (const options of [{ downloadedEvent: { version: '1.0.27' } }, { writable: false }]) {
    const f = fixture(options);
    await f.checker.check();
    await f.checker.download();
    await f.checker.install();
    assert.equal(f.launches.length, 0);
    assert.equal(f.quit(), 0);
    assert.equal(f.updater.installs, 1);
    assert.ok(f.logs.includes('Installer launch delegated to electron-updater.'));
  }
});

test('failure logging carries stable codes only and drops unusable ones', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => { throw Object.assign(new Error('Authorization: token secret-for-test'), { code: 'HTTP_ERROR_500 with secret-for-test' }); };
  await f.checker.check();
  assert.deepEqual(f.logs, [`Failed while checking: ${updateError({}).error}`]);
  assert.ok(!JSON.stringify(f.logs).includes('secret-for-test'));
  assert.equal(updateError({ code: 'ERR_UPDATER_INVALID_INSTALLER' }).error, updateError({ code: 'ERR_UPDATER_CHECKSUM_MISMATCH' }).error);
});

test('the checksum used for verification belongs to the file that was downloaded', async () => {
  const f = fixture({ downloadedEvent: {
    version: '1.0.27', sha512: 'top-level', path: 'AI-Usage-Setup-1.0.27-x64.exe',
    downloadedFile: DOWNLOADED.downloadedFile,
    files: [{ url: 'AI-Usage-Portable-1.0.27-x64.exe', sha512: 'portable' }, { url: 'AI-Usage-Setup-1.0.27-x64.exe', sha512: 'setup' }],
  } });
  await f.checker.check();
  await f.checker.download();
  await f.checker.install();
  assert.equal(f.launches[0].sha512, 'setup');
});
