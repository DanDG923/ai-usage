'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');
const { createDatabaseQueue, createMaintenanceHost } = require('../electron/maintenance-host.cjs');
const { createMaintenanceService } = require('../electron/maintenance-service.cjs');

test('storage jobs serialize after failures and shutdown drains before closing', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const order = [];
  const queue = createDatabaseQueue();
  const first = queue.run(async () => { order.push('start'); await held; throw new Error('disk failure'); });
  const firstFailed = assert.rejects(first, /disk failure/);
  const second = queue.run(() => { order.push('second'); return 2; });
  let drained = false;
  const closing = queue.close().then(() => { drained = true; });
  await assert.rejects(queue.run(() => {}), /closing/);
  assert.deepEqual(order, ['start']);
  assert.equal(drained, false);
  release();
  await firstFailed;
  assert.equal(await second, 2);
  await closing;
  assert.deepEqual(order, ['start', 'second']);
  assert.equal(drained, true);
});

test('maintenance service serializes scheduled backups and closes after active work', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const order = [];
  const service = createMaintenanceService({
    openStore: () => ({
      async createBackup() { order.push('backup'); await held; order.push('finished'); return { exportPath: 'saved' }; },
      maybeCreateScheduledBackup() { order.push('scheduled'); return null; },
      close() { order.push('closed'); },
    }),
  });
  const backup = service.handle({ type: 'create-backup' });
  const scheduled = service.handle({ type: 'scheduled-backup' });
  const closed = service.handle({ type: 'close' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['backup']);
  release();
  assert.deepEqual(await backup, { exportPath: 'saved' });
  assert.equal(await scheduled, null);
  assert.deepEqual(await closed, { closed: true });
  assert.deepEqual(order, ['backup', 'finished', 'scheduled', 'closed']);
  await assert.rejects(service.handle({ type: 'create-backup' }), /has closed/);
});

test('settings remain writable during provider reads while restore excludes collectors and writers', async () => {
  let releaseCollection;
  let releaseRestore;
  const collectionHeld = new Promise((resolve) => { releaseCollection = resolve; });
  const restoreHeld = new Promise((resolve) => { releaseRestore = resolve; });
  const order = [];
  const queue = createDatabaseQueue();
  const collecting = queue.collect(async () => { order.push('collection'); await collectionHeld; order.push('collected'); });
  const restoring = queue.exclusive(async () => { order.push('restore'); await restoreHeld; order.push('restored'); });
  const nextCollection = queue.collect(() => { order.push('next collection'); });
  await queue.run(() => { order.push('settings'); });
  assert.deepEqual(order, ['collection', 'settings'], 'waiting for a provider must not prevent settings writes');
  releaseCollection();
  await collecting;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['collection', 'settings', 'collected', 'restore']);
  const saving = queue.run(() => { order.push('saved'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(order.includes('saved'), false, 'main-thread writes must wait for the SQLite restore transaction');
  assert.equal(order.includes('next collection'), false, 'new collectors must wait for storage maintenance');
  releaseRestore();
  await Promise.all([restoring, saving, nextCollection]);
  assert.ok(order.indexOf('saved') > order.indexOf('restored'));
  assert.ok(order.indexOf('next collection') > order.indexOf('restored'));
  await queue.close();
  await assert.rejects(queue.collect(() => {}), /closing/);
  await assert.rejects(queue.exclusive(() => {}), /closing/);
});

test('worker failures reject outstanding jobs and late replies cannot reach a replacement', async () => {
  const workers = [];
  const host = createMaintenanceHost({ createWorker: () => {
    const worker = new EventEmitter();
    worker.sent = [];
    worker.postMessage = (message) => worker.sent.push(message);
    workers.push(worker);
    return worker;
  } });
  const first = host.request('create-backup');
  workers[0].emit('error', new Error('Worker startup failed'));
  await assert.rejects(first, /Worker startup failed/);
  const second = host.request('scheduled-backup');
  const id = workers[1].sent[0].id;
  workers[0].emit('message', { id, ok: true, result: 'wrong worker' });
  workers[0].emit('exit', 1);
  workers[1].emit('message', { id, ok: true, result: null });
  assert.equal(await second, null);
  const closing = host.close();
  await assert.rejects(host.request('create-backup'), /closing/);
  workers[1].emit('message', { id: workers[1].sent[1].id, ok: true, result: { closed: true } });
  assert.deepEqual(await closing, { closed: true });
});

test('real worker backs up, exports and restores without blocking parent timers or losing its safety point', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-worker-'));
  const config = { databasePath: path.join(root, 'usage.sqlite'), backupDirectory: path.join(root, 'Backups') };
  const store = new UsageStore(config.databasePath, config.backupDirectory);
  const host = createMaintenanceHost(config);
  let pulse;
  try {
    store.updateSettings({ backupRetentionCount: 1, theme: 'light', backupFrequency: 'daily' });
    const insert = store.db.prepare(`INSERT INTO usage_events(event_key, source_id, occurred_at, model,
      input_tokens, output_tokens, metadata_json)
      VALUES (?, 'codex', ?, 'gpt-5.6-sol', 100, 20, ?)`);
    store.db.exec('BEGIN');
    for (let index = 0; index < 5000; index += 1) insert.run(`worker-${index}`, new Date().toISOString(), JSON.stringify({ padding: 'x'.repeat(1024) }));
    store.db.exec('COMMIT');
    await host.request('ping');
    let ticks = 0;
    pulse = setInterval(() => { ticks += 1; }, 2);
    const backup = await host.request('create-backup');
    assert.ok(ticks > 1, 'parent timers should keep running during a full database backup');
    assert.ok(fs.existsSync(backup.databasePath));
    assert.equal(store.readExport(backup.exportPath).usageEvents.length, 5000);
    const redundant = await host.request('scheduled-backup');
    assert.equal(redundant, null, 'scheduled backup should honor the backup already written');

    const csvPath = path.join(root, 'ledger.csv');
    const csv = await host.request('export-csv', { filePath: csvPath, days: 30 });
    assert.equal(csv.rows, 5000);
    assert.equal(fs.readFileSync(csvPath, 'utf8').trim().split('\r\n').length, 5001);

    store.db.prepare('DELETE FROM usage_events WHERE event_key = ?').run('worker-0');
    store.updateSettings({ theme: 'dark' });
    const restored = await host.request('restore-backup', { filePath: backup.exportPath });
    assert.equal(restored.result.usageEvents, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 5000);
    assert.equal(store.getSettings().theme, 'light');
    assert.ok(fs.existsSync(backup.exportPath), 'retention must protect the chosen restore point');
    assert.ok(fs.existsSync(restored.safetyBackup.exportPath), 'restore must leave a safety backup');
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

    await assert.rejects(host.request('restore-backup', { filePath: path.join(root, 'missing.json') }), /could not be found/);
    assert.deepEqual(await host.request('ping'), { ok: true }, 'a failed job must not poison the worker queue');
    const finalBackup = host.request('create-backup');
    const closing = host.close();
    assert.ok(fs.existsSync((await finalBackup).exportPath), 'graceful close must wait for the backup');
    await closing;
  } finally {
    clearInterval(pulse);
    await host.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a maintenance request that never answers times out and the wedged worker is replaced', async () => {
  const workers = [];
  const host = createMaintenanceHost({
    requestTimeoutMs: 20,
    createWorker: () => {
      const worker = new EventEmitter();
      worker.sent = [];
      worker.terminated = 0;
      worker.postMessage = (message) => worker.sent.push(message);
      worker.terminate = async () => { worker.terminated += 1; };
      workers.push(worker);
      return worker;
    },
  });
  const stalled = host.request('create-backup');
  const sibling = host.request('scheduled-backup');
  await assert.rejects(stalled, /did not respond in time \(create-backup\)/);
  await assert.rejects(sibling, /did not respond in time/);
  assert.equal(workers[0].terminated, 1);
  assert.equal(host.running, false);
  // A late reply from the abandoned worker is ignored; the next request gets a fresh one.
  const next = host.request('scheduled-backup');
  assert.equal(workers.length, 2);
  workers[0].emit('message', { id: workers[1].sent[0].id, ok: true, result: 'stale' });
  workers[1].emit('message', { id: workers[1].sent[0].id, ok: true, result: null });
  assert.equal(await next, null);
  // Close carries no timer: it is bounded by the caller's shutdown deadline.
  const closing = host.close();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(workers[1].terminated, 0);
  workers[1].emit('message', { id: workers[1].sent[1].id, ok: true, result: { closed: true } });
  assert.deepEqual(await closing, { closed: true });
});

function fakeWorkers() {
  const workers = [];
  const createWorker = () => {
    const worker = new EventEmitter();
    worker.sent = [];
    worker.terminated = 0;
    worker.postMessage = (message) => worker.sent.push(message);
    worker.terminate = async () => { worker.terminated += 1; worker.emit('exit', 1); };
    workers.push(worker);
    return worker;
  };
  const reply = (worker, result) => worker.emit('message', { id: worker.sent.at(-1).id, ok: true, result });
  return { workers, createWorker, reply };
}

test('an idle maintenance worker closes and exits, a new job gets a fresh one, and shutdown waits for it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { workers, createWorker, reply } = fakeWorkers();
  const host = createMaintenanceHost({ idleTimeoutMs: 30_000, createWorker });
  const backup = host.request('scheduled-backup');
  reply(workers[0], null);
  assert.equal(await backup, null);
  t.mock.timers.tick(29_000);
  assert.equal(workers[0].sent.length, 1, 'still within the idle period');
  t.mock.timers.tick(1_000);
  assert.equal(workers[0].sent.at(-1).type, 'close', 'the idle worker is asked to close its store');
  assert.equal(host.running, false);
  // A job arriving while it closes starts a fresh worker instead of waiting on it.
  const ping = host.request('ping');
  assert.equal(workers.length, 2);
  reply(workers[1], { ok: true });
  assert.deepEqual(await ping, { ok: true });
  // Shutdown closes the current worker and waits for the released one to exit.
  let closed = false;
  const closing = host.close().then((result) => { closed = true; return result; });
  reply(workers[1], { closed: true });
  await new Promise(setImmediate);
  assert.equal(closed, false, 'the released worker is still closing');
  workers[0].emit('exit', 0);
  assert.deepEqual(await closing, { closed: true });
  // A released worker that never exits is ended.
  const stuck = createMaintenanceHost({ idleTimeoutMs: 30_000, createWorker });
  const job = stuck.request('ping');
  reply(workers[2], { ok: true });
  await job;
  t.mock.timers.tick(30_000);
  t.mock.timers.tick(10_000);
  assert.equal(workers[2].terminated, 1);
});

test('a desktop import preview keeps its worker until it is imported, cancelled or expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  const { workers, createWorker, reply } = fakeWorkers();
  const host = createMaintenanceHost({ idleTimeoutMs: 30_000, now: () => clock, createWorker });
  const idle = (ms) => { clock += ms; t.mock.timers.tick(ms); };
  const preview = host.request('preview-desktop-export', { filePath: 'conversations.json' });
  reply(workers[0], { id: 'preview-1' });
  await preview;
  idle(10 * 60_000);
  assert.equal(host.running, true, 'the user is still reviewing the preview');
  const cancel = host.request('cancel-desktop-export', { previewId: 'preview-1' });
  reply(workers[0], { cancelled: true });
  await cancel;
  idle(30_000);
  assert.equal(host.running, false, 'released once the preview is cancelled');

  const again = host.request('preview-desktop-export', { filePath: 'conversations.json' });
  reply(workers[1], { id: 'preview-2' });
  await again;
  idle(29 * 60_000);
  assert.equal(host.running, true);
  idle(60_000);
  assert.equal(host.running, false, 'released once the preview has expired');
  for (const worker of workers) worker.emit('exit', 0);
  assert.deepEqual(await host.close(), { closed: true });
});

test('the window process can tell whether a scheduled backup is due without writing anything', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-worker-'));
  const store = new UsageStore(path.join(root, 'usage.sqlite'), path.join(root, 'Backups'));
  try {
    store.updateSettings({ backupFrequency: 'daily' });
    assert.equal(store.scheduledBackupDue(), true);
    assert.equal(store.scheduledBackupDue(), true, 'asking records no attempt');
    assert.ok(store.maybeCreateScheduledBackup());
    assert.equal(store.scheduledBackupDue(), false);
    assert.equal(store.scheduledBackupDue(Date.now() + 25 * 3_600_000), true);
    store.updateSettings({ backupFrequency: 'off' });
    assert.equal(store.scheduledBackupDue(Date.now() + 25 * 3_600_000), false);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a real idle worker closes its store and exits on its own', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-worker-'));
  const config = { databasePath: path.join(root, 'usage.sqlite'), backupDirectory: path.join(root, 'Backups') };
  new UsageStore(config.databasePath, config.backupDirectory).close();
  const host = createMaintenanceHost({ ...config, idleTimeoutMs: 50 });
  try {
    // Opens the worker's own store connection.
    await host.request('scheduled-backup');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(host.running, false);
    const started = Date.now();
    await host.close();
    assert.ok(Date.now() - started < 5_000, 'the released worker exited without being terminated');
  } finally {
    await host.close();
    // On Windows an open connection would keep the database locked.
    fs.rmSync(root, { recursive: true, force: true });
  }
});
