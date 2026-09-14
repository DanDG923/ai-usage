'use strict';

const fs = require('node:fs');
const path = require('node:path');

function releaseNotes(changelog, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable release version is required.');
  const heading = version.replaceAll('.', '\\.');
  const match = changelog.match(new RegExp(`^## ${heading}(?:[ \\t][^\\r\\n]*)?\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  if (!match || !match[1].trim()) throw new Error(`No changelog notes exist for ${version}.`);
  return `${match[1].trim()}\n`;
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const notes = releaseNotes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), pkg.version);
  const directory = require('./build-paths.cjs').buildDirectory(root);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'release-notes.md'), notes, 'utf8');
}

module.exports = { releaseNotes };
