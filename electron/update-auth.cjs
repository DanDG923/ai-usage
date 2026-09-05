'use strict';

const fs = require('node:fs');
const path = require('node:path').win32;
const { execFile } = require('node:child_process');

const AUTH_REQUIRED_MESSAGE = 'Private updates need GitHub CLI signed in to github.com with access to DanDG923/ai-usage. Sign in with gh auth login, then check again.';
const COMMAND_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

function authRequired() {
  const error = new Error(AUTH_REQUIRED_MESSAGE);
  error.code = 'UPDATE_AUTH_REQUIRED';
  return error;
}

function environmentValue(environment, name) {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
}

function absoluteDirectory(value) {
  if (typeof value !== 'string') return null;
  const unquoted = value.trim().replace(/^"(.*)"$/, '$1');
  // Require a local drive and reject rooted, drive-relative, UNC and device
  // paths. A relative PATH entry must never select a CLI beside the app.
  if (!/^[a-z]:[\\/]/i.test(unquoted) || /["<>|?*]/.test(unquoted) || [...unquoted].some((character) => character.charCodeAt(0) < 32) || unquoted.slice(2).includes(':')) return null;
  return path.normalize(unquoted);
}

function commandEnvironment(environment) {
  const clean = {};
  for (const [key, value] of Object.entries(environment)) {
    // gh gives environment tokens priority over the user's stored sign-in.
    // Disable diagnostic output as well; credentials never belong in logs.
    if (/^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST|GH_DEBUG|DEBUG|PATH)$/i.test(key)) continue;
    clean[key] = value;
  }
  clean.PATH = String(environmentValue(environment, 'PATH') || '').split(';').map(absoluteDirectory).filter(Boolean).join(';');
  clean.GH_PROMPT_DISABLED = '1';
  clean.GH_NO_UPDATE_NOTIFIER = '1';
  clean.GH_NO_EXTENSION_UPDATE_NOTIFIER = '1';
  return clean;
}

function createGitHubUpdateAuth({ environment = process.env, stat = fs.statSync, execute = execFile } = {}) {
  function findCli() {
    const programRoots = [
      environmentValue(environment, 'ProgramW6432'),
      environmentValue(environment, 'ProgramFiles'),
      environmentValue(environment, 'ProgramFiles(x86)'),
      'C:\\Program Files',
      'C:\\Program Files (x86)',
    ].map(absoluteDirectory).filter(Boolean);
    const local = absoluteDirectory(environmentValue(environment, 'LOCALAPPDATA'));
    const directories = [
      ...programRoots.map((root) => path.join(root, 'GitHub CLI')),
      ...(local ? [path.join(local, 'Programs', 'GitHub CLI'), path.join(local, 'Microsoft', 'WinGet', 'Links')] : []),
      ...String(environmentValue(environment, 'PATH') || '').split(';').map(absoluteDirectory).filter(Boolean),
    ];
    const visited = new Set();
    for (const directory of directories) {
      const executable = path.join(directory, 'gh.exe');
      if (visited.has(executable.toLowerCase())) continue;
      visited.add(executable.toLowerCase());
      try { if (stat(executable).isFile()) return executable; } catch { /* Try the next installed location. */ }
    }
    throw authRequired();
  }

  async function getToken() {
    try {
      const executable = findCli();
      const output = await new Promise((resolve, reject) => {
        execute(executable, ['auth', 'token', '--hostname', 'github.com'], {
          shell: false,
          windowsHide: true,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          cwd: path.dirname(executable),
          env: commandEnvironment(environment),
        }, (error, stdout) => {
          if (error) reject(authRequired());
          else resolve(stdout);
        });
      });
      if (typeof output !== 'string' || output.length > MAX_OUTPUT_BYTES) throw authRequired();
      const token = output.trim();
      // Accept GitHub's current token families and legacy 40-character tokens;
      // reject banners, multiline output and header-control characters.
      if (token.length > 255 || !/^(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|[a-fA-F0-9]{40})$/.test(token)) throw authRequired();
      return token;
    } catch {
      // Never retain the command's error, stdout, stderr or a token as a cause.
      throw authRequired();
    }
  }

  return { getToken };
}

module.exports = { createGitHubUpdateAuth };
