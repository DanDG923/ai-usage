'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createUpdateChecker } = require('../electron/updater.cjs');

const pkg = { updateFeed: { provider: 'github', owner: 'DanDG923', repo: 'ai-usage', private: true } };

function fakeUpdater() {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.setFeedURL = (value) => { updater.feed = value; };
  updater.checkForUpdates = async () => {
    updater.checks++;
    updater.emit('update-not-available');
  };
  return updater;
}

function checker(loader, options = {}) {
  const states = [];
  const instance = createUpdateChecker({
    autoUpdater: loader, enabled: () => true, isPackaged: true, isPortable: false, platform: 'win32', pkg,
    getToken: async () => 'secret-for-test', onStatus: (value) => states.push(value), ...options,
  });
  return { checker: instance, states };
}

test('electron-updater is loaded for the first check, not at launch, and configured once', async () => {
  const updater = fakeUpdater();
  let loads = 0;
  const { checker: instance } = checker(() => { loads++; return updater; });
  assert.equal(instance.available, true);
  assert.equal(loads, 0, 'construction must not load the module');
  assert.equal(updater.autoDownload, undefined);
  assert.equal((await instance.check()).status, 'up-to-date');
  assert.equal(loads, 1);
  assert.equal(updater.autoDownload, false, 'the loaded instance is configured like an eager one');
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.feed.token, 'secret-for-test');
  await instance.check();
  assert.equal(loads, 1, 'later checks reuse the loaded module');
  assert.equal(updater.checks, 2);
});

test('builds that can never update do not load the module at all', async () => {
  for (const options of [{ isPackaged: false }, { isPortable: true }, { platform: 'darwin' }]) {
    let loads = 0;
    const { checker: instance } = checker(() => { loads++; return fakeUpdater(); }, options);
    assert.equal(instance.available, false);
    assert.equal((await instance.check()).status, 'unavailable');
    await instance.download();
    await instance.install();
    assert.equal(loads, 0);
  }
});

test('a loader that fails or returns nothing reports a stable error without crashing', async () => {
  for (const loader of [() => null, () => { throw new Error('Cannot find module electron-updater'); }]) {
    const { checker: instance, states } = checker(loader);
    const result = await instance.check();
    assert.equal(result.status, 'error');
    assert.match(result.error, /update component could not be loaded/);
    assert.equal(states.at(-1).status, 'error');
    assert.equal((await instance.check()).status, 'error', 'the failure is repeatable, not sticky in a wedged state');
  }
});
