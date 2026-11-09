'use strict';
require('./setup.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { deriveLearningSamples, forecastQuota } = require('../electron/forecast.cjs');
const { latestEvidenceAt, withoutStaleRestatements } = require('../electron/quota-evidence.cjs');
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

test('idle redraws after the last fetch add no observed time to the learned pace', () => {
  // Reads at 0%, 10% and 13%; an idle session then redraws the 13% it
  // fetched just before the last read, every half hour until now.
  const reads = [
    reading('2026-09-22T08:00:00.000Z', 0, 'official-claude-usage'),
    reading('2026-09-22T20:00:00.000Z', 10, 'official-claude-usage'),
    reading('2026-09-23T12:00:00.000Z', 13, 'official-claude-usage'),
  ];
  const redraws = [];
  for (let at = Date.parse('2026-09-23T12:30:00.000Z'); at <= Date.parse('2026-09-23T21:00:00.000Z'); at += 30 * MINUTE) {
    redraws.push({ ...reading(at, 13, 'official-statusline'), fetchedAfter: '2026-09-23T11:55:00.000Z', seenSince: '2026-09-23T11:56:00.000Z' });
  }
  const pick = ({ windowPace, safePace, expectedRemaining, heavyRemaining, staleHours, state }) => ({ windowPace, safePace, expectedRemaining, heavyRemaining, staleHours, state });
  for (const compactReadings of [false, true]) {
    const options = { now: NOW, schedule: SCHEDULE, compactReadings };
    assert.deepEqual(pick(forecastQuota([...reads, ...redraws], options)), pick(forecastQuota(reads, options)), `compact ${compactReadings}`);
  }
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
  // An undated redraw of the old window cannot be ordered either and goes the
  // same way, while an undated one of the new window gets through.
  const undated = [
    rows[0],
    reading('2026-09-28T08:02:00.000Z', 40, 'official-statusline'),
    { ...reading('2026-09-28T08:02:30.000Z', 1, 'official-statusline'), resetsAt: nextReset },
  ];
  assert.deepEqual(withoutStaleRestatements(undated, { nowMs: Date.parse('2026-09-28T08:03:00.000Z') }).map((row) => row.usedPercent), [0, 1]);
  // The other way round, the new window's redraw is the newer evidence.
  const turning = [
    fetched('2026-09-28T07:59:50.000Z', 40, '2026-09-28T07:59:00.000Z'),
    { ...fetched('2026-09-28T08:00:40.000Z', 0, '2026-09-28T07:59:30.000Z'), resetsAt: nextReset },
  ];
  assert.deepEqual(withoutStaleRestatements(turning, { nowMs: Date.parse('2026-09-28T08:03:00.000Z') }).map((row) => row.usedPercent), [40, 0]);
});

test('undated sessions redrawing different figures each keep their own first redraw', () => {
  const { store, now, record } = cardStore();
  try {
    // Two sessions first seen with limits in hand, at 13% and at 20%, each
    // redrawing its figure every minute for two hours between the other's.
    const first = now - 2 * HOUR;
    for (let at = first; at <= now - MINUTE; at += MINUTE) {
      record(at, 13, 'official-statusline', null, first);
      record(at + 500, 20, 'official-statusline', null, first + 500);
    }
    const quota = store.getQuota('claude', store.getSettings(), now);
    assert.equal(quota.usedPercent, 20);
    const rows = store.prepare('SELECT * FROM quota_observations ORDER BY observed_at').all();
    assert.equal(latestEvidenceAt(rows), first + 500, 'the 20% is placed no later than its first redraw');
    // Neither session's fetch is known, only that it fell in this week.
    const weekStart = Date.parse(quota.resetsAt) - 7 * 24 * HOUR;
    assert.equal(quota.evidenceAt, new Date(weekStart).toISOString());
    assert.ok(Math.abs(quota.forecast.staleHours - (now - weekStart) / HOUR) < 1e-6, `stale ${quota.forecast.staleHours}`);
  } finally {
    store.close();
  }
});

test('a figure from before an early replenishment is no evidence for the allowance that replaced it', () => {
  // Reads of 80%, then an early replenishment to 0% under the same reset,
  // then an undated redraw back at 80% whose fetch is unknown.
  const weekStart = Date.parse(RESET) - 7 * 24 * HOUR;
  const rows = [reading('2026-09-23T08:00:00.000Z', 80, 'official-claude-usage'),
    reading('2026-09-23T10:00:00.000Z', 0, 'official-claude-usage'),
    { ...reading('2026-09-23T15:00:00.000Z', 80, 'official-statusline'), seenSince: '2026-09-23T15:00:00.000Z' }];
  assert.equal(latestEvidenceAt(rows, { known: true }), weekStart, 'the 08:00 read of the old allowance does not date it');
  assert.equal(latestEvidenceAt(rows.slice(0, 2).concat(reading('2026-09-23T15:00:00.000Z', 80, 'official-claude-usage')),
    { known: true }), Date.parse('2026-09-23T15:00:00.000Z'), 'a read of the new allowance does');
  // From a helper that did not record sessions, the new 80% is first shown
  // after the replenishment, not when the old allowance reached it.
  const legacy = [reading('2026-09-23T08:00:00.000Z', 80, 'official-statusline'),
    reading('2026-09-23T10:00:00.000Z', 0, 'official-claude-usage'),
    reading('2026-09-23T15:00:00.000Z', 80, 'official-statusline'), reading('2026-09-23T15:10:00.000Z', 80, 'official-statusline')];
  assert.equal(latestEvidenceAt(legacy), Date.parse('2026-09-23T15:00:00.000Z'));
});

test('an undated redraw of the window an early replenishment replaced does not return to the card', () => {
  const inWindow = (at, used, provenance, resetsAt) => ({ ...reading(at, used, provenance), resetsAt });
  const oldReset = '2026-09-24T08:00:00.000Z';
  const newReset = '2026-09-30T10:00:00.000Z';
  // A Refresh reads 60% of a week ending tomorrow; the next reads 1% of a new
  // week, replenished early; an idle session then redraws the old 60%.
  const replenished = [inWindow('2026-09-23T08:00:00.000Z', 60, 'official-claude-usage', oldReset),
    inWindow('2026-09-23T10:00:00.000Z', 1, 'official-claude-usage', newReset),
    inWindow('2026-09-23T11:00:00.000Z', 60, 'official-statusline', oldReset)];
  const nowMs = Date.parse('2026-09-23T11:30:00.000Z');
  assert.deepEqual(times(withoutStaleRestatements(replenished, { nowMs })), [['08:00', 60], ['10:00', 1]]);
  // A reset corrected to the earlier time is kept once a read confirms it.
  const corrected = [...replenished, inWindow('2026-09-23T11:15:00.000Z', 2, 'official-claude-usage', oldReset)];
  assert.deepEqual(times(withoutStaleRestatements(corrected, { nowMs })), [['08:00', 60], ['10:00', 1], ['11:00', 60], ['11:15', 2]]);
  // Two undated readings cannot be ordered, so the later redraw still stands.
  const undated = [inWindow('2026-09-23T10:00:00.000Z', 1, 'official-statusline', newReset),
    inWindow('2026-09-23T11:00:00.000Z', 60, 'official-statusline', oldReset)];
  assert.equal(withoutStaleRestatements(undated, { nowMs }).length, 2);
});

test('a rise is learned from the lower figure’s fetch, not its redraw', () => {
  // A session fetched 10% after 09:00 and first redrew it at 11:00; a Refresh
  // read 20% at 13:00. Ten points in four hours, as if 10% had been read at 09:00.
  const nowMs = Date.parse('2026-09-23T14:00:00.000Z');
  const later = reading('2026-09-23T13:00:00.000Z', 20, 'official-claude-usage');
  const redrawn = deriveLearningSamples([{ ...reading('2026-09-23T11:00:00.000Z', 10, 'official-statusline'),
    fetchedAfter: '2026-09-23T09:00:00.000Z' }, later], SCHEDULE, nowMs);
  const read = deriveLearningSamples([reading('2026-09-23T09:00:00.000Z', 10, 'official-claude-usage'), later], SCHEDULE, nowMs);
  assert.ok(read.length > 0);
  assert.deepEqual(redrawn, read);
  assert.ok(Math.abs(redrawn[0].rate - 2.5) < 1e-9, `rate ${redrawn[0].rate}`);
});

test('a dated redraw of the replaced window, fetched around the read of the new one, waits for a read', () => {
  const inWindow = (at, used, provenance, resetsAt, bounds = {}) => ({ ...reading(at, used, provenance), resetsAt, ...bounds });
  const oldReset = '2026-09-24T08:00:00.000Z';
  const newReset = '2026-09-30T10:00:00.000Z';
  // A session last redrew at 09:55, fetched the old week's 60% at some point
  // before its 10:30 redraw; a Refresh at 10:00 read 1% of a new week.
  const replenished = [inWindow('2026-09-23T08:00:00.000Z', 60, 'official-claude-usage', oldReset),
    inWindow('2026-09-23T10:00:00.000Z', 1, 'official-claude-usage', newReset),
    inWindow('2026-09-23T10:30:00.000Z', 60, 'official-statusline', oldReset,
      { fetchedAfter: '2026-09-23T09:55:00.000Z', seenSince: '2026-09-23T10:30:00.000Z' })];
  const nowMs = Date.parse('2026-09-23T11:00:00.000Z');
  assert.deepEqual(times(withoutStaleRestatements(replenished, { nowMs })), [['08:00', 60], ['10:00', 1]]);
  // A read of the earlier reset confirms it was corrected.
  const corrected = [...replenished, inWindow('2026-09-23T10:45:00.000Z', 61, 'official-claude-usage', oldReset)];
  assert.deepEqual(times(withoutStaleRestatements(corrected, { nowMs })), [['08:00', 60], ['10:00', 1], ['10:30', 60], ['10:45', 61]]);
});

test('an early replenishment a session fetched starts the new window at that fetch, not its redraw', () => {
  // A Refresh read 40%; the allowance was then replenished early. A working
  // session idle since 09:00 fetched the new 1% and redrew it at 12:00.
  const replenished = (row) => [reading('2026-09-23T06:00:00.000Z', 40, 'official-claude-usage'), row,
    reading('2026-09-23T14:00:00.000Z', 4, 'official-claude-usage'), reading('2026-09-23T17:00:00.000Z', 7, 'official-claude-usage')];
  const options = { now: '2026-09-23T17:30:00.000Z', schedule: SCHEDULE };
  const redrawn = forecastQuota(replenished({ ...reading('2026-09-23T12:00:00.000Z', 1, 'official-statusline'),
    fetchedAfter: '2026-09-23T09:00:00.000Z' }), options);
  // The same figure read at the fetch's lower bound.
  const read = forecastQuota(replenished(reading('2026-09-23T09:00:00.000Z', 1, 'official-claude-usage')), options);
  assert.ok(read.windowPace > 0, `pace ${read.windowPace}`);
  assert.ok(Math.abs(redrawn.windowPace - read.windowPace) < 1e-9, `${redrawn.windowPace} vs ${read.windowPace}`);
});

test('a figure no known fetch supports is caught up from its first redraw but is not fresh', () => {
  // Redrawn for an hour by a session first seen with limits in hand, and the
  // same redraws had that session's opening redraw shown the fetch.
  const first = Date.parse('2026-09-23T20:25:00.000Z');
  const redraws = (dated) => Array.from({ length: 60 }, (_, index) => ({
    ...reading(first + index * MINUTE, 14, 'official-statusline'),
    ...(dated ? { fetchedAfter: new Date(first - 5_000).toISOString() } : { seenSince: new Date(first).toISOString() }),
  }));
  const reads = [reading('2026-09-22T21:07:40.000Z', 13, 'official-claude-usage')];
  for (const compactReadings of [false, true]) {
    const options = { now: NOW, schedule: SCHEDULE, compactReadings };
    const undated = forecastQuota([...reads, ...redraws(false)], options);
    const dated = forecastQuota([...reads, ...redraws(true)], options);
    // Use since the fetch is caught up from the first redraw, not the week's start…
    assert.ok(Math.abs(undated.estimatedCurrentRemaining - dated.estimatedCurrentRemaining) < 0.1,
      `${undated.estimatedCurrentRemaining} vs ${dated.estimatedCurrentRemaining}`);
    // …but only a known fetch makes the figure current.
    assert.ok(dated.staleHours < 1.1, `dated ${dated.staleHours}`);
    assert.ok(Math.abs(undated.staleHours - (Date.parse(NOW) - (Date.parse(RESET) - 7 * 24 * HOUR)) / HOUR) < 1e-6,
      `undated ${undated.staleHours}`);
  }
});

test('legacy readings from two sessions redrawing in turn renew neither figure', () => {
  // From before the helper recorded sessions: one session shows 13% and
  // another 1%, each redrawing its own figure every minute for two hours.
  const first = Date.parse('2026-09-23T10:00:00.000Z');
  const rows = [];
  for (let minute = 0; minute < 120; minute += 1) {
    rows.push(reading(first + minute * MINUTE, 13, 'official-statusline'));
    rows.push(reading(first + minute * MINUTE + 30_000, 1, 'official-statusline'));
  }
  assert.equal(latestEvidenceAt(rows), first + 30_000, 'the 1% is no newer than its first showing');
  assert.equal(latestEvidenceAt(rows.slice(0, -1)), first, 'nor is the 13%');
});

test('an undated idle session does not renew its evidence with every redraw', () => {
  const { store, now, record } = cardStore();
  try {
    // From a helper that did not record sessions, redrawing 13% for hours.
    for (let at = now - 3 * HOUR; at <= now - MINUTE; at += 10 * MINUTE) record(at, 13, 'official-statusline');
    const rows = () => store.prepare('SELECT * FROM quota_observations ORDER BY observed_at').all();
    assert.equal(latestEvidenceAt(rows()), now - 3 * HOUR, 'the figure is placed no later than its first showing');
    // Nothing says when it was fetched, only that it fell in this week.
    const quota = store.getQuota('claude', store.getSettings(), now);
    const weekStart = Date.parse(quota.resetsAt) - 7 * 24 * HOUR;
    assert.equal(quota.evidenceAt, new Date(weekStart).toISOString());
    assert.ok(Math.abs(quota.forecast.staleHours - (now - weekStart) / HOUR) < 1e-6, `stale ${quota.forecast.staleHours}`);
    // A new figure is placed afresh, but its fetch is no better known.
    record(now, 14, 'official-statusline');
    assert.equal(latestEvidenceAt(rows()), now);
    assert.equal(store.getQuota('claude', store.getSettings(), now).evidenceAt, new Date(weekStart).toISOString());
  } finally {
    store.close();
  }
});

test('an undated rise raises the mark a later undated drop must answer to', () => {
  // Two sessions first seen with limits in hand, after a Refresh read 10%:
  // one shows 20%, the other then 15%. The 20% proves more was used.
  const rows = [
    reading('2026-09-22T10:00:00.000Z', 10, 'official-claude-usage'),
    reading('2026-09-22T10:05:00.000Z', 20, 'official-statusline'),
    reading('2026-09-22T10:06:00.000Z', 15, 'official-statusline'),
  ];
  const used = (kept) => kept.map((row) => row.usedPercent);
  assert.deepEqual(used(withoutStaleRestatements(rows, { nowMs: Date.parse('2026-09-22T12:00:00.000Z') })), [10, 20]);
  assert.deepEqual(used(withoutStaleRestatements(rows.slice(1), { nowMs: Date.parse('2026-09-22T12:00:00.000Z') })), [20],
    'with no provider read as well');
  // Only once the 20% is a day old, with nothing newer, is the 15% believed.
  assert.equal(withoutStaleRestatements(rows, { nowMs: Date.parse('2026-09-23T10:10:00.000Z') }).at(-1).usedPercent, 15);
});

test('two sessions sharing a fetch date keep their own upper bounds', () => {
  // Both sessions' previous redraws fell in the same millisecond, but the
  // second first showed 20% forty seconds after the first did. A drop fetched
  // after 20:00:30 is not provably newer than the second session's fetch.
  const withSeen = (row, seenSince) => ({ ...row, seenSince });
  const rows = [
    withSeen(fetched('2026-09-22T20:00:10.000Z', 20, '2026-09-22T20:00:00.000Z'), '2026-09-22T20:00:10.000Z'),
    withSeen(fetched('2026-09-22T20:00:50.000Z', 20, '2026-09-22T20:00:00.000Z'), '2026-09-22T20:00:50.000Z'),
    withSeen(fetched('2026-09-22T20:01:00.000Z', 10, '2026-09-22T20:00:30.000Z'), '2026-09-22T20:01:00.000Z'),
  ];
  assert.deepEqual(withoutStaleRestatements(rows, { nowMs: Date.parse('2026-09-22T20:05:00.000Z') }).map((row) => row.usedPercent), [20, 20]);
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

test('a rise is learned up to its fetch, not its later first redraw', () => {
  // Active hours end at 17:00 local. The week rises to 20% in a fetch at
  // 16:30 local that a status line first draws at 18:00.
  const schedule = { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 8, endHour: 17 };
  const learn = (rise) => deriveLearningSamples([
    reading('2026-09-22T08:00:00.000Z', 10, 'official-claude-usage'),
    rise,
    reading('2026-09-22T19:00:00.000Z', 20, 'official-claude-usage'),
  ], schedule, Date.parse(NOW)).map(({ weight: _weight, ...sample }) => sample);
  const read = learn(reading('2026-09-22T15:30:00.000Z', 20, 'official-claude-usage'));
  const redrawn = learn({ ...reading('2026-09-22T17:00:00.000Z', 20, 'official-statusline'),
    fetchedAfter: '2026-09-22T15:30:00.000Z', seenSince: '2026-09-22T17:00:00.000Z' });
  assert.ok(read.some((sample) => sample.changed && sample.phase === 'active'));
  assert.deepEqual(redrawn, read);
});

test('compaction keeps a newer fetch that confirms a figure among redraws of an older one', () => {
  // An idle session redraws the 10% it fetched at 07:00 every ten minutes;
  // another session confirms 10% with a fresh fetch at 16:00; a read at
  // 17:00 shows 20%. The rise belongs to the hour after the confirmation.
  const rows = [reading('2026-09-22T08:00:00.000Z', 10, 'official-claude-usage')];
  for (let at = Date.parse('2026-09-22T08:10:00.000Z'); at <= Date.parse('2026-09-22T19:50:00.000Z'); at += 10 * MINUTE) {
    rows.push({ ...reading(at, 10, 'official-statusline'), fetchedAfter: '2026-09-22T07:00:00.000Z', seenSince: '2026-09-22T07:01:00.000Z' });
  }
  rows.push({ ...reading('2026-09-22T16:00:05.000Z', 10, 'official-statusline'), fetchedAfter: '2026-09-22T16:00:00.000Z', seenSince: '2026-09-22T16:00:05.000Z' });
  rows.push(reading('2026-09-22T17:00:00.000Z', 20, 'official-claude-usage'));
  rows.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const pick = ({ recentPace, workingPace, safePace, expectedRemaining, learnedSamples }) => ({ recentPace, workingPace, safePace, expectedRemaining, learnedSamples });
  // Active from 16:00 local, so where the rise is placed decides its phase.
  const options = { now: '2026-09-22T20:00:00.000Z', schedule: { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 16, endHour: 22 } };
  assert.deepEqual(pick(forecastQuota(rows, { ...options, compactReadings: true })), pick(forecastQuota(rows, options)));
});

test('a rise fetched on a normal day counts though first redrawn on an ignored one', () => {
  // The rise is fetched at 23:30 local on the 22nd and first drawn at 00:30
  // on the 23rd, a date the forecast is told to ignore.
  const learn = (rise) => deriveLearningSamples([
    reading('2026-09-22T08:00:00.000Z', 10, 'official-claude-usage'),
    rise,
  ], SCHEDULE, Date.parse(NOW), ['2026-09-23']).map(({ weight: _weight, ...sample }) => sample);
  const read = learn(reading('2026-09-22T22:30:00.000Z', 20, 'official-claude-usage'));
  const redrawn = learn({ ...reading('2026-09-22T23:30:00.000Z', 20, 'official-statusline'),
    fetchedAfter: '2026-09-22T22:30:00.000Z', seenSince: '2026-09-22T23:30:00.000Z' });
  assert.ok(read.some((sample) => sample.changed), 'the rise is learned');
  assert.deepEqual(redrawn, read);
});

test('a newer dated fetch of an unchanged figure places the next increase as a read would', () => {
  // 10% at 10:00 local, the same 10% confirmed at 18:00, then 20% at 19:00.
  const learn = (confirmation) => deriveLearningSamples([
    reading('2026-09-22T09:00:00.000Z', 10, 'official-claude-usage'),
    confirmation,
    reading('2026-09-22T18:00:00.000Z', 20, 'official-claude-usage'),
  ], SCHEDULE, Date.parse(NOW)).map(({ weight: _weight, ...sample }) => sample);
  const read = learn(reading('2026-09-22T17:00:00.000Z', 10, 'official-claude-usage'));
  const confirmed = learn(fetched10('2026-09-22T17:01:00.000Z', '2026-09-22T17:00:00.000Z'));
  const redrawn = learn(fetched10('2026-09-22T17:01:00.000Z', '2026-09-22T08:00:00.000Z'));
  assert.deepEqual(confirmed, read);
  assert.notDeepEqual(redrawn, read, 'a redraw of an older fetch confirms nothing');
});

function fetched10(observedAt, fetchedAfter) {
  return { ...reading(observedAt, 10, 'official-statusline'), fetchedAfter };
}

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
  const time = (value) => (value == null ? null : new Date(value).toISOString());
  const record = (at, usedPercent, provenance, fetchedAfter = null, seenSince = null) => store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly', observedAt: new Date(at).toISOString(),
    usedPercent, remainingPercent: 100 - usedPercent, resetsAt, windowMinutes: 10_080, planType: null,
    provenance, confidence: 1, metadata: {}, fetchedAfter: time(fetchedAfter), seenSince: time(seenSince),
  });
  return { store, now, record };
}

test('a status-line reading keeps its fetch when imported again, but another session’s redraw never inherits it', () => {
  const { store, now, record } = cardStore();
  const stored = (at) => store.prepare(`SELECT used_percent, fetched_after, seen_since FROM quota_observations
    WHERE bucket_id = 'seven_day' AND observed_at = ?`).get(new Date(at).toISOString());
  try {
    record(now - HOUR, 30, 'official-claude-usage');
    // A working session fetched 31% just before this redraw; the same line
    // read again from a re-read inbox can no longer be dated.
    const at = now - 2 * MINUTE;
    record(at, 31, 'official-statusline', at - 5_000, at);
    record(at, 31, 'official-statusline');
    assert.deepEqual({ ...stored(at) }, { used_percent: 31, fetched_after: new Date(at - 5_000).toISOString(), seen_since: new Date(at).toISOString() });
    // In the same millisecond, a session first seen with limits in hand
    // redraws the 12% it fetched days ago.
    record(at, 12, 'official-statusline', null, at);
    assert.deepEqual({ ...stored(at) }, { used_percent: 12, fetched_after: null, seen_since: new Date(at).toISOString() });
    const quota = store.getQuota('claude', store.getSettings(), now);
    assert.equal(quota.usedPercent, 30, 'the undated 12% is not a replenishment the working session fetched');
    assert.equal(quota.provenance, 'official-claude-usage');
  } finally {
    store.close();
  }
});

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
