'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { deriveFableEstimate, rederiveFableEstimate } = require('../electron/claude-collector.cjs');
const { UsageStore } = require('../electron/store.cjs');
const { createDatabaseQueue } = require('../electron/maintenance-host.cjs');

const HOUR = 3_600_000;
// The handler derives against the wall clock, so the window has to be live now.
const NOW = Date.now();
const RESET = new Date(NOW + 3 * 24 * HOUR).toISOString();
const iso = (at) => new Date(at).toISOString();

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-fable-rederive-'));
  const store = new UsageStore(path.join(root, 'db.sqlite'), path.join(root, 'Backups'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const handlers = new Map();
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const registration = source.slice(source.indexOf('function registerIpc()'), source.indexOf('\nfunction publishUpdateStatus('));
  vm.runInNewContext(`${registration}\nregisterIpc();`, {
    handleIpc: (channel, handler) => handlers.set(channel, handler), store, databaseJobs: createDatabaseQueue(),
    invalidateSnapshot() {}, applySettingsEffects() {}, updateTray() {}, snapshot: () => store.getDashboardSnapshot(),
    rederiveFableEstimate, JSON,
  });
  const overall = (at, usedPercent) => store.recordObservation({
    sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly', observedAt: iso(at), usedPercent,
    remainingPercent: 100 - usedPercent, resetsAt: RESET, windowMinutes: 10_080, planType: 'max',
    provenance: 'official-statusline', confidence: 1, metadata: {},
  });
  const fableRows = () => store.prepare(
    "SELECT used_percent, provenance FROM quota_observations WHERE source_id = 'claude-fable' ORDER BY observed_at, id").all();
  return {
    store, overall, fableRows,
    updateSettings: (patch) => handlers.get('dashboard:update-settings')({}, patch),
  };
}

// Ten boosted points become fifteen when the boost ends overnight, and a
// Fable session then adds ten points of the current allowance. Learned as
// usage, the whole fifteen-point step is Fable's (doubled for its half cap).
function boostedWeek({ overall, store }) {
  overall(NOW - 26 * HOUR, 10);
  store.recordUsageEvent({ eventKey: 'fable-step', sourceId: 'claude', occurredAt: iso(NOW - 20 * HOUR), sessionId: 'fable',
    model: 'claude-fable-5', inputTokens: 4_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0,
    reasoningOutputTokens: 0, metadata: {} });
  overall(NOW - 2 * HOUR, 25);
}
const change = { source: 'claude', at: iso(NOW - 14 * HOUR), previousAllowancePercent: 150 };

test('saving or removing an allowance change re-derives a stale Fable estimate at once', async (t) => {
  const context = fixture(t);
  boostedWeek(context);
  const initial = deriveFableEstimate(context.store, NOW - HOUR);
  assert.equal(initial.derived, true);
  assert.ok(Math.abs(initial.usedPercent - 30) < 0.01);

  const result = await context.updateSettings({ allowanceChanges: [change] });
  assert.deepEqual(result.settings.allowanceChanges, [change]);
  let rows = context.fableRows();
  assert.equal(rows.length, 2, 'a fresh derived row supersedes the stale one; history is kept');
  assert.ok(Math.abs(rows.at(-1).used_percent - 20) < 0.01, `rescaled estimate ${rows.at(-1).used_percent}`);
  assert.equal(rows.at(-1).provenance, 'derived-tokens');
  assert.ok(Math.abs(result.snapshot.quotas.fable.usedPercent - 20) < 0.01, 'the returned snapshot already shows the new estimate');

  await context.updateSettings({ theme: 'light' });
  assert.equal(context.fableRows().length, 2, 'unrelated settings leave the estimate alone');
  await context.updateSettings({ allowanceChanges: [change] });
  assert.equal(context.fableRows().length, 2, 'an unchanged list is not a change');

  await context.updateSettings({ allowanceChanges: [] });
  rows = context.fableRows();
  assert.equal(rows.length, 3);
  assert.ok(Math.abs(rows.at(-1).used_percent - 30) < 0.01, 'removing the entry restores the earlier estimate');
});

test('an official Fable reading is never displaced by the recomputation', async (t) => {
  const context = fixture(t);
  boostedWeek(context);
  deriveFableEstimate(context.store, NOW - 90 * 60_000);
  context.store.recordObservation({
    sourceId: 'claude-fable', bucketId: 'fable_seven_day', bucketName: 'Fable 5 weekly', observedAt: iso(NOW - HOUR),
    usedPercent: 44, remainingPercent: 56, resetsAt: RESET, windowMinutes: 10_080, provenance: 'manual-official',
    confidence: 0.98, metadata: {},
  });
  await context.updateSettings({ allowanceChanges: [change] });
  const rows = context.fableRows();
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows.at(-1) }, { used_percent: 44, provenance: 'manual-official' });
  assert.deepEqual(rederiveFableEstimate(context.store), { derived: false, reason: 'no-derived-estimate' });
});

test('a newer malformed official row the card rejects does not hide the derived row it shows', async (t) => {
  const context = fixture(t);
  boostedWeek(context);
  deriveFableEstimate(context.store, NOW - 90 * 60_000);
  // Older versions could persist a reset before its own observation; ingest
  // now rejects it, and getQuota skips it in favour of the derived row.
  context.store.prepare(`INSERT INTO quota_observations(source_id, bucket_id, bucket_name, observed_at, used_percent,
    remaining_percent, resets_at, window_minutes, plan_type, provenance, confidence, metadata_json)
    VALUES ('claude-fable', 'fable_seven_day', 'Fable 5 weekly', ?, 44, 56, ?, 10080, 'max', 'manual-official', 0.98, '{}')`)
    .run(iso(NOW - HOUR), iso(NOW - 2 * 24 * HOUR));
  assert.equal(context.store.getQuota('claude-fable').provenance, 'derived-tokens');
  await context.updateSettings({ allowanceChanges: [change] });
  const rows = context.fableRows();
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1).provenance, 'derived-tokens');
  assert.ok(Math.abs(rows.at(-1).used_percent - 20) < 0.01, `rescaled estimate ${rows.at(-1).used_percent}`);
  assert.ok(Math.abs(context.store.getQuota('claude-fable').usedPercent - 20) < 0.01);
});

test('a derivation that cannot run leaves the setting saved and reports why', (t) => {
  const context = fixture(t);
  context.store.recordObservation({
    sourceId: 'claude-fable', bucketId: 'fable_seven_day', bucketName: 'Fable 5 weekly', observedAt: iso(NOW - HOUR),
    usedPercent: 12, remainingPercent: 88, resetsAt: RESET, windowMinutes: 10_080, provenance: 'derived-tokens',
    confidence: 0.5, metadata: {},
  });
  assert.deepEqual(rederiveFableEstimate(context.store), { derived: false, reason: 'no-overall-reading' });
  assert.equal(context.fableRows().length, 1);
});
