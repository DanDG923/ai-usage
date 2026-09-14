'use strict';
const fs = require('node:fs');
const path = require('node:path');

function checkVersion(root, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable x.y.z version.');
  const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  if ([pkg.version, lock.version, lock.packages[''].version].some((entry) => entry !== version)) throw new Error('Package and lockfile versions disagree.');
  const readme = read('README.md');
  for (const kind of ['Setup', 'Portable']) {
    if (!readme.includes(`AI-Usage-${kind}-${version}-x64.exe`)) throw new Error(`README ${kind} version disagrees.`);
  }
  const heading = read('CHANGELOG.md').match(/^## (\d+\.\d+\.\d+)/m)?.[1];
  if (heading !== version) throw new Error('The latest changelog heading must match the version.');
  return version;
}

function bumpVersion(root, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable x.y.z version.');
  const file = (name) => path.join(root, name);
  const pkg = JSON.parse(fs.readFileSync(file('package.json'), 'utf8'));
  const previous = pkg.version;
  const lock = JSON.parse(fs.readFileSync(file('package-lock.json'), 'utf8'));
  pkg.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  let changelog = fs.readFileSync(file('CHANGELOG.md'), 'utf8');
  if (!changelog.includes(`## ${version}\n`) && !changelog.includes(`## ${version}\r\n`)) {
    changelog = changelog.replace(/^# Changelog\s*/, `# Changelog\n\n## ${version}\n\n- Release notes pending review.\n\n`);
  }
  const readme = fs.readFileSync(file('README.md'), 'utf8').replaceAll(previous, version);
  // Prepare every change before writing; historical changelog headings stay intact.
  for (const [name, text] of [['package.json', JSON.stringify(pkg, null, 2) + '\n'], ['package-lock.json', JSON.stringify(lock, null, 2) + '\n'], ['README.md', readme], ['CHANGELOG.md', changelog]]) fs.writeFileSync(file(name), text);
  return checkVersion(root, version);
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const args = process.argv.slice(2);
  const version = args.find((arg) => !arg.startsWith('--')) || require('../package.json').version;
  if (args.includes('--check')) checkVersion(root, version);
  else { bumpVersion(root, version); process.stdout.write(`Review the release notes, then tag with: git tag v${version}\n`); }
}
module.exports = { checkVersion, bumpVersion };
