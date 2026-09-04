'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDirectory = path.join(root, pkg.build?.directories?.output || 'release');
const artifactNames = [
  `AI-Usage-Portable-${pkg.version}-x64.exe`,
  `AI-Usage-Setup-${pkg.version}-x64.exe`,
  `AI-Usage-Setup-${pkg.version}-x64.exe.blockmap`,
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
    return /(^|\/)(?:backups|\.git)(?:\/|$)/i.test(entry)
      || ['-', '--wal', '--shm', 'ai-usage.sqlite', 'ai-usage.sqlite-wal', 'ai-usage.sqlite-shm'].includes(basename)
      || basename.endsWith('.aiusage.json');
  });
  if (privateLocalData.length) fail(`private local data is packaged: ${privateLocalData.slice(0, 5).join(', ')}`);
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

async function auditArtifacts() {
  const lines = [];
  for (const name of artifactNames) {
    const artifactPath = path.join(releaseDirectory, name);
    if (!fs.existsSync(artifactPath)) fail(`missing release artifact: ${name}`);
    const size = fs.statSync(artifactPath).size;
    const minimum = name.endsWith('.exe') ? 1_000_000 : 1_000;
    if (size < minimum) fail(`release artifact is unexpectedly small: ${name} (${size} bytes)`);
    lines.push(`${await hashFile(artifactPath)} *${name}`);
  }
  const checksumPath = path.join(releaseDirectory, 'SHA256SUMS.txt');
  // LF endings: `sha256sum -c` in Git Bash and WSL rejects a CRLF manifest.
  fs.writeFileSync(checksumPath, `${lines.join('\n')}\n`, 'utf8');
  return { checksumPath, artifacts: artifactNames.length };
}

async function main() {
  const entries = normalizedEntries();
  assertArchive(entries);
  const result = await auditArtifacts();
  process.stdout.write(`${JSON.stringify({
    version: pkg.version,
    asarEntries: entries.length,
    sourceMaps: 0,
    bundledClaudeBinaries: 0,
    privateLocalData: 0,
    ...result,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
