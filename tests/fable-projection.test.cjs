'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { projectFableAllowance } = require('../electron/fable-projection.cjs');
const { getLastCurrentOfficial } = require('../electron/fable-tracker.cjs');
const { UsageStore } = require('../electron/store.cjs');

const HOUR = 3_600_000;
const RESET = '2026-09-02T00:00:00.000Z';
const NOW = Date.parse('2026-08-29T13:00:00Z');
const iso = (at) => new Date(at).toISOString();

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-fable-projection-'));
  const store = new UsageStore(path.join(root, 'db.sqlite'), path.join(root, 'Backups'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const overall = (observedAt, usedPercent, overrides = {}) => store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly', observedAt: iso(observedAt), usedPercent,
    remainingPercent: 100 - usedPercent, resetsAt: RESET, windowMinutes: 10_080, planType: 'max',
    provenance: 'official-claude-usage', confidence: 1, metadata: { scope: 'overall' }, ...overrides,
  });
  const fable = (observedAt, usedPercent, overrides = {}) => store.recordObservation({
    sourceId: 'claude-fable', bucketId: 'fable_seven_day', bucketName: 'Fable 5 weekly', observedAt: iso(observedAt),
    usedPercent, remainingPercent: 100 - usedPercent, resetsAt: RESET, windowMinutes: 10_080, planType: 'max',
    provenance: 'official-claude-usage', confidence: 1, metadata: { scope: 'model' }, ...overrides,
  });
  const usage = (key, occurredAt, model, inputTokens) => store.recordUsageEvent({
    eventKey: `projection:${key}`, sourceId: 'claude', occurredAt: iso(occurredAt), sessionId: 'session', model,
    inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, metadata: {},
  });
  const fableRows = () => store.prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE source_id = 'claude-fable'").get().count;
  return { store, overall, fable, usage, fableRows, quota: (nowMs = NOW) => store.getQuota('claude-fable', store.getSettings(), nowMs) };
}

// Ten points of overall use, all of it Fable: doubled for the half cap, 20%.
function fableWeek({ overall, usage }) {
  overall(NOW - 25 * HOUR, 10);
  usage('f1', NOW - 19 * HOUR, 'claude-fable-5', 4_000_000);
  overall(NOW - HOUR, 20);
}

test('an overall interval crossing a manual anchor counts only pressure after the anchor', (t) => {
  const context = fixture(t);
  context.overall(NOW - 4 * HOUR, 10);
  context.usage('before-anchor', NOW - 3 * HOUR, 'claude-fable-5', 1000);
  context.fable(NOW - 2 * HOUR, 20, { provenance: 'manual-official' });
  context.overall(NOW, 20);
  const result = projectFableAllowance(context.store, NOW);
  assert.equal(result.usedPercent, 20);
  assert.ok(result.series.every((point) => point.usedPercent <= 20));
});

test('each series ceiling bounds its point without discarding pressure from the card accumulator', (t) => {
  const context = fixture(t);
  context.overall(NOW - 4 * HOUR, 10);
  context.fable(NOW - 4 * HOUR, 50, { provenance: 'manual-official' });
  context.usage('fable-step', NOW - 3 * HOUR, 'claude-fable-5', 1000);
  context.overall(NOW - 2 * HOUR, 20);
  context.usage('opus-step', NOW - HOUR, 'claude-opus-5', 1000);
  context.overall(NOW, 30);
  const result = projectFableAllowance(context.store, NOW);
  assert.equal(result.usedPercent, 60);
  assert.deepEqual(result.series.map((point) => point.usedPercent), [40, 60, 60]);
});

test('the Fable card is a projected window when no provider-backed Fable window is live, and nothing is stored', (t) => {
  const context = fixture(t);
  assert.equal(context.quota(), null, 'no evidence at all means no window');
  fableWeek(context);
  const quota = context.quota();
  assert.equal(quota.bucketId, 'fable_seven_day');
  assert.equal(quota.provenance, 'derived-tokens');
  assert.equal(quota.metadata.projected, true);
  assert.equal(quota.metadata.calibration.method, 'overall-share');
  assert.ok(Math.abs(quota.usedPercent - 20) < 0.01, `usedPercent ${quota.usedPercent}`);
  assert.equal(quota.observedAt, iso(NOW));
  assert.equal(quota.resetsAt, RESET);
  assert.equal(quota.windows.length, 1);
  assert.equal(quota.forecast.expired, false);
  assert.ok(quota.forecast.learnedSamples >= 1, 'the forecast learns from the projected series');
  assert.equal(quota.tokenCapacity.status, 'unavailable');
  assert.equal(context.fableRows(), 0);
  const snapshot = context.store.getDashboardSnapshot(30, NOW);
  assert.equal(snapshot.quotas.fable.provenance, 'derived-tokens');
  assert.deepEqual(snapshot.cycles.fable, [], 'cycle history is built from persisted readings only');
});

test('a live official Fable window headlines and no projection is added beside it', (t) => {
  const context = fixture(t);
  fableWeek(context);
  context.fable(NOW - 30 * 60_000, 44);
  const quota = context.quota();
  assert.equal(quota.provenance, 'official-claude-usage');
  assert.equal(quota.usedPercent, 44);
  assert.deepEqual(quota.windows.map((window) => window.provenance), ['official-claude-usage']);
  const expiredOfficial = fixture(t);
  fableWeek(expiredOfficial);
  expiredOfficial.fable(NOW - 9 * 24 * HOUR, 60, { resetsAt: iso(NOW - 5 * 24 * HOUR) });
  const withHistory = expiredOfficial.quota();
  assert.equal(withHistory.provenance, 'derived-tokens', 'an expired official window does not block the projection');
  assert.deepEqual(withHistory.windows.map((window) => window.provenance), ['derived-tokens'],
    'one window per bucket: the projection stands in for the expired reading');
  const snapshot = expiredOfficial.store.getDashboardSnapshot(30, NOW);
  assert.equal(snapshot.quotas.fable.windows.length, 1);
  assert.ok(snapshot.cycles.fable.some((cycle) => Math.abs(cycle.peakUsedPercent - 60) < 0.01), 'the expired reading stays in cycle history');
});

test('the projection follows the allowance-change setting on the very next snapshot, in both directions', (t) => {
  const context = fixture(t);
  // The boost ended overnight: ten boosted points read as fifteen, and the
  // Fable session added ten real points. Learned as usage, all fifteen of the
  // step would be Fable's.
  context.overall(NOW - 25 * HOUR, 10);
  context.usage('f1', NOW - 19 * HOUR, 'claude-fable-5', 4_000_000);
  context.overall(NOW - HOUR, 25);
  assert.ok(Math.abs(context.quota().usedPercent - 30) < 0.01);
  const change = { source: 'claude', at: iso(NOW - 12 * HOUR), previousAllowancePercent: 150 };
  context.store.updateSettings({ allowanceChanges: [change] });
  assert.ok(Math.abs(context.quota().usedPercent - 20) < 0.01, 'the rescaled step leaves ten real points');
  context.store.updateSettings({ allowanceChanges: [change, { ...change, source: 'codex' }] });
  assert.ok(Math.abs(context.quota().usedPercent - 20) < 0.01, 'a Codex entry changes nothing');
  context.store.updateSettings({ allowanceChanges: [] });
  assert.ok(Math.abs(context.quota().usedPercent - 30) < 0.01, 'removal restores the earlier estimate');
  assert.equal(context.fableRows(), 0, 'no refresh, no rows, no stale figure anywhere');
});

test('projected points are not rescaled a second time when an allowance change falls inside the window', (t) => {
  const context = fixture(t);
  // Ten boosted points, then the boost ends, then ten more of the current
  // allowance. In today's terms the first step was fifteen points and the
  // second ten, all of it Fable and doubled for the half cap.
  context.overall(NOW - 25 * HOUR, 10);
  context.usage('f1', NOW - 22 * HOUR, 'claude-fable-5', 4_000_000);
  context.overall(NOW - 20 * HOUR, 20);
  context.usage('f2', NOW - 10 * HOUR, 'claude-fable-5', 4_000_000);
  context.overall(NOW - HOUR, 40);
  context.store.updateSettings({ allowanceChanges: [{ source: 'claude', at: iso(NOW - 12 * HOUR), previousAllowancePercent: 150 }] });
  const projection = projectFableAllowance(context.store, NOW);
  assert.deepEqual(projection.series.map((point) => Math.round(point.usedPercent)), [30, 50, 50],
    'the projection already expresses every point in the current allowance');
  const observed = context.quota().forecast.series.observed.map((point) => Math.round(point.remaining));
  assert.deepEqual(observed, [70, 50, 50], 'the forecast takes the projected points as they are, not scaled to 45 again');
});

test('a plan-less status-line row newer than the SDK reading cannot switch the projection off', (t) => {
  const context = fixture(t);
  fableWeek(context);
  context.overall(NOW - 30 * 60_000, 20, { planType: null, provenance: 'official-statusline', metadata: {} });
  const projection = projectFableAllowance(context.store, NOW);
  assert.equal(projection.available, true);
  assert.equal(projection.planType, 'max');
  assert.ok(Math.abs(context.quota().usedPercent - 20) < 0.01);
  const pro = fixture(t);
  pro.overall(NOW - 25 * HOUR, 10, { planType: 'pro' });
  pro.usage('f1', NOW - 19 * HOUR, 'claude-fable-5', 4_000_000);
  pro.overall(NOW - HOUR, 20, { planType: 'pro' });
  assert.deepEqual(projectFableAllowance(pro.store, NOW), { available: false, reason: 'fable-not-confirmed-in-shared-plan', planType: 'pro' });
  assert.equal(pro.quota(), null);
  // A named plan without a Fable allowance has no Fable window to wait for.
  assert.equal(pro.store.getTraySnapshot(NOW).fableApplies, false);
});

test('an idle redraw of the overall figure does not move the projection boundary past later Fable activity', (t) => {
  const estimate = (withRedraw) => {
    const context = fixture(t);
    fableWeek(context);
    // Fable is used after the last overall read; the tail projects it.
    context.usage('f2', NOW - 30 * 60_000, 'claude-fable-5', 1_000_000);
    // An idle session then redraws the 20% it fetched before that activity.
    if (withRedraw) {
      context.overall(NOW - 5 * 60_000, 20, { planType: null, provenance: 'official-statusline', metadata: {},
        fetchedAfter: iso(NOW - 62 * 60_000) });
    }
    return projectFableAllowance(context.store, NOW).usedPercent;
  };
  const without = estimate(false);
  assert.ok(without > 20.5, `the tail adds the later activity (${without})`);
  assert.ok(Math.abs(estimate(true) - without) < 1e-9, 'the redraw changes nothing');
});

test('a status-line figure bounds calibration at its fetch, as a read at that moment would', (t) => {
  // Fable is used before and after the fetch that shows the week at 20%; the
  // status line first redraws that figure two hours after the fetch.
  const project = (step) => {
    const context = fixture(t);
    context.overall(NOW - 25 * HOUR, 10);
    context.usage('a', NOW - 19 * HOUR, 'claude-fable-5', 2_000_000);
    step(context);
    context.usage('b', NOW - 2 * HOUR, 'claude-fable-5', 2_000_000);
    return projectFableAllowance(context.store, NOW);
  };
  const read = project((context) => context.overall(NOW - 3 * HOUR, 20));
  const redrawn = project((context) => context.overall(NOW - HOUR, 20,
    { planType: null, provenance: 'official-statusline', metadata: {}, fetchedAfter: iso(NOW - 3 * HOUR) }));
  assert.ok(Math.abs(read.usedPercent - 40) < 0.01, `the later use is projected once at the step's rate (${read.usedPercent})`);
  assert.ok(Math.abs(redrawn.usedPercent - read.usedPercent) < 1e-9, `${redrawn.usedPercent} vs ${read.usedPercent}`);
});

test('the series carries one point per overall step plus the current estimate', (t) => {
  const context = fixture(t);
  context.overall(NOW - 25 * HOUR, 10);
  context.usage('f1', NOW - 22 * HOUR, 'claude-fable-5', 2_000_000);
  context.overall(NOW - 20 * HOUR, 15);
  context.usage('f2', NOW - 10 * HOUR, 'claude-fable-5', 2_000_000);
  context.overall(NOW - HOUR, 20);
  const projection = projectFableAllowance(context.store, NOW);
  assert.equal(projection.available, true);
  assert.equal(projection.measuredSteps, 2);
  assert.deepEqual(projection.series.map((point) => point.observedAt), [iso(NOW - 20 * HOUR), iso(NOW - HOUR), iso(NOW)]);
  assert.deepEqual(projection.series.map((point) => Math.round(point.usedPercent)), [10, 20, 20]);
  const quota = context.quota();
  assert.equal(quota.forecast.series.observed.length, 3);
});

test('the projection is cached until Claude evidence, the allowance setting, the clock or the reset moves it', (t) => {
  const context = fixture(t);
  fableWeek(context);
  const settings = context.store.getSettings();
  const first = context.store.getFableProjection(settings, NOW);
  assert.equal(context.store.getFableProjection(settings, NOW + 30_000), first, 'a repeat inside a minute is served from cache');
  assert.notEqual(context.store.getFableProjection(settings, NOW + 61_000), first, 'the tail grows with the clock');
  const cached = context.store.getFableProjection(settings, NOW + 61_000);
  context.usage('later', NOW + 62_000, 'claude-fable-5', 1_000_000);
  assert.notEqual(context.store.getFableProjection(settings, NOW + 63_000), cached, 'Claude usage invalidates');
  const afterUsage = context.store.getFableProjection(settings, NOW + 63_000);
  context.overall(NOW + 64_000, 21);
  assert.notEqual(context.store.getFableProjection(settings, NOW + 65_000), afterUsage, 'a Claude reading invalidates');
  const afterReading = context.store.getFableProjection(settings, NOW + 65_000);
  const changed = context.store.updateSettings({ allowanceChanges: [{ source: 'claude', at: iso(NOW - 12 * HOUR), previousAllowancePercent: 150 }] });
  assert.notEqual(context.store.getFableProjection(changed, NOW + 66_000), afterReading, 'the setting is part of the key');
  const pending = context.store.updateSettings({ allowanceChanges: [{ source: 'claude', at: iso(NOW + 70_000), previousAllowancePercent: 150 }] });
  const before = context.store.getFableProjection(pending, NOW + 67_000);
  assert.notEqual(context.store.getFableProjection(pending, NOW + 71_000), before, 'a pending change expires the cache at its instant');
});

test('a future-dated Claude event or reading expires the cached projection at its own timestamp', (t) => {
  const context = fixture(t);
  fableWeek(context);
  const settings = context.store.getSettings();
  context.usage('queued', NOW + 10_000, 'claude-fable-5', 2_000_000);
  const stale = context.store.getFableProjection(settings, NOW);
  assert.ok(Math.abs(stale.usedPercent - 20) < 0.01, 'the queued event is not yet part of the estimate');
  assert.equal(context.store.getFableProjection(settings, NOW + 5_000), stale);
  const current = context.store.getFableProjection(settings, NOW + 20_000);
  assert.notEqual(current, stale, 'the cache expired when the event became current');
  assert.deepEqual(current, projectFableAllowance(context.store, NOW + 20_000));
  assert.ok(current.usedPercent > 20, `the event is in the tail now (${current.usedPercent})`);
  context.overall(NOW + 40_000, 30);
  const beforeReading = context.store.getFableProjection(settings, NOW + 30_000);
  assert.notEqual(context.store.getFableProjection(settings, NOW + 41_000), beforeReading, 'a future-dated reading expires it too');
});

test('readings dated ahead of the projection clock wait for their own timestamp', (t) => {
  const context = fixture(t);
  fableWeek(context);
  // An early reset queued ten minutes ahead: the next window has one reading
  // and could not be projected, so using it now would end the estimate early.
  const nextReset = iso(NOW + 7 * 24 * HOUR);
  context.overall(NOW + 10 * 60_000, 1, { resetsAt: nextReset });
  const now = projectFableAllowance(context.store, NOW);
  assert.equal(now.available, true);
  assert.equal(now.resetsAt, RESET);
  assert.ok(Math.abs(now.usedPercent - 20) < 0.01);
  assert.ok(Math.abs(context.quota().usedPercent - 20) < 0.01, 'the card keeps the current window until the reading is current');
  const later = projectFableAllowance(context.store, NOW + 11 * 60_000);
  assert.deepEqual(later, { available: false, reason: 'not-enough-overall-readings' }, 'once current, the new window governs');
  // A Fable anchor dated ahead of now is likewise not an anchor yet.
  const anchored = fixture(t);
  fableWeek(anchored);
  anchored.fable(NOW + 5 * 60_000, 44, { provenance: 'manual-official', metadata: {} });
  assert.equal(projectFableAllowance(anchored.store, NOW).anchored, false);
  assert.equal(projectFableAllowance(anchored.store, NOW + 6 * 60_000).anchored, true);
});

test('a replenishment before the reset timestamp moves restarts the projection with the new cycle', (t) => {
  const context = fixture(t);
  context.overall(NOW - 30 * HOUR, 49);
  context.usage('old-cycle', NOW - 29 * HOUR, 'claude-fable-5', 1_000_000);
  context.overall(NOW - 28 * HOUR, 50);
  // Replenished, but the provider still reports the old reset timestamp.
  context.overall(NOW - 20 * HOUR, 0);
  context.usage('new-cycle', NOW - 10 * HOUR, 'claude-fable-5', 5_000_000);
  context.overall(NOW - HOUR, 5);
  const projection = projectFableAllowance(context.store, NOW);
  assert.equal(projection.available, true);
  assert.ok(Math.abs(projection.usedPercent - 10) < 0.01, `five new points, all Fable: ${projection.usedPercent}`);
  assert.deepEqual(projection.series.map((point) => Math.round(point.usedPercent)), [10, 10]);

  // The previous cycle's Fable use must not carry into the new one either.
  const opusOnly = fixture(t);
  opusOnly.overall(NOW - 30 * HOUR, 10);
  opusOnly.usage('old-cycle', NOW - 29 * HOUR, 'claude-fable-5', 4_000_000);
  opusOnly.overall(NOW - 28 * HOUR, 50);
  opusOnly.overall(NOW - 20 * HOUR, 0);
  opusOnly.usage('new-cycle', NOW - 10 * HOUR, 'claude-opus-5', 5_000_000);
  opusOnly.overall(NOW - HOUR, 5);
  assert.equal(projectFableAllowance(opusOnly.store, NOW).usedPercent, 0);

  // Nor may an anchor taken before the replenishment.
  const anchored = fixture(t);
  anchored.overall(NOW - 30 * HOUR, 10);
  anchored.fable(NOW - 29 * HOUR, 30, { provenance: 'manual-official', metadata: {} });
  anchored.overall(NOW - 28 * HOUR, 50);
  anchored.overall(NOW - 20 * HOUR, 0);
  anchored.usage('new-cycle', NOW - 10 * HOUR, 'claude-fable-5', 1_000_000);
  anchored.overall(NOW - HOUR, 1);
  const fresh = projectFableAllowance(anchored.store, NOW);
  assert.equal(fresh.anchored, false);
  assert.ok(Math.abs(fresh.usedPercent - 2) < 0.01, `one new point, all Fable: ${fresh.usedPercent}`);
});

test('a recorded allowance upgrade is not mistaken for a replenishment', (t) => {
  const context = fixture(t);
  // Before the upgrade the allowance was a quarter of today's: 8% then is 2%
  // now, so the provider's drop from 8% to 2% is the same use, not a new cycle.
  context.overall(NOW - 30 * HOUR, 0);
  context.usage('before-upgrade', NOW - 25 * HOUR, 'claude-fable-5', 4_000_000);
  context.overall(NOW - 20 * HOUR, 8);
  context.store.updateSettings({ allowanceChanges: [{ source: 'claude', at: iso(NOW - 15 * HOUR), previousAllowancePercent: 25 }] });
  context.overall(NOW - 10 * HOUR, 2);
  context.usage('after-upgrade', NOW - 5 * HOUR, 'claude-fable-5', 2_000_000);
  context.overall(NOW - HOUR, 3);
  const projection = projectFableAllowance(context.store, NOW);
  // Two points before the upgrade and one after, in today's terms, all of it
  // Fable and doubled for the half cap.
  assert.ok(Math.abs(projection.usedPercent - 6) < 0.01, `usedPercent ${projection.usedPercent}`);
  assert.equal(projection.measuredSteps, 2);
});

test('a stale status-line restatement near zero is not mistaken for a replenishment', (t) => {
  const context = fixture(t);
  fableWeek(context);
  // A session that fetched its limits at the start of the week redraws them.
  context.overall(NOW - 30 * 60_000, 1, { planType: null, provenance: 'official-statusline', metadata: {} });
  const projection = projectFableAllowance(context.store, NOW);
  assert.equal(projection.available, true);
  assert.ok(Math.abs(projection.usedPercent - 20) < 0.01, `usedPercent ${projection.usedPercent}`);
  assert.equal(projection.ceiling, 40, 'the ceiling follows the reading the Claude card shows');
});

// Last week's Fable readings supply the only calibration pair candidates; this
// week has one overall reading and no anchor, so only a pair can project it.
function calibrationWeek(context, values) {
  const previousReset = iso(Date.parse(RESET) - 7 * 24 * HOUR);
  const times = [NOW - 6 * 24 * HOUR, NOW - 5 * 24 * HOUR, NOW - 4 * 24 * HOUR];
  values.forEach(([used, provenance], index) => {
    if (index > 0) context.usage(`calibration-${index}`, times[index] - 6 * HOUR, 'claude-fable-5', 500_000);
    context.fable(times[index], used, { resetsAt: previousReset, provenance, metadata: {} });
  });
  context.overall(NOW - 2 * HOUR, 3);
  context.usage('this-week', NOW - HOUR, 'claude-fable-5', 2_000_000);
  return projectFableAllowance(context.store, NOW);
}

test('a correction and its rebound are not measured as Fable consumption', (t) => {
  const rebound = calibrationWeek(fixture(t),
    [[20, 'official-claude-usage'], [19, 'official-statusline'], [20, 'official-statusline']]);
  assert.deepEqual(rebound, { available: false, reason: 'not-enough-overall-readings' },
    'usage never passed the 20% already observed');
  const rise = calibrationWeek(fixture(t),
    [[20, 'official-claude-usage'], [19, 'official-statusline'], [22, 'official-statusline']]);
  assert.equal(rise.method, 'fable-anchor-pair');
  assert.equal(rise.measuredPairs, 1);
  assert.equal(rise.calibration.pairMeasuredPressure, 10,
    'the rise is measured from the reading that set the high-water mark, so both sessions count');
});

test('a Fable replenishment starts a new high-water mark for calibration', (t) => {
  const context = fixture(t);
  context.fable(NOW - 30 * HOUR, 60);
  context.fable(NOW - 20 * HOUR, 1);
  context.usage('after-replenishment', NOW - 15 * HOUR, 'claude-fable-5', 1_000_000);
  context.fable(NOW - 10 * HOUR, 6);
  context.overall(NOW - 2 * HOUR, 3);
  context.usage('tail', NOW - HOUR, 'claude-fable-5', 1_000_000);
  const projection = projectFableAllowance(context.store, NOW);
  assert.equal(projection.method, 'fable-anchor-pair');
  assert.equal(projection.measuredPairs, 1, 'the rise after the replenishment is real consumption');
});

test('the tracker anchors on the reading the card shows: the latest usable one in the bucket', (t) => {
  const context = fixture(t);
  context.fable(NOW - 2 * HOUR, 40);
  context.fable(NOW - HOUR, 20, { provenance: 'manual-official', metadata: {} });
  assert.equal(context.quota().usedPercent, 20);
  assert.equal(getLastCurrentOfficial(context.store, NOW).used_percent, 20, 'a newer manual correction outranks an older provider reading');
  context.fable(NOW - 30 * 60_000, 44);
  assert.equal(getLastCurrentOfficial(context.store, NOW).used_percent, 44);
  const expired = fixture(t);
  expired.fable(NOW - 9 * 24 * HOUR, 60, { resetsAt: iso(NOW - 5 * 24 * HOUR) });
  assert.equal(getLastCurrentOfficial(expired.store, NOW), null, 'an expired reading is history, not an anchor');
});

test('legacy stored estimates are removed once by the migration and can never come back', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-fable-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'db.sqlite');
  let store = new UsageStore(databasePath, path.join(root, 'Backups'));
  store.recordObservation({
    sourceId: 'claude-fable', bucketId: 'fable_seven_day', bucketName: 'Fable 5 weekly', observedAt: iso(NOW - HOUR),
    usedPercent: 12, remainingPercent: 88, resetsAt: RESET, windowMinutes: 10_080, provenance: 'manual-official',
    confidence: 0.98, metadata: {},
  });
  store.prepare(`INSERT INTO quota_observations(source_id, bucket_id, bucket_name, observed_at, used_percent, remaining_percent,
    resets_at, window_minutes, plan_type, provenance, confidence, metadata_json)
    VALUES ('claude-fable', 'fable_seven_day', 'Fable 5 weekly', ?, 30, 70, ?, 10080, 'max', 'derived-tokens', 0.5, '{}')`)
    .run(iso(NOW - 2 * HOUR), RESET);
  store.prepare('DELETE FROM settings WHERE key = ?').run('migration.fable-projection-v1');
  store.close();
  store = new UsageStore(databasePath, path.join(root, 'Backups'));
  try {
    const rows = store.prepare("SELECT provenance FROM quota_observations WHERE source_id = 'claude-fable'").all();
    assert.deepEqual(rows.map((row) => row.provenance), ['manual-official']);
    assert.ok(store.prepare('SELECT 1 FROM settings WHERE key = ?').get('migration.fable-projection-v1'));
    assert.throws(() => store.recordObservation({
      sourceId: 'claude-fable', bucketId: 'fable_seven_day', bucketName: 'Fable 5 weekly', observedAt: iso(NOW),
      usedPercent: 12, remainingPercent: 88, resetsAt: RESET, windowMinutes: 10_080, provenance: 'derived-tokens',
      confidence: 0.5, metadata: {},
    }), /projected, not stored/);
    const restored = store.restoreFromExport({ schemaVersion: 1, observations: [{
      source_id: 'claude-fable', bucket_id: 'fable_seven_day', observed_at: iso(NOW - 3 * HOUR), used_percent: 5,
      resets_at: RESET, window_minutes: 10_080, provenance: 'derived-tokens',
    }] });
    assert.equal(restored.observations, 0);
    assert.equal(restored.skipped, 1);
  } finally { store.close(); }
});
