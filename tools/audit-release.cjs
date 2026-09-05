'use strict';

const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const yaml = require('js-yaml');
const { auditManifest, hashFile } = require('./release-manifest.cjs');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDirectory = path.join(root, pkg.build?.directories?.output || 'release');
const artifactNames = [
  `AI-Usage-Portable-${pkg.version}-x64.exe`,
  `AI-Usage-Setup-${pkg.version}-x64.exe`,
  `AI-Usage-Setup-${pkg.version}-x64.exe.blockmap`,
  'latest.yml',
];
const archivePath = path.join(releaseDirectory, 'win-unpacked', 'resources', 'app.asar');

function fail(message) {
  throw new Error(`Release audit failed: ${message}`);
}

function normalizedEntries() {
  if (!fs.existsSync(archivePath)) fail(`missing packaged application archive: ${archivePath}`);
  return asar.listPackage(archivePath)
    .map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, ''));
}

function assertArchive(entries) {
  const required = [
    'dist/index.html',
    'electron/main.cjs',
    'electron/preload.cjs',
    'electron/maintenance-host.cjs',
    'electron/maintenance-service.cjs',
    'node_modules/@anthropic-ai/claude-agent-sdk/package.json',
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) fail(`required application file is absent from ASAR: ${entry}`);
  }

  const sourceMaps = entries.filter((entry) => entry.toLowerCase().endsWith('.map'));
  if (sourceMaps.length) fail(`source map files are packaged (${sourceMaps.length})`);

  const bundledClaude = entries.filter((entry) => /(^|\/)node_modules\/@anthropic-ai\/claude-agent-sdk-win32-/i.test(entry));
  if (bundledClaude.length) fail('the optional bundled Claude executable is packaged');

  const privateLocalData = entries.filter((entry) => {
    const basename = path.posix.basename(entry).toLowerCase();
    return /(^|\/)(?:backups|\.git|\.codex|\.claude)(?:\/|$)/i.test(entry)
      || ['-', '--wal', '--shm', 'ai-usage.sqlite', 'ai-usage.sqlite-wal', 'ai-usage.sqlite-shm'].includes(basename)
      || ['auth.json', '.credentials.json', 'hosts.yml', '.env'].includes(basename)
      || /\.sqlite(?:-(?:wal|shm))?$/i.test(basename)
      || basename.endsWith('.aiusage.json');
  });
  if (privateLocalData.length) fail(`private local data is packaged: ${privateLocalData.slice(0, 5).join(', ')}`);
}

function assertPrivateFeed() {
  const configurationPath = path.join(releaseDirectory, 'win-unpacked', 'resources', 'app-update.yml');
  if (!fs.existsSync(configurationPath)) fail('packaged update configuration is missing');
  const configuration = yaml.load(fs.readFileSync(configurationPath, 'utf8'), { schema: yaml.JSON_SCHEMA });
  if (configuration?.provider !== 'github' || configuration.owner !== 'DanDG923'
    || configuration.repo !== 'ai-usage' || configuration.private !== true) fail('packaged private feed is incorrect');
  const allowed = new Set(['provider', 'owner', 'repo', 'private', 'updaterCacheDirName']);
  if (Object.keys(configuration).some((key) => !allowed.has(key))) fail('packaged feed contains unexpected settings or credentials');
  const packedPackage = JSON.parse(asar.extractFile(archivePath, 'package.json').toString('utf8'));
  if (packedPackage.version !== pkg.version) fail('packaged version does not match package.json');
  if (JSON.stringify(packedPackage.updateFeed) !== JSON.stringify(pkg.build.publish)) {
    fail('packaged persistent update feed does not match package.json');
  }
  if (packedPackage.build?.publish && JSON.stringify(packedPackage.build.publish) !== JSON.stringify(pkg.build.publish)) {
    fail('packaged publish configuration does not match package.json');
  }
}

async function auditArtifacts() {
  const lines = [];
  for (const name of artifactNames) {
    const artifactPath = path.join(releaseDirectory, name);
    if (!fs.existsSync(artifactPath)) fail(`missing release artifact: ${name}`);
    const size = fs.statSync(artifactPath).size;
    const minimum = name.endsWith('.exe') ? 1_000_000 : name.endsWith('.blockmap') ? 1_000 : 100;
    if (size < minimum) fail(`release artifact is unexpectedly small: ${name} (${size} bytes)`);
    lines.push(`${(await hashFile(artifactPath)).toUpperCase()} *${name}`);
  }
  const checksumPath = path.join(releaseDirectory, 'SHA256SUMS.txt');
  // LF endings: `sha256sum -c` in Git Bash and WSL rejects a CRLF manifest.
  fs.writeFileSync(checksumPath, `${lines.join('\n')}\n`, 'utf8');
  return { checksumPath, artifacts: artifactNames.length };
}

async function main() {
  const entries = normalizedEntries();
  assertArchive(entries);
  assertPrivateFeed();
  const updateManifest = await auditManifest(releaseDirectory, pkg.version);
  const result = await auditArtifacts();
  process.stdout.write(`${JSON.stringify({
    version: pkg.version,
    asarEntries: entries.length,
    sourceMaps: 0,
    bundledClaudeBinaries: 0,
    privateLocalData: 0,
    updateManifest,
    ...result,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
