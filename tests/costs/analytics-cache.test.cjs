'use strict';
require('../setup.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { UsageStore } = require('../../electron/store.cjs');
const DAY = 86400000;
const NOW = Date.parse('2026-09-05T12:00:00Z');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-cache-'));
  const store = new UsageStore(path.join(directory, 'test.sqlite'), directory);
  t.after(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = path.join(directory, `test.sqlite${suffix}`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  });
  store.updateSettings({ currency: 'USD' });
  return store;
}
function event(store, key = 'one', at = NOW, tokens = 100000) {
  store.recordUsageEvent({ eventKey: key, sourceId: 'claude', model: 'claude-fable-5',
    occurredAt: new Date(at).toISOString(), inputTokens: tokens });
}
function costs(store, now = NOW, days = 7, settings = store.getSettings()) {
  return store.getCostAnalytics(days, settings, now);
}
function midnight(ms, days = 0) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

test('unchanged analytics survive forecast time changes and selected-period switches', t => {
  const store = fixture(t);
  event(store);
  const first = costs(store);
  assert.equal(costs(store, NOW + 21000), first);
  costs(store, NOW, 30);
  assert.equal(costs(store, NOW + 22000), first);
  assert.equal(first.actual, 1);
});

test('cache tracks the inclusive local-midnight boundary exactly and handles clock rollback', t => {
  const store = fixture(t);
  // A 7-day period is the last seven local calendar days, today included.
  const start = midnight(NOW, -6);
  event(store, 'boundary', start);
  event(store, 'earlier', start - 1);
  assert.equal(costs(store).actual, 1);
  assert.equal(costs(store, midnight(NOW, 1) - 1).actual, 1);
  assert.equal(costs(store, midnight(NOW, 1)).actual, 0);
  assert.equal(costs(store, NOW).actual, 1);
});

test('local updates, price edits, currency and conversion changes cannot reuse stale costs', t => {
  const store = fixture(t);
  event(store);
  assert.equal(costs(store).actual, 1);
  event(store, 'one', NOW, 200000);
  assert.equal(costs(store).actual, 2);
  store.updatePrice({ model: 'claude-fable-5', inputUsdPerMillion: 20,
    cacheWriteUsdPerMillion: 25, cacheWrite1hUsdPerMillion: 40, cacheReadUsdPerMillion: 2, outputUsdPerMillion: 100 });
  assert.equal(costs(store).actual, 4);
  const gbp = costs(store, NOW, 7, { currency: 'GBP', usdToCurrency: 0.5 });
  assert.equal(gbp.actual, 2);
  assert.equal(gbp.currency, 'GBP');
  assert.equal(costs(store, NOW, 7, { currency: 'GBP', usdToCurrency: 0.75 }).actual, 3);
});

test('a collector connection updating existing rows invalidates cached analytics', t => {
  const store = fixture(t);
  event(store);
  assert.equal(costs(store).actual, 1);
  const writer = new DatabaseSync(store.databasePath);
  try { writer.exec('UPDATE usage_events SET input_tokens = 300000'); } finally { writer.close(); }
  assert.equal(costs(store).actual, 3);
});

test('transaction rollback never leaves uncommitted totals in the cache', t => {
  const store = fixture(t);
  event(store);
  const original = costs(store);
  assert.equal(original.actual, 1);
  assert.throws(() => store.transaction(() => {
    event(store, 'two');
    assert.equal(costs(store).actual, 2);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(costs(store), original, 'rolled-back revisions preserve the committed cache');
});

test('empty caches notice new records and imported exports', t => {
  const store = fixture(t);
  assert.equal(costs(store).actual, 0);
  store.restoreFromExport({ schemaVersion: 1, usageEvents: [{ event_key: 'imported', source_id: 'claude',
    model: 'claude-fable-5', occurred_at: new Date(NOW).toISOString(), input_tokens: 100000 }] });
  assert.equal(costs(store).actual, 1);
});

test('legacy and explicit TTL records retain matching per-category token and cost totals', t => {
  const store = fixture(t);
  for (const [key, total, five, hour] of [['legacy', 100000, 0, 0], ['hour', 200000, 0, 200000], ['five', 50000, 50000, 0]]) {
    store.recordUsageEvent({ eventKey: key, sourceId: 'claude', model: 'claude-fable-5',
      occurredAt: new Date(NOW).toISOString(), cacheWriteInputTokens: total,
      cacheWrite5mInputTokens: five, cacheWrite1hInputTokens: hour });
  }
  const row = costs(store).byModel[0];
  assert.equal(row.cacheWrite5mInputTokens, 150000);
  assert.equal(row.cacheWrite1hInputTokens, 200000);
  assert.equal(row.costBreakdown.cacheWrite5m, 1.875);
  assert.equal(row.costBreakdown.cacheWrite1h, 4);
  assert.equal(new Set(costs(store).sessions.map(session => session.sessionId)).size, 3);
});

function reading(store, { sourceId = 'claude-fable', bucketId = 'fable_seven_day', at = NOW - 1000, reset = NOW + DAY, used = 30 } = {}) {
  store.recordObservation({ sourceId, bucketId, observedAt: new Date(at).toISOString(),
    resetsAt: new Date(reset).toISOString(), usedPercent: used, remainingPercent: 100 - used,
    windowMinutes: 10080, provenance: 'official' });
}
function cycles(store, now = NOW, settings = store.getSettings(), sourceId = 'claude-fable', bucketId = 'fable_seven_day') {
  return store.getCycleHistory(sourceId, { bucketId }, settings, 8, now);
}

test('unchanged cycle history is cached while current events, reset boundaries and clock rollback stay exact', t => {
  const store = fixture(t);
  reading(store);
  event(store, 'past', NOW - 1000);
  event(store, 'future', NOW + 5000);
  const first = cycles(store);
  assert.equal(first[0].cost, 1);
  assert.equal(cycles(store, NOW + 5000), first, 'the upper event boundary is exclusive');
  assert.equal(cycles(store, NOW + 5001)[0].cost, 2);
  assert.equal(cycles(store, NOW + DAY - 1)[0].current, true);
  assert.equal(cycles(store, NOW + DAY)[0].current, false);
  assert.equal(cycles(store, NOW - 1001)[0].cost, 0);
  assert.equal(cycles(store, NOW - 1001)[0].current, true);
  assert.deepEqual(cycles(store), store.buildCycleHistory('claude-fable', { bucketId: 'fable_seven_day' }, store.getSettings(), 8, NOW));
});

test('cycle history invalidates for local events, observations, prices and currency conversion', t => {
  const store = fixture(t);
  reading(store);
  event(store, 'one', NOW - 1000);
  const first = cycles(store);
  assert.equal(cycles(store, NOW + 21000), first);
  event(store, 'one', NOW - 1000, 200000);
  assert.equal(cycles(store)[0].cost, 2);
  reading(store, { used: 60 });
  assert.equal(cycles(store)[0].peakUsedPercent, 60);
  store.updatePrice({ model: 'claude-fable-5', inputUsdPerMillion: 20,
    cacheWriteUsdPerMillion: 25, cacheWrite1hUsdPerMillion: 40, cacheReadUsdPerMillion: 2, outputUsdPerMillion: 100 });
  assert.equal(cycles(store)[0].cost, 4);
  assert.equal(cycles(store, NOW, { currency: 'GBP', usdToCurrency: 0.5 })[0].cost, 2);
  store.updateSettings({ currency: 'GBP', usdToCurrency: 0.75 });
  assert.equal(cycles(store)[0].cost, 3);
});

test('collector commits invalidate cycle and full-session caches even when row IDs are unchanged', t => {
  const store = fixture(t);
  reading(store);
  event(store, 'one', NOW - 1000);
  assert.equal(cycles(store)[0].cost, 1);
  assert.equal(store.getSessionPage({}, NOW).rows[0].cost, 1);
  const writer = new DatabaseSync(store.databasePath);
  try { writer.exec('UPDATE usage_events SET input_tokens = 300000; UPDATE quota_observations SET used_percent = 75'); }
  finally { writer.close(); }
  assert.equal(cycles(store)[0].cost, 3);
  assert.equal(cycles(store)[0].peakUsedPercent, 75);
  assert.equal(store.getSessionPage({}, NOW).rows[0].cost, 3);
});

test('transactional cycle reads bypass caches and rolled-back data cannot survive', t => {
  const store = fixture(t);
  reading(store);
  event(store, 'one', NOW - 1000);
  const original = cycles(store);
  assert.equal(original[0].cost, 1);
  assert.throws(() => store.transaction(() => {
    event(store, 'two', NOW - 500);
    reading(store, { used: 90 });
    assert.equal(cycles(store)[0].cost, 2);
    assert.equal(cycles(store)[0].peakUsedPercent, 90);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(cycles(store), original, 'rolled-back revisions preserve the committed cycle cache');
  assert.equal(cycles(store)[0].peakUsedPercent, 30);
});

test('cycle cache is bounded, keeps model scopes separate and notices restored history', t => {
  const store = fixture(t);
  assert.deepEqual(cycles(store), []);
  store.restoreFromExport({ schemaVersion: 1, observations: [{ source_id: 'claude-fable', bucket_id: 'fable_seven_day',
    observed_at: new Date(NOW - 1000).toISOString(), resets_at: new Date(NOW + DAY).toISOString(),
    used_percent: 30, remaining_percent: 70, window_minutes: 10080, provenance: 'official' }] });
  assert.equal(cycles(store).length, 1);
  reading(store, { sourceId: 'claude', bucketId: 'seven_day' });
  event(store, 'fable', NOW - 1000);
  store.recordUsageEvent({ eventKey: 'opus', sourceId: 'claude', model: 'claude-opus-5',
    occurredAt: new Date(NOW - 1000).toISOString(), inputTokens: 200000 });
  assert.equal(cycles(store)[0].tokens, 100000);
  assert.equal(cycles(store, NOW, store.getSettings(), 'claude', 'seven_day')[0].tokens, 300000);
  for (let rate = 1; rate <= 20; rate += 1) cycles(store, NOW, { currency: 'USD', usdToCurrency: rate });
  assert.equal(store.cycleHistoryCache.size, 12);
});

test('status, cursor, backup and forecast settings writes keep committed analytics and cycle caches', t => {
  const store = fixture(t);
  reading(store);
  event(store, 'one', NOW - 1000);
  const originalCosts = costs(store);
  const originalCycles = cycles(store);
  const originalTask = store.getTaskPage({ days: 7 }, NOW).rows[0];
  store.setSourceStatus('codex', 'connected', 'No new usage.');
  store.markImportedFile('synthetic-log.jsonl', 1, 100, { offset: 100 });
  store.updateSettings({ theme: 'light', forecastExcludedDates: ['2026-09-04'] });
  store.prepare('INSERT INTO backups(created_at, database_path, export_path) VALUES (?, ?, ?)')
    .run(new Date(NOW).toISOString(), 'synthetic.sqlite', 'synthetic.json');
  assert.equal(costs(store), originalCosts);
  assert.equal(cycles(store), originalCycles);
  assert.equal(store.getTaskPage({ days: 7 }, NOW).rows[0], originalTask);
  const writer = new DatabaseSync(store.databasePath);
  try {
    writer.exec("UPDATE sources SET status_detail = 'External status only'; UPDATE imported_files SET size_bytes = 200;");
  } finally { writer.close(); }
  assert.equal(costs(store), originalCosts, 'unrelated commits from collector connections preserve the ledger');
  assert.equal(cycles(store), originalCycles, 'unrelated commits preserve cycle history');
});

test('quota revisions affect only their source and bucket; other-provider usage leaves cycle caches intact', t => {
  const store = fixture(t);
  reading(store);
  event(store, 'one', NOW - 1000);
  const originalCosts = costs(store);
  const originalCycles = cycles(store);
  reading(store, { sourceId: 'codex', bucketId: 'codex:weekly' });
  reading(store, { sourceId: 'claude-fable', bucketId: 'different-bucket' });
  assert.equal(costs(store), originalCosts);
  assert.equal(cycles(store), originalCycles);
  reading(store, { used: 60 });
  assert.equal(costs(store), originalCosts, 'quota changes never reprice the ledger');
  const changedCycles = cycles(store);
  assert.notEqual(changedCycles, originalCycles);
  assert.equal(changedCycles[0].peakUsedPercent, 60);
  store.recordUsageEvent({ eventKey: 'codex-only', sourceId: 'codex', model: 'gpt-5.6-sol',
    occurredAt: new Date(NOW - 1000).toISOString(), inputTokens: 1000 });
  assert.notEqual(costs(store), originalCosts);
  assert.equal(cycles(store), changedCycles);
});

test('external usage deletion invalidates totals and cycles while external rollback retains committed caches', t => {
  const store = fixture(t);
  reading(store);
  event(store, 'one', NOW - 1000);
  const originalCosts = costs(store);
  const originalCycles = cycles(store);
  const writer = new DatabaseSync(store.databasePath);
  try {
    writer.exec('BEGIN IMMEDIATE; DELETE FROM usage_events;');
    assert.equal(costs(store), originalCosts, 'uncommitted external changes stay invisible');
    assert.equal(cycles(store), originalCycles);
    writer.exec('ROLLBACK;');
    assert.equal(costs(store), originalCosts);
    assert.equal(cycles(store), originalCycles);
    writer.exec('DELETE FROM usage_events;');
    assert.equal(costs(store).actual, 0);
    assert.equal(cycles(store)[0].cost, 0);
  } finally { writer.close(); }
});

test('direct SQL source and bucket moves invalidate both former and destination cycle scopes', t => {
  const store = fixture(t);
  reading(store);
  reading(store, { sourceId: 'codex', bucketId: 'codex:weekly' });
  event(store, 'move', NOW - 1000);
  const fableBefore = cycles(store);
  const codexBefore = cycles(store, NOW, store.getSettings(), 'codex', 'codex:weekly');
  const destinationBefore = cycles(store, NOW, store.getSettings(), 'claude', 'moved-bucket');
  const costsBefore = costs(store);
  const writer = new DatabaseSync(store.databasePath);
  try {
    writer.exec("UPDATE usage_events SET source_id = 'codex' WHERE event_key = 'move';");
    assert.equal(cycles(store)[0].cost, 0);
    const codexAfter = cycles(store, NOW, store.getSettings(), 'codex', 'codex:weekly');
    assert.notEqual(codexAfter, codexBefore);
    assert.equal(codexAfter[0].cost, 1);
    assert.notEqual(costs(store), costsBefore);
    const fableAfterMove = cycles(store);
    writer.exec("UPDATE quota_observations SET source_id = 'claude', bucket_id = 'moved-bucket' WHERE source_id = 'claude-fable';");
    assert.notEqual(cycles(store), fableAfterMove);
    assert.deepEqual(cycles(store), []);
    const destinationAfter = cycles(store, NOW, store.getSettings(), 'claude', 'moved-bucket');
    assert.notEqual(destinationAfter, destinationBefore);
    assert.equal(destinationAfter[0].peakUsedPercent, fableBefore[0].peakUsedPercent);
    assert.equal(cycles(store, NOW, store.getSettings(), 'codex', 'codex:weekly'), codexAfter);
  } finally { writer.close(); }
});

test('future events enter costs, tasks, sessions and CSV exactly at their inclusive timestamp', t => {
  const store = fixture(t);
  event(store, 'past', NOW - 1000);
  event(store, 'future', NOW + 5000, 200000);
  event(store, 'distant', Date.parse('2040-01-01T00:00:00Z'), 900000);
  const original = costs(store);
  assert.equal(original.actual, 1);
  assert.equal(original.totalTokens, 100000);
  assert.equal(costs(store, NOW + 4999), original);
  assert.equal(store.getSessionPage({ days: 7 }, NOW).total, 1);
  assert.equal(store.getTaskPage({ days: 7 }, NOW).total, 1);
  assert.equal(store.exportLedgerCsv(7, NOW).rows, 1);
  assert.equal(costs(store, NOW + 5000).actual, 3);
  assert.equal(store.getSessionPage({ days: 7 }, NOW + 5000).total, 2);
  assert.equal(store.getTaskPage({ days: 7 }, NOW + 5000).total, 2);
  assert.equal(store.exportLedgerCsv(7, NOW + 5000).rows, 2);
  assert.equal(costs(store, NOW + 4999).actual, 1, 'clock rollback excludes the future row again');
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 3, 'future evidence remains stored');
});

test('an empty period expires when its first future event becomes current', t => {
  const store = fixture(t);
  event(store, 'future', NOW + 1);
  const empty = costs(store);
  assert.equal(empty.actual, 0);
  assert.equal(costs(store), empty);
  assert.equal(costs(store, NOW + 1).actual, 1);
});

test('reset timestamp jitter cannot truncate older cycles or readings in the final requested cycle', t => {
  const store = fixture(t);
  for (let cycle = 0; cycle < 9; cycle += 1) {
    for (let index = 0; index < 20; index += 1) {
      reading(store, { at: NOW - cycle * 7 * DAY - 100000 + index * 1000,
        reset: NOW + DAY - cycle * 7 * DAY + index * 1000, used: index + 10 });
    }
  }
  const history = cycles(store);
  assert.equal(history.length, 8);
  assert.ok(history.every((cycle) => cycle.readings === 20));
  assert.ok(history.every((cycle) => cycle.peakUsedPercent === 29));
  assert.equal(history[0].resetsAt, new Date(NOW + DAY + 19000).toISOString());
  assert.equal(history.at(-1).resetsAt, new Date(NOW + DAY - 7 * 7 * DAY + 19000).toISOString());
});

test('revision migration preserves old databases, remains idempotent and validates SQLite integrity', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-cache-upgrade-'));
  const databasePath = path.join(directory, 'test.sqlite');
  let store = new UsageStore(databasePath, directory);
  t.after(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = path.join(directory, `test.sqlite${suffix}`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  });
  store.updateSettings({ currency: 'USD', forecastExcludedDates: ['2026-09-04'] });
  reading(store);
  event(store, 'existing', NOW - 1000);
  const before = {
    settings: store.getSettings(), usage: store.prepare('SELECT * FROM usage_events').all(),
    observations: store.prepare('SELECT * FROM quota_observations').all(),
  };
  for (const row of store.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'analytics_%'").all()) {
    assert.match(row.name, /^analytics_[a-z_]+$/);
    store.db.exec(`DROP TRIGGER ${row.name}`);
  }
  store.db.exec('DROP TABLE analytics_revisions');
  store.close();
  store = new UsageStore(databasePath, directory);
  assert.deepEqual(store.getSettings(), before.settings);
  assert.deepEqual(store.prepare('SELECT * FROM usage_events').all(), before.usage);
  assert.deepEqual(store.prepare('SELECT * FROM quota_observations').all(), before.observations);
  assert.equal(store.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(store.prepare('PRAGMA foreign_key_check').all(), []);
  const triggerCount = () => store.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'analytics_%'").get().count;
  assert.equal(triggerCount(), 12);
  assert.equal(costs(store).actual, 1);
  store.prepare('UPDATE usage_events SET input_tokens = 200000').run();
  assert.equal(costs(store).actual, 2, 'migrated triggers invalidate existing rows');
  store.close();
  store = new UsageStore(databasePath, directory);
  assert.equal(triggerCount(), 12);
  assert.equal(costs(store).actual, 2);
  assert.deepEqual(store.getSettings(), before.settings);
  assert.equal(store.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(store.prepare('PRAGMA foreign_key_check').all(), []);
});

test('only newly restored Codex events invalidate Codex accounting cursors without losing context', t => {
  const store = fixture(t);
  const codexPath = 'C:\\synthetic\\.codex\\sessions\\rollout.jsonl';
  const claudePath = 'C:\\synthetic\\.claude\\projects\\rollout.jsonl';
  const context = { sessionId: 'synthetic', model: 'gpt-5.6-sol', agentAttributionVersion: 1,
    accountingVersion: 1, lastTokenSnapshot: { fingerprint: 'synthetic' } };
  store.markImportedFile(codexPath, 123, 456, context);
  store.markImportedFile(claudePath, 124, 457, context);
  const beforeCodex = store.getImportedFile(codexPath);
  const restoreRow = { event_key: 'existing', source_id: 'codex', occurred_at: new Date(NOW).toISOString(),
    input_tokens: 1000, model: 'gpt-5.6-sol' };
  store.recordUsageEvent({ eventKey: 'existing', sourceId: 'codex', occurredAt: restoreRow.occurred_at, inputTokens: 1000 });
  assert.equal(store.restoreFromExport({ schemaVersion: 1, usageEvents: [restoreRow] }).usageEvents, 0);
  assert.deepEqual(store.getImportedFile(codexPath), beforeCodex, 'already-present rows do not cause another rescan');
  store.restoreFromExport({ schemaVersion: 1, usageEvents: [{ ...restoreRow, event_key: 'claude-new', source_id: 'claude' }] });
  assert.deepEqual(store.getImportedFile(codexPath), beforeCodex, 'Claude restores do not affect Codex cursors');
  const afterClaude = store.getImportedFile(claudePath);
  assert.equal(afterClaude.state.accountingVersion, undefined, 'Claude restore schedules its own clone accounting repair');
  assert.equal(store.restoreFromExport({ schemaVersion: 1, usageEvents: [{ ...restoreRow, event_key: 'codex-new' }] }).usageEvents, 1);
  const afterCodex = store.getImportedFile(codexPath);
  const { accountingVersion: _version, ...preservedContext } = context;
  assert.deepEqual(afterCodex.state, preservedContext);
  assert.equal(afterCodex.size_bytes, beforeCodex.size_bytes);
  assert.equal(afterCodex.modified_ms, beforeCodex.modified_ms);
  assert.equal(afterCodex.imported_at, beforeCodex.imported_at);
  assert.deepEqual(store.getImportedFile(claudePath), afterClaude, 'Codex restores do not alter Claude cursors');
});

test('failed restore cursor invalidation rolls back newly restored evidence and keeps the original cursor', t => {
  const store = fixture(t);
  const file = 'C:/synthetic/.codex/sessions/rollout.jsonl';
  store.markImportedFile(file, 123, 456, { accountingVersion: 1, agentAttributionVersion: 1 });
  const before = store.getImportedFile(file);
  const originalCosts = costs(store);
  store.db.exec(`CREATE TRIGGER block_cursor_invalidation BEFORE UPDATE OF state_json ON imported_files
    BEGIN SELECT RAISE(ABORT, 'Synthetic cursor invalidation failure'); END;`);
  assert.throws(() => store.restoreFromExport({ schemaVersion: 1, usageEvents: [{
    event_key: 'rollback', source_id: 'codex', occurred_at: new Date(NOW).toISOString(), input_tokens: 1000,
  }] }), /Synthetic cursor invalidation failure/);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 0);
  assert.deepEqual(store.getImportedFile(file), before);
  assert.equal(costs(store), originalCosts);
});
