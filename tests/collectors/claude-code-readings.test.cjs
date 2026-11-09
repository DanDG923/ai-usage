'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../../electron/store.cjs');
const { CLAUDE_CODE_READING_FORMAT, importClaudeCodeReadings } = require('../../electron/claude-collector.cjs');
const { evidenceTimes } = require('../../electron/quota-evidence.cjs');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms) => new Date(ms).toISOString();

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-claude-code-readings-'));
  const store = new UsageStore(':memory:', os.tmpdir());
  t.after(() => store.close());
  return { directory, store };
}

function reading(nowMs, overrides = {}) {
  return {
    format: CLAUDE_CODE_READING_FORMAT,
    version: 1,
    captured_at: iso(nowMs - MINUTE),
    fetched_after: iso(nowMs - MINUTE - 20_000),
    session_id: 'session-a',
    model: { id: 'claude-opus-5-5' },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: iso(nowMs + 3 * HOUR) },
      seven_day: { used_percentage: 41, resets_at: iso(nowMs + 4 * 24 * HOUR) },
    },
    ...overrides,
  };
}

const write = (directory, name, value) => fs.writeFileSync(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
const rows = (store, sourceId = 'claude') => store.prepare(`SELECT bucket_id, observed_at, used_percent, provenance, fetched_after, seen_since, metadata_json
  FROM quota_observations WHERE source_id = ? ORDER BY bucket_id`).all(sourceId);

test('a reading is stored as a status-line observation dated by its own fetch, then removed', (t) => {
  const { directory, store } = setup(t);
  const nowMs = Date.now();
  const value = reading(nowMs);
  write(directory, '0001-session-a.json', value);
  const result = importClaudeCodeReadings(store, directory, { nowMs });
  assert.equal(result.files, 1);
  assert.equal(result.claudeObservations, 2);
  assert.equal(result.latestClaudeObservedAt, value.captured_at);
  const stored = rows(store);
  assert.deepEqual(stored.map((row) => [row.bucket_id, row.used_percent, row.provenance]), [
    ['five_hour', 23.5, 'official-statusline'],
    ['seven_day', 41, 'official-statusline'],
  ]);
  for (const row of stored) {
    assert.equal(row.observed_at, value.captured_at);
    assert.equal(row.fetched_after, value.fetched_after);
    assert.equal(row.seen_since, value.captured_at);
    assert.equal(JSON.parse(row.metadata_json).channel, 'claude-code-mod');
    assert.equal(JSON.parse(row.metadata_json).model, 'claude-opus-5-5');
  }
  // Known freshness counts from the fetch, not from the start of the window.
  const [evidence] = evidenceTimes([{ ...stored[1], observedAt: stored[1].observed_at, resetsAt: value.rate_limits.seven_day.resets_at,
    windowMinutes: 10_080, usedPercent: 41 }], { known: true });
  assert.equal(evidence, Date.parse(value.fetched_after));
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('a Fable window goes to the Fable source, and readings import in file order', (t) => {
  const { directory, store } = setup(t);
  const nowMs = Date.now();
  const first = reading(nowMs, { captured_at: iso(nowMs - 3 * MINUTE), fetched_after: iso(nowMs - 4 * MINUTE),
    rate_limits: { seven_day_fable: { used_percentage: 10, resets_at: iso(nowMs + 2 * 24 * HOUR) } } });
  const second = reading(nowMs, { rate_limits: { seven_day_fable: { used_percentage: 12, resets_at: iso(nowMs + 2 * 24 * HOUR) } } });
  write(directory, '0002-session-a.json', second);
  write(directory, '0001-session-a.json', first);
  const result = importClaudeCodeReadings(store, directory, { nowMs });
  assert.equal(result.fableObservations, 2);
  assert.equal(result.latestFableObservedAt, second.captured_at);
  assert.deepEqual(rows(store, 'claude-fable').map((row) => [row.bucket_id, row.used_percent]).sort(), [
    ['fable:seven_day_fable', 10], ['fable:seven_day_fable', 12],
  ]);
});

test('a fetch window no single request could take leaves the reading undated', (t) => {
  const { directory, store } = setup(t);
  const nowMs = Date.now();
  for (const [name, fetchedAfter] of [['a.json', iso(nowMs - 2 * HOUR)], ['b.json', iso(nowMs)], ['c.json', 'yesterday']]) {
    write(directory, name, reading(nowMs, { session_id: name, captured_at: iso(nowMs - MINUTE - name.charCodeAt(0)), fetched_after: fetchedAfter }));
  }
  importClaudeCodeReadings(store, directory, { nowMs });
  const stored = rows(store);
  assert.equal(stored.length, 6);
  for (const row of stored) {
    assert.equal(row.fetched_after, null);
    assert.equal(row.seen_since, row.observed_at);
  }
});

test('malformed, foreign and future files are discarded, and a torn one is retried', (t) => {
  const { directory, store } = setup(t);
  const nowMs = Date.now();
  write(directory, 'torn.json', '{"format":"ai-usage-claude-code-rea');
  write(directory, 'old-torn.json', '{"format"');
  const old = (nowMs - 5 * MINUTE) / 1000;
  fs.utimesSync(path.join(directory, 'old-torn.json'), old, old);
  write(directory, 'foreign.json', { format: 'something-else', version: 1, captured_at: iso(nowMs), rate_limits: {} });
  write(directory, 'version.json', reading(nowMs, { version: 2 }));
  write(directory, 'future.json', reading(nowMs, { captured_at: iso(nowMs + HOUR), fetched_after: iso(nowMs + HOUR - MINUTE) }));
  write(directory, 'notes.txt', 'ignored');
  write(directory, 'huge.json', `{"pad":"${'x'.repeat(70 * 1024)}"}`);
  const result = importClaudeCodeReadings(store, directory, { nowMs });
  assert.equal(result.invalidRecords, 4);
  assert.equal(result.rejectedRecords, 1);
  assert.equal(result.observations, 0);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['notes.txt', 'torn.json']);
  assert.deepEqual(rows(store), []);
});

test('of a backlog the newest readings are imported first, and the rest wait', (t) => {
  const { directory, store } = setup(t);
  for (let index = 0; index <= 2_000; index += 1) write(directory, `${String(index).padStart(15, '0')}-s-1.json`, '{}');
  const result = importClaudeCodeReadings(store, directory);
  assert.equal(result.files, 2_000);
  assert.deepEqual(fs.readdirSync(directory), ['000000000000000-s-1.json']);
});

test('an import that cannot store keeps the reading for the next collection', (t) => {
  const { directory, store } = setup(t);
  const nowMs = Date.now();
  write(directory, 'a.json', reading(nowMs));
  const failure = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
  t.mock.method(store, 'recordObservation', () => { throw failure; });
  const result = importClaudeCodeReadings(store, directory, { nowMs });
  assert.equal(result.readErrors, 1);
  assert.equal(result.observations, 0);
  assert.deepEqual(fs.readdirSync(directory), ['a.json']);
});

test('no folder yet, or none configured, is simply nothing to import', (t) => {
  const { directory, store } = setup(t);
  assert.equal(importClaudeCodeReadings(store, path.join(directory, 'missing')).readErrors, 0);
  assert.equal(importClaudeCodeReadings(store, null).files, 0);
});
