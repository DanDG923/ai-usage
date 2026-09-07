'use strict';

// Synthetic records only. Run before/after a change and compare the checksum
// as well as the median; a faster total is useful only if it is still correct.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { UsageStore } = require('../electron/store.cjs');

const count = Number(process.argv[2] || 30_000);
if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) {
  throw new Error('Choose between 1 and 1000000 synthetic records.');
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-benchmark-'));
const store = new UsageStore(':memory:', root);
const now = Date.parse('2026-09-04T12:00:00Z');
const models = ['gpt-5.6-sol', 'claude-fable-5', 'gpt-5.6-sol-20260901', 'unknown-model'];
try {
  store.updateSettings({ currency: 'USD', usdToCurrency: 1 });
  store.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      store.recordUsageEvent({
        eventKey: `synthetic-${index}`,
        sourceId: index % 2 ? 'claude' : 'codex',
        occurredAt: new Date(now - (index + 1) * (28 * 86_400_000 / count)).toISOString(),
        model: models[index % models.length],
        sessionId: `session-${index % 200}`,
        project: `synthetic-project-${index % 20}`,
        inputTokens: 1_000 + index % 100,
        cachedInputTokens: 200,
        outputTokens: 50,
      });
    }
    for (const [sourceId, bucketId] of [['codex', 'codex:weekly'], ['claude', 'seven_day'], ['claude-fable', 'fable_seven_day']]) {
      for (let index = 0; index < 8; index += 1) {
        store.recordObservation({ sourceId, bucketId,
          observedAt: new Date(now - (index * 7 + 1) * 86400000).toISOString(),
          resetsAt: new Date(now - (index * 7 - 3) * 86400000).toISOString(),
          usedPercent: 30, remainingPercent: 70, windowMinutes: 10080,
          provenance: 'official', metadata: { scope: 'overall' } });
      }
    }
  });
  const settings = store.getSettings();
  function measure(read) {
    for (let index = 0; index < 2; index += 1) read();
    const timings = [];
    let result;
    for (let index = 0; index < 7; index += 1) {
      const start = performance.now();
      result = read();
      timings.push(performance.now() - start);
    }
    const sorted = [...timings].sort((a, b) => a - b);
    return {
      medianMs: Number(sorted[3].toFixed(3)),
      runsMs: timings.map(value => Number(value.toFixed(3))),
      resultSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    };
  }
  // Report full aggregation separately: a cache hit is not a faster cold scan.
  const uncached = measure(() => store.withPriceCache(() => store.buildCostAnalytics(30, settings, now)));
  const cached = measure(() => store.getCostAnalytics(30, settings, now));
  if (cached.resultSha256 !== uncached.resultSha256) throw new Error('Cached analytics differ from a fresh aggregation.');
  // Hold the regular cost cache warm in both snapshot measurements to isolate
  // cycle work. Compare complete results, including all three cycle histories.
  const cachedCycleReader = store.getCycleHistory;
  store.getCycleHistory = store.buildCycleHistory;
  let snapshotUncachedCycles;
  try {
    snapshotUncachedCycles = measure(() => store.getDashboardSnapshot(30, now));
  } finally {
    store.getCycleHistory = cachedCycleReader;
  }
  const snapshotCached = measure(() => store.getDashboardSnapshot(30, now));
  if (snapshotCached.resultSha256 !== snapshotUncachedCycles.resultSha256) throw new Error('Cached snapshot differs from uncached cycles.');
  const sessionSearch = measure(() => store.getSessionPage({ days: 30, query: 'synthetic-project-0', pageSize: 10 }, now));
  const afterStatusWrite = measure(() => {
    store.setSourceStatus('codex', 'connected', 'Synthetic status-only refresh.');
    return store.getCostAnalytics(30, settings, now);
  });
  if (afterStatusWrite.resultSha256 !== uncached.resultSha256) throw new Error('Status-only refresh changed analytics.');
  const readCycles = () => Object.fromEntries([
    ['codex', 'codex:weekly'], ['claude', 'seven_day'], ['claude-fable', 'fable_seven_day'],
  ].map(([sourceId, bucketId]) => [sourceId, store.getCycleHistory(sourceId, { bucketId }, settings, 8, now)]));
  const cachedCycles = measure(readCycles);
  const cyclesAfterStatusWrite = measure(() => {
    store.setSourceStatus('codex', 'connected', 'Synthetic status-only refresh.');
    return readCycles();
  });
  if (cyclesAfterStatusWrite.resultSha256 !== cachedCycles.resultSha256) throw new Error('Status-only refresh changed cycle history.');
  console.log(JSON.stringify({
    records: count,
    node: process.version,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    uncached,
    cached,
    snapshotUncachedCycles,
    snapshotCached,
    sessionSearch,
    afterStatusWrite,
    cachedCycles,
    cyclesAfterStatusWrite,
  }, null, 2));
} finally {
  store.close();
  // Only the empty directory created above; never a recursive deletion.
  fs.rmdirSync(root);
}
