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
const models = ['gpt-5.6-sol', 'claude-opus-5', 'gpt-5.6-sol-20260901', 'unknown-model'];
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
  });
  const settings = store.getSettings();
  for (let index = 0; index < 2; index += 1) store.getCostAnalytics(30, settings, now);
  const timings = [];
  let result;
  for (let index = 0; index < 7; index += 1) {
    const start = performance.now();
    result = store.getCostAnalytics(30, settings, now);
    timings.push(performance.now() - start);
  }
  const sorted = [...timings].sort((a, b) => a - b);
  console.log(JSON.stringify({
    records: count,
    node: process.version,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    medianMs: Number(sorted[3].toFixed(2)),
    runsMs: timings.map((value) => Number(value.toFixed(2))),
    resultSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
  }, null, 2));
} finally {
  store.close();
  // Only the empty directory created above; never a recursive deletion.
  fs.rmdirSync(root);
}
