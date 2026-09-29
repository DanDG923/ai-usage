'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore, DEFAULT_SETTINGS } = require('../electron/store.cjs');
const { readStartupPreferences } = require('../electron/startup-preferences.cjs');
const { registerIpc } = require('../electron/ipc-handlers.cjs');

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-rendering-'));
  // Windows refuses to remove a directory while a database handle is open;
  // every test closes its store before this runs.
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}

test('software rendering is on by default and validated as a boolean', (t) => {
  const root = scratch(t);
  const store = new UsageStore(path.join(root, 'ai-usage.sqlite'), path.join(root, 'Backups'));
  try {
    assert.equal(DEFAULT_SETTINGS.softwareRendering, true);
    assert.equal(store.getSettings().softwareRendering, true);
    assert.throws(() => store.updateSettings({ softwareRendering: 'yes' }), /Invalid value/);
    store.updateSettings({ softwareRendering: false });
    assert.equal(store.getSettings().softwareRendering, false);
  } finally {
    store.close();
  }
});

test('the startup preference is read from the saved database before the store opens', (t) => {
  const root = scratch(t);
  const databasePath = path.join(root, 'ai-usage.sqlite');
  assert.deepEqual(readStartupPreferences(databasePath), { softwareRendering: true }, 'first launch uses the default');
  const store = new UsageStore(databasePath, path.join(root, 'Backups'));
  store.updateSettings({ softwareRendering: false });
  assert.deepEqual(readStartupPreferences(databasePath), { softwareRendering: false }, 'readable while the store holds the database open');
  store.close();
  assert.deepEqual(readStartupPreferences(databasePath), { softwareRendering: false });
  assert.ok(!fs.existsSync(`${databasePath}-journal`), 'reading must not leave a rollback journal behind');
});

test('an unreadable database, a bad value and a missing path all keep the default', (t) => {
  const root = scratch(t);
  const garbage = path.join(root, 'garbage.sqlite');
  fs.writeFileSync(garbage, 'not a database');
  assert.deepEqual(readStartupPreferences(garbage), { softwareRendering: true });
  assert.deepEqual(readStartupPreferences(undefined), { softwareRendering: true });
  const databasePath = path.join(root, 'ai-usage.sqlite');
  const store = new UsageStore(databasePath, path.join(root, 'Backups'));
  store.db.prepare("UPDATE settings SET value_json = '\"sometimes\"' WHERE key = 'softwareRendering'").run();
  store.close();
  assert.deepEqual(readStartupPreferences(databasePath), { softwareRendering: true });
});

test('the renderer learns the active and requested rendering modes and can request a relaunch', async () => {
  const handlers = new Map();
  let relaunches = 0;
  registerIpc({
    handleIpc: (name, fn) => handlers.set(name, fn),
    store: { getSettings: () => ({ softwareRendering: false }) },
    renderingMode: 'software',
    relaunch: () => { relaunches++; },
  });
  assert.deepEqual(handlers.get('app:rendering-mode')(), { active: 'software', requested: 'hardware', forced: false });
  await handlers.get('app:relaunch')();
  assert.equal(relaunches, 1);
});

test('an environment override is reported as forced so the renderer never offers a pointless restart', () => {
  const handlers = new Map();
  registerIpc({
    handleIpc: (name, fn) => handlers.set(name, fn),
    store: { getSettings: () => ({ softwareRendering: false }) },
    renderingMode: 'software',
    renderingForced: true,
    relaunch: () => {},
  });
  assert.deepEqual(handlers.get('app:rendering-mode')(), { active: 'software', requested: 'hardware', forced: true });
});

test('a rendering change is a cheap setting that never rebuilds the dashboard snapshot', async () => {
  const handlers = new Map();
  let rebuilt = 0;
  let patched = 0;
  registerIpc({
    handleIpc: (name, fn) => handlers.set(name, fn),
    store: { updateSettings: (patch) => ({ ...patch }) },
    databaseJobs: { run: (operation) => Promise.resolve().then(operation) },
    invalidateSnapshot: () => { rebuilt++; },
    applySettingsEffects: () => {},
    snapshot: () => { rebuilt++; return {}; },
    patchSnapshotSettings: () => { patched++; return { settings: {} }; },
    updateTray: () => {},
  });
  await handlers.get('dashboard:update-settings')({}, { softwareRendering: false });
  assert.equal(rebuilt, 0);
  assert.equal(patched, 1);
});

test('digest settings patch the snapshot, while a new refresh interval rebuilds the forecasts it affects', async () => {
  const handlers = new Map();
  let invalidated = 0;
  let patched = 0;
  registerIpc({
    handleIpc: (name, fn) => handlers.set(name, fn),
    store: { updateSettings: (patch) => ({ ...patch }) },
    databaseJobs: { run: (operation) => Promise.resolve().then(operation) },
    invalidateSnapshot: () => { invalidated++; },
    applySettingsEffects: () => {},
    snapshot: () => ({}),
    patchSnapshotSettings: () => { patched++; return { settings: {} }; },
    updateTray: () => {},
  });
  const update = (patch) => handlers.get('dashboard:update-settings')({}, patch);
  await update({ notifyDigest: true });
  await update({ digestHour: 7 });
  assert.deepEqual({ invalidated, patched }, { invalidated: 0, patched: 2 });
  // The grace a lower status-line reading waits for is two refresh intervals.
  await update({ refreshIntervalMinutes: 240 });
  assert.deepEqual({ invalidated, patched }, { invalidated: 1, patched: 2 });
});
