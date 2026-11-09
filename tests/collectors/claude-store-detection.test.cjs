'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findClaudeBinary } = require('../../electron/claude-collector.cjs');

function isolatedInstall(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-store-'));
  const previous = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH };
  process.env.USERPROFILE = root;
  process.env.APPDATA = path.join(root, 'roaming');
  process.env.LOCALAPPDATA = path.join(root, 'local');
  process.env.PATH = '';
  const storeRoot = path.join(process.env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc',
    'LocalCache', 'Roaming', 'Claude', 'claude-code');
  const install = (directory) => {
    fs.mkdirSync(directory, { recursive: true });
    const binary = path.join(directory, 'claude.exe');
    fs.writeFileSync(binary, 'fixture');
    return binary;
  };
  try { run({ root, storeRoot, install }); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('Store Claude Code is found without PATH or a conventional roaming installation', () => {
  isolatedInstall(({ storeRoot, install }) => {
    install(path.join(storeRoot, '2.1.9'));
    const expected = install(path.join(storeRoot, '2.1.260'));
    fs.mkdirSync(path.join(storeRoot, '2.1.999'), { recursive: true });
    assert.equal(findClaudeBinary(), expected);
  });
});

test('a newly installed native CLI is found before the app receives an updated PATH', () => {
  isolatedInstall(({ root, install }) => {
    const expected = install(path.join(root, '.local', 'bin'));
    assert.equal(findClaudeBinary(), expected);
  });
});

test('an unreadable conventional root does not hide a valid Store installation', () => {
  isolatedInstall(({ root, storeRoot, install }) => {
    const blockedAppData = path.join(root, 'not-a-directory');
    fs.writeFileSync(blockedAppData, 'fixture');
    process.env.APPDATA = blockedAppData;
    const expected = install(path.join(storeRoot, '2.1.260'));
    assert.equal(findClaudeBinary(), expected);
  });
});

test('conventional Claude Code keeps priority over the Store fallback', () => {
  isolatedInstall(({ storeRoot, install }) => {
    install(path.join(storeRoot, '2.1.260'));
    const expected = install(path.join(process.env.APPDATA, 'Claude', 'claude-code', '2.1.10'));
    assert.equal(findClaudeBinary(), expected);
  });
});

test('Store GUI executables, unrelated packages and directories named claude.exe are ignored', () => {
  isolatedInstall(({ storeRoot, install }) => {
    install(path.dirname(storeRoot));
    install(storeRoot.replace('Claude_pzs8sxrjxfjjc', 'OtherPublisher_package'));
    fs.mkdirSync(path.join(storeRoot, '2.1.260', 'claude.exe'), { recursive: true });
    assert.equal(findClaudeBinary(), null);
  });
});
