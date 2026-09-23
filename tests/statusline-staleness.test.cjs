'use strict';
require('./setup.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { deriveLearningSamples, forecastQuota, withoutStaleRestatements } = require('../electron/forecast.cjs');
const { UsageStore } = require('../electron/store.cjs');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const RESET = '2026-09-28T08:00:00.000Z';
const NOW = '2026-09-23T21:28:38.000Z';
const SCHEDULE = { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 8, endHour: 22 };

const reading = (observedAt, usedPercent, provenance) => ({
  observedAt: typeof observedAt === 'number' ? new Date(observedAt).toISOString() : observedAt,
  usedPercent, remainingPercent: 100 - usedPercent, resetsAt: RESET, windowMinutes: 10_080, provenance,
});

// The pattern that made a healthy Claude week read as critical: an idle Claude
// Code session keeps redrawing its status line with the 1% it last fetched,
// while the official usage read (fresh each time) reports 13%, then 14%, then 17%.
function week({ withStaleStatusLine }) {
  const rows = [reading('2026-09-22T16:21:00.000Z', 0, 'official-statusline'), reading('2026-09-22T17:10:00.000Z', 1, 'official-statusline')];
  const statusLineUntil = Date.parse('2026-09-23T01:18:00.000Z');
  for (let at = Date.parse('2026-09-22T17:20:00.000Z'); at <= statusLineUntil; at += 10 * MINUTE) {
    if (withStaleStatusLine || at < Date.parse('2026-09-22T21:07:40.000Z')) rows.push(reading(at, 1, 'official-statusline'));
  }
  // 22:07 local, just after the active hours end at 22:00.
  rows.push(reading('2026-09-22T21:07:40.000Z', 13, 'official-claude-usage'));
  for (let hour = 1; hour <= 3; hour += 1) rows.push(reading(Date.parse('2026-09-22T21:07:40.000Z') + hour * HOUR, 13, 'official-claude-usage'));
  rows.push(reading('2026-09-23T00:16:00.000Z', 14, 'official-claude-usage'));
  rows.push(reading('2026-09-23T11:51:00.000Z', 14, 'official-claude-usage'));
  rows.push(reading('2026-09-23T21:25:00.000Z', 17, 'official-claude-usage'));
  return rows.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}

test('a lower status-line reading after a fresh read is dropped; earlier and other-window readings are kept', () => {
  const kept = withoutStaleRestatements([
    reading('2026-09-22T17:00:00.000Z', 1, 'official-statusline'),
    reading('2026-09-22T21:00:00.000Z', 13, 'official-claude-usage'),
    reading('2026-09-22T21:05:00.000Z', 1, 'official-statusline'),
    reading('2026-09-22T21:10:00.000Z', 13, 'official-statusline'),
    { ...reading('2026-09-22T21:15:00.000Z', 1, 'official-statusline'), resetsAt: '2026-10-05T08:00:00.000Z' },
  ]);
  assert.deepEqual(kept.map((row) => [row.observedAt.slice(11, 16), row.usedPercent]), [
    ['17:00', 1], ['21:00', 13], ['21:10', 13], ['21:15', 1],
  ]);
  // A fresh read that shows a replenishment becomes the new reference.
  const replenished = withoutStaleRestatements([
    reading('2026-09-22T20:00:00.000Z', 40, 'official-claude-usage'),
    reading('2026-09-22T21:00:00.000Z', 1, 'official-claude-usage'),
    reading('2026-09-22T21:05:00.000Z', 1, 'official-statusline'),
  ]);
  assert.equal(replenished.length, 3);
});

test('interleaved stale status-line readings neither reset the window nor add late-night use', () => {
  const clean = forecastQuota(week({ withStaleStatusLine: false }), { now: NOW, schedule: SCHEDULE, compactReadings: true });
  const mixed = forecastQuota(week({ withStaleStatusLine: true }), { now: NOW, schedule: SCHEDULE, compactReadings: true });
  assert.notEqual(mixed.state, 'critical');
  assert.equal(mixed.exhaustsAt, null, 'a week at 17% used by Wednesday night does not run out');
  assert.ok(Math.abs(mixed.expectedRemaining - clean.expectedRemaining) < 1, `${mixed.expectedRemaining} vs ${clean.expectedRemaining}`);
  assert.ok(Math.abs(mixed.safePace - clean.safePace) < 0.05, `${mixed.safePace} vs ${clean.safePace}`);
  // The observed line starts at the window's first reading, not at a phantom reset.
  assert.ok(mixed.series.observed.every((point) => point.remaining >= 83));
});

test('an unchanged status-line reading does not pin the next increase to its own time', () => {
  // The session last changed to 1% at 18:10 local; the 12% rise is first seen by a
  // fresh read at 22:07 local. Its phase must follow the span since 18:10, which
  // is almost all active hours, not the nine minutes after the last repeat.
  const rows = [
    reading('2026-09-22T17:10:00.000Z', 1, 'official-statusline'),
    ...Array.from({ length: 24 }, (_, index) => reading(Date.parse('2026-09-22T17:18:25.000Z') + index * 10 * MINUTE, 1, 'official-statusline')),
    reading('2026-09-22T21:07:40.000Z', 13, 'official-claude-usage'),
  ];
  const samples = deriveLearningSamples(rows, SCHEDULE, Date.parse(NOW));
  const offSchedule = samples.filter((sample) => sample.phase === 'off-schedule').reduce((sum, sample) => sum + sample.delta, 0);
  const active = samples.filter((sample) => sample.phase === 'active').reduce((sum, sample) => sum + sample.delta, 0);
  assert.ok(offSchedule < 1, `off-schedule share ${offSchedule}`);
  assert.ok(active > 11, `active share ${active}`);
});

test('a card never shows a stale status-line restatement as the current balance', () => {
  const store = new UsageStore(':memory:', os.tmpdir());
  try {
    const now = Date.now();
    const resetsAt = new Date(now + 4 * 24 * HOUR).toISOString();
    const record = (at, usedPercent, provenance) => store.recordObservation({
      sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly', observedAt: new Date(at).toISOString(),
      usedPercent, remainingPercent: 100 - usedPercent, resetsAt, windowMinutes: 10_080, planType: null,
      provenance, confidence: 1, metadata: {},
    });
    record(now - 3 * HOUR, 1, 'official-statusline');
    record(now - 2 * HOUR, 13, 'official-claude-usage');
    record(now - MINUTE, 1, 'official-statusline');
    const quota = store.getQuota('claude');
    assert.equal(quota.remainingPercent, 87);
    assert.equal(quota.provenance, 'official-claude-usage');
  } finally {
    store.close();
  }
});
