'use strict';
require('./setup.cjs');
// An absolute program path on this system: exactly C:\Claude Code\claude.exe on Windows.
const FIXTURE_FOLDER = require('node:path').join(process.platform === 'win32' ? 'C:\\' : '/', 'Claude Code');
const FIXTURE_CLAUDE = require('node:path').join(FIXTURE_FOLDER, 'claude.exe');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createClaudeSetup, INSTALLER_FILE, INSTALL_TARGET } = require('../electron/claude-setup.cjs');
const { MANUAL_INSTALL_COMMAND, digestOf } = require('../electron/claude-installer.cjs');

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-setup-'));
  const statePath = path.join(root, 'setup.json');
  const setup = createClaudeSetup({ statePath, findBinary: () => FIXTURE_CLAUDE, run: async () => JSON.stringify({ loggedIn: false }), ...options });
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

const installerScript = Buffer.from('param([string]$Target = "latest")\nWrite-Output "install $Target"\n');
const installerPin = { url: 'https://claude.ai/install.ps1', sha256: digestOf(installerScript), bytes: installerScript.length, verifiedOn: '2026-10-06' };
const servedInstaller = async (url) => ({ url, bytes: Buffer.from(installerScript) });

test('installer cannot claim success until the installed binary is found', { skip: process.platform !== 'win32' ? 'the installer runs Windows PowerShell from the Windows system folder (SystemRoot, C:\\Windows by default), a Windows path that does not exist elsewhere' : false }, async () => {
  let command;
  let scriptAtLaunch;
  const logs = [];
  const f = fixture({ findBinary: () => null, fetchInstaller: servedInstaller, installerPin, log: (line) => logs.push(line), launch: (file, args) => {
    command = { file, args };
    scriptAtLaunch = fs.readFileSync(args[args.indexOf('-File') + 1]);
    const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 0)); return child;
  } });
  try {
    await assert.rejects(f.setup.install(), /could not be verified/);
    assert.match(command.file, /powershell.exe$/);
    // The script runs from a verified local file, never from a remote expression.
    assert.deepEqual(command.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.equal(path.dirname(command.args[5]), path.dirname(f.statePath));
    assert.equal(path.basename(command.args[5]), INSTALLER_FILE);
    assert.equal(command.args.at(-1), INSTALL_TARGET);
    assert.ok(!command.args.some((arg) => /Invoke-RestMethod|https?:|scriptblock/i.test(arg)));
    assert.deepEqual(scriptAtLaunch, installerScript);
    assert.equal(fs.existsSync(command.args[5]), false, 'the script is removed after the installer exits');
    assert.equal(fs.existsSync(f.statePath), false);
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(`sha256 ${installerPin.sha256} \\(${installerScript.length} bytes`));
  } finally { f.clean(); }
});

test('a changed vendor installer is never written or run, and the user is told how to install manually', async () => {
  let launched = 0;
  const changed = async (url) => ({ url, bytes: Buffer.concat([installerScript, Buffer.from('Start-Process evil.exe\n')]) });
  const f = fixture({ findBinary: () => null, fetchInstaller: changed, installerPin, launch: () => { launched++; return new EventEmitter(); } });
  try {
    await assert.rejects(f.setup.install(), (error) => error.code === 'CLAUDE_INSTALLER_CHANGED' && error.message.includes(MANUAL_INSTALL_COMMAND));
    assert.equal(launched, 0);
    assert.equal(fs.existsSync(path.join(path.dirname(f.statePath), INSTALLER_FILE)), false);
    assert.equal((await f.setup.status()).busy, false);
  } finally { f.clean(); }
});

test('a failed installer download is reported without request details and without running anything', async () => {
  let launched = 0;
  const logs = [];
  const offline = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND claude.ai https://claude.ai/install.ps1?token=secret'), { code: 'ENOTFOUND' }); };
  const f = fixture({ findBinary: () => null, fetchInstaller: offline, installerPin, log: (line) => logs.push(line), launch: () => { launched++; return new EventEmitter(); } });
  try {
    await assert.rejects(f.setup.install(), /could not be downloaded/);
    assert.equal(launched, 0);
    assert.ok(!logs.join('\n').includes('secret'));
    assert.deepEqual(logs, ['Claude installer download failed (ENOTFOUND).']);
  } finally { f.clean(); }
});

test('cancelling during the installer download aborts the request and leaves setup idle', async () => {
  let launched = 0;
  let aborted = false;
  const pending = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })); });
  });
  const f = fixture({ findBinary: () => null, fetchInstaller: pending, installerPin, launch: () => { launched++; return new EventEmitter(); } });
  try {
    const install = f.setup.install();
    const rejection = assert.rejects(install, (error) => error.code === 'CLAUDE_INSTALLER_DOWNLOAD_CANCELLED' && /cancelled/.test(error.message));
    await new Promise((resolve) => setImmediate(resolve));
    f.setup.cancel();
    await rejection;
    assert.equal(aborted, true);
    assert.equal(launched, 0);
    assert.equal(fs.existsSync(path.join(path.dirname(f.statePath), INSTALLER_FILE)), false);
    assert.equal((await f.setup.status()).busy, false);
    // A later cancel is a no-op rather than a stale handle.
    f.setup.cancel();
  } finally { f.clean(); }
});

test('a download that completes after Cancel is discarded and never launched', async () => {
  let launched = 0;
  let release;
  const late = () => new Promise((resolve) => { release = () => resolve({ url: installerPin.url, bytes: Buffer.from(installerScript) }); });
  const f = fixture({ findBinary: () => null, fetchInstaller: late, installerPin, launch: () => { launched++; return new EventEmitter(); } });
  try {
    const install = f.setup.install();
    const rejection = assert.rejects(install, /cancelled/);
    await new Promise((resolve) => setImmediate(resolve));
    f.setup.cancel();
    release();
    await rejection;
    assert.equal(launched, 0);
    assert.equal(fs.existsSync(path.join(path.dirname(f.statePath), INSTALLER_FILE)), false);
    assert.equal((await f.setup.status()).busy, false);
  } finally { f.clean(); }
});

test('the installer script is removed even when the installer fails or is cancelled', { skip: process.platform !== 'win32' ? 'the installer runs Windows PowerShell from the Windows system folder (SystemRoot, C:\\Windows by default), a Windows path that does not exist elsewhere' : false }, async () => {
  const f = fixture({ findBinary: () => null, fetchInstaller: servedInstaller, installerPin, launch: () => {
    const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 1)); return child;
  } });
  try {
    await assert.rejects(f.setup.install(), /did not finish/);
    assert.equal(fs.existsSync(path.join(path.dirname(f.statePath), INSTALLER_FILE)), false);
  } finally { f.clean(); }
});

test('login is exclusive, cancellable, and retryable without leaking its output', async () => {
  let launchOptions;
  const f = fixture({ launch: (file, args, options) => {
    assert.equal(file, FIXTURE_CLAUDE); assert.deepEqual(args, ['auth', 'login']);
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
    assert.equal(launchOptions.cwd, FIXTURE_FOLDER);
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
