'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');

// One definition of the Windows path rules the provider lookup and the update
// sign-in share. Both used to carry a private copy, and the two had to be
// kept identical by hand because either one admitting a relative or UNC path
// would let the launch directory choose which program runs.
//
// The app ships only for Windows, and on Windows these rules always use
// Windows paths. On any other system the same rules run with that system's
// paths instead, only so that the logic and its tests can run there; see
// pathRules for what changes.

/** @typedef {import('node:path').PlatformPath} PathFlavour */

/** The path flavour of the system the process runs on. */
const platformPath = process.platform === 'win32' ? nodePath.win32 : nodePath.posix;

// Environment names are case-insensitive on Windows: the value under
// whichever spelling the process actually carries. The lookup ignores case
// on every system, so it behaves the same wherever the tests run.
/**
 * @param {NodeJS.ProcessEnv} environment
 * @param {string} name
 */
function environmentValue(environment, name) {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
}

// The path rules for one path flavour. With Windows paths (the only flavour
// the shipped app ever uses) an absolute path needs a drive letter. With POSIX
// paths it needs a single leading slash instead; a leading double slash is
// refused like a UNC path, and every other refusal (quotes, wildcards,
// control characters, a colon after the root) is the same as on Windows.
/** @param {PathFlavour} [path] */
function pathRules(path = platformPath) {
  const windows = path.sep === '\\';
  const root = windows ? /^[a-z]:[\\/]/i : /^\/(?!\/)/;
  const rootLength = windows ? 2 : 1;

  // An absolute local path, normalised, or null. Requires a drive letter and
  // rejects rooted, drive-relative, UNC, device and alternate-stream forms, so
  // no value is ever resolved against the directory the app was opened from.
  /** @param {string | null | undefined} value */
  function absolutePath(value) {
    if (typeof value !== 'string') return null;
    const unquoted = value.trim().replace(/^"(.*)"$/, '$1');
    if (!root.test(unquoted) || /["<>|?*]/.test(unquoted)
      || [...unquoted].some((character) => character.charCodeAt(0) < 32)
      || unquoted.slice(rootLength).includes(':')) return null;
    return path.normalize(unquoted);
  }

  // The real, lower-cased directory the process was launched from, or null
  // when it cannot be resolved. A shortcut, a downloaded archive or an Explorer
  // "open with" placed the process there; even when PATH also lists it as an
  // absolute entry it must never be searched for a provider or the GitHub CLI.
  // Lower-casing on a case-sensitive system only makes the comparison
  // stricter: it can exclude a directory, never admit the launch directory.
  function launchDirectory(realpath = fs.realpathSync) {
    try { return path.normalize(realpath(process.cwd())).toLowerCase(); } catch { return null; }
  }

  return { path, absolutePath, environmentValue, launchDirectory };
}

const { absolutePath, launchDirectory } = pathRules();

module.exports = { absolutePath, environmentValue, launchDirectory, pathRules, platformPath };
