'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowIdleRelease } = require('../electron/window-idle.cjs');

function harness(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = new EventEmitter();
  let visible = true, destroyed = false, busy = false, released = 0;
  const sent = [];
  Object.assign(window, {
    isVisible: () => visible, isDestroyed: () => destroyed,
    webContents: { send: (...args) => sent.push(args) },
    hide: () => { visible = false; window.emit('hide'); },
    show: () => { visible = true; window.emit('show'); },
    destroy: () => { destroyed = true; window.emit('closed'); },
  });
  const controller = createWindowIdleRelease({ window, idleMs: 30, isBusy: () => busy, onRelease: () => { released++; } });
  return { window, controller, sent, busy: (value) => { busy = value; }, released: () => released };
}

test('closing to tray releases only after the idle delay and renderer consent', (t) => {
  const h = harness(t);
  h.window.hide();
  t.mock.timers.tick(29);
  assert.equal(h.sent.length, 0);
  t.mock.timers.tick(1);
  assert.equal(h.sent[0][0], 'dashboard:prepare-sleep');
  assert.equal(h.window.isDestroyed(), false);
  assert.equal(h.controller.reply(h.sent[0][1], true), true);
  assert.equal(h.window.isDestroyed(), false, 'the IPC reply can finish first');
  t.mock.timers.tick(1);
  assert.equal(h.window.isDestroyed(), true);
  assert.equal(h.released(), 1);
});

test('reopening cancels both an idle timer and an already approved destruction', (t) => {
  const h = harness(t);
  h.window.hide();
  h.window.show();
  t.mock.timers.tick(100);
  assert.equal(h.sent.length, 0);
  h.window.hide();
  t.mock.timers.tick(30);
  h.controller.reply(h.sent[0][1], true);
  h.window.show();
  t.mock.timers.tick(100);
  assert.equal(h.window.isDestroyed(), false);
  assert.equal(h.released(), 0);
});

test('busy work, drafts, absent replies and stale replies keep the window intact', (t) => {
  const h = harness(t);
  h.busy(true);
  h.window.hide();
  t.mock.timers.tick(30);
  assert.equal(h.sent.length, 0);
  h.busy(false);
  t.mock.timers.tick(30);
  t.mock.timers.tick(30);
  const first = h.sent[0][1];
  assert.equal(h.controller.reply(first, false), false);
  assert.equal(h.controller.reply(first, 'true'), false);
  t.mock.timers.tick(30);
  t.mock.timers.tick(30);
  assert.equal(h.controller.reply(first, true), false);
  const latest = h.sent.at(-1)[1];
  assert.equal(h.controller.reply(latest, true), true);
  h.busy(true);
  t.mock.timers.tick(1);
  assert.equal(h.window.isDestroyed(), false, 'work started after consent must also block release');
});

test('shutdown cancellation and a destroyed window cannot be released again', (t) => {
  const h = harness(t);
  h.window.hide();
  t.mock.timers.tick(30);
  h.controller.cancel();
  assert.equal(h.controller.reply(h.sent[0][1], true), false);
  t.mock.timers.tick(100);
  assert.equal(h.released(), 0);
  h.window.destroy();
  h.controller.schedule();
  t.mock.timers.tick(100);
  assert.equal(h.released(), 0);
});
