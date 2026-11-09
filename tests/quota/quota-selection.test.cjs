'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');
const { isMainWindow, isOfficialWindow, orderWindows, selectDisplayedWindows } = require('../../electron/quota-selection.cjs');

const NOW = Date.parse('2026-09-14T12:00:00Z');
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const window = (bucketId, overrides = {}) => ({
  bucketId, observedAt: iso(NOW - HOUR), resetsAt: iso(NOW + 3 * 24 * HOUR), windowMinutes: 10_080,
  provenance: 'official', metadata: {}, forecast: { expired: false }, ...overrides,
});

test('the main allowance is recognised by limit id, scope, or canonical bucket, never by suffix guessing', () => {
  assert.ok(isMainWindow(window('codex:primary')));
  assert.ok(isMainWindow(window('codex_bengalfox:primary', { metadata: { limitId: 'codex' } })));
  assert.ok(!isMainWindow(window('codex_bengalfox:primary', { metadata: { limitId: 'codex_bengalfox' } })));
  assert.ok(isMainWindow(window('seven_day')));
  assert.ok(isMainWindow(window('five_hour')));
  assert.ok(isMainWindow(window('anything', { metadata: { scope: 'overall' } })));
  assert.ok(!isMainWindow(window('seven_day', { metadata: { scope: 'model' } })));
  assert.ok(!isMainWindow(window('seven_day_opus')));
  assert.ok(!isMainWindow(window('seven_day_haiku')), 'an unrecognised scope-less bucket is not assumed to be the pool');
  assert.ok(!isMainWindow(window('model_scoped:fable')));
  assert.ok(isMainWindow(window('fable_seven_day')));
  assert.ok(isMainWindow(window('fable:seven_day_fable')));
  assert.ok(!isMainWindow(window('fable:five_hour_fable')));
  assert.ok(!isMainWindow(null));
  assert.ok(isOfficialWindow(window('x', { provenance: 'official-claude-usage' })));
  assert.ok(isOfficialWindow(window('x', { provenance: 'local-official' })));
  assert.ok(!isOfficialWindow(window('x', { provenance: 'derived-tokens' })));
  assert.ok(!isOfficialWindow(window('x', { provenance: 'manual-official' })), 'a typed reading is not provider-backed');
});

test('windows order active, main, longest, official, newest, then bucket id', () => {
  const expired = window('seven_day', { resetsAt: iso(NOW - HOUR), observedAt: iso(NOW - 2 * HOUR), forecast: { expired: true } });
  const fiveHour = window('five_hour', { windowMinutes: 300 });
  const opus = window('seven_day_opus', { metadata: { scope: 'model' } });
  const derived = window('seven_day', { provenance: 'derived-tokens', observedAt: iso(NOW) });
  const older = window('seven_day', { observedAt: iso(NOW - 3 * HOUR) });
  const newest = window('seven_day');
  const ordered = orderWindows([expired, opus, derived, fiveHour, older, newest], { nowMs: NOW }).map((entry) => entry.window);
  assert.deepEqual(ordered, [newest, older, derived, fiveHour, opus, expired]);
  const byFlag = orderWindows([expired, opus, derived, fiveHour, older, newest]).map((entry) => entry.window);
  assert.deepEqual(byFlag, ordered, 'without a clock the forecast flag the store set gives the same order');
  const tie = [window('b'), window('a')];
  assert.deepEqual(orderWindows(tie, { nowMs: NOW }).map((entry) => entry.window.bucketId), ['a', 'b']);
});

test('selection headlines the first active window and falls back to an expired one', () => {
  const main = window('codex:secondary', { metadata: { limitId: 'codex' } });
  const spark = window('codex_bengalfox:secondary', { metadata: { limitId: 'codex_bengalfox' } });
  const sparkSession = window('codex_bengalfox:primary', { windowMinutes: 300, metadata: { limitId: 'codex_bengalfox' } });
  const oldSlot = window('codex:primary', { resetsAt: iso(NOW - HOUR), forecast: { expired: true } });
  const selection = selectDisplayedWindows([spark, sparkSession, oldSlot, main], { nowMs: NOW });
  assert.equal(selection.primary, main, 'the account limit wins regardless of slot name or endpoint order');
  assert.deepEqual(selection.active, [main, spark, sparkSession]);
  assert.deepEqual(selection.secondary, [spark, sparkSession]);
  assert.deepEqual(selection.expired, [oldSlot]);
  const onlyExpired = selectDisplayedWindows([oldSlot], { nowMs: NOW });
  assert.equal(onlyExpired.primary, oldSlot, 'an expired-only provider still reports its last window');
  assert.deepEqual(onlyExpired.active, []);
  assert.deepEqual(selectDisplayedWindows([], { nowMs: NOW }), { primary: null, active: [], secondary: [], expired: [] });
  assert.deepEqual(selectDisplayedWindows(null).primary, null);
});

test('a caller may supply its own expiry signal', () => {
  const a = window('seven_day', { forecast: { expired: true } });
  const b = window('five_hour', { windowMinutes: 300 });
  assert.equal(selectDisplayedWindows([a, b]).primary, b, 'the forecast flag is the default signal');
  assert.equal(selectDisplayedWindows([a, b], { isExpired: () => false }).primary, a);
  assert.equal(selectDisplayedWindows([a, b], { nowMs: NOW }).primary, a, 'a clock overrides a stale flag');
});
