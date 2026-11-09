'use strict';
require('./setup.cjs');

// The bridge is written down three times: the preload that exposes it, the
// main-process handlers that answer it, and the renderer's type for it. A
// sandboxed preload cannot require a shared list, so this holds them together.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { mainApplication } = require('./helpers/main-application.cjs');

const root = path.resolve(__dirname, '..');

// Runs a preload against a recording ipcRenderer and calls every method once.
function bridgeOf(file) {
  let bridge;
  const invoked = new Set();
  const listened = new Set();
  const listeners = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron', file), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: {
        invoke: async (channel) => { invoked.add(channel); return null; },
        on: (channel, listener) => { listened.add(channel); listeners.push(listener); },
        removeListener() {},
      },
    }),
  });
  const channelsOf = new Map();
  for (const [name, method] of Object.entries(bridge)) {
    const before = new Set([...invoked, ...listened]);
    const result = method(() => true);
    if (typeof result === 'function') result();
    else result?.catch?.(() => {});
    channelsOf.set(name, [...invoked, ...listened].filter((channel) => !before.has(channel)));
  }
  // Some channels are only called in answer to a message from the main process.
  for (const listener of listeners) listener({}, 'token');
  return { methods: Object.keys(bridge).sort(), invoked, listened, channelsOf };
}

// Every channel the main process answers, and every channel it sends on.
function mainProcess() {
  const { main, handlers } = mainApplication({ electron: { Menu: { buildFromTemplate: (template) => template } } });
  main.ipc.registerIpc();
  const sources = ['app', '.'].flatMap((folder) => fs.readdirSync(path.join(root, 'electron', folder))
    .filter((name) => name.endsWith('.cjs') && !name.endsWith('preload.cjs'))
    .map((name) => fs.readFileSync(path.join(root, 'electron', folder, name), 'utf8'))).join('\n');
  const sent = new Set([...sources.matchAll(/\.send\('([a-z-]+:[a-z-]+)'/g)].map((match) => match[1]));
  return { handled: new Set(handlers.keys()), sent };
}

// The method names of a bridge type in src/types.ts.
function typedMethods(typeName) {
  const source = fs.readFileSync(path.join(root, 'src', 'types.ts'), 'utf8');
  const start = source.indexOf(`export type ${typeName} = {`);
  assert.notEqual(start, -1, `${typeName} is declared in src/types.ts`);
  const body = source.slice(start, source.indexOf('\n};', start));
  // Members sit at two spaces; a member's own nested fields are indented further.
  return [...body.matchAll(/^ {2}(\w+)\??[(:]/gm)].map((match) => match[1]).sort();
}

test('every dashboard bridge method reaches a handler, every handler is reachable, and the type lists the same methods', () => {
  const dashboard = bridgeOf('preload.cjs');
  const flyout = bridgeOf('flyout-preload.cjs');
  const { handled, sent } = mainProcess();

  for (const channel of dashboard.invoked) assert.ok(handled.has(channel), `no handler answers ${channel}`);
  for (const channel of flyout.invoked) assert.ok(handled.has(channel), `no handler answers ${channel}`);
  for (const channel of handled) {
    const preload = channel.startsWith('flyout:') ? flyout : dashboard;
    assert.ok(preload.invoked.has(channel), `nothing in the ${channel.startsWith('flyout:') ? 'flyout' : 'dashboard'} preload calls ${channel}`);
  }
  // The flyout reaches only its own channels, and the dashboard none of them.
  assert.ok([...flyout.invoked].every((channel) => channel.startsWith('flyout:')));
  assert.ok([...dashboard.invoked].every((channel) => !channel.startsWith('flyout:')));

  // Each channel a preload listens on is one the main process sends, and the reverse.
  const listened = new Set([...dashboard.listened, ...flyout.listened]);
  assert.deepEqual([...listened].sort(), [...sent].sort());

  assert.deepEqual(typedMethods('Bridge'), dashboard.methods);
  assert.deepEqual(typedMethods('FlyoutBridge'), flyout.methods);
});
