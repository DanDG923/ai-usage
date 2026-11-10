'use strict';

// The repository root, and a way to read one of its files as text, for tests
// that inspect source, configuration or documentation rather than load it.
// Modules under test are still required by relative path in each test file.

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

function readRepoFile(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8');
}

module.exports = { repoRoot, readRepoFile };
