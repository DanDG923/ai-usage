'use strict';
require('./setup.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createClaudeSetup } = require('../electron/claude-setup.cjs');

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-setup-'));
  const statePath = path.join(root, 'setup.json');
  const setup = createClaudeSetup({ statePath, findBinary: () => 'C:\\Claude Code\\claude.exe', run: async () => JSON.stringify({ loggedIn: false }), ...options });
  return { setup, statePath, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('fresh setup distinguishes missing executable, signed-out and failed auth checks', async () => {
  for (const [options, installed, auth] of [
    [{ findBinary: () => null }, false, 'unavailable'],
    [{}, true, 'signed-out'],
    [{ run: async () => { throw new Error('private diagnostic'); } }, true, 'unavailable'],
  ]) {
    const f = fixture(options);
    try { assert.deepEqual(await f.setup.status(), { installed, auth, dismissed: false, busy: false, helperInstalled: false }); } finally { f.clean(); }
  }
});

test('status never exposes account fields or credentials and first-run choice persists', async () => {
  const f = fixture({ run: async () => JSON.stringify({ loggedIn: true, email: 'private@example.test', token: 'never-return' }) });
  try {
    assert.equal(JSON.stringify(await f.setup.status()).includes('private'), false);
    assert.equal(JSON.stringify(await f.setup.status()).includes('never-return'), false);
    f.setup.skip();
    const reopened = createClaudeSetup({ statePath: f.statePath, findBinary: () => null });
    assert.equal((await reopened.status()).dismissed, true);
  } finally { f.clean(); }
});

test('finishing requires sign-in and only enables the helper when selected', async () => {
  let loggedIn = false;
  let helperCalls = 0;
  const f = fixture({ run: async () => JSON.stringify({ loggedIn }), installHelper: () => { helperCalls++; } });
  try {
    await assert.rejects(f.setup.finish({ enableHelper: true }), /Sign in/);
    assert.equal(fs.existsSync(f.statePath), false);
    loggedIn = true;
    await f.setup.finish();
    assert.equal(helperCalls, 0);
    await f.setup.finish({ enableHelper: true });
    assert.equal(helperCalls, 1);
  } finally { f.clean(); }
});

test('existing installation is reused without downloading or changing its login', async () => {
  let launched = false;
  const f = fixture({ launch: () => { launched = true; } });
  try { await f.setup.install(); assert.equal(launched, false); } finally { f.clean(); }
});

test('installer cannot claim success until the installed binary is found', async () => {
  let command;
  const f = fixture({ findBinary: () => null, launch: (file, args) => {
    command = { file, args }; const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 0)); return child;
  } });
  try {
    await assert.rejects(f.setup.install(), /could not be verified/);
    assert.match(command.file, /powershell.exe$/);
    assert.match(command.args.at(-1), /https:\/\/claude.ai\/install.ps1/);
    assert.equal(fs.existsSync(f.statePath), false);
  } finally { f.clean(); }
});

test('login is exclusive, cancellable, and retryable without leaking its output', async () => {
  let launchOptions;
  const f = fixture({ launch: (file, args, options) => {
    assert.equal(file, 'C:\\Claude Code\\claude.exe'); assert.deepEqual(args, ['auth', 'login']);
    launchOptions = options; return new EventEmitter();
  } });
  try {
    const pending = f.setup.login();
    const rejection = assert.rejects(pending, /cancelled/);
    await assert.rejects(f.setup.login(), /already running/);
    assert.throws(() => f.setup.skip(), /Cancel/);
    f.setup.cancel(); await rejection;
    assert.equal((await f.setup.status()).busy, false);
    assert.equal(launchOptions.stdio, 'ignore');
    assert.equal(launchOptions.cwd, 'C:\\Claude Code');
    assert.ok(Object.hasOwn(launchOptions.env, 'PATH'));
    assert.equal(fs.existsSync(f.statePath), false);
  } finally { f.clean(); }
});

test('failed helper setup leaves first-run setup unfinished', async () => {
  const f = fixture({ run: async () => JSON.stringify({ loggedIn: true }), installHelper: () => { throw new Error('helper failed'); } });
  try { await assert.rejects(f.setup.finish({ enableHelper: true }), /helper failed/); assert.equal(fs.existsSync(f.statePath), false); } finally { f.clean(); }
});

test('unchecking the existing helper disables it and verifies authentication only once', async () => {
  let installed = true;
  let checks = 0;
  const f = fixture({
    run: async () => { checks++; return JSON.stringify({ loggedIn: true }); },
    helperInstalled: () => installed,
    uninstallHelper: () => { installed = false; },
  });
  try {
    const status = await f.setup.finish({ enableHelper: false });
    assert.equal(status.helperInstalled, false);
    assert.equal(status.dismissed, true);
    assert.equal(status.busy, false);
    assert.equal(checks, 1);
  } finally { f.clean(); }
});

test('failed helper removal leaves setup unfinished and retryable', async () => {
  const f = fixture({ run: async () => JSON.stringify({ loggedIn: true }),
    helperInstalled: () => true, uninstallHelper: () => { throw new Error('settings locked'); } });
  try {
    await assert.rejects(f.setup.finish({ enableHelper: false }), /settings locked/);
    assert.equal(fs.existsSync(f.statePath), false);
    assert.equal((await f.setup.status()).busy, false);
  } finally { f.clean(); }
});

test('login returns its single verification result and holds the lock during verification', async () => {
  let checks = 0;
  let resolveStatus;
  const f = fixture({
    run: () => { checks++; return new Promise(resolve => { resolveStatus = resolve; }); },
    launch: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 0)); return child; },
  });
  try {
    const pending = f.setup.login();
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.setup.login(), /already running/);
    resolveStatus(JSON.stringify({ loggedIn: true }));
    const result = await pending;
    assert.equal(checks, 1);
    assert.equal(result.auth, 'signed-in');
    assert.equal(result.busy, false);
  } finally { f.clean(); }
});

test('the launch environment is handed to every Claude command rather than the mutated process environment', async () => {
  const seen = [];
  const environment = Object.freeze({ PATH: 'C:\\Windows', GH_TOKEN: 'kept-for-claude' });
  const f = fixture({ run: async (_file, args, options) => { seen.push([args, options]); return JSON.stringify({ loggedIn: true }); }, environment });
  try {
    await f.setup.status();
    assert.deepEqual(seen[0][0], ['auth', 'status']);
    assert.equal(seen[0][1].environment, environment);
  } finally {
    f.clean();
  }
});

test('the dismissal probe reads the saved flag without running the Claude CLI', async () => {
  let runs = 0;
  const f = fixture({ run: async () => { runs++; return JSON.stringify({ loggedIn: true }); } });
  try {
    assert.equal(f.setup.dismissed(), false);
    f.setup.skip();
    assert.equal(f.setup.dismissed(), true);
    assert.equal(runs, 0);
    assert.equal((await f.setup.status()).dismissed, true);
    assert.equal(runs, 1);
  } finally { f.clean(); }
});
