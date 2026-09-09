'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');
const { codexQuotaLabel } = require('../electron/codex-quota-label.cjs');

const malformed = ['null', '  null  ', '[]', '[{}]', '42', 'true', '"text"', '{broken'];
const validMetadata = { limitId: 'spark', limitName: 'Spark', resetCredits: 2, extra: { retained: true } };
function observation(bucketId, metadata) {
  return { source_id: 'codex', bucket_id: bucketId, bucket_name: 'Weekly',
    observed_at: new Date().toISOString(), resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    used_percent: 25, remaining_percent: 75, window_minutes: 10_080, metadata_json: metadata };
}
function withDatabase(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-quota-metadata-'));
  const open = () => new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  const store = open();
  try { run(store, open, root); } finally { store.close(); }
}

test('backup restore skips invalid quota metadata shapes and preserves valid objects', () => withDatabase((store, _open, root) => {
  const invalid = [...malformed, [], 42, true];
  const observations = invalid.map((value, index) => observation(`invalid-${index}`, value));
  observations.push(observation('spark:secondary', JSON.stringify(validMetadata)), observation('object', validMetadata),
    observation('missing', undefined), observation('legacy-null', null));
  const file = path.join(root, 'crafted.aiusage.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, observations }));
  const counts = store.restoreFromBackup(file);
  assert.equal(counts.skipped, invalid.length);
  assert.equal(counts.observations, 4);
  const rows = store.db.prepare('SELECT bucket_id, metadata_json FROM quota_observations').all();
  assert.equal(rows.length, 4);
  assert.deepEqual(JSON.parse(rows.find((row) => row.bucket_id === 'spark:secondary').metadata_json), validMetadata);
  const quota = store.getDashboardSnapshot().quotas.codex;
  assert.equal(quota.windows.find((window) => window.bucketId === 'spark:secondary').bucketName, 'Spark · Weekly');
  assert.deepEqual(quota.windows.find((window) => window.bucketId === 'object').metadata, validMetadata);
  assert.equal(quota.usedPercent, 25);
}));

for (const metadata of malformed) {
  test(`persisted quota metadata ${metadata} remains readable after reopening`, () => withDatabase((store, open) => {
    store.restoreFromExport({ schemaVersion: 1, observations: [observation('dormant', '{}')] });
    store.db.prepare('UPDATE quota_observations SET metadata_json = ?').run(metadata);
    const reopened = open();
    try {
      const snapshot = reopened.getDashboardSnapshot();
      assert.deepEqual(snapshot.quotas.codex.metadata, {});
      assert.equal(snapshot.quotas.codex.bucketName, 'Weekly');
      assert.equal(snapshot.quotas.codex.usedPercent, 25);
      assert.equal(reopened.db.prepare('SELECT metadata_json FROM quota_observations').get().metadata_json, metadata,
        'reading old malformed metadata must not rewrite or delete historical evidence');
    } finally { reopened.close(); }
  }));
}

for (const metadata of [
  { limitId: 'spark', limitName: { toString: null } },
  { limitId: { toString: null } },
  { limitId: 'spark', limitName: [{ toString: null }] },
]) {
  test(`non-text quota label fields cannot break a restored or reopened snapshot: ${JSON.stringify(metadata)}`, () => withDatabase((store, open) => {
    assert.doesNotThrow(() => codexQuotaLabel('Weekly', 10_080, metadata));
    store.restoreFromExport({ schemaVersion: 1, observations: [observation('untrusted', JSON.stringify(metadata))] });
    assert.doesNotThrow(() => store.getDashboardSnapshot());
    const reopened = open();
    try { assert.doesNotThrow(() => reopened.getDashboardSnapshot()); } finally { reopened.close(); }
  }));
}

test('quota label guards preserve account, model, manual and default labels', () => {
  assert.equal(codexQuotaLabel('Weekly', 10_080, null), 'Weekly');
  assert.equal(codexQuotaLabel('Weekly', 10_080), 'Weekly');
  assert.equal(codexQuotaLabel('Weekly', 10_080, { limitId: 'codex' }), 'Weekly');
  assert.equal(codexQuotaLabel('Five hour', 300, validMetadata), 'Spark · Five hour');
  assert.equal(codexQuotaLabel('Manual allowance', 10_080, validMetadata), 'Manual allowance');
  assert.equal(codexQuotaLabel('Weekly', 10_080, { limitId: 'spark' }), 'spark · Weekly');
});

test('reset credit metadata cannot carry coercion traps into the dashboard after restore or reopen', () => withDatabase((store, open) => {
  for (const value of [{ toString: null, valueOf: null }, [{ toString: null }], '2', -1, 1.5, null, 0, 2]) {
    const metadata = { limitId: 'codex', resetCredits: value };
    store.db.prepare('DELETE FROM quota_observations').run();
    store.restoreFromExport({ schemaVersion: 1, observations: [observation('codex:weekly', JSON.stringify(metadata))] });
    const reopened = open();
    try {
      for (const reader of [store, reopened]) {
        const snapshot = reader.getDashboardSnapshot();
        assert.equal(snapshot.resetCredits, Number.isSafeInteger(value) && value >= 0 ? value : 0);
        assert.doesNotThrow(() => snapshot.resetCredits > 0);
        assert.deepEqual(snapshot.quotas.codex.metadata, metadata, 'retain the original metadata as evidence');
      }
    } finally { reopened.close(); }
  }
}));
