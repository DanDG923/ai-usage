'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  WINDOW_BOUNDS,
  createDeferredWindowReveal,
  initializeWithVisibleFailure,
  registerSingleInstance,
  resolveWindowTarget,
  revealWindow,
  createDeadline,
  settleWithin,
} = require('../../electron/app-lifecycle.cjs');

test('a secondary process quits without installing a second-instance handler', () => {
  const events = [];
  const app = {
    requestSingleInstanceLock: () => false,
    on: (event) => events.push(event),
    quitCalled: false,
    quit() { this.quitCalled = true; },
  };

  assert.equal(registerSingleInstance(app, () => {}), false);
  assert.equal(app.quitCalled, true);
  assert.deepEqual(events, []);
});

test('the primary process reveals its window when a second instance starts', () => {
  const handlers = new Map();
  const app = {
    requestSingleInstanceLock: () => true,
    on: (event, handler) => handlers.set(event, handler),
    quit() { throw new Error('primary process must not quit'); },
  };
  let reveals = 0;

  assert.equal(registerSingleInstance(app, () => { reveals += 1; }), true);
  handlers.get('second-instance')();
  assert.equal(reveals, 1);
});

test('revealing a hidden minimized window restores, shows, and focuses it', () => {
  const calls = [];
  const existing = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };

  const revealed = revealWindow(existing, () => {
    throw new Error('an existing window must be reused');
  });

  assert.equal(revealed, existing);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
});

test('revealing a missing window creates, shows, and focuses it', () => {
  const calls = [];
  const created = {
    isMinimized: () => false,
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };

  assert.equal(revealWindow(null, () => created), created);
  assert.deepEqual(calls, ['show', 'focus']);
});

test('packaged builds ignore a development server environment value', () => {
  assert.deepEqual(resolveWindowTarget({
    isPackaged: true,
    devUrl: 'http://localhost:5173',
    filePath: 'C:\\app\\dist\\index.html',
  }), {
    kind: 'file',
    value: 'C:\\app\\dist\\index.html',
  });
});

test('development builds use the configured development server', () => {
  assert.deepEqual(resolveWindowTarget({
    isPackaged: false,
    devUrl: 'http://localhost:5173',
    filePath: 'C:\\app\\dist\\index.html',
  }), {
    kind: 'url',
    value: 'http://localhost:5173',
  });
});

test('the main window remains usable on a 720-pixel-wide display', () => {
  assert.equal(WINDOW_BOUNDS.minWidth, 720);
  assert.equal(WINDOW_BOUNDS.minHeight, 720);
});

test('an early reveal request waits for app initialization and runs only once', () => {
  const calls = [];
  const reveal = createDeferredWindowReveal(() => calls.push('reveal'));

  reveal.request();
  reveal.request();
  assert.deepEqual(calls, []);

  reveal.markReady();
  assert.deepEqual(calls, ['reveal']);

  reveal.request();
  assert.deepEqual(calls, ['reveal', 'reveal']);
});

test('startup initialization failures are surfaced instead of becoming a hidden rejected promise', async () => {
  const failures = [];
  const completed = await initializeWithVisibleFailure({
    initialize: async () => { throw new Error('database unavailable'); },
    onFailure: (error) => failures.push(error.message),
  });

  assert.equal(completed, false);
  assert.deepEqual(failures, ['database unavailable']);
});

test('a visible load failure can retry the rejected operation', async () => {
  let attempts = 0;
  const failures = [];
  const completed = await initializeWithVisibleFailure({
    initialize: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('index.html unavailable');
    },
    onFailure: (error) => {
      failures.push(error.message);
      return 'retry';
    },
  });

  assert.equal(completed, true);
  assert.equal(attempts, 2);
  assert.deepEqual(failures, ['index.html unavailable']);
});

test('settleWithin passes results through and rejects once the shutdown budget is spent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(await settleWithin(Promise.resolve('closed'), 1_000, 'late'), 'closed');
  const stalled = settleWithin(new Promise(() => {}), 1_000, 'Storage did not close in time.');
  t.mock.timers.tick(999);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1);
  await assert.rejects(stalled, /did not close in time/);
});

test('one deadline bounds a multi-step sequence and reports whether it was the cause', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const deadline = createDeadline(15_000, 'Update preparation did not finish in time.');
  assert.equal(await Promise.race([Promise.resolve('drained'), deadline.expiry]), 'drained');
  assert.equal(deadline.expired, false);
  // A step that fails on its own is distinguishable from the deadline firing.
  await assert.rejects(Promise.race([Promise.reject(new Error('disk full')), deadline.expiry]), /disk full/);
  assert.equal(deadline.expired, false);
  const stalledBackup = assert.rejects(Promise.race([new Promise(() => {}), deadline.expiry]), /did not finish in time/);
  t.mock.timers.tick(15_000);
  await settle();
  await stalledBackup;
  assert.equal(deadline.expired, true);
  // Later steps racing the same expired deadline fail immediately.
  await assert.rejects(Promise.race([new Promise(() => {}), deadline.expiry]), /did not finish in time/);
  deadline.cancel();
  const cancelled = createDeadline(1_000, 'late');
  cancelled.cancel();
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(cancelled.expired, false);
});
