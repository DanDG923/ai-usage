'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageStore } = require('../electron/store.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;

function openStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-quota-probe-'));
  return new UsageStore(':memory:', path.join(root, 'Backups'));
}

function record(store, sourceId, observedMs, resetMs, bucketId = 'seven_day') {
  store.recordObservation({
    sourceId, bucketId, observedAt: new Date(observedMs).toISOString(), usedPercent: 40,
    resetsAt: new Date(resetMs).toISOString(), windowMinutes: 10_080, provenance: 'official-statusline',
  });
}

test('the existence probe agrees with getQuota on whether a source has any usable reading', () => {
  const store = openStore();
  const now = Date.parse('2026-09-12T12:00:00Z');
  try {
    assert.equal(store.hasUsableObservation('claude', now), false);
    assert.equal(store.getQuota('claude', store.getSettings(), now), null);
    // An expired reading still counts as history, exactly as getQuota keeps
    // the latest dormant row so the card can say "expired".
    record(store, 'claude', now - 20 * DAY_MS, now - 13 * DAY_MS);
    assert.equal(store.hasUsableObservation('claude', now), true);
    assert.notEqual(store.getQuota('claude', store.getSettings(), now), null);
    // Asked about an instant before a reading was taken, neither answer may
    // count that reading: it lies in that instant's future.
    assert.equal(store.hasUsableObservation('claude-fable', now), false);
    record(store, 'claude-fable', now - DAY_MS, now + 5 * DAY_MS, 'fable_seven_day');
    const earlier = now - 2 * DAY_MS;
    assert.equal(store.hasUsableObservation('claude-fable', earlier), false);
    assert.equal(store.getQuota('claude-fable', store.getSettings(), earlier), null);
    assert.equal(store.hasUsableObservation('claude-fable', now), true);
  } finally {
    store.close();
  }
});

test('the freshness bound requires a running window observed within the bound', () => {
  const store = openStore();
  const now = Date.parse('2026-09-12T12:00:00Z');
  const fresh = { activeWithinMs: 8 * DAY_MS };
  try {
    // Expired only: history exists, but nothing is running.
    record(store, 'claude', now - 20 * DAY_MS, now - 13 * DAY_MS);
    assert.equal(store.hasUsableObservation('claude', now, fresh), false);
    // Still running, but the reading itself is older than the bound.
    record(store, 'claude', now - 9 * DAY_MS, now + 20 * DAY_MS, 'model_scoped_opus');
    assert.equal(store.hasUsableObservation('claude', now, fresh), false);
    // A recent reading whose window has already ended does not count either.
    record(store, 'claude', now - 2 * DAY_MS, now - DAY_MS, 'five_hour');
    assert.equal(store.hasUsableObservation('claude', now, fresh), false);
    // One recent, running reading is enough.
    record(store, 'claude', now - DAY_MS, now + 5 * DAY_MS);
    assert.equal(store.hasUsableObservation('claude', now, fresh), true);
  } finally {
    store.close();
  }
});

test('a corrected expired reset supersedes older active readings of the same bucket', () => {
  const store = openStore();
  const now = Date.parse('2026-09-12T12:00:00Z');
  const hour = 3_600_000;
  const fresh = { activeWithinMs: 8 * DAY_MS };
  try {
    record(store, 'claude', now - 4 * hour, now + hour);
    record(store, 'claude', now - 3 * hour, now - hour);
    const quota = store.getQuota('claude', store.getSettings(), now);
    assert.equal(quota.forecast.expired, true);
    assert.equal(store.hasUsableObservation('claude', now, fresh), false);
    assert.equal(store.hasUsableObservation('claude', now), true, 'expired history still exists');

    // Superseding a bucket must not hide a separate, still-active window,
    // even when its latest reading predates both rows in the expired bucket.
    record(store, 'claude', now - 5 * hour, now + 2 * hour, 'model_scoped_opus');
    assert.equal(store.hasUsableObservation('claude', now, fresh), true);
  } finally {
    store.close();
  }
});

test('an invalid latest row cannot supersede the latest usable reading', () => {
  const store = openStore();
  const now = Date.parse('2026-09-12T12:00:00Z');
  const hour = 3_600_000;
  const fresh = { activeWithinMs: 8 * DAY_MS };
  try {
    record(store, 'claude', now - 4 * hour, now + hour);
    record(store, 'claude', now - 2 * hour, now + 2 * hour);
    // Simulate malformed data persisted by an older build or backup.
    store.prepare('UPDATE quota_observations SET resets_at = ? WHERE observed_at = ?')
      .run('invalid', new Date(now - 2 * hour).toISOString());
    assert.equal(store.hasUsableObservation('claude', now, fresh), true);

    record(store, 'claude', now - 3 * hour, now - hour);
    assert.equal(store.getQuota('claude', store.getSettings(), now).forecast.expired, true);
    assert.equal(store.hasUsableObservation('claude', now, fresh), false);
  } finally {
    store.close();
  }
});
