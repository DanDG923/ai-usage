'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

function fail(message) {
  throw new Error(`Release manifest is invalid: ${message}`);
}

function validateManifest(manifest, { version, installerName, installerSize, installerSha512 }) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('expected an object');
  if (manifest.version !== version) fail('version does not match package.json');
  if (!Array.isArray(manifest.files) || manifest.files.length !== 1) fail('expected exactly one installer');
  const installer = manifest.files[0];
  if (installer?.url !== installerName || manifest.path !== installerName) fail('installer filename does not match');
  if (installer.size !== installerSize) fail('installer size does not match');
  if (installer.sha512 !== installerSha512 || manifest.sha512 !== installerSha512) fail('installer SHA-512 does not match');
  if (typeof manifest.releaseDate !== 'string' || !Number.isFinite(Date.parse(manifest.releaseDate))) fail('missing release date');
  return manifest;
}

async function hashFile(filePath, algorithm = 'sha256', encoding = 'hex') {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest(encoding);
}

async function auditManifest(releaseDirectory, version) {
  const manifestPath = path.join(releaseDirectory, 'latest.yml');
  if (!fs.existsSync(manifestPath)) fail('latest.yml is missing');
  if (fs.statSync(manifestPath).size > 1_048_576) fail('latest.yml is too large');
  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'), { schema: yaml.JSON_SCHEMA });
  const installerName = `AI-Usage-Setup-${version}-x64.exe`;
  const installerPath = path.join(releaseDirectory, installerName);
  const installerSize = fs.statSync(installerPath).size;
  const installerSha512 = await hashFile(installerPath, 'sha512', 'base64');
  validateManifest(manifest, { version, installerName, installerSize, installerSha512 });
  return { manifest: 'latest.yml', installerSize, installerSha512 };
}

module.exports = { auditManifest, hashFile, validateManifest };
