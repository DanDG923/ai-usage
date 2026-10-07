'use strict';

// Refreshes or checks the pinned digest of Anthropic's Claude Code installer
// script (electron/claude-installer-pin.json). `--check` fails the build when
// the published script no longer matches the pin, so a release never ships a
// pin that would send every user to the manual fallback; `--update` rewrites
// the pin after the new script has been reviewed.
const fs = require('node:fs');
const path = require('node:path');
const { digestOf, fetchInstaller, validPin } = require('../electron/claude-installer.cjs');

const pinPath = path.join(__dirname, '..', 'electron', 'claude-installer-pin.json');

function readPin(file = pinPath) {
  const pin = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!validPin(pin)) throw new Error('electron/claude-installer-pin.json is malformed.');
  return pin;
}

async function currentDigest(pin, options) {
  const { url, bytes } = await fetchInstaller(pin.url, options);
  return { url, bytes: bytes.length, sha256: digestOf(bytes) };
}

async function checkPin({ file = pinPath, fetchOptions } = {}) {
  const pin = readPin(file);
  const current = await currentDigest(pin, fetchOptions);
  const matches = current.sha256 === pin.sha256;
  return { matches, pinned: pin.sha256, current: current.sha256, bytes: current.bytes, resolvedUrl: current.url };
}

async function updatePin({ file = pinPath, fetchOptions, today = new Date() } = {}) {
  const pin = readPin(file);
  const current = await currentDigest(pin, fetchOptions);
  const next = { url: pin.url, sha256: current.sha256, bytes: current.bytes, verifiedOn: today.toISOString().slice(0, 10) };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { changed: next.sha256 !== pin.sha256, previous: pin.sha256, ...next };
}

async function main(argv) {
  if (argv.includes('--update')) {
    const result = await updatePin();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const result = await checkPin();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.matches) {
    throw new Error(`The published Claude installer (sha256 ${result.current}) no longer matches the pin (${result.pinned}). `
      + 'Review the new script, then run "npm run installer:update" and commit electron/claude-installer-pin.json.');
  }
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { checkPin, readPin, updatePin };
