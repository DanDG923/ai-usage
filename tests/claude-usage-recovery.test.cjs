'use strict';
require('./setup.cjs');
// An absolute program path on this system: exactly C:\fixture\claude.exe on Windows.
const FIXTURE_CLAUDE = require('node:path').join(process.platform === 'win32' ? 'C:\\' : '/', 'fixture', 'claude.exe');
const assert = require('node:assert/strict');
const test = require('node:test');
const { createClaudeAgentSdkUsagePort } = require('../electron/claude-agent-usage.cjs');
const { createUsageDiagnostics } = require('../electron/claude-usage-diagnostics.cjs');
const fresh = { subscription_type: 'max', rate_limits_available: true, rate_limits: {
  seven_day: { utilization: 1, resets_at: '2026-09-07T08:00:00Z' },
  model_scoped: [{ display_name: 'Fable', utilization: 1, resets_at: '2026-09-07T08:00:00Z' }],
} };
const ok = '[DEBUG] fetchUtilization: 200 after 1 attempt(s)\n';
const offline = '[ERROR] Failed to load usage data: connect ECONNREFUSED fixture-secret\n';
function fixture(steps, options = {}) {
  let calls = 0;
  let closed = 0;
  const port = createClaudeAgentSdkUsagePort({ retryDelayMs: 0, ...options,
    findClaudeBinary: () => FIXTURE_CLAUDE,
    loadSdk: async () => ({ query({ options: queryOptions }) {
      assert.equal(closed, calls, 'Previous query must close before a retry');
      const step = steps[calls++];
      assert.ok(step, 'No unbounded retries');
      assert.deepEqual(queryOptions.extraArgs, { 'debug-to-stderr': null });
      return {
        initializationResult: async () => ({}),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => step.payload ?? fresh,
        async return() {
          // Simulate stderr arriving after the stdout control response.
          queryOptions.stderr(step.log ?? ok);
          closed += 1;
          step.onClose?.();
          return { done: true };
        },
      };
    } }),
  });
  return { port, calls: () => calls };
}

test('cached windows after a failed fetch are rejected even when marked available', async () => {
  const f = fixture([{ log: offline }, { log: offline }]);
  await assert.rejects(f.port.read(), error => {
    assert.equal(error.code, 'claude-usage-econnrefused');
    assert.equal(error.collectionDiagnostics.attempts.length, 2);
    assert.equal(JSON.stringify(error).includes('fixture-secret'), false);
    return true;
  });
  assert.equal(f.calls(), 2);
});

test('one fresh process retry recovers a transient failure and retains safe attempt details', async () => {
  const f = fixture([{ log: offline }, { log: ok }]);
  const result = await f.port.read();
  assert.deepEqual(result, fresh);
  assert.deepEqual(result.collectionDiagnostics.attempts.map(a => a.outcome), ['failed', 'fresh']);
});

test('empty subscription responses retry once then fail without inventing fresh evidence', async () => {
  const payload = { subscription_type: 'max', rate_limits_available: false, rate_limits: null };
  const f = fixture([{ payload, log: ok }, { payload, log: ok }]);
  await assert.rejects(f.port.read(), { code: 'claude-usage-empty' });
  assert.equal(f.calls(), 2);
});

test('empty subscription responses without a usage diagnostic are not retried', async () => {
  const payload = { subscription_type: 'max', rate_limits_available: false, rate_limits: null };
  const f = fixture([{ payload, log: '' }]);
  await assert.rejects(f.port.read(), { code: 'claude-usage-empty' });
  assert.equal(f.calls(), 1);
});

test('non-subscription sessions can legitimately have no plan windows', async () => {
  const payload = { subscription_type: null, rate_limits_available: false, rate_limits: null };
  const f = fixture([{ payload, log: '' }]);
  assert.deepEqual(await f.port.read(), payload);
  assert.equal(f.calls(), 1);
});

// As Claude Code answered a Refresh on 7 October 2026, on an account whose
// plan windows were running: in under a second, without a fetch.
const signedOut = { subscription_type: null, rate_limits_available: false, rate_limits: null };

test('no subscription for an account known to have one retries once, then fails as signed out', async () => {
  const f = fixture([{ payload: signedOut, log: '' }, { payload: signedOut, log: '' }]);
  await assert.rejects(f.port.read({ expectSubscription: true }), (error) => {
    assert.equal(error.code, 'claude-usage-signed-out');
    assert.match(error.message, /did not report your Claude subscription sign-in/);
    assert.deepEqual(error.collectionDiagnostics.attempts.map((a) => a.errorCode),
      ['claude-usage-signed-out', 'claude-usage-signed-out']);
    return true;
  });
  assert.equal(f.calls(), 2);
});

test('a sign-in Claude Code sees on the retry recovers the read', async () => {
  const f = fixture([{ payload: signedOut, log: '' }, { log: ok }]);
  const result = await f.port.read({ expectSubscription: true });
  assert.deepEqual(result, fresh);
  assert.deepEqual(result.collectionDiagnostics.attempts.map((a) => a.outcome), ['failed', 'fresh']);
});

test('a protocol change that removes freshness diagnostics fails closed', async () => {
  const f = fixture([{ log: '' }, { log: '' }]);
  await assert.rejects(f.port.read(), { code: 'claude-usage-unverified' });
  assert.equal(f.calls(), 1);
});

test('a read Claude Code answers from its shared snapshot of the last minute is fresh', async () => {
  const f = fixture([{ log: '[DEBUG] Usage read answered from a snapshot 38s old; endpoint not asked\n' }]);
  const result = await f.port.read();
  assert.deepEqual(result, fresh);
  assert.deepEqual(result.collectionDiagnostics.attempts.map(a => a.outcome), ['fresh']);
  assert.equal(f.calls(), 1);
});

test('a snapshot older than the CLI serves fails closed', async () => {
  const f = fixture([{ log: '[DEBUG] Usage read answered from a snapshot 61s old; endpoint not asked\n' }]);
  await assert.rejects(f.port.read(), { code: 'claude-usage-unverified' });
  assert.equal(f.calls(), 1);
});

test('an old snapshot after an earlier fetch leaves the read unverified', () => {
  const d = createUsageDiagnostics();
  d.write(ok);
  d.write('[DEBUG] Usage read answered from a snapshot 61s old; endpoint not asked\n');
  assert.deepEqual(d.finish(), { outcome: 'unverified', code: null, httpStatus: null });
});

for (const status of [401, 403, 429]) {
  test(`HTTP ${status} does not trigger an immediate retry`, async () => {
    const f = fixture([{ log: `[ERROR] Failed to load usage data: Request failed with status code ${status}\n` }]);
    await assert.rejects(f.port.read(), { code: `claude-usage-http-${status}` });
    assert.equal(f.calls(), 1);
  });
}

test('cancellation during retry backoff prevents a second child', async () => {
  const controller = new AbortController();
  const f = fixture([{ log: offline, onClose: () => setTimeout(() => controller.abort(), 5) }], { retryDelayMs: 1000 });
  await assert.rejects(f.port.read({ signal: controller.signal }), { code: 'claude-usage-aborted' });
  assert.equal(f.calls(), 1);
});

test('diagnostics handle split chunks and ignore unrelated startup errors', () => {
  const d = createUsageDiagnostics();
  d.write('[ERROR] Failed to fetch org settings: ECONNREFUSED\n');
  d.write('[DEBUG] fetchUtilization: 200 after 1 attempt(s)\n');
  assert.equal(d.finish().outcome, 'verified');
  d.write('[ERROR] Failed to load us');
  d.write('age data: connect ECONN');
  d.write('REFUSED fixture-secret');
  assert.deepEqual(d.finish(), { outcome: 'failed', code: 'claude-usage-econnrefused', httpStatus: null });
});

test('oversized unrelated debug lines cannot prevent subsequent fetch diagnostics', () => {
  const d = createUsageDiagnostics();
  d.write('x'.repeat(100000));
  d.write('\n' + ok);
  assert.equal(d.finish().outcome, 'verified');
});

test('a failed live fetch cannot advance stored Claude or Fable evidence timestamps', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { UsageStore } = require('../electron/store.cjs');
  const { createFableUsageTracker } = require('../electron/fable-tracker.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-freshness-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'backups'));
  const f = fixture([{ log: ok }, { log: offline }, { log: offline }]);
  let now = new Date('2026-09-05T13:00:00Z');
  const tracker = createFableUsageTracker({ store, usagePort: f.port, clock: () => now, activityReader: { import: async () => ({}) } });
  try {
    await tracker.refresh();
    const before = store.db.prepare('SELECT source_id, observed_at FROM quota_observations ORDER BY source_id').all();
    now = new Date('2026-09-05T14:00:00Z');
    const failed = await tracker.refresh();
    assert.equal(failed.health.state, 'stale');
    assert.equal(failed.provider.attemptSucceeded, false);
    assert.equal(failed.provider.errorCode, 'claude-usage-econnrefused');
    assert.equal(failed.provider.collectionDiagnostics.attempts.length, 2);
    assert.deepEqual(store.db.prepare('SELECT source_id, observed_at FROM quota_observations ORDER BY source_id').all(), before);
  } finally { store.close(); }
});
