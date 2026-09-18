'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createCollectorHost, createInlineCollectorHost } = require('../electron/collector-host.cjs');
const { createCollectorService, serializeSettled, serveParentPort } = require('../electron/collector-service.cjs');

function fakeStore() {
  return { closed: false, close() { this.closed = true; } };
}

test('the service runs both collectors against one lazily opened store and serialises outcomes', async () => {
  let opened = 0;
  const store = fakeStore();
  const calls = [];
  const service = createCollectorService({
    databasePath: 'db', backupDirectory: 'backups', inboxPath: 'inbox',
    openStore: () => { opened += 1; return store; },
    collectors: {
      codex: async (target) => { calls.push(['codex', target === store]); return { observations: 2 }; },
      claude: async (target, inbox) => { calls.push(['claude', target === store, inbox]); throw new Error('Claude refresh failed'); },
    },
  });
  assert.equal(opened, 0);
  const result = await service.handle({ type: 'refresh-all' });
  assert.equal(opened, 1);
  assert.deepEqual(calls, [['codex', true], ['claude', true, 'inbox']]);
  assert.deepEqual(result.codex, { status: 'fulfilled', value: { observations: 2 } });
  assert.deepEqual(result.claude, { status: 'rejected', reason: { message: 'Claude refresh failed' } });
  await service.handle({ type: 'refresh-claude' });
  assert.equal(opened, 1);
  await service.handle({ type: 'close' });
  assert.equal(store.closed, true);
  await assert.rejects(service.handle({ type: 'nonsense' }), /Unknown collector request/);
});

test('serializeSettled never leaks Error instances across the process boundary', () => {
  assert.deepEqual(serializeSettled({ status: 'rejected', reason: new Error('boom') }), { status: 'rejected', reason: { message: 'boom' } });
  assert.deepEqual(serializeSettled({ status: 'rejected', reason: undefined }), { status: 'rejected', reason: { message: 'Unknown local error.' } });
  assert.deepEqual(serializeSettled({ status: 'fulfilled', value: 1 }), { status: 'fulfilled', value: 1 });
});

test('the parent port protocol correlates replies by id and reports failures as messages', async () => {
  const port = new EventEmitter();
  const sent = [];
  port.postMessage = (message) => sent.push(message);
  const service = { handle: async (request) => { if (request.type === 'fail') throw new Error('nope'); return { echo: request.type, extra: request.extra }; } };
  serveParentPort(port, service);
  port.emit('message', { data: { id: 1, type: 'ping', payload: { extra: 'x' } } });
  port.emit('message', { data: { id: 2, type: 'fail' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.find((entry) => entry.id === 1), { id: 1, ok: true, result: { echo: 'ping', extra: 'x' } });
  assert.deepEqual(sent.find((entry) => entry.id === 2), { id: 2, ok: false, error: { message: 'nope' } });
});

function fakeChild() {
  const child = new EventEmitter();
  child.sent = [];
  child.killed = false;
  child.postMessage = (message) => child.sent.push(message);
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
}

test('idle collectors close their store, exit, and restart without rejecting new work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const children = [];
  const host = createCollectorHost({ fork: () => {
    const child = fakeChild();
    child.kill = () => { child.killed = true; };
    children.push(child); return child;
  }, modulePath: 'x', config: {}, idleTimeoutMs: 30 });
  t.after(() => host.stop());
  const first = host.refreshAll();
  const overlap = host.refreshClaude();
  const a = children[0];
  a.emit('message', { id: a.sent[0].id, ok: true, result: 1 });
  await first;
  t.mock.timers.tick(100);
  assert.equal(a.sent.length, 2, 'never close while another request is pending');
  a.emit('message', { id: a.sent[1].id, ok: true, result: 2 });
  await overlap;
  t.mock.timers.tick(29);
  assert.equal(host.running, true);
  t.mock.timers.tick(1);
  assert.equal(a.sent.at(-1).type, 'close');
  assert.equal(a.killed, false, 'wait for the database close acknowledgement');
  assert.equal(host.running, false);
  const next = host.refreshAll();
  const b = children[1];
  a.emit('message', { id: a.sent.at(-1).id, ok: true, result: { closed: true } });
  assert.equal(a.killed, true);
  a.emit('exit', 0);
  b.emit('message', { id: b.sent[0].id, ok: true, result: 3 });
  assert.equal(await next, 3);
  assert.equal(host.running, true);
});

test('new collector work cancels idle exit and an unresponsive idle close is bounded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = fakeChild();
  const host = createCollectorHost({ fork: () => a, modulePath: 'x', config: {}, idleTimeoutMs: 30 });
  t.after(() => host.stop());
  const first = host.refreshAll();
  a.emit('message', { id: a.sent[0].id, ok: true, result: 1 });
  await first;
  t.mock.timers.tick(29);
  const next = host.refreshClaude();
  t.mock.timers.tick(30);
  assert.equal(a.sent.length, 2);
  a.emit('message', { id: a.sent[1].id, ok: false, error: { message: 'provider offline' } });
  await assert.rejects(next, /provider offline/);
  t.mock.timers.tick(30);
  assert.equal(a.sent.at(-1).type, 'close');
  t.mock.timers.tick(5000);
  assert.equal(a.killed, true);
});

test('a graceful service close waits for accepted collection to finish', async () => {
  let finish;
  const wait = new Promise((resolve) => { finish = resolve; });
  const store = fakeStore();
  const service = createCollectorService({ databasePath: 'db', openStore: () => store,
    collectors: { codex: async () => wait, claude: async () => ({}) } });
  const refresh = service.handle({ type: 'refresh-all' });
  await new Promise((resolve) => setImmediate(resolve));
  const closing = service.handle({ type: 'close' });
  assert.equal(store.closed, false);
  finish({});
  await Promise.all([refresh, closing]);
  assert.equal(store.closed, true);
});

test('the host spawns on demand, resolves by id, and fails in-flight requests if the child exits', async () => {
  const children = [];
  const host = createCollectorHost({
    fork: (modulePath, args) => {
      const child = fakeChild();
      child.modulePath = modulePath;
      child.args = args;
      children.push(child);
      return child;
    },
    modulePath: 'collector-service.cjs',
    config: { databasePath: 'db' },
    requestTimeoutMs: 1000,
  });
  assert.equal(host.running, false);
  const pending = host.refreshAll();
  assert.equal(children.length, 1);
  assert.deepEqual(JSON.parse(children[0].args[0]), { databasePath: 'db' });
  assert.equal(children[0].sent[0].type, 'refresh-all');
  children[0].emit('message', { id: children[0].sent[0].id, ok: true, result: { codex: { status: 'fulfilled', value: {} } } });
  assert.deepEqual(await pending, { codex: { status: 'fulfilled', value: {} } });

  const failing = host.refreshClaude();
  children[0].emit('message', { id: children[0].sent[1].id, ok: false, error: { message: 'bad' } });
  await assert.rejects(failing, /bad/);

  const orphaned = host.refreshAll();
  children[0].emit('exit', 1);
  await assert.rejects(orphaned, /stopped unexpectedly/);
  assert.equal(host.running, false);
  const respawned = host.refreshAll();
  assert.equal(children.length, 2);
  host.stop();
  assert.equal(children[1].killed, true);
  await assert.rejects(respawned, /stopped/);
});

test('a request that never answers times out and recycles the child', async () => {
  const children = [];
  const host = createCollectorHost({
    fork: () => { const child = fakeChild(); children.push(child); return child; },
    modulePath: 'x',
    config: {},
    requestTimeoutMs: 20,
  });
  await assert.rejects(host.refreshAll(), /Timed out/);
  assert.equal(children[0].killed, true);
  assert.equal(host.running, false);
});

test('the inline host exposes the same surface over an in-process service', async () => {
  let closed = false;
  const host = createInlineCollectorHost({ handle: async (request) => ({ type: request.type }), close: () => { closed = true; } });
  assert.deepEqual(await host.refreshAll(), { type: 'refresh-all' });
  assert.deepEqual(await host.refreshClaude(), { type: 'refresh-claude' });
  host.stop();
  assert.equal(closed, true);
});

test('a recycled child exiting late cannot fail a request already registered against its replacement', async () => {
  const children = [];
  const host = createCollectorHost({
    fork: () => {
      const child = fakeChild();
      // Real processes exit asynchronously after kill(); this child only
      // announces its exit when the test says so.
      child.kill = () => { child.killed = true; };
      children.push(child);
      return child;
    },
    modulePath: 'x',
    config: {},
    requestTimeoutMs: 1000,
  });
  const first = host.refreshAll();
  host.stop();
  await assert.rejects(first, /was stopped/);
  const second = host.refreshAll();
  assert.equal(children.length, 2);
  children[0].emit('exit', 0);
  children[1].emit('message', { id: children[1].sent[0].id, ok: true, result: { ok: true } });
  assert.deepEqual(await second, { ok: true });
  assert.equal(host.running, true);
});

test('overlapping requests never run one source\'s collector concurrently', async () => {
  let running = 0;
  let peak = 0;
  const order = [];
  const slow = (name) => async () => {
    running += 1;
    peak = Math.max(peak, running);
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    order.push(`${name}:end`);
    return { name };
  };
  const service = createCollectorService({
    databasePath: 'db', backupDirectory: 'backups', inboxPath: 'inbox',
    openStore: () => fakeStore(),
    collectors: { codex: async () => ({}), claude: slow('claude') },
  });
  const [all, only] = await Promise.all([service.handle({ type: 'refresh-all' }), service.handle({ type: 'refresh-claude' })]);
  assert.equal(peak, 1, 'the Claude collector ran against itself');
  assert.deepEqual(order, ['claude:start', 'claude:end'], 'waiting requests should share the same scan');
  assert.equal(all.claude.status, 'fulfilled');
  assert.equal(only.claude.status, 'fulfilled');
});

test('a failed queued run does not block the next one for that source', async () => {
  let calls = 0;
  const service = createCollectorService({
    databasePath: 'db', backupDirectory: 'backups', inboxPath: 'inbox',
    openStore: () => fakeStore(),
    collectors: {
      codex: async () => ({}),
      claude: async () => { calls += 1; if (calls === 1) throw new Error('first fails'); return { calls }; },
    },
  });
  const first = await service.handle({ type: 'refresh-claude' });
  assert.equal(first.claude.status, 'rejected');
  const second = await service.handle({ type: 'refresh-claude' });
  assert.deepEqual(second.claude, { status: 'fulfilled', value: { calls: 2 } });
});

test('the host forwards fork options so the collector child inherits the launch environment', () => {
  const forks = [];
  const host = createCollectorHost({
    fork: (modulePath, args, options) => { forks.push(options); return fakeChild(); },
    modulePath: 'collector-service.cjs',
    config: { databasePath: 'db' },
    forkOptions: { env: { GH_TOKEN: 'kept-for-providers', PATH: 'C:\\Windows' } },
  });
  void host.refreshAll().catch(() => {});
  assert.equal(forks[0].serviceName, 'AI Usage collectors');
  assert.deepEqual(forks[0].env, { GH_TOKEN: 'kept-for-providers', PATH: 'C:\\Windows' });
  host.stop();
});
