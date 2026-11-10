'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdateChecker, feedConfigured } = require('../../electron/updater.cjs');

const pkg = { updateFeed: { provider: 'github', owner: 'DanDG923', repo: 'ai-usage', private: false } };
function fixture(options = {}) {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.downloads = 0;
  updater.installs = 0;
  updater.setFeedURL = () => { throw new Error('the public feed comes from app-update.yml'); };
  updater.checkForUpdates = async () => {
    updater.checks++;
    updater.emit('update-available', { version: '1.0.23', releaseNotes: 'Public updates' });
  };
  updater.downloadUpdate = async () => {
    updater.downloads++;
    updater.emit('download-progress', { percent: 48.2 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-updater-fixture-'));
    const downloadedFile = path.join(root, 'setup.exe');
    const content = Buffer.from('test installer, never executed');
    fs.writeFileSync(downloadedFile, content);
    updater.emit('update-downloaded', { version: '1.0.23', downloadedFile,
      files: [{ url: 'setup.exe', sha512: crypto.createHash('sha512').update(content).digest('base64') }] });
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
    platform: 'win32', pkg,
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

test('development, portable and unsupported platform builds never check or install', async () => {
  for (const options of [{ isPackaged: false }, { isPortable: true }, { platform: 'darwin' }]) {
    const { checker, updater } = fixture(options);
    assert.equal((await checker.check()).status, 'unavailable');
    await checker.download();
    await checker.install();
    assert.equal(updater.checks + updater.downloads + updater.installs, 0);
  }
});

test('public checks need no credential, disable implicit installs, and emit safe version/notes', async () => {
  const { checker, updater, states, logs } = fixture();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.disableWebInstaller, true);
  assert.equal(updater.logger, null);
  assert.equal(updater.disableDifferentialDownload, true);
  const result = await checker.check();
  assert.equal(result.status, 'available');
  assert.equal('auth' in result, false);
  assert.equal(result.releaseNotes, 'Public updates');
  assert.equal(updater.checks, 1);
  assert.equal(updater.installs, 0);
  assert.equal(states.at(-1).status, 'available');
  assert.deepEqual(logs, ['Update available: 1.0.23.']);
});

test('GitHub refusals and rate limits read as a temporary failure, not a sign-in problem', async () => {
  const { checker, updater } = fixture();
  for (const message of ['HttpError: 401 Unauthorized', 'HttpError: 403 Forbidden', 'HttpError: 404 Not Found', 'HttpError: 429 Too Many Requests']) {
    updater.checkForUpdates = async () => { throw new Error(message); };
    const result = await checker.check();
    assert.equal(result.status, 'error');
    assert.doesNotMatch(result.error, /sign in|private|access/i);
  }
});

test('checking is deduplicated and downloads cannot race an in-flight check', async () => {
  let resolveCheck;
  const { checker, updater } = fixture();
  updater.checkForUpdates = () => new Promise((resolve) => {
    updater.checks++;
    resolveCheck = () => { updater.emit('update-available', { version: '1.0.23' }); resolve(); };
  });
  const a = checker.check();
  const b = checker.check();
  const c = checker.download();
  await Promise.resolve();
  assert.equal(a, b);
  assert.equal(a, c);
  await new Promise((resolve) => setImmediate(resolve));
  resolveCheck();
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
  // The emitted event and the rejected promise carry the same error object.
  assert.equal(logs.filter((line) => line.startsWith('Failed while')).length, 1);
  assert.equal(states.filter((state) => state.status === 'error').length, 1);
});

test('the update check leaves GitHub tokens in the environment for the processes that use them', async (t) => {
  const previous = process.env.GH_TOKEN;
  t.after(() => { if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous; });
  process.env.GH_TOKEN = 'kept-for-providers';
  const { checker } = fixture();
  assert.equal((await checker.check()).status, 'available');
  assert.equal(process.env.GH_TOKEN, 'kept-for-providers');
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.checks, 0);
  checker.stop();
});

test('repeated starts keep the existing schedule and a disabled setting clears it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  let enabled = true;
  const { checker, updater } = fixture({ enabled: () => enabled });
  checker.start();
  t.mock.timers.tick(30_000);
  // A settings save restarts effects; the first check must still land at 45 s.
  checker.start();
  t.mock.timers.tick(15_000);
  await settle();
  assert.equal(updater.checks, 1);
  checker.start();
  t.mock.timers.tick(45_000);
  await settle();
  assert.equal(updater.checks, 1, 'restarting must not schedule an extra check');
  enabled = false;
  checker.start();
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  await settle();
  assert.equal(updater.checks, 1, 'a disabled setting clears the schedule');
  enabled = true;
  checker.start();
  t.mock.timers.tick(45_000);
  await settle();
  assert.equal(updater.checks, 2, 're-enabling schedules a fresh first check');
  checker.stop();
});
