'use strict';
require('./setup.cjs');

// The path rules choose Windows or POSIX paths by the system they run on. The
// shipped app only ever runs with Windows paths, so these tests inject the
// Windows flavour explicitly and pin the results the Windows tests expect;
// they run, and must give the same answers, on every system.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathRules, platformPath } = require('../electron/windows-paths.cjs');
const { providerExecutables } = require('../electron/provider-executable.cjs');
const { installerLaunch } = require('../electron/installer-launch.cjs');

const UNUSABLE_WINDOWS_PATHS = [undefined, null, '', '.', 'relative', 'C:relative', '\\rooted', '/rooted', '\\\\server\\share',
  '\\\\?\\C:\\temp', 'C:\\temp:stream', 'C:\\a"b', 'C:\\a<b', 'C:\\a|b', 'C:\\a?b', 'C:\\a*b', 'C:\\a\u0001b'];

test('the platform flavour is Windows paths on Windows and POSIX paths elsewhere', () => {
  assert.equal(platformPath, process.platform === 'win32' ? path.win32 : path.posix);
});

test('with Windows paths, only an absolute drive path is accepted and it is normalised', () => {
  const { absolutePath } = pathRules(path.win32);
  for (const value of UNUSABLE_WINDOWS_PATHS) assert.equal(absolutePath(value), null, String(value));
  assert.equal(absolutePath('C:\\Users\\tester'), 'C:\\Users\\tester');
  assert.equal(absolutePath(' "D:\\tools\\codex" '), 'D:\\tools\\codex');
  assert.equal(absolutePath('c:/Program Files/../bin/'), 'c:\\bin\\');
});

test('with POSIX paths, only a single-slash absolute path is accepted, with the same refusals', () => {
  const { absolutePath } = pathRules(path.posix);
  for (const value of [undefined, '', '.', 'relative', 'C:\\temp', '//server/share', '/a:b', '/a"b', '/a*b', '/a\u0001b']) {
    assert.equal(absolutePath(value), null, String(value));
  }
  assert.equal(absolutePath('"/home/tester/../tools"'), '/home/tools');
});

test('with Windows paths, environment names ignore case and the launch directory is compared lower-cased', () => {
  const { environmentValue, launchDirectory } = pathRules(path.win32);
  assert.equal(environmentValue({ Path: 'C:\\bin' }, 'PATH'), 'C:\\bin');
  assert.equal(environmentValue({ localappdata: 'C:\\local' }, 'LOCALAPPDATA'), 'C:\\local');
  assert.equal(environmentValue({}, 'PATH'), undefined);
  assert.equal(launchDirectory(() => 'C:\\Users\\Tester\\Downloads\\.'), 'c:\\users\\tester\\downloads');
  assert.equal(launchDirectory(() => { throw new Error('gone'); }), null);
});

test('with Windows paths, providerHome honours an absolute override and otherwise derives the folder from the profile', () => {
  const { providerHome } = providerExecutables(path.win32);
  assert.equal(providerHome('CODEX_HOME', '.codex', { CODEX_HOME: 'D:\\tools\\codex', USERPROFILE: 'C:\\Users\\tester' }), 'D:\\tools\\codex');
  assert.equal(providerHome('codex_home', '.codex', { Codex_Home: '"D:\\tools\\codex"' }), 'D:\\tools\\codex');
  assert.equal(providerHome('CODEX_HOME', '.codex', { CODEX_HOME: 'relative\\codex', USERPROFILE: 'C:\\Users\\tester' }), 'C:\\Users\\tester\\.codex');
  assert.equal(providerHome('CLAUDE_CONFIG_DIR', '.claude', { USERPROFILE: 'C:\\Users\\tester' }), 'C:\\Users\\tester\\.claude');
  assert.equal(providerHome('CLAUDE_CONFIG_DIR', '.claude', { USERPROFILE: '\\\\server\\share' }), null);
  assert.equal(providerHome('CLAUDE_CONFIG_DIR', '.claude', { USERPROFILE: '/home/tester' }), null);
  assert.equal(providerHome('CLAUDE_CONFIG_DIR', '.claude', {}), null);
});

test('with POSIX paths, providerHome follows the same rules with POSIX folders', () => {
  const { providerHome } = providerExecutables(path.posix);
  assert.equal(providerHome('CODEX_HOME', '.codex', { CODEX_HOME: '/opt/codex', USERPROFILE: '/home/tester' }), '/opt/codex');
  assert.equal(providerHome('CODEX_HOME', '.codex', { CODEX_HOME: 'relative/codex', USERPROFILE: '/home/tester' }), '/home/tester/.codex');
  assert.equal(providerHome('CLAUDE_CONFIG_DIR', '.claude', { USERPROFILE: 'C:\\Users\\tester' }), null);
  assert.equal(providerHome('CLAUDE_CONFIG_DIR', '.claude', { USERPROFILE: '//server/share' }), null);
});

test('with Windows paths, provider launch options reject relative programs and keep no relative PATH entry', () => {
  const { providerProcessOptions } = providerExecutables(path.win32);
  for (const file of ['codex.exe', '.\\codex.exe', 'C:codex.exe', '\\codex.exe', 'C:\\bin\\codex.cmd', '/usr/bin/codex.exe', '\\\\server\\share\\codex.exe']) {
    assert.throws(() => providerProcessOptions(file, {}), /^Error: Provider executable must be an absolute local \.exe path\.$/, file);
  }
  // None of these entries is an absolute drive path, so none is ever looked up on disk.
  const result = providerProcessOptions('"C:\\Program Files\\Codex\\codex.EXE"', { Path: ';.;relative;C:relative;\\rooted', path: 'x', KEEP_ME: 'present' });
  assert.deepEqual(result, { cwd: 'C:\\Program Files\\Codex', env: { KEEP_ME: 'present', PATH: '' } });
});

test('with Windows paths, an invalid explicit Codex override fails closed without touching the disk', () => {
  const { findCodexBinary } = providerExecutables(path.win32);
  const before = process.env.CODEX_BINARY;
  try {
    for (const value of ['', '.\\codex.exe', 'codex.exe', 'C:codex.exe', 'C:\\bin', 'C:\\bin\\codex.exe:stream', '/usr/bin/codex.exe']) {
      process.env.CODEX_BINARY = value;
      assert.equal(findCodexBinary(), null, value);
    }
  } finally {
    if (before === undefined) delete process.env.CODEX_BINARY; else process.env.CODEX_BINARY = before;
  }
});

test('with Windows paths, the installer must be an absolute .exe path before its checksum is read', async () => {
  const { verifyInstaller } = installerLaunch(path.win32);
  const digest = 'A'.repeat(86) + '==';
  for (const file of [undefined, 'AI-Usage-Setup-9.9.9-x64.exe', 'C:setup.exe', 'C:\\download\\setup.cmd', 'C:\\download\\setup.exe.txt']) {
    await assert.rejects(verifyInstaller(file, digest), (error) => error.code === 'ERR_UPDATER_INVALID_INSTALLER', String(file));
  }
  for (const sha of [null, 'not-a-digest']) {
    await assert.rejects(verifyInstaller('C:\\download\\Setup.EXE', sha), (error) => error.code === 'ERR_UPDATER_CHECKSUM_MISMATCH');
  }
});

test('with Windows paths, NSIS elevation retries preserve launch tokens only for the trusted installer, ignoring case', async () => {
  const { preserveInstallerEnvironment } = installerLaunch(path.win32);
  /** @type {unknown[][]} */
  const calls = [];
  const updater = { installerPath: 'C:\\download\\setup.exe', spawnLog: async (/** @type {unknown[]} */ ...args) => { calls.push(args); return true; } };
  preserveInstallerEnvironment(updater, { GH_TOKEN: 'launch-only' }, 'C:\\app\\resources');
  await updater.spawnLog(updater.installerPath, ['/S']);
  await updater.spawnLog('C:\\app\\resources\\elevate.exe', [updater.installerPath]);
  await updater.spawnLog('C:\\other\\program.exe', []);
  await updater.spawnLog('C:\\app\\resources\\elevate.exe', ['C:\\other\\program.exe']);
  await updater.spawnLog('c:\\DOWNLOAD\\.\\Setup.exe', [], { EXTRA: '1' });
  await updater.spawnLog('C:\\APP\\resources\\ELEVATE.exe', ['c:/download/setup.exe']);
  assert.deepEqual(calls.map((call) => call[2]), [
    { GH_TOKEN: 'launch-only' },
    { GH_TOKEN: 'launch-only' },
    undefined,
    undefined,
    { GH_TOKEN: 'launch-only', EXTRA: '1' },
    { GH_TOKEN: 'launch-only' },
  ]);
});
