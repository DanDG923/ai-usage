'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');
const { createFableUsageTracker } = require('../electron/fable-tracker.cjs');
// Timing and error-code fields vary run to run; the contract is the rest.
function providerSummary(provider) {
  const { durationMs, errorCode, ...rest } = provider;
  assert.ok(Number.isFinite(durationMs) && durationMs >= 0);
  assert.ok(errorCode === null || typeof errorCode === 'string');
  return rest;
}

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-fable-tracker-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  return Promise.resolve(run(store)).finally(() => store.close());
}

const NOW = '2026-08-30T18:00:00.000Z';
const RESET = '2026-09-03T08:00:00.000Z';

function usagePayload(overrides = {}) {
  return {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 18, resets_at: '2026-08-30T20:00:00.000Z' },
      seven_day: { utilization: 31, resets_at: RESET },
      seven_day_oauth_apps: { utilization: 22, resets_at: RESET },
      seven_day_opus: { utilization: 44, resets_at: RESET },
      seven_day_sonnet: { utilization: 11, resets_at: RESET },
      model_scoped: [
        { display_name: 'Fable', utilization: 63, resets_at: RESET },
        { display_name: 'Research model', utilization: 27, resets_at: RESET },
      ],
      extra_usage: {
        is_enabled: true,
        monthly_limit: 250,
        used_credits: 99,
        utilization: 39.6,
        currency: 'USD',
        credential_material: 'fixture-secret-that-must-not-escape',
      },
    },
    ...overrides,
  };
}

test('one refresh records the server-supplied Fable window as official without manual input', async () => withStore(async (store) => {
  const tracker = createFableUsageTracker({
    store,
    clock: () => new Date(NOW),
    activityReader: { import: async () => ({ filesFound: 0, usageEvents: 0, fableEvents: 0 }) },
    usagePort: { read: async () => usagePayload() },
  });

  const result = await tracker.refresh();

  assert.equal(result.allowance.kind, 'official');
  assert.equal(result.allowance.usedPercent, 63);
  assert.equal(result.allowance.remainingPercent, 37);
  assert.equal(result.allowance.resetsAt, RESET);
  assert.equal(result.allowance.source, 'claude-usage-model-scoped');
  assert.equal(result.health.officialSource, 'connected');
  assert.equal(store.getQuota('claude-fable').provenance, 'official-claude-usage');
  const claudeWindows = store.getQuota('claude').windows;
  assert.deepEqual(claudeWindows.map((window) => window.bucketId).sort(), [
    'five_hour',
    'model_scoped:research%20model',
    'seven_day',
    'seven_day_oauth_apps',
    'seven_day_opus',
    'seven_day_sonnet',
  ]);
  assert.deepEqual(providerSummary(result.provider), {
    attemptSucceeded: true,
    kind: 'observed',
    overallWindowsRecorded: 6,
    extraUsage: {
      isEnabled: true, monthlyLimit: 250, usedCredits: 99, utilization: 39.6, currency: 'USD',
    },
  });
  const byBucket = Object.fromEntries(claudeWindows.map((window) => [window.bucketId, window]));
  assert.equal(byBucket.five_hour.usedPercent, 18);
  assert.equal(byBucket.seven_day.usedPercent, 31);
  assert.equal(byBucket.seven_day_oauth_apps.usedPercent, 22);
  assert.equal(byBucket.seven_day_opus.usedPercent, 44);
  assert.equal(byBucket.seven_day_sonnet.usedPercent, 11);
  assert.equal(byBucket['model_scoped:research%20model'].usedPercent, 27);
  assert.equal(byBucket['model_scoped:research%20model'].metadata.displayName, 'Research model');
  assert.equal(claudeWindows.every((window) => window.metadata.extraUsage?.currency === 'USD'), true);
  const fableQuota = store.getQuota('claude-fable');
  assert.deepEqual(fableQuota.metadata.extraUsage, result.provider.extraUsage);
  assert.equal(JSON.stringify({ result, claudeWindows, fable: fableQuota }).includes('fixture-secret'), false);
}));

test('a zero-percent official Fable window is valid evidence, not a missing value', async () => withStore(async (store) => {
  const payload = usagePayload();
  payload.rate_limits.model_scoped[0].utilization = 0;
  const tracker = createFableUsageTracker({
    store,
    clock: () => new Date(NOW),
    activityReader: { import: async () => ({ filesFound: 0, usageEvents: 0, fableEvents: 0 }) },
    usagePort: { read: async () => payload },
  });

  const result = await tracker.refresh();
  assert.equal(result.allowance.kind, 'official');
  assert.equal(result.allowance.usedPercent, 0);
  assert.equal(result.allowance.remainingPercent, 100);
}));

test('actual local Fable activity remains available when the provider window is absent', async () => withStore(async (store) => {
  store.recordUsageEvent({
    eventKey: 'local-fable', sourceId: 'claude', occurredAt: '2026-08-30T17:00:00.000Z',
    model: 'claude-fable-5', inputTokens: 120, cachedInputTokens: 30,
    cacheWrite5mInputTokens: 10, outputTokens: 7,
  });
  const tracker = createFableUsageTracker({
    store,
    clock: () => new Date(NOW),
    activityReader: { import: async () => ({ filesFound: 1, usageEvents: 1, fableEvents: 1 }) },
    usagePort: { read: async () => usagePayload({ rate_limits: null }) },
  });

  const result = await tracker.refresh();

  assert.equal(result.allowance.kind, 'unavailable');
  assert.equal(result.allowance.reason, 'plan-window-unavailable');
  assert.equal(result.activity.scope, 'this-device');
  assert.equal(result.activity.requests, 1);
  assert.equal(result.activity.inputTokens, 120);
  assert.equal(result.activity.cachedInputTokens, 30);
  assert.equal(result.activity.outputTokens, 7);
  assert.equal(result.health.activitySource, 'current');
  assert.deepEqual(providerSummary(result.provider), {
    attemptSucceeded: true, kind: 'unavailable', overallWindowsRecorded: 0, extraUsage: null,
  });
}));

test('an upstream failure retains the last unexpired official reading and marks it stale', async () => withStore(async (store) => {
  store.recordObservation({
    sourceId: 'claude-fable', bucketId: 'fable_seven_day', bucketName: 'Fable 5 weekly',
    observedAt: '2026-08-30T17:30:00.000Z', usedPercent: 52, resetsAt: RESET,
    windowMinutes: 10_080, planType: 'max', provenance: 'official-claude-usage',
  });
  const tracker = createFableUsageTracker({
    store,
    clock: () => new Date(NOW),
    activityReader: { import: async () => ({ filesFound: 0, usageEvents: 0, fableEvents: 0 }) },
    usagePort: { read: async () => { throw new Error('temporary upstream failure'); } },
  });

  const result = await tracker.refresh();

  assert.equal(result.allowance.kind, 'official');
  assert.equal(result.allowance.usedPercent, 52);
  assert.equal(result.health.state, 'stale');
  assert.equal(result.health.officialSource, 'temporarily-unavailable');
  assert.match(result.health.detail, /temporary upstream failure/i);
  assert.deepEqual(providerSummary(result.provider), {
    attemptSucceeded: false, kind: 'failed', overallWindowsRecorded: 0, extraUsage: null,
  });
}));

test('a fresh status-line fallback from this refresh is current even when the SDK provider fails', async () => withStore(async (store) => {
  const fallbackObservedAt = '2026-08-30T17:59:00.000Z';
  store.recordObservation({
    sourceId: 'claude-fable', bucketId: 'fable_seven_day', bucketName: 'Fable 5 weekly',
    observedAt: fallbackObservedAt, usedPercent: 47, resetsAt: RESET,
    windowMinutes: 10_080, planType: 'max', provenance: 'official-statusline',
  });
  const tracker = createFableUsageTracker({
    store,
    clock: () => new Date(NOW),
    activityReader: { import: async () => ({ filesFound: 0, usageEvents: 0, fableEvents: 0 }) },
    usagePort: { read: async () => { throw new Error('temporary upstream failure'); } },
  });

  const result = await tracker.refresh({ fallbackObservedAt });

  assert.equal(result.allowance.kind, 'official');
  assert.equal(result.allowance.usedPercent, 47);
  assert.equal(result.allowance.source, 'claude-statusline-model-scoped');
  assert.equal(result.health.state, 'current');
  assert.equal(result.health.officialSource, 'connected');
  assert.deepEqual(providerSummary(result.provider), {
    attemptSucceeded: false, kind: 'failed', overallWindowsRecorded: 0, extraUsage: null,
  });
}));

test('invalid provider schema fails closed instead of fabricating a Fable percentage', async () => withStore(async (store) => {
  const tracker = createFableUsageTracker({
    store,
    clock: () => new Date(NOW),
    activityReader: { import: async () => ({ filesFound: 0, usageEvents: 0, fableEvents: 0 }) },
    usagePort: { read: async () => usagePayload({ rate_limits: { model_scoped: [{ display_name: 'Fable', utilization: 1_000, resets_at: RESET }] } }) },
  });

  const result = await tracker.refresh();
  assert.equal(result.allowance.kind, 'unavailable');
  assert.equal(result.allowance.reason, 'invalid-provider-data');
  assert.equal(result.health.officialSource, 'unsupported');
  assert.equal(store.getQuota('claude-fable'), null);
  assert.deepEqual(providerSummary(result.provider), {
    attemptSucceeded: true, kind: 'invalid', overallWindowsRecorded: 0, extraUsage: null,
  });
}));

test('malformed extra usage fails closed before any provider windows are recorded', async () => withStore(async (store) => {
  const payload = usagePayload();
  payload.rate_limits.extra_usage.monthly_limit = -1;
  const tracker = createFableUsageTracker({
    store,
    clock: () => new Date(NOW),
    activityReader: { import: async () => ({ filesFound: 0, usageEvents: 0, fableEvents: 0 }) },
    usagePort: { read: async () => payload },
  });

  const result = await tracker.refresh();

  assert.equal(result.allowance.reason, 'invalid-provider-data');
  assert.equal(store.getQuota('claude'), null);
  assert.equal(store.getQuota('claude-fable'), null);
  assert.deepEqual(providerSummary(result.provider), {
    attemptSucceeded: true, kind: 'invalid', overallWindowsRecorded: 0, extraUsage: null,
  });
}));

test('a malformed non-Fable model-scoped window invalidates the provider slice', async () => withStore(async (store) => {
  const payload = usagePayload();
  payload.rate_limits.model_scoped[1].utilization = 101;
  const tracker = createFableUsageTracker({
    store,
    clock: () => new Date(NOW),
    activityReader: { import: async () => ({ filesFound: 0, usageEvents: 0, fableEvents: 0 }) },
    usagePort: { read: async () => payload },
  });

  const result = await tracker.refresh();

  assert.equal(result.allowance.reason, 'invalid-provider-data');
  assert.equal(store.getQuota('claude'), null);
  assert.equal(store.getQuota('claude-fable'), null);
  assert.deepEqual(providerSummary(result.provider), {
    attemptSucceeded: true, kind: 'invalid', overallWindowsRecorded: 0, extraUsage: null,
  });
}));
