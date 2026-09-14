'use strict';
const os = require('node:os');
const path = require('node:path');

function buildDirectory(root, environment = process.env) {
  if (environment.AI_USAGE_BUILD_OUTPUT) return path.resolve(environment.AI_USAGE_BUILD_OUTPUT);
  if (environment.CI) return path.join(root, 'release');
  return path.join(environment.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'AI Usage', 'Build', 'release');
}

module.exports = { buildDirectory };
