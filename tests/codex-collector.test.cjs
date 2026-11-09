'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { join: joinPath } = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  collectFromAppServer,
  importLocalSessions,
  JsonLineClient,
  recordRateLimit,
  refreshCodex,
} = require('../electron/codex-collector.cjs');

// An absolute program path on this system: exactly C:\\fixture\\codex.exe on Windows.
const FIXTURE_FOLDER = joinPath(process.platform === 'win32' ? 'C:\\' : '/', 'fixture');
const FIXTURE_CODEX = joinPath(FIXTURE_FOLDER, 'codex.exe');

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
  const client = new JsonLineClient(FIXTURE_CODEX, (file, args, options) => {
    assert.equal(file, FIXTURE_CODEX);
    assert.deepEqual(args, ['app-server', '--stdio']);
    assert.equal(options.cwd, FIXTURE_FOLDER);
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
    const client = new JsonLineClient(FIXTURE_CODEX, () => child);
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
  const client = new JsonLineClient(FIXTURE_CODEX, () => child);

  await assert.rejects(client.request('initialize'), /write EPIPE/);
});

test('the JSON-line client still resolves valid JSON-line responses', async () => {
  const child = makeChild();
  const client = new JsonLineClient(FIXTURE_CODEX, () => child);
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
    transaction: (run) => run(),
    upsertDailyUsage() { throw new Error('no daily buckets should be written'); },
  }, 'codex.exe', { clientFactory: () => client });

  assert.equal(result.observations, 1);
  assert.equal(result.dailyBuckets, 0);
  assert.equal(result.usageWarning, 'Codex daily usage could not be read.');
  assert.equal(observations[0].usedPercent, 23);
  assert.equal(closed, true);
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
  // The official allowance is current; the local failure is reported, not
  // presented to the verdict and alerts as stale data.
  assert.equal(statuses[0][1], 'connected');
  assert.match(statuses[0][2], /could not be scanned/);
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

  assert.equal(statuses[0][1], 'connected');
  assert.match(statuses[0][2], /optional daily account history was unavailable/);
  assert.deepEqual(statuses[0][4], { scanSucceeded: true });
});

test('an app-server failure does not mark the current scan successful', async () => {
  const statuses = [];
  await refreshCodex({
    setSourceStatus: (...args) => statuses.push(args),
    hasUsableObservation: () => true,
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

test('session logs the OS refused to read are reported in the Codex status instead of passing silently', async () => {
  const statuses = [];
  await refreshCodex({
    setSourceStatus: (...args) => statuses.push(args),
  }, {
    findBinary: () => 'codex.exe',
    importSessions: () => ({ importedFiles: 3, events: 9, observations: 1, readErrors: 2, lastReadError: 'EBUSY' }),
    collectAppServer: async () => ({ observations: 1, dailyBuckets: 0, resetCredits: null, usageWarning: null }),
  });
  assert.equal(statuses[0][1], 'connected');
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

// The tests below run the real collector against a temporary store, with only
// the app server's responses stubbed.
function temporaryStore(t) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { UsageStore } = require('../electron/store.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-codex-status-'));
  const store = new UsageStore(path.join(root, 'usage.sqlite'), path.join(root, 'Backups'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return store;
}

const codexSource = (store) => store.prepare("SELECT id, status, status_detail, last_success_at FROM sources WHERE id = 'codex'").get();
const codexBuckets = (store) => store.prepare("SELECT DISTINCT bucket_id FROM quota_observations WHERE source_id = 'codex' ORDER BY bucket_id")
  .all().map((row) => row.bucket_id);
const liveWindow = (minutes, usedPercent, resetsInMs = minutes * 60_000) => ({
  usedPercent, windowDurationMins: minutes, resetsAt: Math.floor((Date.now() + resetsInMs) / 1000),
});
const noLocalRows = () => ({ importedFiles: 0, events: 0, observations: 0 });

// An app server that answers every request, with `rateLimits` as its reading.
const answeringAppServer = (rateLimits) => (store, binary) => collectFromAppServer(store, binary, {
  clientFactory: () => ({
    notify() {},
    close() {},
    request: async (method) => (method === 'account/rateLimits/read' ? rateLimits : {}),
  }),
});

const refreshWith = (store, collectAppServer, importSessions = noLocalRows) => refreshCodex(store, {
  findBinary: () => 'codex.exe', importSessions, collectAppServer,
});

const EMPTY_READINGS = [
  ['no result', null],
  ['an empty result', {}],
  ['no rate limits', { rateLimits: null, rateLimitsByLimitId: null }],
  ['an empty limit map', { rateLimitsByLimitId: {} }],
  ['a limit with no windows', { rateLimits: { limitId: 'codex', primary: null, secondary: null } }],
  ['a window with no used percentage', { rateLimitsByLimitId: { codex: { primary: { windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } }],
  ['a window with no reset', { rateLimitsByLimitId: { codex: { primary: { usedPercent: 12, windowDurationMins: 300 } } } }],
  ['an unexpected shape', { rateLimits: 'unsupported', rateLimitsByLimitId: 'unsupported' }],
];

for (const [name, reading] of EMPTY_READINGS) {
  test(`an app-server read with ${name} leaves the Codex allowance unknown instead of connected`, async (t) => {
    const store = temporaryStore(t);
    const result = await refreshWith(store, answeringAppServer(reading));

    assert.equal(result.appServer.observations, 0);
    const source = codexSource(store);
    assert.equal(source.status, 'unavailable');
    assert.equal(source.last_success_at, null, 'a read with no allowance is not a successful scan');
    assert.match(source.status_detail, /returned no allowance reading/);
    assert.match(source.status_detail, /allowance is unknown/);
    // Unknown stays unknown: no figure was stored to stand in for the missing one.
    assert.deepEqual(codexBuckets(store), []);
    assert.equal(store.getQuota('codex', store.getSettings(), Date.now()), null);
  });
}

test('an empty app-server read after a good one keeps the last reading and reports it as not replaced', async (t) => {
  const store = temporaryStore(t);
  const healthy = { rateLimits: { limitId: 'codex', planType: 'pro', primary: liveWindow(300, 30), secondary: liveWindow(10_080, 12) } };

  await refreshWith(store, answeringAppServer(healthy));
  const connected = codexSource(store);
  assert.equal(connected.status, 'connected');
  assert.equal(connected.status_detail, 'Connected through the local Codex app server.');
  assert.ok(connected.last_success_at);
  const stored = store.prepare("SELECT COUNT(*) AS n FROM quota_observations WHERE source_id = 'codex'").get().n;
  assert.equal(stored, 2);

  await refreshWith(store, answeringAppServer({}));
  const afterEmpty = codexSource(store);
  assert.equal(afterEmpty.status, 'stale');
  assert.match(afterEmpty.status_detail, /returned no allowance reading/);
  assert.match(afterEmpty.status_detail, /still active/);
  assert.equal(afterEmpty.last_success_at, connected.last_success_at, 'the last good scan is the one that read an allowance');
  assert.equal(store.prepare("SELECT COUNT(*) AS n FROM quota_observations WHERE source_id = 'codex'").get().n, stored);
  assert.equal(store.getQuota('codex', store.getSettings(), Date.now()).windows.length, 2);

  // The next good read reports exactly what a healthy refresh always has.
  await refreshWith(store, answeringAppServer(healthy));
  assert.equal(codexSource(store).status, 'connected');
  assert.equal(codexSource(store).status_detail, 'Connected through the local Codex app server.');
});

test('an empty app-server read beside a reading whose window has ended reports no usable allowance', async (t) => {
  const store = temporaryStore(t);
  const day = 86_400_000;
  recordRateLimit(store, {
    limitId: 'codex',
    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: Math.floor((Date.now() - day) / 1000) },
  }, new Date(Date.now() - day - 3_600_000).toISOString(), 'official');
  assert.equal(store.hasUsableObservation('codex'), true, 'the ended window is still valid history');

  await refreshWith(store, answeringAppServer({}));
  assert.equal(codexSource(store).status, 'unavailable');
});

test('a persistently failing app server keeps one status whether or not a run imports new local rows', async (t) => {
  const { decideNotifications, emptyState } = require('../electron/notifications.cjs');
  const store = temporaryStore(t);
  const failing = async () => { throw new Error('server unavailable'); };
  let run = 0;
  const withNewRows = (target) => {
    run += 1;
    const observations = recordRateLimit(target, { limitId: 'codex', primary: liveWindow(300, 20 + run), secondary: liveWindow(10_080, 5) },
      new Date(Date.now() - (10 - run) * 1000).toISOString(), 'local-official');
    return { importedFiles: 1, events: 3, observations };
  };

  // What the app hands the notifier after each refresh.
  const settings = { notifyFallback: true, notifyDesktop: true };
  let previous = { settings, sources: [{ id: 'codex', status: 'connected' }] };
  let state = decideNotifications({ previous: null, current: previous, state: emptyState() }).state;
  const statuses = [];
  const toasts = [];
  for (const importSessions of [withNewRows, noLocalRows, withNewRows, noLocalRows, noLocalRows, withNewRows]) {
    await refreshWith(store, failing, importSessions);
    const source = codexSource(store);
    statuses.push(source.status);
    assert.equal(source.last_success_at, null);
    assert.match(source.status_detail, /^App server unavailable; Local records were scanned\. server unavailable$/);
    const current = { settings, sources: [source] };
    const decided = decideNotifications({ previous, current, state });
    toasts.push(...decided.notifications.filter((entry) => entry.kind === 'fallback'));
    state = decided.state;
    previous = current;
  }

  assert.deepEqual(toasts.map((entry) => entry.title), [], 'no cached-data toast while a reading stays in force');
  assert.deepEqual(statuses, Array(6).fill('observing'));
});

test('a failing app server with no allowance still in force is an error, even on a run that imports old rows', async (t) => {
  const store = temporaryStore(t);
  const failing = async () => { throw new Error('server unavailable'); };
  const day = 86_400_000;
  const importsEndedWindow = (target) => ({
    importedFiles: 1,
    events: 1,
    observations: recordRateLimit(target, {
      limitId: 'codex',
      primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: Math.floor((Date.now() - day) / 1000) },
    }, new Date(Date.now() - day - 3_600_000).toISOString(), 'local-official'),
  });

  const first = await refreshWith(store, failing, importsEndedWindow);
  assert.equal(first.local.observations, 1);
  assert.equal(codexSource(store).status, 'error');
  await refreshWith(store, failing);
  assert.equal(codexSource(store).status, 'error');
});

test('a rejected window in an app-server reading is reported without discarding the valid ones', async (t) => {
  const store = temporaryStore(t);
  const reading = {
    rateLimitsByLimitId: {
      codex: { planType: 'pro', primary: liveWindow(300, 30), secondary: liveWindow(10_080, 12) },
      // Further ahead than the store accepts for any window.
      codex_far: { limitName: 'Far', primary: liveWindow(300, 10, 40 * 86_400_000) },
      codex_spark: { limitName: 'Spark', primary: liveWindow(300, 5) },
    },
  };

  const result = await answeringAppServer(reading)(store, 'codex.exe');
  assert.equal(result.observations, 3);
  assert.equal(result.rejected, 1);
  assert.match(result.lastRejection, /31 days/);
  assert.deepEqual(codexBuckets(store), ['codex:primary', 'codex:secondary', 'codex_spark:primary']);

  await refreshWith(store, answeringAppServer(reading));
  const source = codexSource(store);
  assert.equal(source.status, 'connected');
  assert.ok(source.last_success_at);
  assert.match(source.status_detail, /^Connected through the local Codex app server\. 1 allowance window in the reading was rejected and left unchanged \(.*31 days.*\)\.$/);
});

test('an app-server reading whose only window is rejected is not a successful read', async (t) => {
  const store = temporaryStore(t);
  const reading = { rateLimits: { limitId: 'codex', primary: liveWindow(300, 10, 40 * 86_400_000) } };

  await refreshWith(store, answeringAppServer(reading));
  const source = codexSource(store);
  assert.equal(source.status, 'unavailable');
  assert.equal(source.last_success_at, null);
  assert.match(source.status_detail, /could not be recorded \(.*31 days.*\)/);
  assert.deepEqual(codexBuckets(store), []);
});

test('a storage failure part-way through an app-server reading stores none of it', async (t) => {
  const store = temporaryStore(t);
  const failure = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
  const record = store.recordObservation.bind(store);
  let calls = 0;
  store.recordObservation = (observation) => {
    calls += 1;
    if (calls === 2) throw failure;
    return record(observation);
  };
  const reading = { rateLimits: { limitId: 'codex', primary: liveWindow(300, 30), secondary: liveWindow(10_080, 12) } };

  await assert.rejects(answeringAppServer(reading)(store, 'codex.exe'), (error) => error === failure);
  assert.equal(calls, 2);
  assert.deepEqual(codexBuckets(store), [], 'the first window is not committed without the second');
});

test('an app-server failure beside a failed local scan is an error, with or without a reading in force', async (t) => {
  const store = temporaryStore(t);
  recordRateLimit(store, { limitId: 'codex', primary: liveWindow(300, 20) }, new Date().toISOString(), 'official');
  assert.equal(store.hasUsableObservation('codex'), true);

  await refreshWith(store, async () => { throw new Error('server unavailable'); }, () => { throw new Error('session file was rotated'); });
  const source = codexSource(store);
  assert.equal(source.status, 'error');
  assert.match(source.status_detail, /^App server unavailable; Local session records were also unavailable\. server unavailable$/);
});

test('a missing Codex executable keeps one status whether or not a run imports new local rows', async (t) => {
  const store = temporaryStore(t);
  const withoutExecutable = (importSessions) => refreshCodex(store, {
    findBinary: () => null,
    importSessions,
    collectAppServer: async () => { throw new Error('the app server must not be started without an executable'); },
  });

  await withoutExecutable(noLocalRows);
  assert.equal(codexSource(store).status, 'unavailable', 'nothing has been read yet');

  let run = 0;
  const withNewRows = (target) => {
    run += 1;
    const observations = recordRateLimit(target, { limitId: 'codex', primary: liveWindow(300, 20 + run), secondary: liveWindow(10_080, 5) },
      new Date(Date.now() - (10 - run) * 1000).toISOString(), 'local-official');
    return { importedFiles: 1, events: 3, observations };
  };
  const statuses = [];
  for (const importSessions of [withNewRows, noLocalRows, withNewRows, noLocalRows, noLocalRows]) {
    const result = await withoutExecutable(importSessions);
    assert.equal(result.binary, null);
    const source = codexSource(store);
    statuses.push(source.status);
    assert.equal(source.status_detail, 'Codex executable was not found.');
  }
  assert.deepEqual(statuses, Array(5).fill('observing'));
});

test('a missing Codex executable with no allowance still in force is unavailable, even on a run that imports old rows', async (t) => {
  const store = temporaryStore(t);
  const day = 86_400_000;
  const importsEndedWindow = (target) => ({
    importedFiles: 1,
    events: 1,
    observations: recordRateLimit(target, {
      limitId: 'codex',
      primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: Math.floor((Date.now() - day) / 1000) },
    }, new Date(Date.now() - day - 3_600_000).toISOString(), 'local-official'),
  });
  const withoutExecutable = (importSessions) => refreshCodex(store, { findBinary: () => null, importSessions });

  const first = await withoutExecutable(importsEndedWindow);
  assert.equal(first.local.observations, 1);
  assert.equal(codexSource(store).status, 'unavailable');
  await withoutExecutable(noLocalRows);
  assert.equal(codexSource(store).status, 'unavailable');
});

test('a missing Codex executable beside a failed local scan is still an error', async (t) => {
  const store = temporaryStore(t);
  recordRateLimit(store, { limitId: 'codex', primary: liveWindow(300, 20) }, new Date().toISOString(), 'official');

  await refreshCodex(store, { findBinary: () => null, importSessions: () => { throw new Error('session file was rotated'); } });
  const source = codexSource(store);
  assert.equal(source.status, 'error');
  assert.match(source.status_detail, /^Codex executable was not found\. Codex local session scan failed: session file was rotated$/);
});
