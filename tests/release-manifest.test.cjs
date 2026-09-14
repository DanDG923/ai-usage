'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const { auditManifest, validateManifest } = require('../tools/release-manifest.cjs');
const { releaseNotes } = require('../tools/release-notes.cjs');

function fixture() {
  const expected = {
    version: '1.0.23',
    installerName: 'AI-Usage-Setup-1.0.23-x64.exe',
    installerSize: 123456,
    installerSha512: crypto.createHash('sha512').update('installer').digest('base64'),
  };
  return {
    expected,
    manifest: {
      version: expected.version,
      files: [{ url: expected.installerName, size: expected.installerSize, sha512: expected.installerSha512 }],
      path: expected.installerName,
      sha512: expected.installerSha512,
      releaseDate: '2026-09-05T12:00:00.000Z',
    },
  };
}

test('release manifest rejects stale versions, wrong installers, and mismatched checksums or size', () => {
  const { expected, manifest } = fixture();
  assert.equal(validateManifest(manifest, expected), manifest);
  for (const mutate of [
    (value) => { value.version = '1.0.22'; },
    (value) => { value.path = 'AI-Usage-Portable-1.0.23-x64.exe'; },
    (value) => { value.files[0].url = 'https://unrelated.example/installer.exe'; },
    (value) => { value.files[0].url = '../installer.exe'; },
    (value) => { value.files[0].size -= 1; },
    (value) => { value.files[0].sha512 = 'wrong'; },
    (value) => { value.sha512 = 'wrong'; },
    (value) => { value.files.push({ ...value.files[0] }); },
    (value) => { delete value.releaseDate; },
  ]) {
    const invalid = structuredClone(manifest);
    mutate(invalid);
    assert.throws(() => validateManifest(invalid, expected), /Release manifest is invalid/);
  }
});

test('manifest audit hashes the actual installer and detects tampering after manifest creation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-manifest-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { expected, manifest } = fixture();
  const installerPath = path.join(directory, expected.installerName);
  fs.writeFileSync(installerPath, 'installer');
  manifest.files[0].size = fs.statSync(installerPath).size;
  fs.writeFileSync(path.join(directory, 'latest.yml'), yaml.dump(manifest));
  const result = await auditManifest(directory, expected.version);
  assert.equal(result.installerSha512, expected.installerSha512);
  fs.writeFileSync(installerPath, 'tampering');
  await assert.rejects(auditManifest(directory, expected.version), /SHA-512 does not match/);
});

test('manifest audit rejects missing and duplicate-key YAML manifests', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-manifest-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(auditManifest(directory, '1.0.23'), /latest.yml is missing/);
  fs.writeFileSync(path.join(directory, 'latest.yml'), 'version: 1.0.23\nversion: 1.0.22\n');
  await assert.rejects(auditManifest(directory, '1.0.23'), /duplicated mapping key/);
});

test('release notes contain only the selected version and retain paragraphs', () => {
  const changelog = '# Changelog\r\n\r\n## 1.0.23 — 5 September\r\n\r\nFirst paragraph.\r\n\r\n- Second item.\r\n\r\n## 1.0.22\r\n\r\nOlder notes.\r\n';
  assert.equal(releaseNotes(changelog, '1.0.23'), 'First paragraph.\r\n\r\n- Second item.\n');
  assert.equal(releaseNotes(changelog, '1.0.22'), 'Older notes.\n');
  assert.throws(() => releaseNotes(changelog, '1.0.2'), /No changelog notes/);
  assert.throws(() => releaseNotes(changelog, '1.0.24'), /No changelog notes/);
  assert.throws(() => releaseNotes(changelog, '1.0.23-beta'), /stable release version/);
});
