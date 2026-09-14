'use strict';
require('./setup.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');
const { createDatabaseQueue } = require('../electron/maintenance-host.cjs');

test('update backup waits for accepted writes and rejects new work until storage closes', async () => {
  const queue = createDatabaseQueue();
  const calls = [];
  let finish;
  const write = queue.run(() => new Promise((resolve) => { finish = resolve; calls.push('write'); }));
  await Promise.resolve();
  const ready = queue.prepareToClose(async () => { calls.push('backup'); });
  await assert.rejects(queue.run(() => calls.push('late write')), /closing/);
  await assert.rejects(queue.collect(() => calls.push('late collection')), /closing/);
  await assert.rejects(queue.exclusive(() => calls.push('late restore')), /closing/);
  assert.deepEqual(calls, ['write']);
  finish();
  await write;
  await ready;
  await queue.close();
  assert.deepEqual(calls, ['write', 'backup']);
});

test('failed update backup resumes database operations with all preceding work retained', async () => {
  const queue = createDatabaseQueue();
  const calls = [];
  await queue.run(() => calls.push('first'));
  await assert.rejects(queue.prepareToClose(async () => { throw new Error('disk full'); }), /disk full/);
  await queue.run(() => calls.push('second'));
  await queue.collect(async () => queue.run(() => calls.push('collection')));
  await queue.exclusive(() => calls.push('restore'));
  assert.deepEqual(calls, ['first', 'second', 'collection', 'restore']);
  await queue.close();
});

test('update preparation drains an accepted restore after active collection before backing up its result', async () => {
  const queue = createDatabaseQueue();
  const calls = [];
  let finishCollection;
  let finishRestore;
  let storedValue = 'original';
  const collection = queue.collect(() => new Promise((resolve) => { finishCollection = resolve; calls.push('collection'); }));
  await Promise.resolve();
  const restore = queue.exclusive(async () => {
    calls.push('restore');
    await new Promise((resolve) => { finishRestore = resolve; });
    storedValue = 'restored';
  });
  const preparing = queue.prepareToClose(() => { calls.push(`backup:${storedValue}`); });
  await assert.rejects(queue.collect(() => calls.push('late collection')), /closing/);
  assert.deepEqual(calls, ['collection']);
  finishCollection();
  await collection;
  // Let the accepted restore enter the write queue; preparation must still wait.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['collection', 'restore']);
  finishRestore();
  await restore;
  await preparing;
  assert.deepEqual(calls, ['collection', 'restore', 'backup:restored']);
  await queue.close();
});
