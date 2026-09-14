'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-07T12:00:00Z');
const iso = (at) => new Date(at).toISOString();
const OFFICIAL = ['official', 'local-official', 'manual-official', 'official-claude-usage', 'official-statusline'];

function fixture(t) {
  const store = new UsageStore(':memory:', os.tmpdir());
  t.after(() => store.close());
  return store;
}

function observation(overrides = {}) {
  return { sourceId: 'claude-fable', bucketId: 'fable_seven_day', bucketName: 'Fable weekly',
    observedAt: iso(NOW), resetsAt: iso(NOW + 3 * 24 * HOUR), windowMinutes: 10_080,
    usedPercent: 80, remainingPercent: 20, planType: 'max', provenance: 'official', confidence: 1,
    metadata: { scope: 'model' }, ...overrides };
}

function latestRow(store) {
  return { ...store.db.prepare('SELECT * FROM quota_observations ORDER BY observed_at DESC LIMIT 1').get() };
}

test('a derived Fable estimate is projected, never stored, so it cannot displace a trusted observation', (t) => {
  const store = fixture(t);
  for (const provenance of OFFICIAL) {
    store.recordObservation(observation({ provenance }));
    const before = latestRow(store);
    assert.throws(() => store.recordObservation(observation({ usedPercent: 0, remainingPercent: 100, provenance: 'derived-tokens',
      planType: 'derived-plan', bucketName: 'Derived window', windowMinutes: 300,
      resetsAt: iso(NOW + HOUR), confidence: 0.4, metadata: { calibration: { method: 'overall-share' } } })),
    /projected, not stored/);
    assert.deepEqual(latestRow(store), before, provenance);
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE provenance = 'derived-tokens'").get().count, 0);
});
test('a trusted correction replaces provenance, plan and window together with its percentages', (t) => {
  const store = fixture(t);
  store.recordObservation(observation({ provenance: 'manual-official' }));
  const before = latestRow(store);
  const replacement = observation({ provenance: 'official-statusline', usedPercent: 25, remainingPercent: 75,
    planType: null, windowMinutes: 300, bucketName: 'Corrected window', resetsAt: iso(NOW + HOUR),
    confidence: 0.9, metadata: { scope: 'model', source: 'statusline' } });
  store.recordObservation(replacement);
  assert.deepEqual(latestRow(store), { ...before,
    bucket_name: replacement.bucketName, used_percent: 25, remaining_percent: 75,
    resets_at: replacement.resetsAt, window_minutes: 300, plan_type: null,
    provenance: 'official-statusline', confidence: 0.9, metadata_json: JSON.stringify(replacement.metadata) });
});
