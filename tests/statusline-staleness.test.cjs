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

const times = (rows) => rows.map((row) => [row.observedAt.slice(11, 16), row.usedPercent]);

test('a lower status-line reading is dropped when the provider’s next read shows no drop', () => {
  const kept = withoutStaleRestatements([
    reading('2026-09-22T17:00:00.000Z', 1, 'official-statusline'),
    reading('2026-09-22T21:00:00.000Z', 13, 'official-claude-usage'),
    reading('2026-09-22T21:05:00.000Z', 1, 'official-statusline'),
    reading('2026-09-22T21:10:00.000Z', 13, 'official-statusline'),
    { ...reading('2026-09-22T21:15:00.000Z', 1, 'official-statusline'), resetsAt: '2026-10-05T08:00:00.000Z' },
    reading('2026-09-22T22:00:00.000Z', 14, 'official-claude-usage'),
  ], { nowMs: Date.parse('2026-09-23T09:00:00.000Z') });
  // Earlier, equal and other-window readings stay; so does a fresh read.
  assert.deepEqual(times(kept), [['17:00', 1], ['21:00', 13], ['21:10', 13], ['21:15', 1], ['22:00', 14]]);
  // A fresh read that shows a replenishment becomes the new reference.
  const replenished = withoutStaleRestatements([
    reading('2026-09-22T20:00:00.000Z', 40, 'official-claude-usage'),
    reading('2026-09-22T21:00:00.000Z', 1, 'official-claude-usage'),
    reading('2026-09-22T21:05:00.000Z', 1, 'official-statusline'),
  ], { nowMs: Date.parse('2026-09-22T21:10:00.000Z') });
  assert.equal(replenished.length, 3);
});

test('an undated early replenishment is kept once the provider confirms it or stays silent past its freshness limit', () => {
  // Claude replenishes before its advertised reset moves: the status line
  // reports 0% and 2% while the last provider read still says 40%. These
  // readings carry no fetch date (a helper that did not record sessions).
  const rows = [
    reading('2026-09-22T20:00:00.000Z', 40, 'official-claude-usage'),
    reading('2026-09-22T20:30:00.000Z', 0, 'official-statusline'),
    reading('2026-09-22T20:50:00.000Z', 2, 'official-statusline'),
  ];
  const confirmed = withoutStaleRestatements([...rows, reading('2026-09-22T21:00:00.000Z', 3, 'official-claude-usage')]);
  assert.deepEqual(times(confirmed), [['20:00', 40], ['20:30', 0], ['20:50', 2], ['21:00', 3]]);
  // Awaiting the next provider read, the drop is held back. Provider reads
  // are manual, so a few hours of silence is normal and proves nothing…
  assert.deepEqual(times(withoutStaleRestatements(rows, { nowMs: Date.parse('2026-09-22T23:30:00.000Z') })), [['20:00', 40]]);
  // …but a weekly read a day old is out of date anyway, and then the status
  // line is believed.
  assert.equal(withoutStaleRestatements(rows, { nowMs: Date.parse('2026-09-23T20:30:00.000Z') }).length, 3);
  // A five-hour window is out of date after an hour, so it waits only the
  // grace: two hours, or two refreshes where those are longer.
  const fiveHour = rows.map((row) => ({ ...row, windowMinutes: 300, resetsAt: '2026-09-23T00:00:00.000Z' }));
  assert.equal(withoutStaleRestatements(fiveHour, { nowMs: Date.parse('2026-09-22T22:30:00.000Z') }).length, 3);
  assert.equal(
    withoutStaleRestatements(fiveHour, { nowMs: Date.parse('2026-09-22T22:30:00.000Z'), freshReadGraceMs: 4 * HOUR }).length,
    1,
    'a longer refresh interval waits longer',
  );
});

const fetched = (observedAt, usedPercent, fetchedAfter) => ({
  ...reading(observedAt, usedPercent, 'official-statusline'),
  fetchedAfter: typeof fetchedAfter === 'number' ? new Date(fetchedAfter).toISOString() : fetchedAfter,
});

test('a dated status-line reading is judged by when its session fetched it, not when it was redrawn', () => {
  // 22 September: an idle session fetched 1% at 18:10 and kept redrawing it
  // every minute, while a Refresh at 22:07 read 13%.
  const idle = Array.from({ length: 300 }, (_, index) => fetched(Date.parse('2026-09-22T17:10:30.000Z') + index * MINUTE, 1, '2026-09-22T17:09:40.000Z'));
  const rows = [...idle, reading('2026-09-22T21:07:40.000Z', 13, 'official-claude-usage')]
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  for (const nowMs of [Date.parse('2026-09-22T23:30:00.000Z'), Date.parse('2026-09-25T09:00:00.000Z')]) {
    const kept = withoutStaleRestatements(rows, { nowMs });
    // However long the provider stays silent, the redraws after the Refresh never replace it.
    assert.equal(kept.at(-1).usedPercent, 13);
    assert.ok(kept.every((row) => row.usedPercent === 13 || Date.parse(row.observedAt) < Date.parse('2026-09-22T21:07:40.000Z')));
  }
  // A session that fetches after the Refresh and sees a drop saw a
  // replenishment: it is the newest evidence at once, without waiting.
  const replenished = withoutStaleRestatements([...rows,
    fetched('2026-09-22T21:31:00.000Z', 0, '2026-09-22T21:30:00.000Z'),
    fetched('2026-09-22T21:32:00.000Z', 0, '2026-09-22T21:30:00.000Z'),
  ].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)), { nowMs: Date.parse('2026-09-22T21:33:00.000Z') });
  // The idle session's redraws of 1% around it change nothing.
  assert.deepEqual(times(replenished.slice(-3)), [['21:07', 13], ['21:31', 0], ['21:32', 0]]);
});

test('an idle session’s older fetch does not interleave with a working session’s newer one', () => {
  // No Refresh this week. The idle session last fetched 0% at 17:40; the
  // working one fetches 1%, then 2%, and both redraw every minute.
  const rows = [];
  for (let minute = 0; minute < 40; minute += 1) {
    const at = Date.parse('2026-09-22T17:10:47.000Z') + minute * MINUTE;
    rows.push(fetched(at, 0, '2026-09-22T16:40:31.000Z'));
    const [used, fetchedAfter] = minute < 20 ? [1, '2026-09-22T17:09:10.000Z'] : [2, '2026-09-22T17:29:50.000Z'];
    rows.push(fetched(at + 500, used, fetchedAfter));
  }
  const kept = withoutStaleRestatements(rows, { nowMs: Date.parse('2026-09-22T18:00:00.000Z') });
  // The idle 0% stood until the working session's first 1%, then no longer.
  assert.deepEqual(times(kept.slice(0, 2)), [['17:10', 0], ['17:10', 1]]);
  assert.ok(kept.slice(1).every((row) => row.usedPercent > 0), 'the idle 0% is older evidence than the working 1%');
  assert.equal(kept.at(-1).usedPercent, 2);
  // After a replenishment the card shows, a redraw of an earlier, higher
  // fetch is older evidence too, and does not bring the old usage back.
  const afterReplenishment = withoutStaleRestatements([...rows,
    fetched('2026-09-22T18:01:00.000Z', 0, '2026-09-22T18:00:10.000Z'),
    fetched('2026-09-22T18:01:30.000Z', 2, '2026-09-22T17:29:50.000Z'),
  ], { nowMs: Date.parse('2026-09-22T18:02:00.000Z') });
  assert.equal(afterReplenishment.at(-1).usedPercent, 0);
});

test('an undated redraw cannot undercut a dated session’s newer fetch', () => {
  // No Refresh this week. An idle session the helper first saw with limits in
  // hand, so undated, redraws 1%; a working session then fetches 40%.
  const rows = [
    reading('2026-09-22T10:00:00.000Z', 1, 'official-statusline'),
    fetched('2026-09-22T10:06:00.000Z', 40, '2026-09-22T10:05:00.000Z'),
    reading('2026-09-22T10:07:00.000Z', 1, 'official-statusline'),
    reading('2026-09-22T10:08:00.000Z', 1, 'official-statusline'),
  ];
  assert.deepEqual(withoutStaleRestatements(rows, { nowMs: Date.parse('2026-09-22T12:00:00.000Z') }).map((row) => row.usedPercent), [1, 40]);
  // Only once the 40% is a day old, with nothing newer, is the undated reading believed.
  assert.equal(withoutStaleRestatements(rows, { nowMs: Date.parse('2026-09-23T10:30:00.000Z') }).at(-1).usedPercent, 1);
});

test('a redraw of the window that just reset does not replace the new one', () => {
  // A Refresh a minute after the weekly reset reads the new window; an idle
  // session then redraws the old window, from a fetch that overlaps the read.
  const nextReset = '2026-10-05T08:00:00.000Z';
  const rows = [
    { ...reading('2026-09-28T08:01:00.000Z', 0, 'official-claude-usage'), resetsAt: nextReset },
    fetched('2026-09-28T08:02:00.000Z', 40, '2026-09-28T08:00:30.000Z'),
  ];
  assert.deepEqual(withoutStaleRestatements(rows, { nowMs: Date.parse('2026-09-28T08:03:00.000Z') }).map((row) => row.usedPercent), [0]);
  // The other way round, the new window's redraw is the newer evidence.
  const turning = [
    fetched('2026-09-28T07:59:50.000Z', 40, '2026-09-28T07:59:00.000Z'),
    { ...fetched('2026-09-28T08:00:40.000Z', 0, '2026-09-28T07:59:30.000Z'), resetsAt: nextReset },
  ];
  assert.deepEqual(withoutStaleRestatements(turning, { nowMs: Date.parse('2026-09-28T08:03:00.000Z') }).map((row) => row.usedPercent), [40, 0]);
});

test('an undated idle session does not renew its evidence with every redraw', () => {
  const { store, now, record } = cardStore();
  try {
    // First seen with limits in hand, so undated, and redrawing 13% since.
    for (let at = now - 3 * HOUR; at <= now - MINUTE; at += 10 * MINUTE) record(at, 13, 'official-statusline');
    const quota = store.getQuota('claude', store.getSettings(), now);
    assert.equal(quota.evidenceAt, new Date(now - 3 * HOUR).toISOString());
    assert.ok(Math.abs(quota.forecast.staleHours - 3) < 1e-6, `stale ${quota.forecast.staleHours}`);
    // A new figure can only follow a new response, so it starts afresh.
    record(now, 14, 'official-statusline');
    assert.equal(store.getQuota('claude', store.getSettings(), now).evidenceAt, new Date(now).toISOString());
  } finally {
    store.close();
  }
});

test('fetches that cannot be ordered let a rise through and hold a drop back', () => {
  // Each fetch is known only to lie between two redraws, and these overlap.
  const rows = [
    fetched('2026-09-22T20:00:50.000Z', 10, '2026-09-22T20:00:00.000Z'),
    fetched('2026-09-22T20:01:00.000Z', 11, '2026-09-22T20:00:20.000Z'),
    fetched('2026-09-22T20:01:10.000Z', 10, '2026-09-22T20:00:30.000Z'),
  ];
  assert.deepEqual(times(withoutStaleRestatements(rows, { nowMs: Date.parse('2026-09-22T20:05:00.000Z') })), [['20:00', 10], ['20:01', 11]]);
  // A second session agrees with the first from a fetch that may be later.
  // A third session's drop, fetched after the first but not provably after
  // the second, is held back too.
  const three = [
    fetched('2026-09-22T20:00:10.000Z', 10, '2026-09-22T20:00:00.000Z'),
    fetched('2026-09-22T20:00:40.000Z', 10, '2026-09-22T20:00:05.000Z'),
    fetched('2026-09-22T20:00:50.000Z', 2, '2026-09-22T20:00:20.000Z'),
  ];
  assert.deepEqual(withoutStaleRestatements(three, { nowMs: Date.parse('2026-09-22T20:05:00.000Z') }).map((row) => row.usedPercent), [10, 10]);
  // Fetched after both, the drop is the newest evidence.
  const later = [...three.slice(0, 2), fetched('2026-09-22T20:01:30.000Z', 2, '2026-09-22T20:00:45.000Z')];
  assert.deepEqual(withoutStaleRestatements(later, { nowMs: Date.parse('2026-09-22T20:05:00.000Z') }).map((row) => row.usedPercent), [10, 10, 2]);
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

function cardStore() {
  const store = new UsageStore(':memory:', os.tmpdir());
  const now = Date.now();
  const resetsAt = new Date(now + 4 * 24 * HOUR).toISOString();
  const record = (at, usedPercent, provenance, fetchedAfter = null) => store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly', observedAt: new Date(at).toISOString(),
    usedPercent, remainingPercent: 100 - usedPercent, resetsAt, windowMinutes: 10_080, planType: null,
    provenance, confidence: 1, metadata: {}, fetchedAfter: fetchedAfter == null ? null : new Date(fetchedAfter).toISOString(),
  });
  return { store, now, record };
}

test('a card replaces a provider read with a lower status-line reading only when its session fetched it later', () => {
  const { store, now, record } = cardStore();
  try {
    // An idle session fetched 1% four hours ago and redraws it every minute.
    record(now - 3 * HOUR, 1, 'official-statusline', now - 4 * HOUR);
    record(now - HOUR, 13, 'official-claude-usage');
    record(now - MINUTE, 1, 'official-statusline', now - 4 * HOUR);
    // However long the provider is silent, the redraw never replaces the
    // Refresh, and the card is as old as the Refresh, not the redraw.
    for (const later of [now, now + 2 * HOUR, now + 3 * 24 * HOUR]) {
      const quota = store.getQuota('claude', store.getSettings(), later);
      assert.equal(quota.remainingPercent, 87);
      assert.equal(quota.provenance, 'official-claude-usage');
      assert.equal(quota.evidenceAt, new Date(now - HOUR).toISOString());
    }
    assert.ok(Math.abs(store.getQuota('claude', store.getSettings(), now + 2 * HOUR).forecast.staleHours - 3) < 1e-9);
    // A session that fetched after the Refresh and saw 1% saw a replenishment.
    record(now, 1, 'official-statusline', now - 30 * MINUTE);
    const quota = store.getQuota('claude', store.getSettings(), now);
    assert.equal(quota.remainingPercent, 99);
    assert.equal(quota.provenance, 'official-statusline');
    assert.equal(quota.evidenceAt, new Date(now - 30 * MINUTE).toISOString());
  } finally {
    store.close();
  }
});

test('an undated lower status-line reading reaches the card once the provider read is out of date', () => {
  const { store, now, record } = cardStore();
  try {
    record(now - 3 * HOUR, 1, 'official-statusline');
    record(now - HOUR, 13, 'official-claude-usage');
    record(now - MINUTE, 1, 'official-statusline');
    // Nothing dates these redraws. Provider reads are manual, so hours of
    // silence are normal: the lower reading waits for the next read…
    for (const later of [now, now + 2 * HOUR, now + 22 * HOUR]) {
      assert.equal(store.getQuota('claude', store.getSettings(), later).remainingPercent, 87);
    }
    // …or until a weekly read is a day old, when the card calls it out of date.
    const quota = store.getQuota('claude', store.getSettings(), now + 24 * HOUR);
    assert.equal(quota.remainingPercent, 99);
    assert.equal(quota.provenance, 'official-statusline');
  } finally {
    store.close();
  }
});

test('the dashboard clock ages a window from its evidence, not from its latest redraw', async () => {
  const path = require('node:path');
  const { createServer } = await import('vite');
  const server = await createServer({ root: path.resolve(__dirname, '..'), configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { snapshotAtTime } = await server.ssrLoadModule('/src/snapshot-time.ts');
    const builtAt = Date.parse('2026-09-23T09:00:00.000Z');
    const window = (evidenceAt) => ({
      bucketId: 'seven_day', bucketName: 'Weekly', observedAt: new Date(builtAt - MINUTE).toISOString(),
      ...(evidenceAt ? { evidenceAt } : {}), usedPercent: 13, remainingPercent: 87, resetsAt: RESET, windowMinutes: 10_080,
      planType: null, provenance: 'official-statusline', metadata: {}, forecast: { staleHours: 20, expired: false },
    });
    const later = builtAt + 2 * HOUR;
    for (const [evidenceAt, staleHours] of [['2026-09-22T13:00:00.000Z', 22], [null, 20]]) {
      const snapshot = { generatedAt: new Date(builtAt).toISOString(), settings: {}, sources: [],
        quotas: { codex: null, claude: { ...window(evidenceAt), windows: [window(evidenceAt)] }, fable: null } };
      const aged = snapshotAtTime(snapshot, later).quotas.claude;
      // With evidence the window keeps ageing from it; without, from the redraw.
      assert.ok(Math.abs(aged.forecast.staleHours - staleHours) < 1e-9, `${evidenceAt}: ${aged.forecast.staleHours}`);
    }
  } finally { await server.close(); }
});
