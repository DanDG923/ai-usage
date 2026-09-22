'use strict';
require('./setup.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { registerIpc } = require('../electron/ipc-handlers.cjs');

function mainHarness() {
  const handlers = new Map();
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => false;
  app.quit = () => {};
  const timers = [];
  const cleared = [];
  const filename = path.resolve(__dirname, '../electron/main.cjs');
  const localRequire = createRequire(filename);
  const context = vm.createContext({
    require: (id) => id === 'electron' ? { app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } } : localRequire(id),
    __dirname: path.dirname(filename), Buffer, console,
    process: { env: {}, argv: [], on() {}, execPath: process.execPath, stderr: process.stderr },
    setTimeout, clearTimeout,
    setInterval: (fn) => { const timer = { fn }; timers.push(timer); return timer; },
    clearInterval: (timer) => cleared.push(timer),
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  return { handlers, timers, cleared, run: (code) => vm.runInContext(code, context), context };
}

test('the actual main module protects every registered IPC handler against foreign frames', () => {
  const h = mainHarness();
  h.run("window = { isDestroyed: () => false, webContents: { mainFrame: {} } }; handleIpc('test', (_event, value) => value);");
  const fn = h.handlers.get('test');
  assert.throws(() => fn({ sender: {}, senderFrame: {} }), /only available/);
  const sender = h.run('window.webContents');
  assert.throws(() => fn({ sender, senderFrame: {} }), /only available/);
  assert.equal(fn({ sender, senderFrame: sender.mainFrame }, 42), 42);
  h.run('window.isDestroyed = () => true;');
  assert.throws(() => fn({ sender, senderFrame: sender.mainFrame }), /only available/);
});

test('unchanged settings preserve collection schedule and recent show refresh suppresses ticks', async () => {
  const h = mainHarness();
  h.run('globalThis.refreshes = 0; store = { getSettings: () => ({ refreshIntervalMinutes: 15 }) }; refreshAll = async () => { refreshes++; }; scheduleAutomaticRefresh(); scheduleAutomaticRefresh();');
  assert.equal(h.timers.length, 1);
  h.run('lastRefreshAt = Date.now();');
  h.timers[0].fn();
  assert.equal(h.run('refreshes'), 0);
  h.run('lastRefreshAt = Date.now() - 16 * 60_000;');
  h.timers[0].fn();
  assert.equal(h.run('refreshes'), 1);
  h.run('store.getSettings = () => ({ refreshIntervalMinutes: 0 }); scheduleAutomaticRefresh();');
  assert.equal(h.cleared.at(-1), h.timers[0]);
});

test('hidden collection uses only tray data and pushes no dashboard payload', () => {
  const h = mainHarness();
  h.run("globalThis.sent = 0; store = { getTraySnapshot: () => ({ kind: 'tray' }), getDashboardSnapshot: () => { throw Error('Full snapshot must not be built'); } }; window = { isDestroyed: () => false, isVisible: () => false, webContents: { send: () => { sent++; } } }; showNotifications = () => {}; publishAfterWrite(currentView());");
  assert.equal(h.run('sent'), 0);
  assert.equal(h.run('previousSnapshot.kind'), 'tray');
});

test('settings responses stay full snapshots after a hidden refresh invalidates the dashboard cache', () => {
  const h = mainHarness();
  h.run("store = { getSettings: () => ({ theme: 'dark' }), getTraySnapshot: () => ({ kind: 'tray' }), getDashboardSnapshot: () => ({ costs: { periodDays: 30 } }) }; window = { isDestroyed: () => false, isVisible: () => false }; cachedSnapshot = null;");
  assert.equal(h.run('patchSnapshotSettings().costs.periodDays'), 30);
  h.run('invalidateSnapshot();');
  assert.equal(h.run('lastFullSnapshot.costs.periodDays'), 30);
});

test('settings edits do not reintroduce an expired cached forecast after collection is disabled', () => {
  const h = mainHarness();
  h.run("store = { getSettings: () => ({ theme: 'dark' }), getDashboardSnapshot: () => ({ expired: true }) }; cachedSnapshot = { days: 30, at: Date.now() - 3_600_000, value: { expired: false } };");
  assert.equal(h.run('patchSnapshotSettings().expired'), true);
});

test('window release drops full snapshots but preserves reset and fallback notification evidence', () => {
  const h = mainHarness();
  h.run(`globalThis.released = 0; store = { releaseDashboardCaches: () => released++ };
    cachedSnapshot = { value: { costs: {} } }; lastFullSnapshot = cachedSnapshot.value;
    previousSnapshot = { costs: { heavy: true }, quotas: { codex: { windows: [{ bucketId: 'weekly', resetsAt: 'later', usedPercent: 90, forecast: { series: [1, 2, 3] } }] } }, sources: [{ id: 'codex', status: 'connected', metadata: { heavy: true } }] };
    releaseDashboardMemory();`);
  assert.equal(h.run('cachedSnapshot'), null);
  assert.equal(h.run('lastFullSnapshot'), null);
  assert.equal(h.run('released'), 1);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(previousSnapshot)')), {
    quotas: { codex: { windows: [{ bucketId: 'weekly', resetsAt: 'later', usedPercent: 90 }] } },
    sources: [{ id: 'codex', status: 'connected' }],
  });
});

test('in-flight dashboard IPC keeps the hidden window alive until success or failure settles', async () => {
  const h = mainHarness();
  h.run("window = { isDestroyed: () => false, webContents: { mainFrame: {} } }; handleIpc('test', () => new Promise((resolve, reject) => { globalThis.resolveJob = resolve; globalThis.rejectJob = reject; }));");
  const sender = h.run('window.webContents');
  const event = { sender, senderFrame: sender.mainFrame };
  const success = h.handlers.get('test')(event);
  assert.equal(h.run('activeDashboardRequests'), 1);
  h.run('resolveJob(42);');
  assert.equal(await success, 42);
  assert.equal(h.run('activeDashboardRequests'), 0);
  const failure = h.handlers.get('test')(event);
  h.run("rejectJob(Error('failed')); ");
  await assert.rejects(failure, /failed/);
  assert.equal(h.run('activeDashboardRequests'), 0);
});

test('tray copy retains the full cost summary without caching a dashboard', () => {
  const h = mainHarness();
  h.run(`globalThis.released = 0;
    store = { getDashboardSnapshot: () => ({ quotas: {}, costs: { actual: 12.34, currency: 'GBP', periodDays: 90 } }), releaseDashboardCaches: () => released++ };
    window = null; periodDays = 90;`);
  assert.match(h.run('traySummary()'), /12.34/);
  assert.match(h.run('traySummary()'), /90/);
  assert.equal(h.run('released'), 2);
  assert.equal(h.run('cachedSnapshot'), null);
  assert.equal(h.run('lastFullSnapshot'), null);
});

test('closing IPC serves the last full snapshot rather than a tray-only notification view', () => {
  const handlers = new Map();
  registerIpc({ handleIpc: (name, fn) => handlers.set(name, fn), storageClosing: () => true,
    getCachedSnapshot: () => ({ value: { costs: { periodDays: 30 } } }),
    getPreviousSnapshot: () => ({ quotas: {} }),
  });
  assert.equal(handlers.get('dashboard:get-snapshot')().costs.periodDays, 30);
});

test('Quit during storage close cancels the prepared update instead of authorizing the installer', async () => {
  const h = mainHarness();
  let releaseClose;
  h.context.closeWait = new Promise((resolve) => { releaseClose = resolve; });
  h.run("updateLog = () => {}; stopForShutdown = () => {}; maintenance = { request: async () => ({}) }; closeStorage = () => closeWait;");
  const preparation = h.run('prepareUpdateInstall()');
  await new Promise((resolve) => setImmediate(resolve));
  h.run('quitRequestedDuringUpdate = true;');
  releaseClose();
  await assert.rejects(preparation, /cancelled while quitting/);
  assert.equal(h.run('shutdownComplete'), true);
  assert.equal(h.run('preparingUpdate'), false);
});

test('preload removes IPC transport prefixes and does not expose events to listeners', async () => {
  let bridge, listener, removed;
  const context = {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: {
        invoke: async () => { throw new Error("Error invoking remote method 'dashboard:create-backup': Error: Disk is full."); },
        on: (_channel, callback) => { listener = callback; },
        removeListener: (_channel, callback) => { removed = callback; },
      },
    }),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), context);
  await assert.rejects(bridge.createBackup(), { message: 'Disk is full.' });
  let args;
  const off = bridge.onUpdated((...values) => { args = values; });
  listener({ secret: true }, { generatedAt: 'today' });
  assert.deepEqual(args, [{ generatedAt: 'today' }]);
  off();
  assert.equal(removed, listener);
});

test('helper mutation returns immediately even if its background collection fails', async () => {
  const handlers = new Map(), logs = [];
  let changed = 0, reject;
  const refresh = new Promise((_resolve, fail) => { reject = fail; });
  registerIpc({ handleIpc: (name, fn) => handlers.set(name, fn), installClaudeHelper: () => ++changed,
    getInboxPath: () => 'inbox', refreshClaudeOnly: () => refresh, log: (line) => logs.push(line) });
  const result = await handlers.get('dashboard:install-claude-helper')();
  assert.deepEqual(result, { result: 1 });
  reject(new Error('offline'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(changed, 1);
  assert.match(logs[0], /offline/);
});

test('read-only exports bypass the exclusive database lane, and cancelling does not build a snapshot', async () => {
  const handlers = new Map(), calls = [];
  registerIpc({ handleIpc: (name, fn) => handlers.set(name, fn),
    getWindow: () => undefined, app: { getPath: () => 'documents' },
    store: { backupDirectory: 'backups' },
    dialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ filePath: 'export.csv' }) },
    databaseJobs: { exclusive: () => assert.fail('read-only export must not block collectors') },
    snapshot: () => assert.fail('cancel must not rebuild'),
    maintenance: { request: async (...args) => { calls.push(args); return {}; } },
  });
  assert.deepEqual(await handlers.get('dashboard:restore-backup')(), { cancelled: true });
  await handlers.get('dashboard:export-csv')({}, 30);
  assert.equal(calls[0][0], 'export-csv');
});
