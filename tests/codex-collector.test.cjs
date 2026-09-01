'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  collectFromAppServer,
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
  const client = new JsonLineClient('codex.exe', () => child);
  const pending = client.request('initialize');

  child.emit('error', new Error('spawn ENOENT'));

  await assert.rejects(pending, /spawn ENOENT/);
  await assert.rejects(client.request('account/usage/read'), /spawn ENOENT/);
});

for (const pipe of ['stdin', 'stdout', 'stderr']) {
  test(`the JSON-line client rejects a pending request when ${pipe} fails`, async () => {
    const child = makeChild();
    const client = new JsonLineClient('codex.exe', () => child);
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
  const client = new JsonLineClient('codex.exe', () => child);

  await assert.rejects(client.request('initialize'), /write EPIPE/);
});

test('the JSON-line client still resolves valid JSON-line responses', async () => {
  const child = makeChild();
  const client = new JsonLineClient('codex.exe', () => child);
  const response = client.request('account/usage/read');

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
