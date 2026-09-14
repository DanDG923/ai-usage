'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { INSTALLER_ARGS, installDirectoryWritable, launchInstaller, verifyInstaller, relaunchApplication, preserveInstallerEnvironment } = require('../electron/installer-launch.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-installer-'));
  const filePath = path.join(root, 'AI-Usage-Setup-9.9.9-x64.exe');
  const bytes = crypto.randomBytes(64 * 1024 + 17);
  fs.writeFileSync(filePath, bytes);
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  return { root, filePath, sha512, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('trusted installer gets the captured environment without changing update authentication', async () => {
  const f = fixture(), calls = [];
  try {
    const environment = { GH_TOKEN: 'launch-only', PATH: 'kept' };
    await launchInstaller({ filePath: f.filePath, sha512: f.sha512, environment, spawnProcess: fakeSpawn(['spawn'], calls) });
    assert.deepEqual(calls[0].options.env, environment);
    assert.notEqual(calls[0].options.env, environment);
  } finally { f.clean(); }
});

test('relaunch temporarily restores only captured token variables and cleans up even on failure', () => {
  const currentEnvironment = { PATH: 'current', GH_TOKEN: 'existing' };
  const environment = { PATH: 'original', GH_TOKEN: 'launch', GITHUB_TOKEN: 'other' };
  assert.throws(() => relaunchApplication({ currentEnvironment, environment, app: { relaunch() {
    assert.deepEqual(currentEnvironment, { PATH: 'current', GH_TOKEN: 'launch', GITHUB_TOKEN: 'other' });
    throw new Error('launch failed');
  } } }), /launch failed/);
  assert.deepEqual(currentEnvironment, { PATH: 'current', GH_TOKEN: 'existing' });
});

test('NSIS asynchronous elevation retries preserve launch tokens only for trusted installer processes', async () => {
  const calls = [];
  const updater = { installerPath: 'C:\\download\\setup.exe', spawnLog: async (...args) => { calls.push(args); } };
  preserveInstallerEnvironment(updater, { GH_TOKEN: 'launch-only' }, 'C:\\app\\resources');
  await updater.spawnLog(updater.installerPath, ['/S']);
  await new Promise((resolve) => setImmediate(resolve));
  await updater.spawnLog('C:\\app\\resources\\elevate.exe', [updater.installerPath]);
  await updater.spawnLog('C:\\other\\program.exe', []);
  await updater.spawnLog('C:\\app\\resources\\elevate.exe', ['C:\\other\\program.exe']);
  assert.deepEqual(calls[0][2], { GH_TOKEN: 'launch-only' });
  assert.deepEqual(calls[1][2], { GH_TOKEN: 'launch-only' });
  assert.equal(calls[2][2], undefined);
  assert.equal(calls[3][2], undefined);
});

// A fake child: `outcomes` lists, per attempt, either an error code or 'spawn'.
function fakeSpawn(outcomes, calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.pid = 4000 + calls.length;
    child.unref = () => { child.unrefCalled = true; };
    const outcome = outcomes[calls.length - 1] ?? 'spawn';
    setImmediate(() => {
      if (outcome === 'spawn') child.emit('spawn');
      else child.emit('error', Object.assign(new Error(`spawn ${outcome}`), { code: outcome }));
    });
    return child;
  };
}

test('the installer is re-verified against the manifest checksum immediately before it runs', async () => {
  const f = fixture();
  try {
    await verifyInstaller(f.filePath, f.sha512);
    for (const [file, sha, code] of [
      [f.filePath, (f.sha512[0] === 'A' ? 'B' : 'A') + f.sha512.slice(1), 'ERR_UPDATER_CHECKSUM_MISMATCH'],
      [f.filePath, 'not-a-digest', 'ERR_UPDATER_CHECKSUM_MISMATCH'],
      [f.filePath, null, 'ERR_UPDATER_CHECKSUM_MISMATCH'],
      [f.filePath.replace(/\.exe$/, '.cmd'), f.sha512, 'ERR_UPDATER_INVALID_INSTALLER'],
      ['AI-Usage-Setup-9.9.9-x64.exe', f.sha512, 'ERR_UPDATER_INVALID_INSTALLER'],
      [path.join(f.root, 'missing.exe'), f.sha512, 'ERR_UPDATER_INVALID_INSTALLER'],
    ]) {
      await assert.rejects(verifyInstaller(file, sha), (error) => error.code === code);
    }
    fs.appendFileSync(f.filePath, 'tampered');
    await assert.rejects(verifyInstaller(f.filePath, f.sha512), (error) => error.code === 'ERR_UPDATER_CHECKSUM_MISMATCH');
  } finally { f.clean(); }
});

test('a refused launch is retried with electron-updater arguments and reported without request details', async () => {
  const f = fixture();
  const calls = [];
  const logs = [];
  try {
    const result = await launchInstaller({
      filePath: f.filePath, sha512: f.sha512, spawnProcess: fakeSpawn(['EBUSY', 'EACCES', 'spawn'], calls), retryDelayMs: 1, onLog: (line) => logs.push(line),
    });
    assert.equal(result.attempt, 3);
    assert.equal(result.pid, 4003);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.file, f.filePath);
      assert.deepEqual(call.args, [...INSTALLER_ARGS]);
      assert.deepEqual(call.options, { detached: true, stdio: 'ignore' });
    }
    assert.deepEqual(logs, [
      'Installer verified: AI-Usage-Setup-9.9.9-x64.exe.',
      'Installer launch attempt 1 of 4 failed (EBUSY).',
      'Installer launch attempt 2 of 4 failed (EACCES).',
      'Installer launched on attempt 3 (pid 4003).',
    ]);
  } finally { f.clean(); }
});

test('launch failures stop after the attempt budget or immediately for a non-retryable error', async () => {
  const f = fixture();
  try {
    let calls = [];
    await assert.rejects(launchInstaller({
      filePath: f.filePath, sha512: f.sha512, spawnProcess: fakeSpawn(['EACCES', 'EACCES', 'EACCES', 'EACCES', 'spawn'], calls), retryDelayMs: 1,
    }), (error) => error.code === 'UPDATE_INSTALLER_LAUNCH_FAILED');
    assert.equal(calls.length, 4);

    calls = [];
    const logs = [];
    await assert.rejects(launchInstaller({
      filePath: f.filePath, sha512: f.sha512, spawnProcess: fakeSpawn(['ENOENT', 'spawn'], calls), retryDelayMs: 1, onLog: (line) => logs.push(line),
    }), (error) => error.code === 'UPDATE_INSTALLER_LAUNCH_FAILED');
    assert.equal(calls.length, 1);
    assert.ok(logs.includes('Installer launch attempt 1 of 4 failed (ENOENT).'));

    calls = [];
    const throwing = (file, args, options) => { calls.push({ file, args, options }); throw Object.assign(new Error('Authorization: token secret'), { code: 'weird code with spaces' }); };
    const seen = [];
    await assert.rejects(launchInstaller({ filePath: f.filePath, sha512: f.sha512, spawnProcess: throwing, retryDelayMs: 1, onLog: (line) => seen.push(line) }));
    assert.ok(!seen.join('\n').includes('secret'));
    assert.ok(seen.includes('Installer launch attempt 1 of 4 failed (UNKNOWN).'));
    // A synchronous throw carries an unrecognised code, so it is retried as UNKNOWN.
    assert.equal(calls.length, 4);
  } finally { f.clean(); }
});

test('a tampered file is never launched', async () => {
  const f = fixture();
  const calls = [];
  try {
    fs.appendFileSync(f.filePath, 'x');
    await assert.rejects(launchInstaller({ filePath: f.filePath, sha512: f.sha512, spawnProcess: fakeSpawn(['spawn'], calls) }));
    assert.equal(calls.length, 0);
  } finally { f.clean(); }
});

test('the per-user install directory is writable and a system directory is not', () => {
  const f = fixture();
  try {
    assert.equal(installDirectoryWritable(f.filePath), true);
    assert.equal(installDirectoryWritable(path.join(f.root, 'missing', 'app.exe')), false);
  } finally { f.clean(); }
});
