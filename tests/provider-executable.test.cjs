'use strict';
require('./setup.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findClaudeBinary } = require('../electron/claude-collector.cjs');
const { findCodexBinary, JsonLineClient } = require('../electron/codex-collector.cjs');
const { providerProcessOptions } = require('../electron/provider-executable.cjs');
const { runCommand } = require('../electron/claude-setup.cjs');

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-provider-'));
  const before = { ...process.env };
  const cwd = process.cwd();
  const install = (directory, name) => {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    fs.writeFileSync(file, 'Harmless fixture: never execute.');
    return file;
  };
  const attack = path.join(root, 'untrusted');
  for (const name of ['claude.exe', 'codex.exe', 'where.exe']) install(attack, name);
  process.chdir(attack);
  for (const key of Object.keys(process.env)) if (/^(PATH|USERPROFILE|APPDATA|LOCALAPPDATA|CODEX_BINARY)$/i.test(key)) delete process.env[key];
  try { run({ root, attack, install }); } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('both public resolvers ignore planted providers and lookup utilities in the launch directory', () => {
  fixture(({ root, attack, install }) => {
    const alias = path.join(root, 'cwd-alias');
    fs.symlinkSync(attack, alias, 'junction');
    for (const value of ['', ';.;relative;C:relative;\\rooted', `"${attack}";${attack.toUpperCase()};${attack}\\.;${alias}`]) {
      process.env.PATH = value;
      assert.equal(findClaudeBinary(), null);
      assert.equal(findCodexBinary(), null);
    }
    const trusted = path.join(root, 'configured bin');
    const claude = install(trusted, 'claude.exe');
    const codex = install(trusted, 'codex.exe');
    process.env.PATH = `.;${alias};"${trusted}";`;
    assert.equal(findClaudeBinary(), claude);
    assert.equal(findCodexBinary(), codex);
  });
});

test('malformed roots and explicit overrides cannot acquire CWD meaning', () => {
  fixture(({ root, attack, install }) => {
    install(path.join(attack, 'OpenAI', 'Codex', 'bin', '1'), 'codex.exe');
    install(path.join(attack, '.local', 'bin'), 'claude.exe');
    for (const value of [undefined, '', '.', 'relative', 'C:relative', '\\rooted', '\\\\server\\share', '\\\\?\\C:\\temp', 'C:\\temp:stream']) {
      for (const name of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE']) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      assert.equal(findCodexBinary(), null);
      assert.equal(findClaudeBinary(), null);
    }
    const configured = install(path.join(root, 'override'), 'custom.exe');
    process.env.CODEX_BINARY = configured;
    assert.equal(findCodexBinary(), configured);
    process.env.PATH = path.dirname(install(path.join(root, 'path'), 'codex.exe'));
    for (const value of ['', '.\\codex.exe', 'codex.exe', 'C:codex.exe', path.dirname(configured), configured + ':stream']) {
      process.env.CODEX_BINARY = value;
      assert.equal(findCodexBinary(), null, 'invalid explicit override fails closed');
    }
  });
});

test('PATH priority, regular files, managed Codex timestamps and case-insensitive environment names remain supported', () => {
  fixture(({ root, install }) => {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(path.join(first, 'codex.exe'), { recursive: true });
    const onPath = install(second, 'codex.exe');
    process.env.Path = `"${first}";${second}`;
    process.env.localappdata = path.join(root, 'local');
    const managed = path.join(process.env.localappdata, 'OpenAI', 'Codex', 'bin');
    const old = install(path.join(managed, 'old'), 'codex.exe');
    const recent = install(path.join(managed, 'new'), 'codex.exe');
    fs.utimesSync(old, 100, 100); fs.utimesSync(recent, 200, 200);
    assert.equal(findCodexBinary(), onPath);
    delete process.env.Path;
    assert.equal(findCodexBinary(), recent);
  });
});

test('provider launch options reject relative programs and strip every CWD-dependent PATH entry', () => {
  fixture(({ root, attack, install }) => {
    const binary = install(path.join(root, 'trusted'), 'codex.exe');
    const result = providerProcessOptions(binary, { Path: `;.;C:relative;${attack};${path.dirname(binary)}`, KEEP_ME: 'present' });
    assert.equal(result.cwd, path.dirname(binary));
    assert.deepEqual(result.env, { KEEP_ME: 'present', PATH: path.dirname(binary) });
    for (const file of ['codex.exe', '.\\codex.exe', 'C:codex.exe', '\\codex.exe', 'C:\\bin\\codex.cmd']) {
      assert.throws(() => providerProcessOptions(file), /absolute local/);
      assert.throws(() => new JsonLineClient(file, () => assert.fail('must not spawn')), /absolute local/);
    }
  });
});

test('setup auth execution rejects a relative program before execFile', async () => {
  await assert.rejects(runCommand('claude.exe', ['auth', 'status']), /absolute local/);
});

test('providerHome honours an absolute override and otherwise derives the folder from the profile', () => {
  const { providerHome } = require('../electron/provider-executable.cjs');
  assert.equal(providerHome('CODEX_HOME', '.codex', { CODEX_HOME: 'D:\\tools\\codex', USERPROFILE: 'C:\\Users\\tester' }), 'D:\\tools\\codex');
  assert.equal(providerHome('codex_home', '.codex', { Codex_Home: '"D:\\tools\\codex"' }), 'D:\\tools\\codex');
  assert.equal(providerHome('CODEX_HOME', '.codex', { CODEX_HOME: 'relative\\codex', USERPROFILE: 'C:\\Users\\tester' }), 'C:\\Users\\tester\\.codex');
  assert.equal(providerHome('CLAUDE_CONFIG_DIR', '.claude', { USERPROFILE: 'C:\\Users\\tester' }), 'C:\\Users\\tester\\.claude');
  assert.equal(providerHome('CLAUDE_CONFIG_DIR', '.claude', { USERPROFILE: '\\\\server\\share' }), null);
  assert.equal(providerHome('CLAUDE_CONFIG_DIR', '.claude', {}), null);
});
