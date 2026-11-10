'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeFileAtomically } = require('../../electron/atomic-write.cjs');
const { installClaudeHelper, uninstallClaudeHelper } = require('../../electron/claude-collector.cjs');
const { providerHome } = require('../helpers/provider-home.cjs');

function temporaryFolder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const busy = (code) => Object.assign(new Error(`${code}: the file is in use`), { code });

// The process dying while it writes: half of the bytes reach the file being
// written, whichever file that is, and nothing after that runs.
function dieWhileWriting(t, settingsPath) {
  const writeFile = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (target, data, ...rest) => {
    if (target !== settingsPath && typeof target !== 'number') return writeFile(target, data, ...rest);
    const bytes = Buffer.from(data);
    writeFile(target, bytes.subarray(0, Math.floor(bytes.length / 2)));
    throw new Error('power lost');
  });
}

test('a crash while Claude\'s settings are being written leaves the previous settings whole', (t) => {
  const { root } = providerHome(t, 'ai-usage-settings-crash-');
  const claude = path.join(root, '.claude');
  const settingsPath = path.join(claude, 'settings.json');
  fs.mkdirSync(claude, { recursive: true });
  const original = `${JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(npm test:*)'] }, statusLine: { type: 'command', command: 'mine.cmd' } }, null, 2)}\n`;
  fs.writeFileSync(settingsPath, original);

  dieWhileWriting(t, settingsPath);
  assert.throws(() => installClaudeHelper(path.join(root, 'inbox.jsonl')), /power lost/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
  t.mock.restoreAll();

  // The same when the helper is removed again.
  installClaudeHelper(path.join(root, 'inbox.jsonl'));
  const installed = fs.readFileSync(settingsPath, 'utf8');
  dieWhileWriting(t, settingsPath);
  assert.throws(() => uninstallClaudeHelper(), /power lost/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), installed);
  t.mock.restoreAll();

  assert.equal(uninstallClaudeHelper().restoredPreviousStatusLine, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), JSON.parse(original));
  assert.deepEqual(fs.readdirSync(claude).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left behind');
});

test('an atomic write replaces the contents, creates a missing file and leaves nothing else behind', (t) => {
  const root = temporaryFolder(t);
  const file = path.join(root, 'settings.json');
  writeFileAtomically(file, 'first\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'first\n');
  writeFileAtomically(file, 'second é\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'second é\n');
  assert.deepEqual(fs.readdirSync(root), ['settings.json']);
});

test('an atomic write keeps the file\'s permissions and writes through a link', { skip: process.platform === 'win32' }, (t) => {
  const root = temporaryFolder(t);
  const real = path.join(root, 'dotfiles', 'settings.json');
  const link = path.join(root, 'settings.json');
  fs.mkdirSync(path.dirname(real));
  fs.writeFileSync(real, 'old\n', { mode: 0o600 });
  fs.chmodSync(real, 0o600);
  fs.symlinkSync(real, link);
  writeFileAtomically(link, 'new\n');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link is still a link');
  assert.equal(fs.readFileSync(real, 'utf8'), 'new\n');
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(real)), ['settings.json']);
});

test('a destination that is briefly locked is retried, and one that stays locked is rewritten in place', (t) => {
  const root = temporaryFolder(t);
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, 'old\n');
  const waits = [];
  let attempts = 0;
  writeFileAtomically(file, 'after a retry\n', {
    rename: (from, to) => { attempts += 1; if (attempts < 3) throw busy('EBUSY'); fs.renameSync(from, to); },
    wait: (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [50, 100]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'after a retry\n');

  attempts = 0;
  writeFileAtomically(file, 'in place\n', { rename: () => { attempts += 1; throw busy('EPERM'); }, wait() {} });
  assert.equal(attempts, 6);
  assert.equal(fs.readFileSync(file, 'utf8'), 'in place\n');

  // Any other failure is reported, and the file is left as it was.
  assert.throws(() => writeFileAtomically(file, 'lost\n', { rename: () => { throw busy('ENOSPC'); } }), /ENOSPC/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'in place\n');
  assert.deepEqual(fs.readdirSync(root), ['settings.json']);
});
