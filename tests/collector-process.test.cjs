'use strict';

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
