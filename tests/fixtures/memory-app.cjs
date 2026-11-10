'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { app, Notification } = require('electron');
const source = process.env.AI_USAGE_MEMORY_SOURCE;
const root = process.env.AI_USAGE_MEMORY_ROOT;
const mode = process.env.AI_USAGE_MEMORY_MODE;
if (!source || !root || !root.includes(`${path.sep}work${path.sep}memory-`)) throw new Error('Use tools/benchmark-memory.cjs.');
app.setPath('userData', path.join(root, 'profile'));
// The real main module runs, but an isolated test must never change autostart
// or issue desktop notifications on the user's machine.
app.setLoginItemSettings = () => {};
Notification.isSupported = () => false;
fs.writeFileSync(path.join(root, 'claude-setup.json'), JSON.stringify({ dismissed: true }));
const { UsageStore } = require(path.join(source, 'electron/store.cjs'));
const seeded = new UsageStore(path.join(root, 'ai-usage.sqlite'), path.join(root, 'Backups'));
seeded.updateSettings({ autoUpdate: false, backupFrequency: 'off', refreshIntervalMinutes: 0,
  notifyDesktop: false, notifyResets: false, notifyFallback: false });
const now = Date.now();
seeded.transaction(() => {
  for (let index = 0; index < 30_000; index++) {
    seeded.recordUsageEvent({ eventKey: `synthetic-${index}`, sourceId: index % 2 ? 'claude' : 'codex',
      occurredAt: new Date(now - (index + 1) * (28 * 86_400_000 / 30_000)).toISOString(),
      model: index % 2 ? 'claude-fable-5' : 'gpt-5.6-sol', sessionId: `session-${index % 200}`,
      project: `synthetic-project-${index % 20}`, inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50 });
  }
});
seeded.close();
const filename = path.join(source, 'electron/main.cjs');
let api;
if (fs.existsSync(path.join(source, 'electron/app/application.cjs'))) {
  // The entry point exports the application it started.
  const application = require(filename);
  api = {
    showMainWindow: () => application.dashboard.showMainWindow(),
    refreshAll: () => application.refresh.refreshAll(),
    stopForShutdown: () => application.lifecycle.stopForShutdown(),
    closeStorage: () => application.lifecycle.closeStorage(),
    get window() { return application.dashboard.window; }, get collectors() { return application.collectors; },
    get store() { return application.store; },
    get cached() { return Boolean(application.snapshots.cachedSnapshot || application.snapshots.lastFullSnapshot); },
  };
} else {
  // An older source tree, for a baseline: its entry point kept everything in
  // module scope, which only the module wrapper can reach.
  const main = new Module(filename, module);
  main.filename = filename;
  // oxlint-disable-next-line no-underscore-dangle
  main.paths = Module._nodeModulePaths(path.dirname(filename));
  // oxlint-disable-next-line no-underscore-dangle
  main._compile(fs.readFileSync(filename, 'utf8') + `
module.exports = {
  showMainWindow, refreshAll, closeStorage, stopForShutdown,
  get window() { return window; }, get collectors() { return collectors; },
  get store() { return store; },
  get cached() { return Boolean(cachedSnapshot || lastFullSnapshot); },
};`, filename);
  api = main.exports;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { mode, electron: process.versions.electron, records: 30_000, samples: [] };
report.windowEvents = [];
app.on('browser-window-created', (_event, target) => {
  report.windowEvents.push({ event: 'created', id: target.id });
  for (const event of ['show', 'hide', 'closed']) target.on(event, () => {
    report.windowEvents.push({ event, id: target.id });
  });
});
function measure(phase) {
  const processes = app.getAppMetrics().map(({ type, name, serviceName, memory }) => ({ type, name, serviceName,
    workingSetMiB: Number((memory.workingSetSize / 1024).toFixed(2)), privateMiB: Number(((memory.privateBytes || 0) / 1024).toFixed(2)) }));
  const sample = { phase, processes, workingSetMiB: Number(processes.reduce((sum, row) => sum + row.workingSetMiB, 0).toFixed(2)),
    privateMiB: Number(processes.reduce((sum, row) => sum + row.privateMiB, 0).toFixed(2)) };
  report.samples.push(sample);
  console.log(JSON.stringify(sample));
}
// The default software rendering keeps the GPU process near 30 MiB private;
// hardware acceleration leaves it near 200 MiB once a dashboard has been drawn.
function assertSmallGpuProcess() {
  const gpu = report.samples.at(-1).processes.find((row) => row.type === 'GPU');
  assert.ok(gpu && gpu.privateMiB < 100, `the GPU process must stay small under software rendering (${gpu?.privateMiB} MiB)`);
}
const evaluate = (fn) => api.window.webContents.executeJavaScript(`(${fn.toString()})()`);
async function until(fn) {
  for (let i = 0; i < 160; i++) { if (await fn()) return; await wait(50); }
  throw new Error(`Timed out: ${fn}`);
}
const ready = () => until(() => api.window && api.window.isVisible() && evaluate(() => Boolean(document.querySelector('#tab-costs'))));
app.whenReady().then(async () => {
  try {
    await until(() => api.store);
    if (mode === 'hidden') {
      await wait(2000);
      assert.equal(api.window, undefined, 'hidden startup must not allocate a renderer');
      await api.refreshAll();
      await wait(32_000);
      assert.equal(api.collectors.running, false);
      measure('hidden-startup');
      assertSmallGpuProcess();
      api.showMainWindow();
      await ready();
      await until(() => api.window.isVisible());
    } else {
      await ready();
      await wait(1200);
      await api.refreshAll();
      await evaluate(() => document.querySelector('#tab-costs').click());
      await until(() => evaluate(() => Boolean(document.querySelector('.period-switch'))));
      await evaluate(() => [...document.querySelectorAll('.period-switch button')].find((button) => button.textContent.includes('90')).click());
      await until(() => evaluate(() => document.querySelector('.period-switch [aria-pressed="true"]')?.textContent.includes('90')));
      await evaluate(() => {
        const input = document.querySelector('input[type="search"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'synthetic-project-2');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await until(() => evaluate(() => !document.querySelector('[aria-busy="true"]')));
      await wait(500);
      measure('open-after-refresh');
      const firstWindow = api.window;
      firstWindow.close();
      assert.equal(firstWindow.isVisible(), false);
      await wait(34_000);
      measure('tray-idle');
      if (mode === 'optimized') {
        assertSmallGpuProcess();
        assert.equal(firstWindow.isDestroyed(), true);
        assert.equal(api.collectors.running, false);
        assert.equal(api.cached, false);
        assert.equal(api.store.costAnalyticsCache.size, 0);
      } else {
        assert.equal(firstWindow.isDestroyed(), false);
        assert.equal(api.collectors.running, true);
      }
      // Background tracking is still available without a dashboard.
      await api.refreshAll();
      assert.equal(api.collectors.running, true);
      const started = Date.now();
      api.showMainWindow();
      await ready();
      await until(() => evaluate(() => Boolean(document.querySelector('#panel-costs'))));
      await until(() => evaluate(() => !document.querySelector('[aria-busy="true"]')));
      report.reopenMs = Date.now() - started;
      assert.equal(await evaluate(() => document.querySelector('input[type="search"]').value), 'synthetic-project-2');
      assert.equal(await evaluate(() => document.querySelector('.period-switch [aria-pressed="true"]').textContent.includes('90')), true);
      measure('reopened');
      if (mode === 'optimized') {
        await evaluate(() => document.querySelector('#tab-settings').click());
        await until(() => evaluate(() => Boolean(document.querySelector('#panel-settings'))));
        const editingWindow = api.window;
        editingWindow.close();
        await wait(32_000);
        assert.equal(editingWindow.isDestroyed(), false, 'Settings drafts must keep the window alive');
        api.showMainWindow();
        assert.equal(api.window, editingWindow);
      }
    }
    assert.equal(api.store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(api.store.db.prepare('SELECT COUNT(*) AS n FROM usage_events').get().n, 30_000);
    const errorLog = path.join(root, 'profile', 'renderer-errors.log');
    assert.equal(fs.existsSync(errorLog) ? fs.readFileSync(errorLog, 'utf8') : '', '');
    report.passed = true;
    console.log('MEMORY_SMOKE_PASS');
  } catch (error) {
    report.passed = false;
    report.error = error.stack;
    console.error(error);
  } finally {
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    api.stopForShutdown();
    await api.closeStorage();
    app.exit(report.passed ? 0 : 1);
  }
});
