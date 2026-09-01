'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createUpdateChecker, feedConfigured } = require('../electron/updater.cjs');

function fakeAutoUpdater() {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.checkForUpdatesAndNotify = async () => { updater.checks += 1; updater.emit('update-not-available'); };
  return updater;
}

test('a placeholder or missing publish feed disables update checks', () => {
  assert.equal(feedConfigured({}), false);
  assert.equal(feedConfigured({ build: { publish: { provider: 'github', owner: 'REPLACE_WITH_GITHUB_OWNER', repo: 'ai-usage' } } }), false);
  assert.equal(feedConfigured({ build: { publish: { provider: 'github', owner: 'someone', repo: 'ai-usage' } } }), true);
  assert.equal(feedConfigured({ build: { publish: [{ provider: 'generic', url: 'https://example.invalid/feed' }] } }), true);
});

test('the checker is unavailable outside packaged builds and never calls the updater', async () => {
  const updater = fakeAutoUpdater();
  const checker = createUpdateChecker({ autoUpdater: updater, enabled: () => true, isPackaged: false, pkg: { build: { publish: { provider: 'github', owner: 'x', repo: 'y' } } } });
  assert.equal(checker.available, false);
  assert.equal((await checker.check()).status, 'unavailable');
  assert.equal(updater.checks, 0);
});

test('a configured packaged build checks on demand and reports the outcome', async () => {
  const updater = fakeAutoUpdater();
  const checker = createUpdateChecker({ autoUpdater: updater, enabled: () => true, isPackaged: true, pkg: { build: { publish: { provider: 'github', owner: 'x', repo: 'y' } } } });
  assert.equal(checker.available, true);
  assert.equal(updater.autoDownload, false);
  const result = await checker.check();
  assert.equal(updater.checks, 1);
  assert.equal(result.status, 'up-to-date');
  updater.checkForUpdatesAndNotify = async () => { throw new Error('offline'); };
  const failed = await checker.check();
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'offline');
  checker.stop();
});
