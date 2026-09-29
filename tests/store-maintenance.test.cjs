'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');
const { exhaustionTime, forecastQuota } = require('../electron/forecast.cjs');

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-maint-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try { return run(store); } finally { store.close(); }
}

const NOW = Date.parse('2026-09-01T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;

function poll(store, observedAt, usedPercent, resetsAt, provenance = 'official') {
  store.recordObservation({
    sourceId: 'codex', bucketId: 'codex:primary', bucketName: 'Weekly', observedAt: iso(observedAt), usedPercent,
    remainingPercent: 100 - usedPercent, resetsAt: iso(resetsAt), windowMinutes: 10_080, provenance, metadata: { limitId: 'codex' },
  });
}

test('renamed settings keys are migrated forward and accepted from old exports', () => withStore((store) => {
  store.db.prepare("INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES ('notifyInApp', 'false', '2026-01-01T00:00:00Z')").run();
  store.db.prepare("DELETE FROM settings WHERE key = 'notifyDesktop'").run();
  store.migrate();
  assert.equal(store.getSettings().notifyDesktop, false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = 'notifyInApp'").get().count, 0);
  const counts = store.restoreFromExport({ schemaVersion: 1, settings: { notifyInApp: true, theme: 'light', reservePercent: 20 } });
  assert.equal(counts.settings, 3);
  assert.equal(counts.skipped, 0);
  assert.deepEqual([store.getSettings().notifyDesktop, store.getSettings().theme, store.getSettings().reservePercent], [true, 'light', 20]);
  assert.throws(() => store.updateSettings({ theme: 'neon' }), /Invalid value for theme/);
  assert.throws(() => store.updateSettings({ reservePercent: 80 }), /Invalid value for reservePercent/);
  assert.throws(() => store.updateSettings({ alertsSnoozedUntil: 'tomorrow-ish' }), /Invalid value for alertsSnoozedUntil/);
  store.updateSettings({ alertsSnoozedUntil: '2026-09-02T00:00:00.000Z' });
  store.updateSettings({ alertsSnoozedUntil: null });
  assert.equal(store.getSettings().alertsSnoozedUntil, null);
}));

test('compaction keeps the first and last reading per bucket, window, and day beyond the retention horizon', () => withStore((store) => {
  const oldReset = NOW - 80 * DAY;
  const oldDay = NOW - 84 * DAY;
  for (let index = 0; index < 20; index += 1) poll(store, oldDay + index * 3_600_000, index, oldReset);
  for (let index = 0; index < 5; index += 1) poll(store, oldDay + DAY + index * 3_600_000, 20 + index, oldReset);
  poll(store, oldDay + 2 * DAY, 30, oldReset, 'manual-official');
  for (let index = 0; index < 6; index += 1) poll(store, NOW - 2 * DAY + index * 3_600_000, index, NOW + 4 * DAY);
  const before = store.db.prepare('SELECT COUNT(*) AS count FROM quota_observations').get().count;
  assert.equal(before, 32);
  const result = store.compactObservations(NOW);
  assert.equal(result.removed, 21);
  // Local days split the 20 hourly polls at midnight: 13:00–23:00 keeps its
  // first and last (0, 10); the next local day runs 00:00–08:00 and then the
  // 13:00 batch, so it keeps 11 and 24. The manual reading is untouched.
  const kept = store.db.prepare('SELECT used_percent FROM quota_observations WHERE observed_at < ? ORDER BY observed_at').all(iso(NOW - 60 * DAY)).map((row) => row.used_percent);
  assert.deepEqual(kept, [0, 10, 11, 24, 30]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM quota_observations WHERE observed_at >= ?').get(iso(NOW - 60 * DAY)).count, 6);
}));

test('forecasting reads a bounded window but still surfaces a dormant bucket by its latest row', () => withStore((store) => {
  poll(store, NOW - 120 * DAY, 50, NOW - 113 * DAY);
  store.recordObservation({
    sourceId: 'codex', bucketId: 'codex:secondary', bucketName: 'Five hour', observedAt: iso(NOW - 3_600_000), usedPercent: 10,
    remainingPercent: 90, resetsAt: iso(NOW + 4 * 3_600_000), windowMinutes: 300, provenance: 'official', metadata: { limitId: 'codex' },
  });
  const quota = store.getQuota('codex', store.getSettings(), NOW);
  const buckets = quota.windows.map((window) => [window.bucketId, window.forecast.expired]);
  assert.deepEqual(buckets.sort(), [['codex:primary', true], ['codex:secondary', false]]);
}));

test('a dormant bucket uses evidence time when older observations are imported later', () => withStore((store) => {
  poll(store, NOW - 80 * DAY, 70, NOW - 79 * DAY);
  poll(store, NOW - 90 * DAY, 20, NOW - 89 * DAY);
  const quota = store.getQuota('codex', store.getSettings(), NOW);
  assert.equal(quota.observedAt, iso(NOW - 80 * DAY));
  assert.equal(quota.usedPercent, 70);
}));

test('source evidence timestamps never move backwards during historical imports', () => withStore((store) => {
  poll(store, NOW - DAY, 70, NOW + DAY);
  poll(store, NOW - 2 * DAY, 20, NOW + DAY);
  const source = store.db.prepare("SELECT last_observation_at FROM sources WHERE id = 'codex'").get();
  assert.equal(source.last_observation_at, iso(NOW - DAY));
}));

test('compaction preserves chronological endpoints and the peak after out-of-order imports', () => withStore((store) => {
  const start = Date.parse('2026-06-01T08:00:00Z');
  const reset = start + 6 * DAY;
  // Import order deliberately differs from evidence order, as in a restore.
  for (const [hour, used] of [[1, 20], [4, 85], [0, 10], [2, 95], [3, 90]]) {
    poll(store, start + hour * 3_600_000, used, reset);
  }
  const quota = { bucketId: 'codex:primary' };
  const before = store.getCycleHistory('codex', quota, store.getSettings(), 8, NOW)[0];
  assert.equal(store.compactObservations(NOW).removed, 2);
  const kept = store.db.prepare('SELECT used_percent FROM quota_observations ORDER BY observed_at').all();
  assert.deepEqual(kept.map((row) => row.used_percent), [10, 95, 85]);
  const after = store.getCycleHistory('codex', quota, store.getSettings(), 8, NOW)[0];
  for (const key of ['peakUsedPercent', 'firstObservedAt', 'lastObservedAt', 'cost', 'tokens']) {
    assert.equal(after[key], before[key], key);
  }
  assert.equal(store.compactObservations(NOW).removed, 0);
}));

test('cycle history summarises each past window with its peak, readings, and current-catalogue cost', () => withStore((store) => {
  const previousReset = NOW - 2 * DAY;
  const currentReset = NOW + 5 * DAY;
  poll(store, previousReset - 6 * DAY, 5, previousReset);
  poll(store, previousReset - 3 * DAY, 60, previousReset);
  poll(store, previousReset - DAY, 91, previousReset);
  poll(store, previousReset - DAY + 3_600_000, 90, previousReset + 5_000); // reset jitter
  poll(store, NOW - DAY, 12, currentReset);
  // Requests stay under the GPT-5.6 long-context threshold so list prices apply.
  store.recordUsageEvent({ eventKey: 'prev-window', sourceId: 'codex', occurredAt: iso(previousReset - 2 * DAY), model: 'gpt-5.6-sol', inputTokens: 100_000, project: 'C:\\work\\alpha' });
  store.recordUsageEvent({ eventKey: 'this-window', sourceId: 'codex', occurredAt: iso(NOW - 3_600_000), model: 'gpt-5.6-sol', inputTokens: 200_000 });
  store.updateSettings({ currency: 'USD', usdToCurrency: 1 });
  const quota = store.getQuota('codex', store.getSettings(), NOW);
  const cycles = store.getCycleHistory('codex', quota, store.getSettings(), 8, NOW);
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].current, true);
  assert.equal(cycles[0].peakUsedPercent, 12);
  assert.equal(cycles[0].cost, 0.8);
  assert.equal(cycles[1].current, false);
  assert.equal(cycles[1].peakUsedPercent, 91);
  assert.equal(cycles[1].readings, 4);
  assert.equal(cycles[1].cost, 0.4);
  assert.equal(cycles[1].tokens, 100_000);
  const snapshot = store.getDashboardSnapshot(30, NOW);
  assert.equal(snapshot.cycles.codex.length, 2);
  assert.deepEqual(snapshot.cycles.claude, []);
}));

test('cost analytics attribute tokens to projects and carry the project onto sessions', () => withStore((store) => {
  store.updateSettings({ currency: 'USD', usdToCurrency: 1 });
  store.recordUsageEvent({ eventKey: 'a1', sourceId: 'codex', occurredAt: iso(NOW - 3_600_000), model: 'gpt-5.6-sol', sessionId: 's1', inputTokens: 100_000, project: 'C:\\work\\alpha' });
  store.recordUsageEvent({ eventKey: 'a2', sourceId: 'claude', occurredAt: iso(NOW - 7_200_000), model: 'claude-opus-5', sessionId: 's2', inputTokens: 100_000, project: 'C:\\work\\alpha' });
  store.recordUsageEvent({ eventKey: 'b1', sourceId: 'claude', occurredAt: iso(NOW - 3_000_000), model: 'claude-opus-5', sessionId: 's3', inputTokens: 20_000 });
  const costs = store.getCostAnalytics(30, store.getSettings(), NOW);
  assert.equal(costs.byProject.length, 2);
  assert.equal(costs.byProject[0].project, 'C:\\work\\alpha');
  assert.equal(costs.byProject[0].cost, 0.9);
  assert.equal(costs.byProject[0].sessionCount, 2);
  assert.deepEqual(costs.byProject[0].sources, ['claude', 'codex']);
  assert.equal(costs.byProject[1].project, null);
  assert.equal(costs.sessions.find((row) => row.sessionId === 's1').project, 'C:\\work\\alpha');
  assert.equal(costs.sessions.find((row) => row.sessionId === 's3').project, null);
  // A later upsert without a project keeps the one already recorded.
  store.recordUsageEvent({ eventKey: 'a1', sourceId: 'codex', occurredAt: iso(NOW - 3_600_000), model: 'gpt-5.6-sol', sessionId: 's1', inputTokens: 110_000 });
  assert.equal(store.db.prepare("SELECT project FROM usage_events WHERE event_key = 'a1'").get().project, 'C:\\work\\alpha');
}));

test('the CSV export lists every ledger record with its priced value and escapes fields safely', () => withStore((store) => {
  store.recordUsageEvent({ eventKey: 'csv-1', sourceId: 'codex', occurredAt: iso(NOW - DAY), model: 'gpt-5.6-sol', sessionId: 'quoted "id"', inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 1000, project: 'C:\\work, alpha' });
  store.recordUsageEvent({ eventKey: 'csv-2', sourceId: 'claude', occurredAt: iso(NOW - 2 * DAY), model: 'mystery-model', inputTokens: 10 });
  const exported = store.exportLedgerCsv(30, NOW);
  const lines = exported.csv.trim().split('\r\n');
  assert.equal(exported.rows, 2);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'occurred_at,source,model,project,session_id,input_tokens,cached_input_tokens,cache_write_5m_input_tokens,cache_write_1h_input_tokens,output_tokens,reasoning_output_tokens,api_equivalent_usd,priced');
  assert.match(lines[1], /mystery-model,,,10,0,0,0,0,0,0,no$/);
  // 1M prompt tokens crosses the GPT-5.6 long-context threshold: input and
  // cache reads double, output is 1.5×. (500k×4×2 + 500k×0.4×2 + 1k×20×1.5)/1M.
  assert.match(lines[2], /"C:\\work, alpha","quoted ""id""",1000000,500000,0,0,1000,0,4\.43,yes$/);
}));

test('restore accepts the project column and the price cache is scoped to one analytics run', () => withStore((store) => {
  const counts = store.restoreFromExport({ schemaVersion: 1, usageEvents: [
    { event_key: 'r1', source_id: 'codex', occurred_at: iso(NOW - DAY), model: 'gpt-5.6-sol', project: 'C:\\restored', input_tokens: 10, output_tokens: 1 },
  ] });
  assert.equal(counts.usageEvents, 1);
  assert.equal(store.db.prepare("SELECT project FROM usage_events WHERE event_key = 'r1'").get().project, 'C:\\restored');
  store.getCostAnalytics(30, store.getSettings(), NOW);
  assert.equal(store.priceCache, null);
  store.updatePrice({ model: 'gpt-5.6-sol', inputUsdPerMillion: 8, cacheWriteUsdPerMillion: 5, cacheWrite1hUsdPerMillion: 5, cacheReadUsdPerMillion: 0.4, outputUsdPerMillion: 20 });
  assert.equal(store.resolvePrice('gpt-5.6-sol').input_usd_per_million, 8);
}));

test('the forecast reports when each projection runs out and honours a reserve', () => {
  assert.equal(exhaustionTime([{ at: 0, remaining: 10 }, { at: 100, remaining: 5 }]), null);
  assert.equal(exhaustionTime([{ at: 0, remaining: 10 }, { at: 100, remaining: 0 }, { at: 200, remaining: 0 }]), iso(100));
  assert.equal(exhaustionTime([{ at: 0, remaining: 10 }, { at: 100, remaining: -10 }]), iso(50));
  const start = Date.parse('2026-08-24T08:00:00Z');
  const reset = Date.parse('2026-09-07T08:00:00Z');
  const observations = Array.from({ length: 8 }, (_, index) => ({
    observedAt: iso(start + index * DAY), resetsAt: iso(reset), usedPercent: index * 11, remainingPercent: 100 - index * 11, windowMinutes: 20_160, provenance: 'official',
  }));
  const base = { now: iso(start + 7 * DAY + 3_600_000), schedule: { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 }, fallbackRate: 0.35 };
  const plain = forecastQuota(observations, base);
  assert.ok(plain.expectedRemaining <= 0, `expected ${plain.expectedRemaining}`);
  assert.ok(plain.exhaustsAt, 'runs out before reset');
  assert.ok(Date.parse(plain.exhaustsAt) < reset);
  assert.ok(plain.heavyExhaustsAt && Date.parse(plain.heavyExhaustsAt) <= Date.parse(plain.exhaustsAt));
  const reserved = forecastQuota(observations, { ...base, reservePercent: 20 });
  assert.equal(reserved.reservePercent, 20);
  assert.ok(reserved.safePace < plain.safePace);
  assert.equal(reserved.expectedRemaining, plain.expectedRemaining);
});

test('restoring an older SQLite backup keeps the settings that backup never stored', () => withStore((store) => {
  store.updateSettings({ claudeFreeResets: 2, softwareRendering: false, theme: 'light' });
  const backup = store.createBackup({ exportJson: false });
  // Make the copy look like a version that predates the newer settings and
  // stored the desktop-notification switch under its old name.
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(backup.databasePath);
  old.exec("DELETE FROM settings WHERE key != 'theme'");
  old.exec(`UPDATE settings SET value_json = '"dark"' WHERE key = 'theme'`);
  old.exec("INSERT INTO settings(key, value_json, updated_at) VALUES ('notifyInApp', 'false', '2026-01-01T00:00:00Z')");
  old.close();
  store.updateSettings({ notifyDesktop: true });
  const payload = store.readExport(backup.databasePath);
  try {
    assert.equal(store.restoreFromExport(payload).settings, 2);
  } finally { payload.close?.(); }
  const settings = store.getSettings();
  assert.deepEqual([settings.theme, settings.notifyDesktop, settings.claudeFreeResets, settings.softwareRendering],
    ['dark', false, 2, false]);
}));

test('a backup recreates a backup folder deleted while the app runs', () => withStore((store) => {
  fs.rmSync(store.backupDirectory, { recursive: true, force: true });
  const backup = store.createBackup({ exportJson: false });
  assert.ok(fs.existsSync(backup.databasePath));
}));

test('the CSV export covers the local calendar days of the dashboard period, not a rolling window', () => withStore((store) => {
  // 15:00 in London on 1 September: the 30-day period starts at local
  // midnight on 3 August, so 20:00 on 2 August is outside it.
  const now = Date.parse('2026-09-01T14:00:00Z');
  store.recordUsageEvent({ eventKey: 'outside', sourceId: 'claude', occurredAt: '2026-08-02T19:00:00Z', model: 'm', inputTokens: 1 });
  store.recordUsageEvent({ eventKey: 'inside', sourceId: 'claude', occurredAt: '2026-08-03T08:00:00Z', model: 'm', inputTokens: 1 });
  const exported = store.exportLedgerCsv(30, now);
  assert.equal(exported.since, '2026-08-02T23:00:00.000Z');
  assert.equal(exported.rows, 1);
}));

test('a streamed CSV export writes in batches exactly what the returned export contains', () => withStore((store) => {
  store.transaction(() => {
    for (let index = 0; index < 12_000; index += 1) {
      store.recordUsageEvent({ eventKey: `batch-${index}`, sourceId: 'claude', occurredAt: iso(NOW - DAY + index * 1000),
        model: 'claude-opus-5-5', project: 'C:\\work\\alpha', sessionId: `session-${index % 7}`, inputTokens: 1000 + index, outputTokens: 10 });
    }
  });
  const returned = store.exportLedgerCsv(30, NOW);
  const chunks = [];
  const streamed = store.exportLedgerCsv(30, NOW, (text) => chunks.push(text));
  assert.ok(chunks.length > 1, `${chunks.length} batch`);
  assert.equal(chunks.join(''), returned.csv);
  assert.deepEqual(streamed, { rows: 12_000, since: returned.since });
}));

test('a failed CSV export leaves the chosen file untouched and no partial file behind', async () => {
  const { createMaintenanceService } = require('../electron/maintenance-service.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-maint-'));
  const filePath = path.join(root, 'ledger.csv');
  fs.writeFileSync(filePath, 'previous export');
  const service = createMaintenanceService({ databasePath: path.join(root, 'usage.sqlite'), backupDirectory: path.join(root, 'Backups'),
    openStore: () => ({
      exportLedgerCsv: (_days, _now, write) => { write('occurred_at\r\n'); throw new Error('disk full'); },
      close() {},
    }) });
  await assert.rejects(service.handle({ type: 'export-csv', filePath, days: 30 }), /disk full/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'previous export');
  assert.deepEqual(fs.readdirSync(root), ['ledger.csv']);
});
