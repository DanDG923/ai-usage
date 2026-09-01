'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  WINDOW_BOUNDS,
  createDeferredWindowReveal,
  initializeWithVisibleFailure,
  registerSingleInstance,
  resolveWindowTarget,
  revealWindow,
} = require('../electron/app-lifecycle.cjs');

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
