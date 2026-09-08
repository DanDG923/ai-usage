'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  collectFromAppServer,
  importLocalSessions,
  JsonLineClient,
  readSessionLines,
  recordRateLimit,
  refreshCodex,
} = require('../electron/codex-collector.cjs');

function makeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test('the JSON-line client rejects pending and future requests when the child cannot start', async () => {
  const child = makeChild();
  const client = new JsonLineClient('C:\\fixture\\codex.exe', (file, args, options) => {
    assert.equal(file, 'C:\\fixture\\codex.exe');
    assert.deepEqual(args, ['app-server', '--stdio']);
    assert.equal(options.cwd, 'C:\\fixture');
    assert.ok(Object.hasOwn(options.env, 'PATH'));
    return child;
  });
  const pending = client.request('initialize');

  child.emit('error', new Error('spawn ENOENT'));

  await assert.rejects(pending, /spawn ENOENT/);
  await assert.rejects(client.request('account/usage/read'), /spawn ENOENT/);
});

for (const pipe of ['stdin', 'stdout', 'stderr']) {
  test(`the JSON-line client rejects a pending request when ${pipe} fails`, async () => {
    const child = makeChild();
    const client = new JsonLineClient('C:\\fixture\\codex.exe', () => child);
    const pending = client.request('account/rateLimits/read');

    child[pipe].emit('error', new Error(`${pipe} EPIPE`));

    await assert.rejects(pending, new RegExp(`${pipe} EPIPE`));
  });
}

test('the JSON-line client handles an asynchronous stdin write failure', async () => {
  const child = makeChild();
  child.stdin = Object.assign(new EventEmitter(), {
    write(_message, callback) {
      queueMicrotask(() => callback(new Error('write EPIPE')));
      return false;
    },
  });
  const client = new JsonLineClient('C:\\fixture\\codex.exe', () => child);

  await assert.rejects(client.request('initialize'), /write EPIPE/);
});

test('the JSON-line client still resolves valid JSON-line responses', async () => {
  const child = makeChild();
  const client = new JsonLineClient('C:\\fixture\\codex.exe', () => child);
  const response = client.request('account/usage/read');

  child.stdout.write('null\n[]\n42\n');
  child.stdout.write(`${JSON.stringify({ id: 1, result: { dailyUsageBuckets: [] } })}\n`);

  assert.deepEqual(await response, { dailyUsageBuckets: [] });
  client.close();
});

test('a rate-limit window with no used percentage remains unknown', () => {
  const observations = [];
  const count = recordRateLimit({
    recordObservation: (observation) => observations.push(observation),
  }, {
    limitId: 'weekly',
    primary: {
      windowDurationMins: 10_080,
      resetsAt: 2_000_000_000,
    },
  }, '2033-05-17T00:00:00.000Z', 'official');

  assert.equal(count, 0);
  assert.deepEqual(observations, []);
});

test('an explicit zero used percentage remains a valid observation', () => {
  const observations = [];
  const count = recordRateLimit({
    recordObservation: (observation) => observations.push(observation),
  }, {
    limitId: 'weekly',
    primary: {
      usedPercent: 0,
      windowDurationMins: 10_080,
      resetsAt: 2_000_000_000,
    },
  }, '2033-05-17T00:00:00.000Z', 'official');

  assert.equal(count, 1);
  assert.equal(observations[0].usedPercent, 0);
  assert.equal(observations[0].remainingPercent, 100);
});

test('a database failure is not treated as a rejected historical quota window', () => {
  const failure = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
  let rejected = 0;
  assert.throws(() => recordRateLimit({
    recordObservation: () => { throw failure; },
  }, {
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2_000_000_000 },
  }, '2033-05-17T00:00:00.000Z', 'local-official', {}, {
    onRejected: () => { rejected += 1; },
  }), (error) => error === failure);
  assert.equal(rejected, 0);
});

test('an optional daily-usage failure does not discard a successful rate-limit reading', async () => {
  const observations = [];
  let closed = false;
  const client = {
    async request(method) {
      if (method === 'initialize') return {};
      if (method === 'account/rateLimits/read') {
        return {
          rateLimits: {
            limitId: 'weekly',
            primary: {
              usedPercent: 23,
              windowDurationMins: 10_080,
              resetsAt: Math.floor((Date.now() + 4 * 86_400_000) / 1000),
            },
          },
        };
      }
      if (method === 'account/usage/read') throw new Error('daily usage is unavailable');
      throw new Error(`Unexpected method: ${method}`);
    },
    notify() {},
    close() { closed = true; },
  };

  const result = await collectFromAppServer({
    recordObservation: (observation) => observations.push(observation),
    upsertDailyUsage() { throw new Error('no daily buckets should be written'); },
  }, 'codex.exe', { clientFactory: () => client });

  assert.equal(result.observations, 1);
  assert.equal(result.dailyBuckets, 0);
  assert.equal(result.usageWarning, 'Codex daily usage could not be read.');
  assert.equal(observations[0].usedPercent, 23);
  assert.equal(closed, true);
});

test('a session file disappearing after discovery is skipped without aborting collection', () => {
  assert.equal(readSessionLines('rotated-away.jsonl', () => { throw new Error('ENOENT'); }), null);
});

test('a local session scan failure cannot block current app-server limits', async () => {
  const statuses = [];
  let appServerCalls = 0;
  const result = await refreshCodex({
    setSourceStatus: (...args) => statuses.push(args),
  }, {
    findBinary: () => 'codex.exe',
    importSessions: () => { throw new Error('session file was rotated'); },
    collectAppServer: async () => {
      appServerCalls += 1;
      return { observations: 1, dailyBuckets: 1, resetCredits: 0, usageWarning: null };
    },
  });

  assert.equal(appServerCalls, 1);
  assert.equal(result.appServer.observations, 1);
  assert.match(result.localWarning, /session file was rotated/);
  assert.equal(statuses[0][1], 'degraded');
});

test('optional daily history degradation still records a successful official scan', async () => {
  const statuses = [];
  await refreshCodex({
    setSourceStatus: (...args) => statuses.push(args),
  }, {
    findBinary: () => 'codex.exe',
    importSessions: () => ({ importedFiles: 0, events: 0, observations: 0 }),
    collectAppServer: async () => ({
      observations: 1,
      dailyBuckets: 0,
      resetCredits: null,
      usageWarning: 'Codex daily usage could not be read.',
    }),
  });

  assert.equal(statuses[0][1], 'degraded');
  assert.deepEqual(statuses[0][4], { scanSucceeded: true });
});

test('an app-server failure does not mark the current scan successful', async () => {
  const statuses = [];
  await refreshCodex({
    setSourceStatus: (...args) => statuses.push(args),
  }, {
    findBinary: () => 'codex.exe',
    importSessions: () => ({ importedFiles: 1, events: 1, observations: 1 }),
    collectAppServer: async () => { throw new Error('server unavailable'); },
  });

  assert.equal(statuses[0][1], 'observing');
  assert.deepEqual(statuses[0][4], { scanSucceeded: false });
});

test('one malformed Codex token count is rejected without stopping the session log or freezing its cursor', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { UsageStore } = require('../electron/store.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-codex-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const sessions = path.join(root, '.codex', 'sessions', '2026', '08');
  fs.mkdirSync(sessions, { recursive: true });
  const tokenCount = (timestamp, usage) => ({
    type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: usage } },
  });
  const lines = [
    { type: 'session_meta', timestamp: '2026-08-29T09:00:00Z', payload: { id: 'session-1', cwd: 'C:/work/demo' } },
    { type: 'turn_context', timestamp: '2026-08-29T09:00:01Z', payload: { model: 'gpt-5.6-sol' } },
    tokenCount('2026-08-29T09:01:00Z', { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 }),
    tokenCount('2026-08-29T09:02:00Z', { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 99 }),
    tokenCount('2026-08-29T09:03:00Z', { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 }),
  ];
  fs.writeFileSync(path.join(sessions, 'rollout.jsonl'), `${lines.map(JSON.stringify).join('\n')}\n`);
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try {
    const first = importLocalSessions(store);
    assert.equal(first.events, 2);
    assert.equal(first.rejected, 1);
    assert.match(first.lastRejection, /reasoning/i);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 2);
    const again = importLocalSessions(store);
    assert.equal(again.events, 0, 'the cursor advanced past the bad row');
  } finally {
    store.close();
    process.env.USERPROFILE = oldProfile;
  }
});

test('two Codex token counts in the same millisecond are both kept, and a rescan assigns the same keys', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { UsageStore } = require('../electron/store.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-codex-'));
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const sessions = path.join(root, '.codex', 'sessions', '2026', '08');
  fs.mkdirSync(sessions, { recursive: true });
  const tokenCount = (timestamp, usage) => ({
    type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: usage } },
  });
  const usage = (output) => ({ input_tokens: 100, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 });
  const lines = [
    { type: 'session_meta', timestamp: '2026-08-29T09:00:00.000Z', payload: { id: 'session-1', cwd: 'C:/work/demo' } },
    { type: 'turn_context', timestamp: '2026-08-29T09:00:01.000Z', payload: { model: 'gpt-5.6-sol' } },
    tokenCount('2026-08-29T09:01:00.000Z', usage(10)),
    // Parallel tool turns: a different count reported at the same instant.
    tokenCount('2026-08-29T09:01:00.000Z', usage(25)),
    tokenCount('2026-08-29T09:02:00.000Z', usage(7)),
  ];
  fs.writeFileSync(path.join(sessions, 'rollout.jsonl'), `${lines.map(JSON.stringify).join('\n')}\n`);
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try {
    assert.equal(importLocalSessions(store).events, 3);
    const rows = () => store.db.prepare('SELECT event_key, output_tokens FROM usage_events ORDER BY event_key').all();
    const first = rows();
    assert.deepEqual(first.map((row) => row.output_tokens), [10, 25, 7]);
    assert.deepEqual(first.map((row) => row.event_key), [
      'codex:session-1:2026-08-29T09:01:00.000Z', 'codex:session-1:2026-08-29T09:01:00.000Z#1', 'codex:session-1:2026-08-29T09:02:00.000Z',
    ]);
    // Forgetting the cursor forces a rescan from the start of the file. The
    // ordinal is derived from file order, so nothing is duplicated.
    store.forgetImportedFile(path.join(sessions, 'rollout.jsonl'));
    importLocalSessions(store);
    assert.deepEqual(rows(), first);
    // An appended record after the cursor continues the same numbering.
    fs.appendFileSync(path.join(sessions, 'rollout.jsonl'), `${JSON.stringify(tokenCount('2026-08-29T09:02:00.000Z', usage(3)))}\n`);
    assert.equal(importLocalSessions(store).events, 1);
    assert.equal(rows().at(-1).event_key, 'codex:session-1:2026-08-29T09:02:00.000Z#1');
  } finally {
    store.close();
    process.env.USERPROFILE = oldProfile;
  }
});

test('CODEX_HOME relocates the session scan and a relative override is ignored', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { UsageStore } = require('../electron/store.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-codex-home-'));
  const previous = { USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };
  const home = path.join(root, 'relocated-codex');
  const sessions = path.join(home, 'sessions', '2026', '08');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  const lines = [
    { type: 'session_meta', timestamp: '2026-08-29T09:00:00Z', payload: { id: 'session-2', cwd: 'C:/work/demo' } },
    { type: 'event_msg', timestamp: '2026-08-29T09:01:00Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } } } },
  ];
  fs.writeFileSync(path.join(sessions, 'rollout.jsonl'), `${lines.map(JSON.stringify).join('\n')}\n`);
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try {
    process.env.USERPROFILE = path.join(root, 'profile');
    process.env.CODEX_HOME = home;
    assert.equal(importLocalSessions(store).events, 1);
    store.forgetImportedFile(path.join(sessions, 'rollout.jsonl'));
    process.env.CODEX_HOME = 'relocated-codex';
    assert.equal(importLocalSessions(store).events, 0, 'a relative override must not resolve against the launch directory');
    delete process.env.CODEX_HOME;
    delete process.env.USERPROFILE;
    assert.deepEqual(importLocalSessions(store), {
      importedFiles: 0, events: 0, observations: 0, rejected: 0, lastRejection: null,
      duplicateEvents: 0, reconciledEvents: 0, reconciliationBackup: null, readErrors: 0, lastReadError: null,
    });
  } finally {
    store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('session logs the OS refused to read degrade the Codex status instead of passing silently', async () => {
  const statuses = [];
  await refreshCodex({
    setSourceStatus: (...args) => statuses.push(args),
  }, {
    findBinary: () => 'codex.exe',
    importSessions: () => ({ importedFiles: 3, events: 9, observations: 1, readErrors: 2, lastReadError: 'EBUSY' }),
    collectAppServer: async () => ({ observations: 1, dailyBuckets: 0, resetCredits: null, usageWarning: null }),
  });
  assert.equal(statuses[0][1], 'degraded');
  assert.match(statuses[0][2], /could not be scanned/);
  assert.match(statuses[0][3].localWarning, /2 Codex session logs could not be read \(EBUSY\)/);
});

test('main Pro weekly and separate Spark windows keep their identity for existing stored observations', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { UsageStore } = require('../electron/store.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-spark-labels-'));
  const store = new UsageStore(path.join(root, 'usage.sqlite'), path.join(root, 'Backups'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const now = Date.now();
  const rawWindow = (minutes, usedPercent) => ({ usedPercent, windowDurationMins: minutes, resetsAt: Math.floor((now + minutes * 60_000) / 1000) });
  recordRateLimit(store, { limitId: 'codex', planType: 'pro', primary: rawWindow(10080, 2), secondary: null }, new Date(now).toISOString(), 'official');
  recordRateLimit(store, { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', planType: 'pro', primary: rawWindow(300, 0), secondary: rawWindow(10080, 0) }, new Date(now).toISOString(), 'official');
  assert.equal(store.db.prepare("SELECT bucket_name FROM quota_observations WHERE bucket_id = 'codex_bengalfox:primary'").get().bucket_name, 'GPT-5.3-Codex-Spark · Five hour');
  // Simulate names stored by 1.0.35: fixing the display must not require rewriting history.
  store.db.exec("UPDATE quota_observations SET bucket_name = 'Weekly' WHERE bucket_id = 'codex_bengalfox:secondary'");
  const quota = store.getQuota('codex', store.getSettings(), now);
  assert.equal(quota.bucketId, 'codex:primary');
  assert.equal(quota.remainingPercent, 98);
  assert.equal(quota.windows.filter(w => w.metadata.limitId === 'codex').length, 1);
  assert.equal(quota.windows.find(w => w.bucketId === 'codex_bengalfox:secondary').bucketName, 'GPT-5.3-Codex-Spark · Weekly');
  assert.equal(store.db.prepare("SELECT bucket_name FROM quota_observations WHERE bucket_id = 'codex_bengalfox:secondary'").get().bucket_name, 'Weekly');
});
