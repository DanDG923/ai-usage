'use strict';

const fs = require('node:fs');
const path = require('node:path').win32;
const { absolutePath, environmentValue, launchDirectory } = require('./windows-paths.cjs');

// Every binary lookup and every provider spawn walks PATH, two or three times
// per refresh, and each walk realpaths and stats every entry. The result is
// remembered briefly: long enough to serve one refresh, short enough that a
// directory the setup flow has just created is seen on the next lookup.
const PATH_CACHE_MS = 30_000;
let pathCache = null;

function pathDirectories(environment = process.env) {
  const launch = launchDirectory();
  if (!launch) return [];
  const key = `${launch}\n${String(environmentValue(environment, 'PATH') || '')}`;
  if (pathCache && pathCache.key === key && Date.now() - pathCache.at < PATH_CACHE_MS) return [...pathCache.directories];
  const directories = new Set();
  for (const entry of key.slice(launch.length + 1).split(';')) {
    const directory = absolutePath(entry);
    if (!directory) continue;
    try {
      // Canonicalize before comparing: junctions, short names, case and dot
      // components must not turn the inherited CWD into an accepted PATH root.
      const real = absolutePath(fs.realpathSync(directory));
      if (real && real.toLowerCase() !== launch && fs.statSync(real).isDirectory()) directories.add(real);
    } catch { /* Ignore unavailable PATH entries. */ }
  }
  pathCache = { key, at: Date.now(), directories: [...directories] };
  return [...directories];
}

function executable(value) {
  const file = absolutePath(value);
  if (!file || path.extname(file).toLowerCase() !== '.exe') return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

function findOnPath(name) {
  for (const directory of pathDirectories()) {
    const file = executable(path.join(directory, name));
    if (file) {
      // A file link from a PATH directory must not lead back into the launch CWD.
      try {
        if (path.dirname(fs.realpathSync(file)).toLowerCase() === launchDirectory()) continue;
      } catch { continue; }
      return file;
    }
  }
  return null;
}

function installationRoot(name, ...parts) {
  const root = absolutePath(environmentValue(process.env, name));
  return root ? path.join(root, ...parts) : null;
}

function versionedBinary(root, name, newestModified = false) {
  if (!root) return null;
  try {
    const versions = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ version: entry.name, binary: executable(path.join(root, entry.name, name)) }))
      .filter((entry) => entry.binary)
      .flatMap((entry) => {
        try { return [{ ...entry, modified: newestModified ? fs.statSync(entry.binary).mtimeMs : 0 }]; } catch { return []; }
      })
      .sort((a, b) => newestModified ? b.modified - a.modified : b.version.localeCompare(a.version, undefined, { numeric: true }));
    return versions[0]?.binary ?? null;
  } catch { return null; }
}

function findClaudeBinary() {
  const onPath = findOnPath('claude.exe');
  if (onPath) return onPath;
  const native = executable(installationRoot('USERPROFILE', '.local', 'bin', 'claude.exe'));
  if (native) return native;
  // Only Claude Code caches, never a similarly named Desktop GUI executable.
  for (const root of [
    installationRoot('APPDATA', 'Claude', 'claude-code'),
    installationRoot('LOCALAPPDATA', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code'),
  ]) {
    const bundled = versionedBinary(root, 'claude.exe');
    if (bundled) return bundled;
  }
  return null;
}

function findCodexBinary() {
  const override = environmentValue(process.env, 'CODEX_BINARY');
  // An explicit override is trusted configuration, but invalid configuration
  // must fail closed rather than selecting a different program implicitly.
  if (override !== undefined) return executable(override);
  return findOnPath('codex.exe')
    ?? versionedBinary(installationRoot('LOCALAPPDATA', 'OpenAI', 'Codex', 'bin'), 'codex.exe', true);
}

function providerProcessOptions(file, environment = process.env) {
  const binary = absolutePath(file);
  if (!binary || path.extname(binary).toLowerCase() !== '.exe') throw new Error('Provider executable must be an absolute local .exe path.');
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !/^path$/i.test(key)));
  env.PATH = pathDirectories(environment).join(';');
  return { cwd: path.dirname(binary), env };
}

// The provider's configuration directory: an absolute override when the
// user set one, otherwise the conventional folder under the profile. A
// relative override or a missing profile yields null rather than a path
// resolved against the launch directory.
function providerHome(overrideName, conventionalFolder, environment = process.env) {
  const override = absolutePath(environmentValue(environment, overrideName));
  if (override) return override;
  const profile = absolutePath(environmentValue(environment, 'USERPROFILE'));
  return profile ? path.join(profile, conventionalFolder) : null;
}

module.exports = { findClaudeBinary, findCodexBinary, providerHome, providerProcessOptions };
