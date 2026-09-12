'use strict';

const fs = require('node:fs');
const path = require('node:path').win32;

// One definition of the Windows path rules the provider lookup and the update
// sign-in share. Both used to carry a private copy, and the two had to be
// kept identical by hand because either one admitting a relative or UNC path
// would let the launch directory choose which program runs.

// Environment names are case-insensitive on Windows: the value under
// whichever spelling the process actually carries.
function environmentValue(environment, name) {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
}

// An absolute local path, normalised, or null. Requires a drive letter and
// rejects rooted, drive-relative, UNC, device and alternate-stream forms, so
// no value is ever resolved against the directory the app was opened from.
function absolutePath(value) {
  if (typeof value !== 'string') return null;
  const unquoted = value.trim().replace(/^"(.*)"$/, '$1');
  if (!/^[a-z]:[\\/]/i.test(unquoted) || /["<>|?*]/.test(unquoted)
    || [...unquoted].some((character) => character.charCodeAt(0) < 32)
    || unquoted.slice(2).includes(':')) return null;
  return path.normalize(unquoted);
}

// The real, lower-cased directory the process was launched from, or null
// when it cannot be resolved. A shortcut, a downloaded archive or an Explorer
// "open with" placed the process there; even when PATH also lists it as an
// absolute entry it must never be searched for a provider or the GitHub CLI.
function launchDirectory(realpath = fs.realpathSync) {
  try { return path.normalize(realpath(process.cwd())).toLowerCase(); } catch { return null; }
}

module.exports = { absolutePath, environmentValue, launchDirectory };
