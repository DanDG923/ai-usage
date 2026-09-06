'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path').win32;
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

// electron-updater launches the installer and quits in the same tick, so a
// launch the operating system refuses (a freshly downloaded executable still
// held by an antivirus scan is the usual cause) leaves the application closed
// with nothing installed. Launching here, before the quit, allows a bounded
// retry and a report of what happened.
const LAUNCH_ATTEMPTS = 4;
const LAUNCH_RETRY_DELAY_MS = 1500;
const INSTALLER_ARGS = Object.freeze(['--updated', '/S', '--force-run']);
const RETRYABLE_CODES = new Set(['EACCES', 'EPERM', 'EBUSY', 'ETXTBSY', 'EAGAIN', 'UNKNOWN']);

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function fileDigest(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')));
  });
}

// The download was verified as it arrived; the file then sat on disk until the
// user chose to install. Check it again immediately before it runs.
async function verifyInstaller(filePath, expectedSha512) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.exe') {
    throw coded('The downloaded installer path is not usable.', 'ERR_UPDATER_INVALID_INSTALLER');
  }
  if (typeof expectedSha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(expectedSha512)) {
    throw coded('The update manifest carries no usable checksum.', 'ERR_UPDATER_CHECKSUM_MISMATCH');
  }
  let digest;
  try {
    digest = await fileDigest(filePath);
  } catch {
    throw coded('The downloaded installer could not be read.', 'ERR_UPDATER_INVALID_INSTALLER');
  }
  if (digest !== expectedSha512) throw coded('The downloaded installer failed verification.', 'ERR_UPDATER_CHECKSUM_MISMATCH');
}

function spawnOnce(filePath, args, spawnProcess) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(filePath, args, { detached: true, stdio: 'ignore' });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref?.();
      resolve(child.pid ?? null);
    });
  });
}

async function launchInstaller({
  filePath, sha512, args = INSTALLER_ARGS, spawnProcess = spawn,
  attempts = LAUNCH_ATTEMPTS, retryDelayMs = LAUNCH_RETRY_DELAY_MS, onLog = () => {},
}) {
  await verifyInstaller(filePath, sha512);
  onLog(`Installer verified: ${path.basename(filePath)}.`);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const pid = await spawnOnce(filePath, [...args], spawnProcess);
      onLog(`Installer launched on attempt ${attempt}${pid ? ` (pid ${pid})` : ''}.`);
      return { attempt, pid };
    } catch (error) {
      const code = /^[A-Z0-9_]{1,40}$/i.test(String(error?.code || '')) ? String(error.code) : 'UNKNOWN';
      onLog(`Installer launch attempt ${attempt} of ${attempts} failed (${code}).`);
      if (!RETRYABLE_CODES.has(code) || attempt === attempts) break;
      await delay(retryDelayMs);
    }
  }
  throw coded('The installer could not be started.', 'UPDATE_INSTALLER_LAUNCH_FAILED');
}

// A per-machine install needs elevation that only electron-updater's helper
// provides; this launcher handles the per-user layout the app ships with.
function installDirectoryWritable(executablePath = process.execPath) {
  try {
    fs.accessSync(path.dirname(executablePath), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = { INSTALLER_ARGS, installDirectoryWritable, launchInstaller, verifyInstaller };
