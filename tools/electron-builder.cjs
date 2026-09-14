'use strict';
const path = require('node:path');
const { buildDirectory } = require('./build-paths.cjs');
const output = buildDirectory(path.resolve(__dirname, '..'));
module.exports = {
  ...require('../package.json').build,
  directories: { output },
  releaseInfo: { releaseNotesFile: path.join(output, 'release-notes.md') },
};
