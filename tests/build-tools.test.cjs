'use strict';
require('./setup.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { checkVersion, bumpVersion } = require('../tools/bump-version.cjs');
const { assertArchive } = require('../tools/audit-release.cjs');
const { buildDirectory } = require('../tools/build-paths.cjs');

test('version tool updates all current metadata while preserving historical changelog entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-version-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }));
  fs.writeFileSync(path.join(root, 'README.md'), 'AI-Usage-Setup-1.2.3-x64.exe AI-Usage-Portable-1.2.3-x64.exe tag v1.2.3');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.3\n\nOld notes.\n');
  assert.equal(bumpVersion(root, '1.2.4'), '1.2.4');
  assert.equal(checkVersion(root, '1.2.4'), '1.2.4');
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /## 1\.2\.3\n\nOld notes/);
  fs.writeFileSync(path.join(root, 'README.md'), 'outdated');
  assert.throws(() => checkVersion(root, '1.2.4'), /README/);
  assert.throws(() => bumpVersion(root, '../bad'), /stable/);
});

test('version tool keeps release notes written ahead of the bump under a dated heading', () => {
  const { releaseNotes } = require('../tools/release-notes.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-version-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }));
  fs.writeFileSync(path.join(root, 'README.md'), 'AI-Usage-Setup-1.2.3-x64.exe AI-Usage-Portable-1.2.3-x64.exe');
  for (const newline of ['\n', '\r\n']) {
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), ['# Changelog', '', '## 1.2.4 — 2 October 2026', '', '- The reviewed notes.', '', '## 1.2.3', '', '- Old notes.', ''].join(newline));
    bumpVersion(root, '1.2.4');
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.equal(changelog.match(/^## 1\.2\.4\b/gm).length, 1, 'no second heading');
    assert.equal(releaseNotes(changelog, '1.2.4'), '- The reviewed notes.\n');
  }
  // A version that only shares a prefix is not the release's heading.
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.40\n\n- Other notes.\n');
  bumpVersion(root, '1.2.4');
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /^## 1\.2\.4\n\n- Release notes pending review\./m);
});

test('release audit rejects missing runtime code, private data, source maps and bundled executables', () => {
  const entries = ['dist/index.html', 'dist/flyout.html', 'electron/main.cjs', 'electron/preload.cjs', 'electron/flyout-preload.cjs', 'electron/maintenance-host.cjs', 'electron/maintenance-service.cjs', 'electron/desktop-estimates.cjs', 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'];
  assert.doesNotThrow(() => assertArchive(entries));
  assert.throws(() => assertArchive(entries.slice(1)), /required application file/);
  for (const name of ['dist/app.js.map', '.codex/auth.json', 'private/ledger.sqlite', 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe', 'dist/assets/demo-grDXqB6S.js', 'dist/assets/flyout-preview-CuXK6gLk.js']) {
    assert.throws(() => assertArchive([...entries, name]), /Release audit failed/);
  }
});

test('local build outputs leave the synced project while CI output remains predictable', () => {
  assert.equal(buildDirectory('repo', { LOCALAPPDATA: 'local' }), path.join('local', 'AI Usage', 'Build', 'release'));
  assert.equal(buildDirectory('repo', { CI: 'true' }), path.join('repo', 'release'));
  assert.equal(buildDirectory('repo', { AI_USAGE_BUILD_OUTPUT: 'chosen' }), path.resolve('chosen'));
});
