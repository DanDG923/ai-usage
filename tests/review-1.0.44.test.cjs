'use strict';
require('./setup.cjs');
process.env.TZ = 'Europe/London';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { forecastQuota } = require('../electron/forecast.cjs');
const { UsageStore } = require('../electron/store.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-review-44-'));
  const store = new UsageStore(path.join(root, 'db.sqlite'), path.join(root, 'Backups'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return store;
}

test('short-window projection is invariant across the minute before a schedule edge in every supported offset', (t) => {
  const priorZone = process.env.TZ;
  t.after(() => { process.env.TZ = priorZone; });
  for (const zone of ['Europe/London', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Lord_Howe']) {
  process.env.TZ = zone;
  const at = (hour, minute = 0) => new Date(2026, 8, 14, hour, minute).getTime();
  const rows = [{ observedAt: at(7), resetsAt: at(12), usedPercent: 0, remainingPercent: 100,
    windowMinutes: 300, provenance: 'official' }];
  for (const minute of [0, 29, 31, 59]) {
    const result = forecastQuota(rows, { now: at(7, minute), fallbackRate: 20,
      schedule: { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 8, endHour: 22 } });
    assert.ok(Math.abs(result.expectedRemaining - 20) < 1e-8, `${minute}: ${result.expectedRemaining}`);
  }
  }
});

test('daily account history uses the snapshot clock', (t) => {
  const store = fixture(t);
  store.upsertDailyUsage('codex', '2020-01-01', 123);
  const snapshot = store.getDashboardSnapshot(30, Date.parse('2020-01-02T12:00:00Z'));
  assert.equal(snapshot.dailyUsage[0]?.tokens, 123);
});

test('currency round trips restore each currency rate', (t) => {
  const store = fixture(t);
  store.updateSettings({ usdToCurrency: 0.75 });
  store.updateSettings({ currency: 'USD' });
  assert.equal(store.updateSettings({ currency: 'GBP' }).usdToCurrency, 0.75);
  assert.throws(() => store.updateSettings({ currency: 'EUR' }), /conversion rate/);
  store.updateSettings({ currency: 'EUR', usdToCurrency: 0.85 });
  store.updateSettings({ currency: 'USD' });
  assert.equal(store.updateSettings({ currency: 'EUR' }).usdToCurrency, 0.85);
});

test('failed scheduled export removes all new files and persists retry backoff', (t) => {
  const store = fixture(t);
  const exporter = require('../electron/backup-export.cjs');
  const write = exporter.writeExport;
  exporter.writeExport = () => { throw new Error('injected disk full'); };
  try { assert.throws(() => store.maybeCreateScheduledBackup(), /disk full/); }
  finally { exporter.writeExport = write; }
  assert.deepEqual(fs.readdirSync(store.backupDirectory), []);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM backups').get().count, 0);
  assert.equal(store.maybeCreateScheduledBackup(), null);
  const second = new UsageStore(store.databasePath, store.backupDirectory);
  try { assert.equal(second.maybeCreateScheduledBackup(), null); } finally { second.close(); }
  const saved = store.createBackup();
  assert.equal(store.readExport(saved.exportPath).schemaVersion, 1);
});

test('restore rejects oversized files before reading and decompression bombs while retaining legacy JSON', (t) => {
  const store = fixture(t);
  const file = path.join(store.backupDirectory, 'oversized.aiusage.json');
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); fs.closeSync(fd);
  assert.throws(() => store.readExport(file), /64 MB/);
  fs.writeFileSync(file, '{"schemaVersion":1}');
  assert.equal(store.readExport(file).schemaVersion, 1);
  fs.writeFileSync(file, require('node:zlib').gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1, 32)));
  assert.throws(() => store.readExport(file), /64 MB/);
});

test('settings repair retains valid allowance changes across clock rollback', (t) => {
  const store = fixture(t);
  const future = { source: 'codex', at: '2090-01-01T00:00:00.000Z', previousAllowancePercent: 150 };
  store.prepare("UPDATE settings SET value_json = ? WHERE key = 'allowanceChanges'").run(JSON.stringify([future, { bad: true }]));
  store.repairSettings();
  assert.deepEqual(store.getSettings().allowanceChanges, [future]);
});

test('daily ingestion rejects dates and counts that cannot survive restore', (t) => {
  const store = fixture(t);
  for (const [date, tokens] of [['2026-02-30', 1], ['2026-09-01', -1], ['2026-09-01', '123'], ['2026-09-01', 1.1]]) {
    assert.throws(() => store.upsertDailyUsage('codex', date, tokens), /daily usage/);
  }
});

test('compaction merges idle rolling resets and revisits backfilled old days', (t) => {
  const store = fixture(t);
  const base = Date.parse('2026-01-01T12:00:00Z');
  const poll = (index) => store.recordObservation({ sourceId: 'codex', bucketId: 'codex:primary',
    observedAt: new Date(base + index * 60_000).toISOString(), resetsAt: new Date(base + index * 60_000 + 7 * 86400000).toISOString(),
    windowMinutes: 10080, usedPercent: 0, remainingPercent: 100, provenance: 'official' });
  for (let i = 0; i < 20; i++) poll(i);
  const now = Date.parse('2026-09-14T12:00:00Z');
  assert.equal(store.compactObservations(now).removed, 18);
  assert.equal(store.compactObservations(now).removed, 0);
  poll(10);
  assert.equal(store.compactObservations(now).removed, 1);
});

test('analytics retain local day and hour boundaries in fractional-offset timezones', (t) => {
  const prior = process.env.TZ;
  t.after(() => { process.env.TZ = prior; });
  for (const zone of ['Asia/Kolkata', 'Asia/Kathmandu']) {
    process.env.TZ = zone;
    const store = fixture(t);
    for (const [i, at] of ['2026-09-13T18:10:00Z', '2026-09-13T18:50:00Z'].entries()) {
      store.recordUsageEvent({ eventKey: `zone-${i}`, sourceId: 'codex', model: 'gpt-5.6-sol',
        sessionId: 'same-session', occurredAt: at, inputTokens: 1000000 });
    }
    const cost = store.getCostAnalytics(30, store.getSettings(), Date.parse('2026-09-14T12:00:00Z'));
    assert.deepEqual(cost.chart.map((row) => row.date), ['2026-09-13', '2026-09-14']);
    assert.equal(cost.chart[0].codex, cost.chart[1].codex);
  }
});

test('capacity treats the first pinned reset after idle polls as normal startup', () => {
  const { estimateTokenCapacity } = require('../electron/token-capacity.cjs');
  const start = Date.parse('2026-09-07T00:00:00Z'), week = 7 * 86400000, hour = 3600000;
  const row = (at, used, reset) => ({ source_id: 'codex', bucket_id: 'codex:weekly', observed_at: new Date(at).toISOString(),
    resets_at: new Date(reset).toISOString(), used_percent: used, remaining_percent: 100 - used, window_minutes: 10080, provenance: 'official' });
  const observations = [row(start, 0, start + week), row(start + hour / 4, 0, start + week + hour / 4),
    ...[1, 2, 3, 4].map((n) => row(start + n * hour, n * 10, start + week + hour / 2))];
  const events = [2, 3, 4].map((n) => ({ source_id: 'codex', occurred_at: new Date(start + n * hour).toISOString(), model: 'gpt-5.6-sol', input_tokens: 100000 }));
  const value = estimateTokenCapacity({ sourceId: 'codex', bucketId: 'codex:weekly', observations, events, nowMs: start + 4 * hour });
  assert.equal(value.intervals, 3);
  assert.ok(!value.warnings.some((warning) => warning.includes('Reset times shifted')));
});

test('read-time compaction preserves both sides of an allowance change', () => {
  const start = Date.parse('2026-09-13T06:00:00Z'), now = Date.parse('2026-09-14T12:00:00Z');
  const observations = Array.from({ length: 121 }, (_, index) => ({
    sourceId: 'codex', bucketId: 'codex:weekly', observedAt: start + index * 15 * 60000,
    usedPercent: 20, remainingPercent: 80, windowMinutes: 10080, resetsAt: Date.parse('2026-09-15T12:00:00Z'), provenance: 'official',
  }));
  const options = { now, schedule: { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 8, endHour: 22 },
    allowanceChanges: [{ source: 'codex', at: '2026-09-14T08:00:00.000Z', previousAllowancePercent: 50 }] };
  const raw = forecastQuota(observations, options), compact = forecastQuota(observations, { ...options, compactReadings: true });
  assert.equal(compact.expectedRemaining, raw.expectedRemaining);
  assert.equal(compact.heavyRemaining, raw.heavyRemaining);
  assert.equal(compact.state, raw.state);
});
