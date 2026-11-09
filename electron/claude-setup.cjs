'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { findClaudeBinary, providerProcessOptions } = require('./provider-executable.cjs');
const { fetchInstaller: downloadInstaller, verifyInstallerScript } = require('./claude-installer.cjs');
const shippedPin = require('./claude-installer-pin.json');

// The vendor installer is fetched, checked against the digest pinned at
// release time, written beside the setup state, and only then run from that
// file. Neither executable arguments nor script content come from the
// renderer. The native installer needs no npm or administrator rights.
const INSTALLER_FILE = 'claude-install.ps1';
const INSTALL_TARGET = 'stable';

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
/**
 * @param {object} [options]
 * @param {string} [options.statePath]
 * @param {typeof findClaudeBinary} [options.findBinary]
 * @param {typeof runCommand} [options.run]
 * @param {typeof spawn} [options.launch]
 * @param {() => unknown} [options.installHelper]
 * @param {() => unknown} [options.uninstallHelper]
 * @param {() => boolean} [options.helperInstalled]
 * @param {NodeJS.ProcessEnv} [options.environment]
 * @param {typeof downloadInstaller} [options.fetchInstaller]
 * @param {typeof shippedPin} [options.installerPin]
 * @param {(message: string) => void} [options.log]
 */
function createClaudeSetup({
  statePath, findBinary = findClaudeBinary, run = runCommand, launch = spawn, installHelper, uninstallHelper, helperInstalled = () => false,
  environment = process.env, fetchInstaller = downloadInstaller, installerPin = shippedPin, log = () => {},
} = {}) {
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
    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
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
      cancelPending = () => finish(new Error(CANCELLED));
      active.once('error', () => finish(new Error('Claude setup could not start. Please try again.')));
      active.once('exit', (code) => finish(code === 0 ? null : new Error('Claude setup was cancelled or did not finish. You can try again.')));
    });
  }
  // Cancels whichever stage is running: the installer download, which has no
  // child process yet, or the interactive child process itself.
  function cancel() {
    const active = child;
    // Terminate only the process tree started by this setup operation.
    if (active && Number.isInteger(active.pid)) {
      execFile(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(active.pid), '/T', '/F'], { windowsHide: true }, (error) => { if (error) active.kill(); });
    }
    cancelPending?.();
  }
  const CANCELLED = 'Claude setup was cancelled or timed out. You can try again.';
  // Runs the download under a cancellation handle so Cancel (or shutdown)
  // aborts the request, and a response that still arrives is discarded.
  async function cancellableDownload(url) {
    const controller = new AbortController();
    let cancelled = false;
    const handle = () => { cancelled = true; controller.abort(); };
    cancelPending = handle;
    try {
      const { bytes } = await fetchInstaller(url, { signal: controller.signal });
      if (cancelled) throw Object.assign(new Error(CANCELLED), { code: 'CLAUDE_INSTALLER_DOWNLOAD_CANCELLED' });
      return bytes;
    } catch (error) {
      if (cancelled || error?.code === 'CLAUDE_INSTALLER_DOWNLOAD_CANCELLED') throw Object.assign(new Error(CANCELLED), { code: 'CLAUDE_INSTALLER_DOWNLOAD_CANCELLED' });
      log(`Claude installer download failed${error?.code ? ` (${error.code})` : ''}.`);
      throw new Error('The Claude Code installer could not be downloaded. Check your connection and try again.');
    } finally {
      if (cancelPending === handle) cancelPending = null;
    }
  }
  return {
    status,
    // The full status spawns the Claude CLI; a window that only needs to know
    // whether the guide was dismissed reads the one saved flag instead.
    dismissed,
    install: () => exclusive(async () => {
      if (findBinary()) return;
      const bytes = await cancellableDownload(installerPin.url);
      // A changed script is reported with the vendor's own command and is
      // never written to disk or run.
      const digest = verifyInstallerScript(bytes, installerPin);
      log(`Claude installer verified: sha256 ${digest} (${bytes.length} bytes, pinned ${installerPin.verifiedOn || 'unknown date'}).`);
      const scriptPath = path.join(path.dirname(statePath), INSTALLER_FILE);
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(scriptPath, bytes);
      try {
        await interactiveCommand(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, INSTALL_TARGET], 12 * 60_000);
      } finally {
        try { fs.unlinkSync(scriptPath); } catch { /* Already gone or still locked; it is overwritten on the next attempt. */ }
      }
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
    finish: (/** @type {{ enableHelper?: boolean }} */ { enableHelper } = {}) => exclusive(async () => {
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

module.exports = { createClaudeSetup, INSTALLER_FILE, INSTALL_TARGET, runCommand };
