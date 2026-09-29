'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');
const { deriveFableEstimate, epochToIso, findClaudeBinary, importClaudeInbox, importClaudeTranscripts, installClaudeHelper, isClaudeHelperInstalled, makeHelperScript, refreshClaude, uninstallClaudeHelper } = require('../electron/claude-collector.cjs');

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-fable-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try { return run(store); } finally { store.close(); }
}

function fableEvent(store, key, occurredAt, tokens) {
  store.recordUsageEvent({
    eventKey: `fable-test:${key}`, sourceId: 'claude', occurredAt,
    sessionId: 'fable-session', model: 'claude-fable-5',
    inputTokens: tokens, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0, metadata: {},
  });
}

function usageEvent(store, key, occurredAt, model, inputTokens) {
  store.recordUsageEvent({
    eventKey: `usage-test:${key}`, sourceId: 'claude', occurredAt,
    sessionId: 'test-session', model,
    inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0, metadata: {},
  });
}

const OVERALL_RESET = '2026-09-02T00:00:00.000Z';

function overallReading(store, observedAt, usedPercent) {
  store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly',
    observedAt, usedPercent, remainingPercent: 100 - usedPercent,
    resetsAt: OVERALL_RESET, windowMinutes: 10_080, planType: 'max',
    provenance: 'official-statusline', confidence: 1, metadata: {},
  });
}

function fableReading(store, observedAt, usedPercent) {
  store.recordObservation({
    sourceId: 'claude-fable', bucketId: 'fable_seven_day', bucketName: 'Fable 5 weekly',
    observedAt, usedPercent, remainingPercent: 100 - usedPercent,
    resetsAt: OVERALL_RESET, windowMinutes: 10_080,
    provenance: 'manual-official', confidence: 0.98, metadata: {},
  });
}

// Fable input is $10/M and Opus $5/M, so 1M Fable and 2M Opus are equal value.
test('Fable moves by its share of each official step, doubled for the half cap', () => withStore((store) => {
  overallReading(store, '2026-08-28T12:00:00.000Z', 10);
  usageEvent(store, 'f1', '2026-08-28T18:00:00.000Z', 'claude-fable-5', 1_000_000);
  usageEvent(store, 'o1', '2026-08-28T18:30:00.000Z', 'claude-opus-5', 2_000_000);
  overallReading(store, '2026-08-29T12:00:00.000Z', 20);

  const result = deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z'));
  assert.equal(result.derived, true);
  // Half the step's value was Fable: 10 points x 0.5 share / 0.5 cap = 10%.
  assert.ok(Math.abs(result.usedPercent - 10) < 0.01, `usedPercent ${result.usedPercent}`);
  assert.equal(result.measuredSteps, 1);
}));

test('a week of nothing but Opus leaves Fable at zero', () => withStore((store) => {
  overallReading(store, '2026-08-28T12:00:00.000Z', 5);
  usageEvent(store, 'o1', '2026-08-28T18:00:00.000Z', 'claude-opus-5', 8_000_000);
  overallReading(store, '2026-08-29T12:00:00.000Z', 45);

  const result = deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z'));
  assert.equal(result.derived, true);
  assert.equal(result.usedPercent, 0);
}));

test('a week of nothing but Fable moves Fable at twice the overall rate', () => withStore((store) => {
  overallReading(store, '2026-08-28T12:00:00.000Z', 0);
  usageEvent(store, 'f1', '2026-08-28T18:00:00.000Z', 'claude-fable-5', 4_000_000);
  overallReading(store, '2026-08-29T12:00:00.000Z', 10);

  const result = deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z'));
  assert.equal(result.derived, true);
  assert.ok(Math.abs(result.usedPercent - 20) < 0.01, `usedPercent ${result.usedPercent}`);
}));

test('shared-pool Fable estimation does not run for plans where inclusion is not established', () => withStore((store) => {
  const reading = (observedAt, usedPercent) => store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly',
    observedAt, usedPercent, remainingPercent: 100 - usedPercent,
    resetsAt: OVERALL_RESET, windowMinutes: 10_080, planType: 'pro',
    provenance: 'official-statusline', confidence: 1,
  });
  reading('2026-08-28T12:00:00.000Z', 10);
  fableEvent(store, 'pro-fable', '2026-08-28T18:00:00.000Z', 1_000_000);
  reading('2026-08-29T12:00:00.000Z', 20);

  const result = deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z'));
  assert.deepEqual(result, { derived: false, reason: 'fable-not-confirmed-in-shared-plan' });
  assert.equal(store.getQuota('claude-fable'), null);
}));

test('shared-pool Fable estimation also refuses an unknown plan', () => withStore((store) => {
  const reading = (observedAt, usedPercent) => store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly',
    observedAt, usedPercent, remainingPercent: 100 - usedPercent,
    resetsAt: OVERALL_RESET, windowMinutes: 10_080, planType: null,
    provenance: 'official-statusline', confidence: 1,
  });
  reading('2026-08-28T12:00:00.000Z', 10);
  fableEvent(store, 'unknown-plan', '2026-08-28T18:00:00.000Z', 1_000_000);
  reading('2026-08-29T12:00:00.000Z', 20);

  assert.deepEqual(deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z')), {
    derived: false,
    reason: 'fable-not-confirmed-in-shared-plan',
  });
}));

test('same-window provider rebounds do not count the same Fable movement twice', () => withStore((store) => {
  overallReading(store, '2026-08-28T08:00:00.000Z', 10);
  usageEvent(store, 'f-hw-1', '2026-08-28T09:00:00.000Z', 'claude-fable-5', 100_000);
  overallReading(store, '2026-08-28T10:00:00.000Z', 12);
  usageEvent(store, 'f-hw-2', '2026-08-28T11:00:00.000Z', 'claude-fable-5', 100_000);
  overallReading(store, '2026-08-28T12:00:00.000Z', 11);
  usageEvent(store, 'f-hw-3', '2026-08-28T13:00:00.000Z', 'claude-fable-5', 100_000);
  overallReading(store, '2026-08-28T14:00:00.000Z', 12);
  usageEvent(store, 'f-hw-4', '2026-08-28T15:00:00.000Z', 'claude-fable-5', 100_000);
  overallReading(store, '2026-08-28T16:00:00.000Z', 13);

  const result = deriveFableEstimate(store, Date.parse('2026-08-28T17:00:00Z'));
  assert.equal(result.derived, true);
  // Overall high-water moved 10 -> 12 -> 13: three points, doubled for the
  // half-sized Fable cap. The 11 -> 12 rebound contributes nothing new.
  assert.ok(Math.abs(result.usedPercent - 6) < 0.01, `usedPercent ${result.usedPercent}`);
}));

test('equal rounded Fable readings do not create a zero-rate calibration that freezes later use', () => withStore((store) => {
  overallReading(store, '2026-08-28T08:00:00.000Z', 10);
  fableReading(store, '2026-08-28T09:00:00.000Z', 5);
  usageEvent(store, 'f-equal-1', '2026-08-28T10:00:00.000Z', 'claude-fable-5', 100_000);
  overallReading(store, '2026-08-28T10:30:00.000Z', 15);
  fableReading(store, '2026-08-28T11:00:00.000Z', 5);
  usageEvent(store, 'f-equal-2', '2026-08-28T12:00:00.000Z', 'claude-fable-5', 100_000);
  overallReading(store, '2026-08-28T13:00:00.000Z', 20);

  const result = deriveFableEstimate(store, Date.parse('2026-08-28T14:00:00Z'));
  assert.equal(result.derived, true);
  assert.equal(result.method, 'overall-share');
  assert.equal(result.measuredPairs, 0);
  assert.ok(Math.abs(result.usedPercent - 15) < 0.01, `usedPercent ${result.usedPercent}`);
}));

test('editing API display prices cannot change the Fable allowance estimate', () => {
  const run = (editPrice) => withStore((store) => {
    overallReading(store, '2026-08-28T08:00:00.000Z', 10);
    usageEvent(store, 'f-price', '2026-08-28T09:00:00.000Z', 'claude-fable-5', 1_000_000);
    usageEvent(store, 'o-price', '2026-08-28T09:30:00.000Z', 'claude-opus-5', 1_000_000);
    overallReading(store, '2026-08-28T10:00:00.000Z', 20);
    if (editPrice) {
      const current = store.getPriceCatalog().find((row) => row.model === 'claude-fable-5');
      store.updatePrice({
        model: current.model, inputUsdPerMillion: 100,
        cacheWriteUsdPerMillion: current.cache_write_usd_per_million,
        cacheWrite1hUsdPerMillion: current.cache_write_1h_usd_per_million,
        cacheReadUsdPerMillion: current.cache_read_usd_per_million,
        outputUsdPerMillion: current.output_usd_per_million,
      });
    }
    return deriveFableEstimate(store, Date.parse('2026-08-28T11:00:00Z')).usedPercent;
  });

  assert.ok(Math.abs(run(false) - run(true)) < 0.0001);
});

test('unknown model activity blocks a precise shared-pool split instead of being priced as zero', () => withStore((store) => {
  overallReading(store, '2026-08-28T08:00:00.000Z', 10);
  usageEvent(store, 'f-covered', '2026-08-28T09:00:00.000Z', 'claude-fable-5', 100_000);
  usageEvent(store, 'unknown-uncovered', '2026-08-28T09:30:00.000Z', 'claude-future-unknown', 5_000_000);
  overallReading(store, '2026-08-28T10:00:00.000Z', 20);

  const result = deriveFableEstimate(store, Date.parse('2026-08-28T11:00:00Z'));
  assert.equal(result.derived, false);
  assert.equal(result.reason, 'insufficient-activity-coverage');
}));

test('the Fable projection is capped by the contemporaneous overall percentage', () => withStore((store) => {
  // A stale or mistyped manual reading of 90% against an overall of only 20%
  // is arithmetically impossible: Fable cannot have spent more of the pool
  // than the pool reports as spent.
  fableReading(store, '2026-08-28T11:00:00.000Z', 90);
  overallReading(store, '2026-08-28T12:00:00.000Z', 10);
  usageEvent(store, 'f1', '2026-08-28T18:00:00.000Z', 'claude-fable-5', 1_000_000);
  overallReading(store, '2026-08-29T12:00:00.000Z', 20);

  const result = deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z'));
  assert.equal(result.derived, true);
  assert.equal(result.clamped, true);
  assert.ok(Math.abs(result.usedPercent - 40) < 0.01, `usedPercent ${result.usedPercent}`);
  assert.ok(Math.abs(result.ceiling - 40) < 0.01);
}));

test('an official Fable reading re-anchors the running total', () => withStore((store) => {
  overallReading(store, '2026-08-28T10:00:00.000Z', 20);
  fableReading(store, '2026-08-28T11:00:00.000Z', 15);
  usageEvent(store, 'f1', '2026-08-28T18:00:00.000Z', 'claude-fable-5', 1_000_000);
  usageEvent(store, 'o1', '2026-08-28T18:30:00.000Z', 'claude-opus-5', 2_000_000);
  overallReading(store, '2026-08-29T12:00:00.000Z', 30);

  const result = deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z'));
  assert.equal(result.derived, true);
  assert.equal(result.anchored, true);
  // 15% anchor + half of a 10-point step, doubled = 25%.
  assert.ok(Math.abs(result.usedPercent - 25) < 0.01, `usedPercent ${result.usedPercent}`);
}));

test('usage from before the first official reading cannot distort the estimate', () => withStore((store) => {
  // The failure this replaces: a machine that joined the window late divided a
  // whole official percentage by the sliver of tokens it could see, and the
  // estimate then climbed several times too fast. Only intervals bounded by
  // two official readings count, so unseen history is simply absent.
  usageEvent(store, 'ancient', '2026-08-26T09:00:00.000Z', 'claude-fable-5', 50_000_000);
  overallReading(store, '2026-08-28T12:00:00.000Z', 40);
  usageEvent(store, 'f1', '2026-08-28T18:00:00.000Z', 'claude-fable-5', 1_000_000);
  overallReading(store, '2026-08-29T12:00:00.000Z', 44);

  const result = deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z'));
  assert.equal(result.derived, true);
  // Only the 4-point step counts, all of it Fable: 4 / 0.5 = 8%.
  assert.ok(Math.abs(result.usedPercent - 8) < 0.01, `usedPercent ${result.usedPercent}`);
}));

test('two official Fable readings calibrate a direct rate that keeps moving without overall steps', () => withStore((store) => {
  // The overall figure never steps here — the exact situation of a machine
  // whose sessions run outside the terminal, where the status line never
  // fires. The two Fable readings bound 1M Fable input tokens ($10), so the
  // rate is 1%/$1, and the 500k tokens ($5) after the anchor project +5.
  overallReading(store, '2026-08-28T10:00:00.000Z', 30);
  fableReading(store, '2026-08-28T11:00:00.000Z', 10);
  usageEvent(store, 'f1', '2026-08-28T12:00:00.000Z', 'claude-fable-5', 1_000_000);
  fableReading(store, '2026-08-28T18:00:00.000Z', 20);
  usageEvent(store, 'f2', '2026-08-28T20:00:00.000Z', 'claude-fable-5', 500_000);

  const result = deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z'));
  assert.equal(result.derived, true);
  assert.equal(result.method, 'fable-anchor-pair');
  assert.equal(result.measuredPairs, 1);
  assert.equal(result.anchored, true);
  assert.ok(Math.abs(result.usedPercent - 25) < 0.01, `usedPercent ${result.usedPercent}`);
}));

test('the direct Fable rate takes precedence over the overall-share split', () => withStore((store) => {
  // The share split would attribute this whole 10-point overall step to Fable
  // and read +20; the measured pair says the rate is 1%/$1 and reads +5 for
  // the $5 spent after the anchor. Direct measurement wins.
  overallReading(store, '2026-08-28T10:00:00.000Z', 10);
  fableReading(store, '2026-08-28T11:00:00.000Z', 10);
  usageEvent(store, 'f1', '2026-08-28T12:00:00.000Z', 'claude-fable-5', 1_000_000);
  fableReading(store, '2026-08-28T18:00:00.000Z', 20);
  usageEvent(store, 'f2', '2026-08-28T20:00:00.000Z', 'claude-fable-5', 500_000);
  overallReading(store, '2026-08-29T12:00:00.000Z', 20);

  const result = deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z'));
  assert.equal(result.derived, true);
  assert.equal(result.method, 'fable-anchor-pair');
  assert.ok(Math.abs(result.usedPercent - 25) < 0.01, `usedPercent ${result.usedPercent}`);
}));

test('post-observation Fable activity is not capped by an older overall reading', () => withStore((store) => {
  overallReading(store, '2026-08-28T10:00:00.000Z', 15);
  fableReading(store, '2026-08-28T11:00:00.000Z', 20);
  usageEvent(store, 'f1', '2026-08-28T12:00:00.000Z', 'claude-fable-5', 1_000_000);
  fableReading(store, '2026-08-28T18:00:00.000Z', 28);
  // $20 more at 0.8%/$ reaches 44. The 2 x 15 ceiling belongs to the older
  // overall observation and cannot cap activity that happened afterwards.
  usageEvent(store, 'f2', '2026-08-28T20:00:00.000Z', 'claude-fable-5', 2_000_000);

  const result = deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z'));
  assert.equal(result.derived, true);
  assert.equal(result.clamped, false);
  assert.ok(Math.abs(result.usedPercent - 44) < 0.01, `usedPercent ${result.usedPercent}`);
}));

test('unknown Fable-model activity in a direct-pair tail fails closed', () => withStore((store) => {
  overallReading(store, '2026-08-28T10:00:00.000Z', 30);
  fableReading(store, '2026-08-28T11:00:00.000Z', 10);
  usageEvent(store, 'known-pair', '2026-08-28T12:00:00.000Z', 'claude-fable-5', 1_000_000);
  fableReading(store, '2026-08-28T18:00:00.000Z', 20);
  usageEvent(store, 'unknown-tail', '2026-08-28T20:00:00.000Z', 'claude-fable-6', 500_000);

  assert.deepEqual(deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z')), {
    derived: false,
    reason: 'insufficient-activity-coverage',
  });
}));

test('unknown Fable-model activity in an overall-share tail fails closed', () => withStore((store) => {
  overallReading(store, '2026-08-28T08:00:00.000Z', 10);
  usageEvent(store, 'known-step', '2026-08-28T09:00:00.000Z', 'claude-fable-5', 100_000);
  overallReading(store, '2026-08-28T10:00:00.000Z', 20);
  usageEvent(store, 'unknown-share-tail', '2026-08-28T11:00:00.000Z', 'claude-fable-6', 500_000);

  assert.deepEqual(deriveFableEstimate(store, Date.parse('2026-08-28T12:00:00Z')), {
    derived: false,
    reason: 'insufficient-activity-coverage',
  });
}));

test('Fable readings on opposite sides of a reset never form a calibration pair', () => withStore((store) => {
  store.recordObservation({
    sourceId: 'claude-fable', bucketId: 'fable_seven_day', bucketName: 'Fable 5 weekly',
    observedAt: '2026-08-24T11:00:00.000Z', usedPercent: 80, remainingPercent: 20,
    resetsAt: '2026-08-26T00:00:00.000Z', windowMinutes: 10_080,
    provenance: 'manual-official', confidence: 0.98, metadata: {},
  });
  usageEvent(store, 'f0', '2026-08-27T09:00:00.000Z', 'claude-fable-5', 1_000_000);
  overallReading(store, '2026-08-28T10:00:00.000Z', 10);
  fableReading(store, '2026-08-28T11:00:00.000Z', 5);
  usageEvent(store, 'f1', '2026-08-28T18:00:00.000Z', 'claude-fable-5', 1_000_000);
  overallReading(store, '2026-08-29T12:00:00.000Z', 20);

  const result = deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z'));
  assert.equal(result.derived, true);
  // No same-window pair exists, so the overall-share split carries the anchor:
  // 5% + a 10-point step, all Fable, doubled = 25%.
  assert.equal(result.method, 'overall-share');
  assert.equal(result.measuredPairs, 0);
  assert.ok(Math.abs(result.usedPercent - 25) < 0.01, `usedPercent ${result.usedPercent}`);
}));

test('an anchor newer than the last overall reading is not projected twice', () => withStore((store) => {
  overallReading(store, '2026-08-28T10:00:00.000Z', 10);
  usageEvent(store, 'f1', '2026-08-28T12:00:00.000Z', 'claude-fable-5', 1_000_000);
  overallReading(store, '2026-08-28T14:00:00.000Z', 15);
  // $10 of Fable value follows the last overall reading, then an official
  // Fable reading absorbs it. Projecting that same value again from the
  // overall reading's timestamp would double count it.
  usageEvent(store, 'f2', '2026-08-28T16:00:00.000Z', 'claude-fable-5', 1_000_000);
  fableReading(store, '2026-08-28T18:00:00.000Z', 12);

  const result = deriveFableEstimate(store, Date.parse('2026-08-28T19:00:00Z'));
  assert.equal(result.derived, true);
  assert.equal(result.anchored, true);
  // No steps after the anchor and no Fable value after it either: the anchor
  // stands alone at 12%.
  assert.ok(Math.abs(result.usedPercent - 12) < 0.01, `usedPercent ${result.usedPercent}`);
}));

test('a single overall reading is not enough to derive anything', () => withStore((store) => {
  overallReading(store, '2026-08-28T12:00:00.000Z', 20);
  usageEvent(store, 'f1', '2026-08-28T18:00:00.000Z', 'claude-fable-5', 1_000_000);
  const result = deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z'));
  assert.equal(result.derived, false);
  assert.equal(result.reason, 'not-enough-overall-readings');
}));

test('the Fable estimate is projected on demand and never written as a reading', () => withStore((store) => {
  overallReading(store, '2026-08-28T12:00:00.000Z', 10);
  usageEvent(store, 'f1', '2026-08-28T18:00:00.000Z', 'claude-fable-5', 1_000_000);
  overallReading(store, '2026-08-29T12:00:00.000Z', 20);
  const first = deriveFableEstimate(store, Date.parse('2026-08-29T13:00:00Z'));
  assert.equal(first.derived, true);
  const repeat = deriveFableEstimate(store, Date.parse('2026-08-29T14:00:00Z'));
  assert.equal(repeat.derived, true);
  assert.ok(Math.abs(repeat.usedPercent - first.usedPercent) < 0.01, 'idle time does not move the estimate');
  assert.equal(store.prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE source_id = 'claude-fable' AND bucket_id = 'fable_seven_day'").get().count, 0);
  const quota = store.getQuota('claude-fable', store.getSettings(), Date.parse('2026-08-29T14:00:00Z'));
  assert.equal(quota.provenance, 'derived-tokens');
  assert.equal(quota.metadata.projected, true);
  assert.ok(Math.abs(quota.usedPercent - first.usedPercent) < 0.01);
}));

test('an expired overall window derives nothing rather than a past reset', () => withStore((store) => {
  // The Fable window is the overall window, so a stale reading can no longer
  // be rolled forward into an invented window. Waiting for the next official
  // reading is the honest answer, and recordObservation would reject a reset
  // in the past anyway, taking the whole Claude refresh down with it.
  store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly',
    observedAt: '2026-01-01T23:00:00.000Z', usedPercent: 10, remainingPercent: 90,
    resetsAt: '2026-01-02T00:00:00.000Z', windowMinutes: 10_080,
    planType: 'max',
    provenance: 'official-statusline', confidence: 1, metadata: {},
  });
  store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly',
    observedAt: '2026-01-01T23:30:00.000Z', usedPercent: 20, remainingPercent: 80,
    resetsAt: '2026-01-02T00:00:00.000Z', windowMinutes: 10_080,
    planType: 'max',
    provenance: 'official-statusline', confidence: 1, metadata: {},
  });
  usageEvent(store, 'recent', '2026-08-29T13:00:00.000Z', 'claude-fable-5', 500_000);
  const result = deriveFableEstimate(store, Date.parse('2026-08-29T14:00:00Z'));
  assert.equal(result.derived, false);
  assert.equal(result.reason, 'overall-window-expired');
  assert.equal(store.getQuota('claude-fable'), null);
}));

test('no official overall reading means no derived Fable estimate', () => withStore((store) => {
  usageEvent(store, 'orphan', '2026-08-29T10:00:00.000Z', 'claude-fable-5', 1_000_000);
  const result = deriveFableEstimate(store, Date.parse('2026-08-29T18:00:00Z'));
  assert.equal(result.derived, false);
  assert.equal(result.reason, 'no-overall-reading');
  assert.equal(store.getQuota('claude-fable'), null);
}));

test('Claude reset timestamps accept epochs and ISO strings', () => {
  assert.equal(epochToIso(1788500000), new Date(1788500000 * 1000).toISOString());
  assert.equal(epochToIso('2026-09-04T12:30:00Z'), '2026-09-04T12:30:00.000Z');
  assert.equal(epochToIso('not-a-date'), null);
  assert.equal(epochToIso(null), null);
  assert.equal(epochToIso(0), null);
  assert.equal(epochToIso(-1), null);
  assert.equal(epochToIso('1970-01-01T00:00:00Z'), null);
});

function assistantRow({ id, uuid, timestamp, model, input, cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h, output }) {
  return {
    type: 'assistant', sessionId: 'session-test', requestId: `request-${id}`,
    uuid, timestamp, entrypoint: 'desktop', isSidechain: false,
    message: {
      id, model, role: 'assistant',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        ...(cacheWrite5m != null || cacheWrite1h != null ? { cache_creation: {
          ephemeral_5m_input_tokens: cacheWrite5m || 0,
          ephemeral_1h_input_tokens: cacheWrite1h || 0,
        } } : {}),
        output_tokens: output,
      },
    },
  };
}

test('Claude transcripts import final message usage once, including Fable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-claude-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const project = path.join(root, '.claude', 'projects', 'test-project');
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, 'session.jsonl');
  const rows = [
    assistantRow({ id: 'message-1', uuid: 'partial', timestamp: '2026-08-29T10:00:00Z', model: 'claude-opus-5', input: 2, cacheRead: 100, cacheWrite: 10, output: 2 }),
    assistantRow({ id: 'message-1', uuid: 'final', timestamp: '2026-08-29T10:00:02Z', model: 'claude-opus-5', input: 2, cacheRead: 100, cacheWrite: 10, output: 12 }),
    assistantRow({ id: 'message-2', uuid: 'fable', timestamp: '2026-08-29T10:01:00Z', model: 'claude-fable-5', input: 3, cacheRead: 200, cacheWrite: 20, cacheWrite5m: 4, cacheWrite1h: 16, output: 8 }),
  ];
  fs.writeFileSync(transcript, `${rows.map(JSON.stringify).join('\n')}\n`);
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try {
    const first = importClaudeTranscripts(store);
    assert.equal(first.usageEvents, 2);
    assert.equal(first.fableEvents, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 2);
    assert.equal(store.db.prepare("SELECT output_tokens FROM usage_events WHERE model = 'claude-opus-5'").get().output_tokens, 12);
    const fable = store.db.prepare("SELECT * FROM usage_events WHERE model = 'claude-fable-5'").get();
    assert.equal(fable.cache_write_5m_input_tokens, 4);
    assert.equal(fable.cache_write_1h_input_tokens, 16);
    assert.equal(importClaudeTranscripts(store).usageEvents, 0);

    rows[1].message.usage.output_tokens = 20;
    rows[1].timestamp = '2026-08-29T10:00:03Z';
    fs.writeFileSync(transcript, `${rows.map(JSON.stringify).join('\n')}\n`);
    importClaudeTranscripts(store);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 2);
    assert.equal(store.db.prepare("SELECT output_tokens FROM usage_events WHERE model = 'claude-opus-5'").get().output_tokens, 20);
  } finally {
    store.close();
    process.env.USERPROFILE = oldProfile;
  }
});

test('status-line snapshots collect quotas without duplicating token costs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-status-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const inbox = path.join(root, 'inbox.jsonl');
  const payload = {
    ai_usage_captured_at: '2026-08-29T10:00:00Z',
    session_id: 'session-test', model: { id: 'claude-opus-5' },
    context_window: { current_usage: { input_tokens: 5, output_tokens: 7 } },
    rate_limits: {
      five_hour: { used_percentage: 12, resets_at: 1788010000 },
      seven_day: { used_percentage: 34, resets_at: 1788500000 },
    },
  };
  fs.writeFileSync(inbox, `${JSON.stringify(payload)}\n${JSON.stringify(payload)}\n`);
  try {
    const result = importClaudeInbox(store, inbox);
    assert.equal(result.usageEvents, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 0);
    assert.equal(store.getQuota('claude').remainingPercent, 66);
    assert.equal(store.getQuota('claude').planType, null);
    assert.equal(importClaudeInbox(store, inbox).snapshots, 0);
    const nextPayload = { ...payload, ai_usage_captured_at: '2026-08-29T10:05:00Z', rate_limits: { ...payload.rate_limits, seven_day: { used_percentage: 35, resets_at: '2026-09-04T12:30:00Z' } } };
    fs.appendFileSync(inbox, `${JSON.stringify(nextPayload)}\n`);
    const incremental = importClaudeInbox(store, inbox);
    assert.equal(incremental.snapshots, 1);
    assert.equal(incremental.observations, 2);
    assert.equal(store.getQuota('claude').remainingPercent, 65);
  } finally {
    store.close();
  }
});

test('status-line snapshots skip invalid reset dates instead of recording 1970', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-invalid-reset-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const inbox = path.join(root, 'inbox.jsonl');
  fs.writeFileSync(inbox, `${JSON.stringify({
    ai_usage_captured_at: '2026-08-29T10:00:00Z',
    rate_limits: { seven_day: { used_percentage: 30, resets_at: 0 } },
  })}\n`);
  try {
    const result = importClaudeInbox(store, inbox);
    assert.equal(result.observations, 0);
    assert.equal(result.invalidResets, 1);
    assert.equal(store.getQuota('claude'), null);
  } finally {
    store.close();
  }
});

test('one rejected status-line limit cannot poison later limits or the durable cursor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-rejected-status-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const inbox = path.join(root, 'inbox.jsonl');
  fs.writeFileSync(inbox, `${JSON.stringify({
    ai_usage_captured_at: '2026-08-29T10:00:00Z',
    rate_limits: {
      broken: { used_percentage: 140, resets_at: '2026-09-04T12:00:00Z' },
      seven_day: { used_percentage: 30, resets_at: '2026-09-04T12:00:00Z' },
    },
  })}\n`);
  try {
    const first = importClaudeInbox(store, inbox);
    assert.equal(first.rejectedRecords, 1);
    assert.equal(first.observations, 1);
    assert.equal(store.getQuota('claude').usedPercent, 30);
    assert.equal(importClaudeInbox(store, inbox).snapshots, 0);
  } finally { store.close(); }
});

test('status-line importer accepts a Windows UTF-8 BOM on the first record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-bom-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const inbox = path.join(root, 'inbox.jsonl');
  const payload = { ai_usage_captured_at: '2026-08-29T10:00:00Z', rate_limits: { seven_day: { used_percentage: 22, resets_at: '2026-09-04T12:00:00Z' } } };
  fs.writeFileSync(inbox, `\uFEFF${JSON.stringify(payload)}\n`, 'utf8');
  try {
    const result = importClaudeInbox(store, inbox);
    assert.equal(result.snapshots, 1);
    assert.equal(store.getQuota('claude').usedPercent, 22);
  } finally { store.close(); }
});

test('status-line importer preserves a partial trailing record for the next refresh', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-partial-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const inbox = path.join(root, 'inbox.jsonl');
  const first = JSON.stringify({ ai_usage_captured_at: '2026-08-29T10:00:00Z', rate_limits: { seven_day: { used_percentage: 20, resets_at: '2026-09-04T12:00:00Z' } } });
  const second = JSON.stringify({ ai_usage_captured_at: '2026-08-29T10:05:00Z', rate_limits: { seven_day: { used_percentage: 35, resets_at: '2026-09-04T12:00:00Z' } } });
  const split = Math.floor(second.length / 2);
  fs.writeFileSync(inbox, `${first}\n${second.slice(0, split)}`, 'utf8');
  try {
    assert.equal(importClaudeInbox(store, inbox).snapshots, 1);
    fs.appendFileSync(inbox, `${second.slice(split)}\n`, 'utf8');
    assert.equal(importClaudeInbox(store, inbox).snapshots, 1);
    assert.equal(store.getQuota('claude').usedPercent, 35);
  } finally { store.close(); }
});

test('status-line rotation imports the stable old file before the new active inbox', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-rotation-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const inbox = path.join(root, 'inbox.jsonl');
  const rotated = `${inbox}.rotated-202608291000000000-1`;
  const row = (time, used) => JSON.stringify({ ai_usage_captured_at: time, rate_limits: { seven_day: { used_percentage: used, resets_at: '2026-09-04T12:00:00Z' } } });
  fs.writeFileSync(rotated, `${row('2026-08-29T10:00:00Z', 20)}\n`, 'utf8');
  fs.writeFileSync(inbox, `${row('2026-08-29T10:05:00Z', 25)}\n`, 'utf8');
  try {
    const result = importClaudeInbox(store, inbox);
    assert.equal(result.snapshots, 2);
    assert.equal(store.getQuota('claude').usedPercent, 25);
    assert.equal(fs.existsSync(rotated), false);
    assert.equal(importClaudeInbox(store, inbox).snapshots, 0);
  } finally { store.close(); }
});

test('a rotation between imports restarts the live inbox even once it outgrows the old cursor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-rotation-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const inbox = path.join(root, 'inbox.jsonl');
  const at = (minute) => new Date(Date.parse('2026-08-29T10:00:00Z') + minute * 60_000).toISOString();
  const row = (minute) => JSON.stringify({ ai_usage_captured_at: at(minute), rate_limits: { seven_day: { used_percentage: 20 + minute / 10, resets_at: '2026-09-04T12:00:00Z' } } });
  const lines = (from, to) => Array.from({ length: to - from }, (_, index) => `${row(from + index)}\n`).join('');
  try {
    fs.writeFileSync(inbox, lines(0, 3), 'utf8');
    assert.equal(importClaudeInbox(store, inbox).observations, 3);
    // Before the next import the helper appends, rotates, and writes more to
    // a new inbox than the old cursor covered.
    fs.appendFileSync(inbox, lines(3, 5), 'utf8');
    fs.renameSync(inbox, `${inbox}.rotated-202608291005000000-1`);
    fs.writeFileSync(inbox, lines(5, 12), 'utf8');
    const result = importClaudeInbox(store, inbox);
    assert.equal(result.invalidRecords, 0, 'no record is read from the middle');
    const stored = store.db.prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE source_id = 'claude'").get().count;
    assert.equal(stored, 12, 'every reading of both files is kept');
    assert.equal(importClaudeInbox(store, inbox).snapshots, 0, 'the restarted inbox keeps an ordinary cursor afterwards');
  } finally { store.close(); }
});

test('a refresh between a rotation and the new inbox still restarts that inbox', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-rotation-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const inbox = path.join(root, 'inbox.jsonl');
  const at = (minute) => new Date(Date.parse('2026-08-29T10:00:00Z') + minute * 60_000).toISOString();
  const row = (minute) => JSON.stringify({ ai_usage_captured_at: at(minute), rate_limits: { seven_day: { used_percentage: 20 + minute / 10, resets_at: '2026-09-04T12:00:00Z' } } });
  const lines = (from, to) => Array.from({ length: to - from }, (_, index) => `${row(from + index)}\n`).join('');
  try {
    fs.writeFileSync(inbox, lines(0, 3), 'utf8');
    importClaudeInbox(store, inbox);
    // The helper has moved the old inbox but not yet written the new one.
    fs.renameSync(inbox, `${inbox}.rotated-202608291005000000-1`);
    importClaudeInbox(store, inbox);
    fs.writeFileSync(inbox, lines(3, 10), 'utf8');
    assert.equal(importClaudeInbox(store, inbox).invalidRecords, 0, 'no record is read from the middle');
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE source_id = 'claude'").get().count, 10);
  } finally { store.close(); }
});

test('a rotated file that keeps failing to import restarts the live inbox once, not every refresh', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-rotation-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const inbox = path.join(root, 'inbox.jsonl');
  const row = (minute) => JSON.stringify({ ai_usage_captured_at: new Date(Date.parse('2026-08-29T10:00:00Z') + minute * 60_000).toISOString(),
    rate_limits: { seven_day: { used_percentage: 20, resets_at: '2026-09-04T12:00:00Z' } } });
  try {
    // Unreadable as a file on every platform, so its import fails each time.
    fs.mkdirSync(`${inbox}.rotated-202608291005000000-1`);
    fs.writeFileSync(inbox, `${row(0)}\n${row(1)}\n`, 'utf8');
    const first = importClaudeInbox(store, inbox);
    assert.equal(first.readErrors, 1);
    assert.ok(first.bytesRead > 0);
    const second = importClaudeInbox(store, inbox);
    assert.equal(second.readErrors, 1);
    assert.equal(second.bytesRead, 0, 'the unchanged live inbox is not read again');
  } finally { store.close(); }
});

test('the helper doubles every PowerShell single-quote character in its inbox path', () => {
  const helper = makeHelperScript("C:\\Users\\O\u2019Brien\\AppData\\Roaming\\ai-usage\\Bob's inbox.jsonl");
  assert.ok(helper.includes("$target = 'C:\\Users\\O\u2019\u2019Brien\\AppData\\Roaming\\ai-usage\\Bob''s inbox.jsonl'"));
});

test('generated helper writes BOM-free UTF-8 and rotates before appending', () => {
  const helper = makeHelperScript('C:\\Temp\\ai-usage\\inbox.jsonl');
  assert.match(helper, /AI_USAGE_HELPER_VERSION=1\.0\.4/);
  assert.match(helper, /Move-Item/);
  assert.match(helper, /UTF8Encoding\(\$false\)/);
  assert.match(helper, /AppendAllText/);
  assert.doesNotMatch(helper, /Add-Content/);
  assert.match(helper, /\$safe\s*=\s*\[ordered\]@\{/);
  assert.match(helper, /\$line\s*=\s*\$safe\s*\|\s*ConvertTo-Json/);
  assert.doesNotMatch(helper, /\$line\s*=\s*\$data\s*\|\s*ConvertTo-Json/);
  assert.doesNotMatch(helper, /session_id|transcript_path|workspace|cwd/i);
});

test('distinct Fable allowance windows do not overwrite one another', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-fable-windows-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const inbox = path.join(root, 'inbox.jsonl');
  const payload = { ai_usage_captured_at: '2026-08-29T10:00:00Z', rate_limits: {
    fable_seven_day: { used_percentage: 22, resets_at: '2026-09-04T12:00:00Z' },
    fable_five_hour: { used_percentage: 44, resets_at: '2026-08-29T14:00:00Z' },
  } };
  fs.writeFileSync(inbox, `${JSON.stringify(payload)}\n`, 'utf8');
  try {
    assert.equal(importClaudeInbox(store, inbox).observations, 2);
    assert.equal(store.getQuota('claude-fable').windows.length, 2);
  } finally { store.close(); }
});

test('persisted Claude allowance becomes stale when a failed refresh adds no evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-persisted-quota-'));
  const previous = { USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.USERPROFILE = root;
  process.env.APPDATA = root;
  process.env.LOCALAPPDATA = root;
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try {
    store.recordObservation({
      sourceId: 'claude', bucketId: 'seven_day', observedAt: new Date().toISOString(),
      usedPercent: 25, resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      windowMinutes: 10_080, provenance: 'official-statusline',
    });
    store.setSourceStatus('claude', 'connected', 'Seed success.');
    const before = store.db.prepare("SELECT last_success_at FROM sources WHERE id = 'claude'").get().last_success_at;
    const inbox = path.join(root, 'missing-inbox.jsonl');
    // Updated deliberately: plan usage is read only on an explicit user refresh now,
    // so this SDK-path test asks for one (readPlanUsage: true).
    await refreshClaude(store, inbox, { readPlanUsage: true, usagePort: { read: async () => { throw new Error('provider down'); } } });
    const source = store.db.prepare("SELECT status, last_success_at, last_attempt_at FROM sources WHERE id = 'claude'").get();
    assert.equal(source.status, 'stale');
    assert.equal(source.last_success_at, before);
    assert.notEqual(source.last_attempt_at, null);
  } finally {
    store.close();
    process.env.USERPROFILE = previous.USERPROFILE;
    process.env.APPDATA = previous.APPDATA;
    process.env.LOCALAPPDATA = previous.LOCALAPPDATA;
  }
});

test('schema-invalid provider data does not advance Claude last-success time', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-invalid-provider-'));
  const previous = { USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.USERPROFILE = root;
  process.env.APPDATA = root;
  process.env.LOCALAPPDATA = root;
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const reset = new Date(Date.now() + 4 * 86_400_000).toISOString();
  try {
    store.recordObservation({
      sourceId: 'claude', bucketId: 'seven_day', observedAt: new Date().toISOString(),
      usedPercent: 25, resetsAt: reset, windowMinutes: 10_080, provenance: 'official-statusline',
    });
    store.setSourceStatus('claude', 'connected', 'Seed success.');
    const seeded = '2026-01-15T12:00:00.000Z';
    store.db.prepare("UPDATE sources SET last_success_at = ? WHERE id = 'claude'").run(seeded);

    // Updated deliberately: plan usage is read only on an explicit user refresh now,
    // so this SDK-path test asks for one (readPlanUsage: true).
    await refreshClaude(store, path.join(root, 'missing-inbox.jsonl'), {
      readPlanUsage: true,
      activityReader: { import: async () => ({ filesFound: 0, usageEvents: 0, fableEvents: 0 }) },
      usagePort: { read: async () => ({
        subscription_type: 'max', rate_limits_available: true,
        rate_limits: { model_scoped: [{ display_name: 'Fable', utilization: 1_000, resets_at: reset }] },
      }) },
    });

    const source = store.db.prepare("SELECT status, last_success_at, last_attempt_at FROM sources WHERE id = 'claude'").get();
    assert.equal(source.status, 'stale');
    assert.equal(source.last_success_at, seeded);
    assert.notEqual(source.last_attempt_at, seeded);
  } finally {
    store.close();
    process.env.USERPROFILE = previous.USERPROFILE;
    process.env.APPDATA = previous.APPDATA;
    process.env.LOCALAPPDATA = previous.LOCALAPPDATA;
  }
});

test('Claude refresh records model-scoped Fable allowance automatically and imports actual local activity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-automatic-fable-'));
  const previous = { USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.USERPROFILE = root;
  process.env.APPDATA = root;
  process.env.LOCALAPPDATA = root;
  const project = path.join(root, '.claude', 'projects', 'automatic-fable');
  fs.mkdirSync(project, { recursive: true });
  const occurredAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(path.join(project, 'session.jsonl'), `${JSON.stringify(assistantRow({
    id: 'fable-automatic', uuid: 'fable-automatic', timestamp: occurredAt,
    model: 'claude-fable-5', input: 120, cacheRead: 30, cacheWrite: 10, output: 7,
  }))}\n`);
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const reset = new Date(Date.now() + 4 * 86_400_000).toISOString();
  try {
    // Updated deliberately: plan usage is read only on an explicit user refresh now,
    // so this SDK-path test asks for one (readPlanUsage: true).
    const result = await refreshClaude(store, path.join(root, 'missing-inbox.jsonl'), {
      readPlanUsage: true,
      usagePort: { read: async () => ({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          seven_day: { utilization: 31, resets_at: reset },
          model_scoped: [{ display_name: 'Fable', utilization: 63, resets_at: reset }],
          extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 25, utilization: 25, currency: 'USD' },
        },
      }) },
    });

    assert.equal(result.fableTracking.allowance.kind, 'official');
    assert.equal(store.getQuota('claude-fable').usedPercent, 63);
    assert.equal(store.getQuota('claude-fable').provenance, 'official-claude-usage');
    assert.equal(result.fableTracking.activity.requests, 1);
    assert.equal(result.fableTracking.activity.inputTokens, 120);
    const source = store.getDashboardSnapshot().sources.find((entry) => entry.id === 'claude-fable');
    assert.equal(source.status, 'connected');
    assert.match(source.status_detail, /official model-scoped/i);
    const claudeSource = store.getDashboardSnapshot().sources.find((entry) => entry.id === 'claude');
    assert.match(claudeSource.status_detail, /extra usage credits.*25.*100.*USD/i);
  } finally {
    store.close();
    process.env.USERPROFILE = previous.USERPROFILE;
    process.env.APPDATA = previous.APPDATA;
    process.env.LOCALAPPDATA = previous.LOCALAPPDATA;
  }
});

test('a current Fable allowance cannot hide a failed local activity import', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-fable-activity-failure-'));
  const previous = { USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.USERPROFILE = root;
  process.env.APPDATA = root;
  process.env.LOCALAPPDATA = root;
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const reset = new Date(Date.now() + 4 * 86_400_000).toISOString();
  try {
    // Updated deliberately: plan usage is read only on an explicit user refresh now,
    // so this SDK-path test asks for one (readPlanUsage: true).
    await refreshClaude(store, path.join(root, 'missing-inbox.jsonl'), {
      readPlanUsage: true,
      activityReader: { import: async () => { throw new Error('transcript scan failed'); } },
      usagePort: { read: async () => ({
        subscription_type: 'max', rate_limits_available: true,
        rate_limits: {
          seven_day: { utilization: 31, resets_at: reset },
          model_scoped: [{ display_name: 'Fable', utilization: 63, resets_at: reset }],
        },
      }) },
    });

    const sources = store.getDashboardSnapshot().sources;
    const fable = sources.find((entry) => entry.id === 'claude-fable');
    const claude = sources.find((entry) => entry.id === 'claude');
    assert.equal(fable.status, 'degraded');
    assert.match(fable.status_detail, /allowance.*current.*activity.*failed/i);
    assert.equal(fable.metadata.automatic.health.activitySource, 'temporarily-unavailable');
    assert.equal(claude.status, 'degraded');
    assert.match(claude.status_detail, /transcript.*failed/i);
  } finally {
    store.close();
    process.env.USERPROFILE = previous.USERPROFILE;
    process.env.APPDATA = previous.APPDATA;
    process.env.LOCALAPPDATA = previous.LOCALAPPDATA;
  }
});

test('helper installation preserves prior status line outside Claude settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-helper-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const claude = path.join(root, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'old-status.cmd' },
    aiUsagePreviousStatusLine: { type: 'command', command: 'invalid-custom-key' },
}));

  try {
    const result = installClaudeHelper(path.join(root, 'inbox.jsonl'));
    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    // Windows PowerShell 5.1 reads a script without a byte-order mark as ANSI.
    assert.deepEqual([...fs.readFileSync(path.join(claude, 'ai-usage-statusline.ps1')).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(settings.aiUsagePreviousStatusLine, undefined);
    assert.match(settings.statusLine.command, /ai-usage-statusline\.ps1/);
    assert.equal(result.previousStatusLinePreserved, true);
    assert.equal(result.restartRequired, true);
  } finally {
    process.env.USERPROFILE = oldProfile;
  }
});

test('fresh status-line Fable evidence stays current when the SDK is unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-fresh-fallback-'));
  const previous = { USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.USERPROFILE = root;
  process.env.APPDATA = root;
  process.env.LOCALAPPDATA = root;
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const inbox = path.join(root, 'inbox.jsonl');
  const reset = new Date(Date.now() + 4 * 86_400_000).toISOString();
  fs.writeFileSync(inbox, `${JSON.stringify({
    ai_usage_captured_at: new Date().toISOString(),
    rate_limits: {
      seven_day: { used_percentage: 22, resets_at: reset },
      fable_seven_day: { used_percentage: 44, resets_at: reset },
    },
  })}\n`);
  try {
    // Updated deliberately: plan usage is read only on an explicit user refresh now,
    // so this SDK-path test asks for one (readPlanUsage: true).
    await refreshClaude(store, inbox, { readPlanUsage: true, usagePort: { read: async () => { throw new Error('provider down'); } } });
    assert.equal(store.db.prepare("SELECT status FROM sources WHERE id = 'claude'").get().status, 'connected');
    assert.equal(store.db.prepare("SELECT status FROM sources WHERE id = 'claude-fable'").get().status, 'connected');
  } finally {
    store.close();
    process.env.USERPROFILE = previous.USERPROFILE;
    process.env.APPDATA = previous.APPDATA;
    process.env.LOCALAPPDATA = previous.LOCALAPPDATA;
  }
});

test('a rejected fallback row cannot prevent exact SDK Fable collection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-poison-fallback-'));
  const previous = { USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.USERPROFILE = root;
  process.env.APPDATA = root;
  process.env.LOCALAPPDATA = root;
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const inbox = path.join(root, 'inbox.jsonl');
  const reset = new Date(Date.now() + 4 * 86_400_000).toISOString();
  fs.writeFileSync(inbox, `${JSON.stringify({
    ai_usage_captured_at: new Date().toISOString(),
    rate_limits: { seven_day: { used_percentage: 140, resets_at: reset } },
  })}\n`);
  try {
    // Updated deliberately: plan usage is read only on an explicit user refresh now,
    // so this SDK-path test asks for one (readPlanUsage: true).
    const result = await refreshClaude(store, inbox, { readPlanUsage: true, usagePort: { read: async () => ({
      subscription_type: 'pro', rate_limits_available: true,
      rate_limits: { model_scoped: [{ display_name: 'Fable', utilization: 33, resets_at: reset }] },
    }) } });
    assert.equal(result.statusLine.rejectedRecords, 1);
    assert.equal(result.fableTracking.allowance.kind, 'official');
    assert.equal(store.getQuota('claude-fable').usedPercent, 33);
  } finally {
    store.close();
    process.env.USERPROFILE = previous.USERPROFILE;
    process.env.APPDATA = previous.APPDATA;
    process.env.LOCALAPPDATA = previous.LOCALAPPDATA;
  }
});

test('disabling the helper hands the previous status line back', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-uninstall-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const claude = path.join(root, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const settingsPath = path.join(claude, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: 'old-status.cmd' } }));
  try {
    const installed = installClaudeHelper(path.join(root, 'inbox.jsonl'));
    assert.equal(isClaudeHelperInstalled(), true);
    assert.equal(fs.existsSync(installed.helperPath), true);
    const result = uninstallClaudeHelper();
    assert.equal(result.managed, true);
    assert.equal(result.restoredPreviousStatusLine, true);
    assert.equal(result.statusLineRemoved, false);
    assert.equal(fs.existsSync(result.helperPath), false);
    assert.equal(fs.existsSync(path.join(claude, 'ai-usage-previous-statusline.json')), false);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(settings.statusLine, { type: 'command', command: 'old-status.cmd' });
    assert.equal(settings.model, 'opus');
    assert.equal(isClaudeHelperInstalled(), false);
    // A leftover locked script does not mean the helper remains enabled.
    fs.writeFileSync(installed.helperPath, 'leftover script');
    assert.equal(isClaudeHelperInstalled(), false);
  } finally {
    process.env.USERPROFILE = oldProfile;
  }
});

test('a different status-line script with the same filename is preserved as user-owned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-helper-ownership-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const claude = path.join(root, '.claude');
  const settingsPath = path.join(claude, 'settings.json');
  const customHelper = path.join(root, 'custom-tools', 'ai-usage-statusline.ps1');
  const customStatusLine = {
    type: 'command',
    command: `powershell.exe -NoProfile -File "${customHelper}"`,
  };
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: customStatusLine }));
  try {
    const installed = installClaudeHelper(path.join(root, 'inbox.jsonl'));
    assert.equal(installed.previousStatusLinePreserved, true);
    const result = uninstallClaudeHelper();
    assert.equal(result.managed, true);
    assert.equal(result.restoredPreviousStatusLine, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine, customStatusLine);
  } finally {
    process.env.USERPROFILE = oldProfile;
  }
});

test('disabling the helper removes a status line it introduced and leaves one it did not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-uninstall-none-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const settingsPath = path.join(root, '.claude', 'settings.json');
  try {
    installClaudeHelper(path.join(root, 'inbox.jsonl'));
    assert.equal(uninstallClaudeHelper().statusLineRemoved, true);
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine, undefined);

    // A status line the user has since pointed elsewhere is not ours to touch.
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'someone-elses.cmd' } }));
    const result = uninstallClaudeHelper();
    assert.equal(result.managed, false);
    assert.equal(result.restoredPreviousStatusLine, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine, { type: 'command', command: 'someone-elses.cmd' });
  } finally {
    process.env.USERPROFILE = oldProfile;
  }
});

test('re-enabling the helper does not leave a second copy of an unchanged settings file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-backup-litter-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const claude = path.join(root, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'old-status.cmd' } }));
  const backups = () => fs.readdirSync(claude).filter((name) => name.includes('.ai-usage-backup-'));
  try {
    installClaudeHelper(path.join(root, 'inbox.jsonl'));
    assert.equal(backups().length, 1);
    installClaudeHelper(path.join(root, 'inbox.jsonl'));
    installClaudeHelper(path.join(root, 'inbox.jsonl'));
    // The second and third runs back up an identical, already-copied file.
    assert.equal(backups().length, 2);
  } finally {
    process.env.USERPROFILE = oldProfile;
  }
});

test('a status line this app did not install is left alone, script included', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-unmanaged-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const settingsPath = path.join(root, '.claude', 'settings.json');
  try {
    const installed = installClaudeHelper(path.join(root, 'inbox.jsonl'));
    // The user repoints Claude at their own status line by hand.
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'someone-elses.cmd' } }));
    const result = uninstallClaudeHelper();
    assert.equal(result.managed, false);
    assert.equal(result.helperScriptRemoved, false);
    assert.equal(fs.existsSync(installed.helperPath), true, 'another scope may still invoke the script');
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine, { type: 'command', command: 'someone-elses.cmd' });
  } finally {
    process.env.USERPROFILE = oldProfile;
  }
});

test('a UTF-8 BOM in Claude settings does not make the helper unremovable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-bom-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const claude = path.join(root, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const settingsPath = path.join(claude, 'settings.json');
  fs.writeFileSync(settingsPath, `﻿${JSON.stringify({ statusLine: { type: 'command', command: 'old-status.cmd' } })}`, 'utf8');
  try {
    const installed = installClaudeHelper(path.join(root, 'inbox.jsonl'));
    assert.match(JSON.parse(fs.readFileSync(installed.settingsPath, 'utf8')).statusLine.command, /ai-usage-statusline\.ps1/);
    const result = uninstallClaudeHelper();
    assert.equal(result.restoredPreviousStatusLine, true);
    assert.equal(result.helperScriptRemoved, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine, { type: 'command', command: 'old-status.cmd' });
  } finally {
    process.env.USERPROFILE = oldProfile;
  }
});

test('an unreadable Claude settings file is reported, never overwritten', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-broken-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const claude = path.join(root, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const settingsPath = path.join(claude, 'settings.json');
  const broken = '{ "statusLine": { "command": "mine.cmd" ';
  fs.writeFileSync(settingsPath, broken, 'utf8');
  try {
    assert.throws(() => installClaudeHelper(path.join(root, 'inbox.jsonl')), /settings file could not be read/);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), broken);
  } finally {
    process.env.USERPROFILE = oldProfile;
  }
});

test('re-enabling the helper discards a preserved status line the user has since deleted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-stale-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const claude = path.join(root, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const settingsPath = path.join(claude, 'settings.json');
  const inbox = path.join(root, 'inbox.jsonl');
  fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'old-status.cmd' } }));
  try {
    installClaudeHelper(inbox);
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }));
    uninstallClaudeHelper();
    installClaudeHelper(inbox);
    const result = uninstallClaudeHelper();
    assert.equal(result.restoredPreviousStatusLine, false);
    assert.equal(result.statusLineRemoved, true);
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine, undefined);
  } finally {
    process.env.USERPROFILE = oldProfile;
  }
});

test('the settings backup is byte-exact, not a UTF-8 round trip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-bytes-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const claude = path.join(root, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const settingsPath = path.join(claude, 'settings.json');
  // A settings file saved in a legacy Windows code page: 0xE9 is not valid
  // UTF-8, so decoding it would replace the byte and lose the original.
  const original = Buffer.concat([Buffer.from('{"note":"caf'), Buffer.from([0xe9]), Buffer.from('","statusLine":{"command":"mine.cmd"}}')]);
  fs.writeFileSync(settingsPath, original);
  try {
    assert.throws(() => installClaudeHelper(path.join(root, 'inbox.jsonl')), /settings file could not be read/);
    const backups = fs.readdirSync(claude).filter((name) => name.includes('.ai-usage-backup-'));
    assert.equal(backups.length, 1);
    assert.ok(fs.readFileSync(path.join(claude, backups[0])).equals(original), 'backup must keep the original bytes');
  } finally {
    process.env.USERPROFILE = oldProfile;
  }
});

test('bundled Claude Code executable is detected when it is not on PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-binary-'));
  const previous = { USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, PATH: process.env.PATH };
  process.env.APPDATA = root;
  // The premise is "not on PATH": empty PATH so a machine with a real Claude
  // install (or even where.exe itself) cannot satisfy the lookup first, and
  // an empty profile so a real native install under ~/.local/bin cannot either.
  process.env.PATH = '';
  process.env.USERPROFILE = path.join(root, 'empty-profile');
  const older = path.join(root, 'Claude', 'claude-code', '2.1.9');
  const newer = path.join(root, 'Claude', 'claude-code', '2.1.10');
  fs.mkdirSync(older, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(older, 'claude.exe'), '');
  fs.writeFileSync(path.join(newer, 'claude.exe'), '');
  try {
    assert.equal(findClaudeBinary(), path.join(newer, 'claude.exe'));
  } finally {
    process.env.USERPROFILE = previous.USERPROFILE;
    process.env.APPDATA = previous.APPDATA;
    process.env.PATH = previous.PATH;
  }
});

test('Claude Desktop is never mistaken for a Claude Code executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-desktop-binary-'));
  const previous = { USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, PATH: process.env.PATH };
  process.env.USERPROFILE = path.join(root, 'empty-profile');
  process.env.APPDATA = path.join(root, 'empty-appdata');
  process.env.LOCALAPPDATA = root;
  process.env.PATH = '';
  const desktop = path.join(root, 'AnthropicClaude', 'app-1.2.3');
  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(path.join(desktop, 'claude.exe'), 'desktop gui');
  try {
    assert.equal(findClaudeBinary(), null);
  } finally {
    process.env.USERPROFILE = previous.USERPROFILE;
    process.env.APPDATA = previous.APPDATA;
    process.env.LOCALAPPDATA = previous.LOCALAPPDATA;
    process.env.PATH = previous.PATH;
  }
});

test('one malformed transcript message is rejected without stopping the file or freezing its cursor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-claude-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const project = path.join(root, '.claude', 'projects', 'test-project');
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, 'session.jsonl');
  const broken = assistantRow({ id: 'message-2', uuid: 'broken', timestamp: '2026-08-29T10:01:00Z', model: 'claude-opus-5', input: 2, output: 2 });
  broken.message.usage.output_tokens_details = { reasoning_tokens: 50 };
  const rows = [
    assistantRow({ id: 'message-1', uuid: 'first', timestamp: '2026-08-29T10:00:00Z', model: 'claude-opus-5', input: 2, output: 4 }),
    broken,
    assistantRow({ id: 'message-3', uuid: 'third', timestamp: '2026-08-29T10:02:00Z', model: 'claude-opus-5', input: 2, output: 6 }),
  ];
  fs.writeFileSync(transcript, `${rows.map(JSON.stringify).join('\n')}\n`);
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try {
    const first = importClaudeTranscripts(store);
    assert.equal(first.usageEvents, 2);
    assert.equal(first.rejectedRows, 1);
    assert.match(first.lastRejection, /reasoning/i);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 2);
    const again = importClaudeTranscripts(store);
    assert.equal(again.usageEvents, 0, 'the cursor advanced past the bad row');
    assert.equal(again.rejectedRows, 0);
  } finally {
    store.close();
    process.env.USERPROFILE = oldProfile;
  }
});

test('CLAUDE_CONFIG_DIR relocates the status-line helper with the settings Claude Code reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-claude-helper-home-'));
  const previous = { USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const profile = path.join(root, 'profile');
  const home = path.join(root, 'relocated-claude');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const original = { type: 'command', command: 'own-status.cmd' };
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ statusLine: original }));
  try {
    process.env.USERPROFILE = profile;
    process.env.CLAUDE_CONFIG_DIR = home;
    const installed = installClaudeHelper(path.join(root, 'inbox.jsonl'));
    assert.equal(installed.settingsPath, path.join(home, 'settings.json'));
    assert.equal(path.dirname(installed.helperPath), home);
    const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    assert.match(settings.statusLine.command, /ai-usage-statusline\.ps1/, 'the settings Claude Code reads now invoke the helper');
    assert.equal(fs.existsSync(path.join(profile, '.claude')), false, 'the unused profile folder is left alone');
    assert.equal(isClaudeHelperInstalled(), true);
    const removed = uninstallClaudeHelper();
    assert.equal(removed.restoredPreviousStatusLine, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).statusLine, original);
    assert.equal(isClaudeHelperInstalled(), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('CLAUDE_CONFIG_DIR relocates the transcript scan', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-claude-home-'));
  const previous = { USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const home = path.join(root, 'relocated-claude');
  const project = path.join(home, 'projects', 'test-project');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(project, 'session.jsonl'), `${JSON.stringify(assistantRow({
    id: 'message-9', uuid: 'final', timestamp: '2026-08-29T10:00:02Z', model: 'claude-opus-5', input: 2, cacheRead: 100, cacheWrite: 10, output: 12,
  }))}\n`);
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try {
    process.env.USERPROFILE = path.join(root, 'profile');
    process.env.CLAUDE_CONFIG_DIR = home;
    const result = importClaudeTranscripts(store);
    assert.equal(result.usageEvents, 1);
    assert.equal(result.readErrors, 0);
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.USERPROFILE;
    assert.equal(importClaudeTranscripts(store).filesFound, 0);
  } finally {
    store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
