'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { findClaudeBinary, providerProcessOptions } = require('./provider-executable.cjs');

// Fixed vendor command: neither executable arguments nor script content come
// from the renderer. The native installer needs no npm or administrator rights.
const INSTALL_COMMAND = "$ErrorActionPreference='Stop'; & ([scriptblock]::Create((Invoke-RestMethod -Uri 'https://claude.ai/install.ps1' -TimeoutSec 60))) stable";

function runCommand(file, args, { timeoutMs = 15000, acceptExitOne = false, environment = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...providerProcessOptions(file, environment), windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error && !(acceptExitOne && error.code === 1)) {
        reject(new Error(error.killed ? 'Claude setup timed out. Check your connection and try again.' : 'Claude could not complete this step. Please try again.'));
      } else resolve(stdout);
    });
  });
}

// `environment` is the one the app was launched with: the update check
// removes GitHub tokens from process.env, and Claude must not inherit that.
function createClaudeSetup({ statePath, findBinary = findClaudeBinary, run = runCommand, launch = spawn, installHelper, uninstallHelper, helperInstalled = () => false, environment = process.env } = {}) {
  let busy = false;
  let child = null;
  let cancelPending = null;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const save = (dismissed) => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ dismissed }), 'utf8');
  };
  const dismissed = () => {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')).dismissed === true; } catch { return false; }
  };
  async function status() {
    const binary = findBinary();
    let auth = 'unavailable';
    if (binary) {
      try {
        const account = JSON.parse(await run(binary, ['auth', 'status'], { acceptExitOne: true, environment }));
        if (typeof account.loggedIn === 'boolean') auth = account.loggedIn ? 'signed-in' : 'signed-out';
      } catch { /* Report an unavailable check separately from a signed-out account. */ }
    }
    return { installed: Boolean(binary), auth, helperInstalled: helperInstalled(), dismissed: dismissed(), busy };
  }
  async function exclusive(action) {
    if (busy) throw new Error('Claude setup is already running.');
    busy = true;
    try {
      // Login and finish already verify authentication. Reuse that result and
      // refresh only local state after the action, keeping the lock until done.
      const checked = await action() ?? await status();
      return { ...checked, helperInstalled: helperInstalled(), dismissed: dismissed(), busy: false };
    } finally { busy = false; }
  }
  function interactiveCommand(file, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      // Claude opens the user's browser itself. Discard its output so OAuth
      // URLs, codes and account details never enter app logs or the renderer.
      child = launch(file, args, { ...providerProcessOptions(file, environment), windowsHide: true, stdio: 'ignore' });
      const active = child;
      const timer = setTimeout(() => cancel(), timeoutMs);
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child === active) child = null;
        cancelPending = null;
        if (error) reject(error); else resolve();
      };
      cancelPending = () => finish(new Error('Claude setup was cancelled or timed out. You can try again.'));
      active.once('error', () => finish(new Error('Claude setup could not start. Please try again.')));
      active.once('exit', (code) => finish(code === 0 ? null : new Error('Claude setup was cancelled or did not finish. You can try again.')));
    });
  }
  function cancel() {
    if (!child) return;
    const active = child;
    // Terminate only the process tree started by this setup operation.
    if (Number.isInteger(active.pid)) {
      execFile(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(active.pid), '/T', '/F'], { windowsHide: true }, (error) => { if (error) active.kill(); });
    }
    cancelPending?.();
  }
  return {
    status,
    install: () => exclusive(async () => {
      if (findBinary()) return;
      await interactiveCommand(powershell, ['-NoProfile', '-NonInteractive', '-Command', INSTALL_COMMAND], 12 * 60_000);
      if (!findBinary()) throw new Error('Claude Code installation could not be verified. Check your connection and try again.');
    }),
    login: () => exclusive(async () => {
      const binary = findBinary();
      if (!binary) throw new Error('Install Claude Code first.');
      await interactiveCommand(binary, ['auth', 'login'], 10 * 60_000);
      const checked = await status();
      if (checked.auth !== 'signed-in') throw new Error('Sign-in is not complete. Please try again.');
      return checked;
    }),
    finish: ({ enableHelper } = {}) => exclusive(async () => {
      const checked = await status();
      if (checked.auth !== 'signed-in') throw new Error('Sign in to Claude before finishing setup.');
      if (enableHelper === true) await installHelper();
      else if (enableHelper === false && checked.helperInstalled) await uninstallHelper();
      save(true);
      return checked;
    }),
    skip: () => { if (busy) throw new Error('Cancel the current step before skipping setup.'); save(true); },
    cancel,
  };
}

module.exports = { createClaudeSetup, INSTALL_COMMAND, runCommand };
