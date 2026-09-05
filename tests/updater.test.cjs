'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createUpdateChecker, feedConfigured } = require('../electron/updater.cjs');

const pkg = { updateFeed: { provider: 'github', owner: 'DanDG923', repo: 'ai-usage', private: true } };
function fixture(options = {}) {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.downloads = 0;
  updater.installs = 0;
  updater.setFeedURL = (value) => { updater.feed = value; };
  updater.checkForUpdates = async () => {
    updater.checks++;
    updater.emit('update-available', { version: '1.0.23', releaseNotes: 'Private updates' });
  };
  updater.downloadUpdate = async () => {
    updater.downloads++;
    updater.emit('download-progress', { percent: 48.2 });
    updater.emit('update-downloaded', { version: '1.0.23' });
  };
  updater.quitAndInstall = (silent, restart) => {
    updater.installs++;
    assert.equal(silent, true);
    assert.equal(restart, true);
  };
  const states = [];
  const logs = [];
  const checker = createUpdateChecker({
    autoUpdater: updater, enabled: () => true, isPackaged: true, isPortable: false,
    platform: 'win32', pkg, getToken: async () => 'secret-for-test',
    onStatus: (value) => states.push(value), onLog: (value) => logs.push(value), ...options,
  });
  return { updater, checker, states, logs };
}

test('placeholder and missing feeds are disabled, packaged top-level feed survives stripped build config', () => {
  assert.equal(feedConfigured({}), false);
  assert.equal(feedConfigured({ build: { publish: { provider: 'github', owner: 'REPLACE_WITH_GITHUB_OWNER', repo: 'ai-usage' } } }), false);
  assert.equal(feedConfigured(pkg), true);
  assert.equal(feedConfigured({ build: { publish: { provider: 'github', owner: 'someone', repo: 'ai-usage' } } }), true);
});

test('development, portable and unsupported platform builds never authenticate, check or install', async () => {
  for (const options of [{ isPackaged: false }, { isPortable: true }, { platform: 'darwin' }]) {
    const { checker, updater } = fixture({ ...options, getToken: () => { throw new Error('must not authenticate'); } });
    assert.equal((await checker.check()).status, 'unavailable');
    await checker.download();
    await checker.install();
    assert.equal(updater.checks + updater.downloads + updater.installs, 0);
  }
});

test('private checks authenticate in memory, disable implicit installs, and emit safe version/notes', async () => {
  const { checker, updater, states, logs } = fixture();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.disableWebInstaller, true);
  assert.equal(updater.logger, null);
  const result = await checker.check();
  assert.equal(result.status, 'available');
  assert.equal(result.auth, 'github-cli');
  assert.equal(result.releaseNotes, 'Private updates');
  assert.equal(updater.feed.token, 'secret-for-test');
  assert.equal(updater.feed.private, true);
  assert.equal(updater.installs, 0);
  assert.ok(!JSON.stringify({ states, logs, result }).includes('secret-for-test'));
});

test('missing GitHub authentication produces an actionable state without contacting the feed', async () => {
  const { checker, updater } = fixture({ getToken: async () => { throw Object.assign(new Error('secret-for-test'), { code: 'UPDATE_AUTH_REQUIRED' }); } });
  assert.equal((await checker.check()).status, 'auth-required');
  assert.equal(updater.checks, 0);
  assert.ok(!JSON.stringify(checker.status()).includes('secret-for-test'));
});

test('checking is deduplicated and downloads cannot race an in-flight check', async () => {
  let resolveToken;
  const { checker, updater } = fixture({ getToken: () => new Promise((resolve) => { resolveToken = resolve; }) });
  const a = checker.check();
  const b = checker.check();
  const c = checker.download();
  await Promise.resolve();
  assert.equal(a, b);
  assert.equal(a, c);
  resolveToken('secret-for-test');
  await a;
  assert.equal(updater.checks, 1);
  assert.equal(updater.downloads, 0);
});

test('download progress is delivered and installation waits for backup and shutdown', async () => {
  let prepared;
  const events = [];
  const { checker, updater, states } = fixture({ beforeInstall: () => new Promise((resolve) => { prepared = resolve; events.push('prepare'); }) });
  await checker.install();
  assert.equal(updater.installs, 0);
  await checker.check();
  await checker.download();
  assert.ok(states.some((state) => state.status === 'downloading' && state.progress === 48.2));
  assert.equal(checker.status().status, 'downloaded');
  const pending = checker.install();
  await Promise.resolve();
  assert.deepEqual(events, ['prepare']);
  assert.equal(updater.installs, 0);
  assert.equal(checker.status().status, 'installing');
  prepared();
  await pending;
  assert.equal(updater.installs, 1);
});

test('a backup failure retains the verified download and permits a later installation retry', async () => {
  let attempts = 0;
  const { checker, updater } = fixture({ beforeInstall: async () => {
    if (++attempts === 1) throw Object.assign(new Error('disk full'), { code: 'UPDATE_BACKUP_FAILED' });
  } });
  await checker.check();
  await checker.download();
  assert.equal((await checker.install()).status, 'downloaded');
  assert.match(checker.status().error, /safety backup failed/i);
  assert.equal(updater.installs, 0);
  await checker.install();
  assert.equal(updater.installs, 1);
  assert.equal(updater.downloads, 1);
});

test('checksum failures never allow installation and do not leak HTTP diagnostics', async () => {
  const { checker, updater, states, logs } = fixture();
  updater.downloadUpdate = async () => {
    const error = Object.assign(new Error('Authorization: token secret-for-test'), { code: 'ERR_UPDATER_CHECKSUM_MISMATCH' });
    updater.emit('error', error);
    throw error;
  };
  await checker.check();
  assert.equal((await checker.download()).status, 'error');
  await checker.install();
  assert.equal(updater.installs, 0);
  assert.ok(!JSON.stringify({ states, logs }).includes('secret-for-test'));
});

test('ordinary HTTP errors are replaced by safe messages and failed checks can be retried', async () => {
  const { checker, updater, logs } = fixture();
  updater.checkForUpdates = async () => { throw new Error('offline Authorization: secret-for-test'); };
  assert.equal((await checker.check()).status, 'error');
  assert.ok(!JSON.stringify({ result: checker.status(), logs }).includes('secret-for-test'));
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  assert.equal((await checker.check()).status, 'up-to-date');
});

test('scheduled/manual checks cannot discard a completed download', async () => {
  const { checker, updater } = fixture();
  await checker.check();
  await checker.download();
  assert.equal((await checker.check()).status, 'downloaded');
  assert.equal(updater.checks, 1);
});

test('installer exceptions invoke recovery after successful preparation', async () => {
  let recovered = 0;
  const { checker, updater } = fixture({ onInstallError: () => { recovered++; } });
  await checker.check();
  await checker.download();
  updater.quitAndInstall = () => { throw new Error('failed to spawn'); };
  await checker.install();
  assert.equal(recovered, 1);
  assert.equal(checker.status().status, 'downloaded');
});

test('disabling automatic checks before the initial delay prevents its check', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let enabled = true;
  const { checker, updater } = fixture({ enabled: () => enabled });
  checker.start();
  enabled = false;
  t.mock.timers.tick(45_000);
  await Promise.resolve();
  assert.equal(updater.checks, 0);
  checker.stop();
});
