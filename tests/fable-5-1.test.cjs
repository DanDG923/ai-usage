'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { projectFableAllowance } = require('../electron/fable-projection.cjs');
const { createFableUsageTracker } = require('../electron/fable-tracker.cjs');
const { UsageStore } = require('../electron/store.cjs');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MILLION = 1_000_000;
const NOW = Date.parse('2026-09-16T13:00:00Z');
const RESET = '2026-09-19T08:00:00.000Z';
const iso = (at) => new Date(at).toISOString();
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${message ?? 'value'}: ${actual} is not within ${tolerance} of ${expected}`);

function fixture(t, name = 'fable-5-1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ai-usage-${name}-`));
  const file = path.join(root, 'db.sqlite');
  const backups = path.join(root, 'Backups');
  const context = { root, file, store: new UsageStore(file, backups) };
  context.reopen = () => {
    context.store.close();
    context.store = new UsageStore(file, backups);
    return context.store;
  };
  t.after(() => { context.store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  context.usage = (key, occurredAt, model, tokens = {}) => context.store.recordUsageEvent({
    eventKey: `fable-5-1:${key}`, sourceId: 'claude', occurredAt: iso(occurredAt), sessionId: `session-${key}`, model,
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, ...tokens,
  });
  context.claude = (observedAt, usedPercent, overrides = {}) => context.store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly', observedAt: iso(observedAt), usedPercent,
    remainingPercent: 100 - usedPercent, resetsAt: RESET, windowMinutes: 10_080, planType: 'max',
    provenance: 'official-claude-usage', confidence: 1, metadata: { scope: 'overall' }, ...overrides,
  });
  context.fable = (observedAt, usedPercent, overrides = {}) => context.store.recordObservation({
    sourceId: 'claude-fable', bucketId: 'fable_seven_day', bucketName: 'Fable weekly', observedAt: iso(observedAt),
    usedPercent, remainingPercent: 100 - usedPercent, resetsAt: RESET, windowMinutes: 10_080, planType: 'max',
    provenance: 'official-claude-usage', confidence: 1, metadata: { scope: 'model' }, ...overrides,
  });
  context.costs = () => context.store.getCostAnalytics(1, context.store.getSettings(), NOW);
  return context;
}

const everyCategory = (model) => ({
  source_id: 'claude', model, input_tokens: MILLION, cached_input_tokens: MILLION,
  cache_write_input_tokens: 2 * MILLION, cache_write_5m_input_tokens: MILLION, cache_write_1h_input_tokens: MILLION,
  output_tokens: MILLION,
});

// ---------------------------------------------------------------------------
// Prices.

test('Fable 5.1 and Opus 5.5 have their own price rows and dates', (t) => {
  const { store } = fixture(t);
  const fable51 = store.resolvePrice('claude-fable-5-1');
  assert.equal(fable51.model, 'claude-fable-5-1');
  assert.deepEqual([fable51.input_usd_per_million, fable51.cache_write_usd_per_million, fable51.cache_write_1h_usd_per_million,
    fable51.cache_read_usd_per_million, fable51.output_usd_per_million], [10, 12.5, 20, 0.25, 50]);
  assert.equal(fable51.effective_from, '2026-09-01');
  assert.equal(fable51.source_url, 'https://platform.claude.com/docs/en/about-claude/pricing');
  assert.equal(fable51.is_seed, 1);
  const opus55 = store.resolvePrice('claude-opus-5-5');
  assert.equal(opus55.model, 'claude-opus-5-5');
  assert.deepEqual([opus55.input_usd_per_million, opus55.cache_write_usd_per_million, opus55.cache_write_1h_usd_per_million,
    opus55.cache_read_usd_per_million, opus55.output_usd_per_million], [4, 5, 8, 0.2, 20]);
  assert.equal(opus55.effective_from, '2026-09-22');
  assert.equal(store.resolvePrice('claude-fable-5').cache_read_usd_per_million, 1, 'Fable 5 keeps its own cache-read rate');
});

test('a million Fable 5.1 cache-read tokens cost a quarter of a dollar, not a dollar', (t) => {
  const { store } = fixture(t);
  const read = (model) => store.calculateCost({ source_id: 'claude', model, cached_input_tokens: MILLION });
  assert.equal(read('claude-fable-5-1').actualUsd, 0.25);
  assert.equal(read('claude-fable-5-1').covered, true);
  assert.equal(read('claude-fable-5').actualUsd, 1);
  near(store.calculateCost(everyCategory('claude-fable-5-1')).actualUsd, 10 + 12.5 + 20 + 0.25 + 50, 1e-9, 'Fable 5.1');
  const opus = store.calculateCost(everyCategory('claude-opus-5-5'));
  near(opus.actualUsd, 4 + 5 + 8 + 0.2 + 20, 1e-9, 'Opus 5.5');
  near(opus.breakdownUsd.cacheRead, 0.2, 1e-12, 'Opus 5.5 cache read');
  near(opus.breakdownUsd.cacheWrite1h, 8, 1e-12, 'Opus 5.5 one-hour write');
  near(store.calculateCost(everyCategory('claude-opus-5')).actualUsd, 5 + 6.25 + 10 + 0.5 + 25, 1e-9, 'Opus 5 unchanged');
});

test('only date suffixes borrow a catalogue row; the next point release is unpriced', (t) => {
  const { store } = fixture(t);
  for (const [model, row] of [
    ['claude-fable-5-20260829', 'claude-fable-5'],
    ['claude-fable-5-2026-08-29', 'claude-fable-5'],
    ['claude-fable-5-1-20260901', 'claude-fable-5-1'],
    ['claude-opus-5-5-20260922', 'claude-opus-5-5'],
    ['gpt-5.6-sol-2026-08', 'gpt-5.6-sol'],
    ['CLAUDE-FABLE-5-1', 'claude-fable-5-1'],
  ]) assert.equal(store.resolvePrice(model)?.model, row, model);
  for (const model of ['claude-fable-5-2', 'claude-opus-5-6', 'claude-fable-5-v2', 'claude-fable-5.1']) {
    assert.equal(store.resolvePrice(model), null, `${model} must not borrow a predecessor's price`);
  }
});

test('Costs price each version at its own rate and list the unknown point release as unpriced', (t) => {
  const context = fixture(t);
  context.store.updateSettings({ currency: 'USD' });
  context.usage('fable-5-1', NOW - HOUR, 'claude-fable-5-1', { cachedInputTokens: MILLION });
  context.usage('fable-5', NOW - HOUR, 'claude-fable-5-20260829', { cachedInputTokens: MILLION });
  context.usage('opus-5-5', NOW - HOUR, 'claude-opus-5-5', { inputTokens: MILLION });
  context.usage('fable-5-2', NOW - HOUR, 'claude-fable-5-2', { inputTokens: 1000 });
  const costs = context.costs();
  near(costs.actual, 0.25 + 1 + 4, 0.005, 'total');
  assert.equal(costs.isLowerBound, true);
  assert.deepEqual(costs.unpricedModels, [{ sourceId: 'claude', model: 'claude-fable-5-2', tokens: 1000 }]);
  const byModel = Object.fromEntries(costs.byModel.map((row) => [row.model, row]));
  assert.equal(byModel['claude-fable-5-1'].cost, 0.25);
  assert.equal(byModel['claude-fable-5-20260829'].cost, 1);
  assert.equal(byModel['claude-opus-5-5'].cost, 4);
  assert.equal(byModel['claude-fable-5-2'].cost, 0);
  assert.equal(byModel['claude-fable-5-2'].coverage, 0);
});

test('an existing database gains both rows on reopen, reprices history and keeps custom rates', (t) => {
  const context = fixture(t, 'fable-5-1-upgrade');
  let store = context.store;
  store.updateSettings({ currency: 'USD' });
  store.db.prepare('DELETE FROM price_catalog WHERE model IN (?, ?)').run('claude-fable-5-1', 'claude-opus-5-5');
  context.usage('old-fable-5-1', NOW - HOUR, 'claude-fable-5-1', { cachedInputTokens: MILLION });
  context.usage('old-opus-5-5', NOW - HOUR, 'claude-opus-5-5', { inputTokens: MILLION });
  assert.equal(store.resolvePrice('claude-fable-5-1'), null, 'without its row Fable 5.1 does not borrow Fable 5\'s');
  const before = context.costs();
  assert.equal(before.isLowerBound, true);
  assert.deepEqual(before.unpricedModels.map((row) => row.model), ['claude-fable-5-1', 'claude-opus-5-5']);
  const events = store.db.prepare('SELECT * FROM usage_events ORDER BY event_key').all();

  store = context.reopen();
  assert.deepEqual(store.db.prepare('SELECT * FROM usage_events ORDER BY event_key').all(), events, 'history is not rewritten');
  const after = context.costs();
  assert.equal(after.isComplete, true);
  assert.equal(after.coverage, 1);
  assert.deepEqual(after.unpricedModels, []);
  near(after.actual, 4.25, 1e-9, 'repriced total');
  assert.equal(store.resolvePrice('claude-fable-5-1').effective_from, '2026-09-01');
  assert.equal(store.resolvePrice('claude-opus-5-5').effective_from, '2026-09-22');

  store.updatePrice({ model: 'claude-fable-5-1', inputUsdPerMillion: 10, cacheWriteUsdPerMillion: 12.5,
    cacheWrite1hUsdPerMillion: 20, cacheReadUsdPerMillion: 0.5, outputUsdPerMillion: 50 });
  store = context.reopen();
  assert.equal(store.resolvePrice('claude-fable-5-1').is_seed, 0);
  assert.equal(store.resolvePrice('claude-fable-5-1').cache_read_usd_per_million, 0.5, 'a custom rate survives the seed');
  near(context.costs().actual, 4.5, 1e-9, 'total at the custom rate');
});

// ---------------------------------------------------------------------------
// Allowance pressure v2.

// Two official Fable readings five points apart bound a million cache-read
// tokens: the pressure measured between them is the model's cache-read weight.
function pairScenario(t, model) {
  const context = fixture(t, 'fable-5-1-pressure');
  context.claude(NOW - 30 * HOUR, 10);
  context.fable(NOW - 20 * HOUR, 10);
  context.usage('pair', NOW - 19 * HOUR, model, { cachedInputTokens: MILLION });
  context.fable(NOW - 2 * HOUR, 15);
  context.claude(NOW - HOUR, 20);
  return projectFableAllowance(context.store, NOW);
}

test('allowance pressure weighs a Fable 5.1 cache read at its own quarter-dollar rate', (t) => {
  const fable51 = pairScenario(t, 'claude-fable-5-1');
  assert.equal(fable51.available, true);
  assert.equal(fable51.calibration.method, 'fable-anchor-pair');
  assert.equal(fable51.calibration.profile, 'allowance-pressure-v2');
  near(fable51.calibration.pairMeasuredPressure, 0.25, 1e-12, 'Fable 5.1 pressure');
  near(fable51.calibration.percentPerPressureUnit, 20, 1e-9, 'Fable 5.1 rate');
  const dated = pairScenario(t, 'claude-fable-5-1-20260901');
  near(dated.calibration.pairMeasuredPressure, 0.25, 1e-12, 'a dated Fable 5.1');
  const fable5 = pairScenario(t, 'claude-fable-5');
  near(fable5.calibration.pairMeasuredPressure, 1, 1e-12, 'Fable 5 pressure');
  near(fable5.calibration.percentPerPressureUnit, 5, 1e-9, 'Fable 5 rate');
});

// Ten overall points split by pressure between Fable and another model, with
// no Fable reading, so the projection's overall-share method applies.
function shareScenario(t, fableModel, fableTokens, otherModel, otherTokens) {
  const context = fixture(t, 'fable-5-1-share');
  context.claude(NOW - 25 * HOUR, 10);
  context.usage('fable', NOW - 20 * HOUR, fableModel, fableTokens);
  context.usage('other', NOW - 19 * HOUR, otherModel, otherTokens);
  context.claude(NOW - HOUR, 20);
  return { context, projection: projectFableAllowance(context.store, NOW) };
}

test('the overall-share split uses the Fable 5.1 and Opus 5.5 weights', (t) => {
  // 4M Fable 5.1 cache reads are 1 pressure unit, as are 250k Opus 5.5 input:
  // half of ten overall points, doubled for Fable's half share.
  const { context, projection } = shareScenario(t, 'claude-fable-5-1', { cachedInputTokens: 4 * MILLION },
    'claude-opus-5-5', { inputTokens: 250_000 });
  assert.equal(projection.calibration.method, 'overall-share');
  assert.equal(projection.calibration.profile, 'allowance-pressure-v2');
  near(projection.usedPercent, 10, 1e-9, 'Fable 5.1 with Opus 5.5');
  const quota = context.store.getQuota('claude-fable', context.store.getSettings(), NOW);
  assert.equal(quota.provenance, 'derived-tokens');
  assert.equal(quota.metadata.calibration.profile, 'allowance-pressure-v2');
  assert.equal(quota.bucketName, 'Fable weekly');

  // The same tokens on the predecessors weigh differently.
  near(shareScenario(t, 'claude-fable-5', { cachedInputTokens: 4 * MILLION }, 'claude-opus-5-5', { inputTokens: 250_000 })
    .projection.usedPercent, 16, 1e-9, 'Fable 5 cache reads weigh four times as much');
  near(shareScenario(t, 'claude-fable-5-1', { cachedInputTokens: 4 * MILLION }, 'claude-opus-5', { inputTokens: 250_000 })
    .projection.usedPercent, 10 * (1 / 2.25) / 0.5, 1e-9, 'Opus 5 input weighs 5, not 4');
});

// ---------------------------------------------------------------------------
// Provider payloads and local activity.

const TRACKER_NOW = '2026-08-30T18:00:00.000Z';
const TRACKER_RESET = '2026-09-03T08:00:00.000Z';

function usagePayload(modelScoped, sevenDay = 31) {
  return {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 18, resets_at: '2026-08-30T20:00:00.000Z' },
      seven_day: { utilization: sevenDay, resets_at: TRACKER_RESET },
      seven_day_opus: { utilization: 44, resets_at: TRACKER_RESET },
      model_scoped: modelScoped,
      extra_usage: { is_enabled: true, monthly_limit: 250, used_credits: 99, utilization: 39.6, currency: 'USD' },
    },
  };
}

function tracker(store, clock, payload) {
  return createFableUsageTracker({
    store,
    clock: () => new Date(clock()),
    activityReader: { import: async () => ({ filesFound: 0, usageEvents: 0, fableEvents: 0 }) },
    usagePort: { read: async () => payload() },
  });
}

test('two disagreeing Fable windows leave Fable unavailable but keep the Claude weekly reading', async (t) => {
  const { store } = fixture(t, 'fable-5-1-conflict');
  const conflict = [
    { display_name: 'Fable', utilization: 40, resets_at: TRACKER_RESET },
    { display_name: 'Fable 5.1', utilization: 55, resets_at: TRACKER_RESET },
    { display_name: 'Research model', utilization: 27, resets_at: TRACKER_RESET },
  ];
  const result = await tracker(store, () => TRACKER_NOW, () => usagePayload(conflict)).refresh();
  assert.deepEqual(result.allowance, { kind: 'unavailable', reason: 'fable-window-conflict' });
  assert.equal(result.provider.kind, 'unavailable');
  assert.equal(result.provider.attemptSucceeded, true);
  assert.equal(result.provider.overallWindowsRecorded, 4);
  assert.equal(result.provider.extraUsage.isEnabled, true);
  assert.equal(result.health.officialSource, 'temporarily-unavailable');
  assert.match(result.health.detail, /fable-window-conflict/);
  const nowMs = Date.parse(TRACKER_NOW);
  const claude = store.getQuota('claude', store.getSettings(), nowMs);
  const weekly = claude.windows.find((window) => window.bucketId === 'seven_day');
  assert.equal(weekly.usedPercent, 31);
  assert.equal(weekly.observedAt, TRACKER_NOW);
  assert.deepEqual(claude.windows.map((window) => window.bucketId).sort(),
    ['five_hour', 'model_scoped:research%20model', 'seven_day', 'seven_day_opus']);
  assert.equal(store.prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE source_id = 'claude-fable'").get().count, 0);
});

test('after a good reading, a conflicting refresh keeps the last Fable reading and still records Claude', async (t) => {
  const { store } = fixture(t, 'fable-5-1-conflict-cached');
  let now = TRACKER_NOW;
  let payload = usagePayload([{ display_name: 'Fable', utilization: 40, resets_at: TRACKER_RESET }]);
  const refresher = tracker(store, () => now, () => payload);
  const first = await refresher.refresh();
  assert.equal(first.allowance.kind, 'official');
  now = iso(Date.parse(TRACKER_NOW) + 30 * 60_000);
  payload = usagePayload([
    { display_name: 'Fable', utilization: 42, resets_at: TRACKER_RESET },
    { display_name: 'Fable', utilization: 47, resets_at: TRACKER_RESET },
  ], 35);
  const second = await refresher.refresh();
  assert.equal(second.allowance.kind, 'official');
  assert.equal(second.allowance.usedPercent, 40, 'the last agreed Fable reading stands');
  assert.equal(second.allowance.observedAt, TRACKER_NOW);
  assert.equal(second.health.state, 'stale');
  assert.equal(second.provider.overallWindowsRecorded, 3);
  const weekly = store.getQuota('claude', store.getSettings(), Date.parse(now)).windows.find((window) => window.bucketId === 'seven_day');
  assert.equal(weekly.usedPercent, 35);
  assert.equal(weekly.observedAt, now);
});

test('local Fable activity lists the versions seen in the Fable window', async (t) => {
  const context = fixture(t, 'fable-5-1-activity');
  const at = Date.parse(TRACKER_NOW);
  context.usage('a', at - 3 * HOUR, 'claude-fable-5', { inputTokens: 100 });
  context.usage('b', at - 2 * HOUR, 'claude-fable-5', { inputTokens: 100 });
  context.usage('c', at - HOUR, 'claude-fable-5-1', { inputTokens: 100, cachedInputTokens: 50 });
  context.usage('opus', at - HOUR, 'claude-opus-5-5', { inputTokens: 100 });
  context.usage('before-window', Date.parse(TRACKER_RESET) - 8 * DAY, 'claude-fable-5-1', { inputTokens: 100 });
  const payload = usagePayload([{ display_name: 'Fable', utilization: 40, resets_at: TRACKER_RESET }]);
  const result = await tracker(context.store, () => TRACKER_NOW, () => payload).refresh();
  assert.equal(result.activity.requests, 3);
  assert.equal(result.activity.inputTokens, 300);
  assert.equal(result.activity.cachedInputTokens, 50);
  assert.deepEqual(result.activity.models, [
    { model: 'claude-fable-5', requests: 2 },
    { model: 'claude-fable-5-1', requests: 1 },
  ]);
});

test('Fable activity by version is costed at each version\'s rate in the settings currency', (t) => {
  const context = fixture(t, 'fable-5-1-by-version');
  const { store } = context;
  context.fable(NOW - HOUR, 30);
  for (const key of ['one', 'two']) {
    context.usage(`fable-5-${key}`, NOW - 2 * HOUR, 'claude-fable-5', { inputTokens: 100_000, cachedInputTokens: MILLION });
  }
  context.usage('fable-5-1', NOW - HOUR, 'claude-fable-5-1', { inputTokens: 100_000, cachedInputTokens: MILLION, outputTokens: 10_000 });
  context.usage('fable-5-2', NOW - HOUR, 'claude-fable-5-2', { inputTokens: 1000 });
  context.usage('opus', NOW - HOUR, 'claude-opus-5-5', { inputTokens: MILLION });
  context.usage('last-week', Date.parse(RESET) - 8 * DAY, 'claude-fable-5-1', { inputTokens: MILLION });
  const settings = store.getSettings();
  assert.equal(settings.currency, 'GBP');
  const quota = store.getQuota('claude-fable', settings, NOW);
  const activity = store.getFableActivity(quota, settings, NOW);
  assert.equal(activity.currency, 'GBP');
  assert.equal(activity.since, iso(Date.parse(RESET) - 7 * DAY));
  assert.equal(activity.through, iso(NOW));
  assert.deepEqual(activity.models.map((entry) => entry.model), ['claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2']);
  const [fable5, fable51, fable52] = activity.models;
  assert.equal(fable5.requests, 2);
  assert.equal(fable5.totalTokens, 2_200_000);
  assert.equal(fable5.cacheReadTokens, 2 * MILLION);
  near(fable5.cost, (2 * (1 + 1)) * settings.usdToCurrency, 1e-4, 'Fable 5 cost');
  assert.equal(fable51.requests, 1);
  assert.equal(fable51.totalTokens, 1_110_000);
  near(fable51.cost, (1 + 0.25 + 0.5) * settings.usdToCurrency, 1e-4, 'Fable 5.1 cost');
  assert.equal(fable51.covered, true);
  assert.equal(fable52.covered, false);
  assert.equal(fable52.cost, 0);

  // Costs by model agree with the per-version figures for the same events.
  const costs = store.getCostAnalytics(1, settings, NOW);
  for (const entry of [fable5, fable51]) {
    const row = costs.byModel.find((model) => model.model === entry.model);
    near(row.cost, entry.cost, 0.005, `${entry.model} against Costs by model`);
  }

  // The dashboard snapshot carries the same split for its Fable window.
  const snapshot = store.getDashboardSnapshot(30, NOW);
  assert.deepEqual(snapshot.fableActivity, store.getFableActivity(snapshot.quotas.fable, settings, NOW));
  store.updateSettings({ currency: 'USD' });
  const usd = store.getFableActivity(quota, store.getSettings(), NOW);
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.models.find((entry) => entry.model === 'claude-fable-5-1').cost, 1.75);
});

// ---------------------------------------------------------------------------
// The "Fable" name.

test('the one-time rename turns Fable 5 into Fable, and legacy names read later are normalised', (t) => {
  const context = fixture(t, 'fable-5-1-rename');
  let store = context.store;
  assert.equal(store.prepare("SELECT name FROM sources WHERE id = 'claude-fable'").get().name, 'Fable');
  assert.ok(store.prepare("SELECT 1 FROM settings WHERE key = 'migration.fable-name-v1'").get());
  // An older database: the old names, and no record of the rename.
  store.prepare("UPDATE sources SET name = 'Fable 5' WHERE id = 'claude-fable'").run();
  context.fable(NOW - 2 * HOUR, 20, { bucketName: 'Fable 5 weekly' });
  context.claude(NOW - 2 * HOUR, 20, { bucketName: 'Fable 5 weekly' });
  store.prepare("DELETE FROM settings WHERE key = 'migration.fable-name-v1'").run();

  store = context.reopen();
  assert.equal(store.prepare("SELECT name FROM sources WHERE id = 'claude-fable'").get().name, 'Fable');
  assert.equal(store.prepare("SELECT bucket_name FROM quota_observations WHERE source_id = 'claude-fable'").get().bucket_name, 'Fable weekly');
  assert.equal(store.prepare("SELECT bucket_name FROM quota_observations WHERE source_id = 'claude'").get().bucket_name,
    'Fable 5 weekly', 'only Fable rows are renamed');
  assert.ok(store.prepare("SELECT 1 FROM settings WHERE key = 'migration.fable-name-v1'").get());
  assert.equal('migration.fable-name-v1' in store.getSettings(), false, 'the marker is not a user setting');

  // Runs once: a later custom name is left alone.
  store.prepare("UPDATE sources SET name = 'Fable 5' WHERE id = 'claude-fable'").run();
  store = context.reopen();
  assert.equal(store.prepare("SELECT name FROM sources WHERE id = 'claude-fable'").get().name, 'Fable 5');

  // A legacy-named reading arriving after the rename is shown as "Fable weekly".
  context.fable(NOW - HOUR, 25, { bucketName: 'Fable 5 weekly' });
  const quota = store.getQuota('claude-fable', store.getSettings(), NOW);
  assert.equal(quota.bucketName, 'Fable weekly');
  assert.equal(quota.windows[0].bucketName, 'Fable weekly');
  assert.equal(quota.usedPercent, 25);
  assert.equal(store.prepare("SELECT bucket_name FROM quota_observations WHERE source_id = 'claude-fable' ORDER BY observed_at DESC").get().bucket_name,
    'Fable 5 weekly', 'the stored row is not rewritten on read');
  assert.equal(store.getTraySnapshot(NOW).quotas.fable.bucketName, 'Fable weekly');
});

test('a backup restored with the old bucket name reads as Fable weekly', (t) => {
  const { store } = fixture(t, 'fable-5-1-restore');
  const nowMs = Date.now();
  const restored = store.restoreFromExport({
    schemaVersion: 1,
    observations: [{
      source_id: 'claude-fable', bucket_id: 'fable_seven_day', bucket_name: 'Fable 5 weekly',
      observed_at: iso(nowMs - HOUR), used_percent: 35, remaining_percent: 65, resets_at: iso(nowMs + 2 * DAY),
      window_minutes: 10_080, plan_type: 'max', provenance: 'official-claude-usage', confidence: 1, metadata_json: '{"scope":"model"}',
    }],
  });
  assert.equal(restored.observations, 1);
  const quota = store.getQuota('claude-fable', store.getSettings(), nowMs);
  assert.equal(quota.bucketName, 'Fable weekly');
  assert.equal(quota.usedPercent, 35);
});

test('Fable activity by version prices cache writes recorded before the five-minute and one-hour split', (t) => {
  const context = fixture(t, 'fable-5-1-legacy-writes');
  const { store } = context;
  context.fable(NOW - HOUR, 10);
  // One row from before the split (total only) and one with a one-hour split.
  context.usage('legacy', NOW - 2 * HOUR, 'claude-fable-5-1', { cacheWriteInputTokens: MILLION });
  context.usage('split', NOW - HOUR, 'claude-fable-5-1', { cacheWriteInputTokens: MILLION, cacheWrite1hInputTokens: MILLION });
  const settings = { ...store.getSettings(), currency: 'USD', usdToCurrency: 1 };
  const activity = store.getFableActivity(store.getQuota('claude-fable', settings, NOW), settings, NOW);
  const [fable51] = activity.models;
  near(fable51.cost, 12.5 + 20, 1e-6, 'a legacy write at the five-minute rate plus a one-hour write');
  const costs = store.getCostAnalytics(1, settings, NOW).byModel.find((row) => row.model === 'claude-fable-5-1');
  near(fable51.cost, costs.cost, 1e-6, 'the Fable page and Costs agree');
});

test('the extra-usage setting comes from the newest plan-usage read of either Claude source', (t) => {
  const context = fixture(t, 'fable-5-1-extra-usage');
  const { store } = context;
  context.claude(NOW - 3 * HOUR, 20, { metadata: { scope: 'overall', source: 'claude-usage', extraUsage: { isEnabled: false, utilization: null } } });
  context.fable(NOW - HOUR, 10, { metadata: { scope: 'model', source: 'claude-usage', extraUsage: { isEnabled: true, utilization: 40 } } });
  // A newer status-line reading carries no extra-usage setting.
  context.claude(NOW - 10 * 60_000, 25, { provenance: 'official-statusline', planType: null, metadata: {} });
  assert.deepEqual(store.getClaudeExtraUsage(NOW), { isEnabled: true, utilization: 40, observedAt: iso(NOW - HOUR) });
  assert.deepEqual(store.getDashboardSnapshot(30, NOW).claudeExtraUsage, store.getClaudeExtraUsage(NOW));
});
