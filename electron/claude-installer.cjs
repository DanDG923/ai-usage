'use strict';

const crypto = require('node:crypto');
const https = require('node:https');

// Anthropic publishes Claude Code's Windows installer as a short PowerShell
// bootstrap script that is not Authenticode-signed. Running whatever that URL
// serves would trust TLS alone, so the app downloads the script, compares its
// SHA-256 with the digest pinned at release time, and runs only an exact match.
// `tools/claude-installer-pin.cjs` refreshes the pin; a changed script is
// reported to the user with the vendor's own command instead of being run.
const MANUAL_INSTALL_COMMAND = 'irm https://claude.ai/install.ps1 | iex';
const MAX_REDIRECTS = 3;
const MAX_SCRIPT_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function digestOf(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validPin(pin) {
  return Boolean(pin) && typeof pin === 'object'
    && typeof pin.url === 'string' && pin.url.startsWith('https://')
    && typeof pin.sha256 === 'string' && /^[0-9a-f]{64}$/.test(pin.sha256);
}

function requestOnce(url, get, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(coded('Installer download was cancelled.', 'CLAUDE_INSTALLER_DOWNLOAD_CANCELLED'));
      return;
    }
    let request;
    try {
      request = get(url, { headers: { 'user-agent': 'ai-usage-claude-setup' }, ...(signal ? { signal } : {}) }, (response) => {
        const status = response.statusCode;
        if (REDIRECT_CODES.has(status)) {
          response.resume();
          resolve({ redirect: response.headers.location ?? null });
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(coded(`Installer download returned HTTP ${status}.`, 'CLAUDE_INSTALLER_DOWNLOAD_FAILED'));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_SCRIPT_BYTES) {
            response.destroy();
            reject(coded('Installer download is larger than expected.', 'CLAUDE_INSTALLER_DOWNLOAD_FAILED'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => reject(coded(`Installer download failed: ${error.code || 'read error'}.`, 'CLAUDE_INSTALLER_DOWNLOAD_FAILED')));
        response.on('end', () => resolve({ bytes: Buffer.concat(chunks) }));
      });
    } catch (error) {
      reject(coded(`Installer download could not start: ${error?.code || 'request error'}.`, 'CLAUDE_INSTALLER_DOWNLOAD_FAILED'));
      return;
    }
    request.on('error', (error) => {
      if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        reject(coded('Installer download was cancelled.', 'CLAUDE_INSTALLER_DOWNLOAD_CANCELLED'));
      } else reject(coded(`Installer download failed: ${error?.code || 'network error'}.`, 'CLAUDE_INSTALLER_DOWNLOAD_FAILED'));
    });
    if (typeof request.setTimeout === 'function') {
      request.setTimeout(timeoutMs, () => {
        request.destroy(coded('Installer download timed out.', 'CLAUDE_INSTALLER_DOWNLOAD_FAILED'));
      });
    }
  });
}

// Follows a bounded number of HTTPS-to-HTTPS redirects (claude.ai currently
// forwards to downloads.claude.ai) and refuses any hop to another scheme. An
// aborted `signal` ends the download with CLAUDE_INSTALLER_DOWNLOAD_CANCELLED.
/**
 * @param {string} url
 * @param {{ get?: typeof https.get, timeoutMs?: number, signal?: AbortSignal }} [options]
 */
async function fetchInstaller(url, { get = https.get, timeoutMs = FETCH_TIMEOUT_MS, signal } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!/^https:\/\//i.test(current)) throw coded('Installer download must use HTTPS.', 'CLAUDE_INSTALLER_DOWNLOAD_FAILED');
    const result = await requestOnce(current, get, timeoutMs, signal);
    if (result.bytes) return { url: current, bytes: result.bytes };
    if (!result.redirect) throw coded('Installer download redirected without a destination.', 'CLAUDE_INSTALLER_DOWNLOAD_FAILED');
    current = new URL(result.redirect, current).href;
  }
  throw coded('Installer download redirected too many times.', 'CLAUDE_INSTALLER_DOWNLOAD_FAILED');
}

// Returns the digest when the script matches the pin; throws when it does not.
function verifyInstallerScript(bytes, pin) {
  if (!validPin(pin)) throw coded('The pinned Claude installer digest is missing or malformed.', 'CLAUDE_INSTALLER_PIN_INVALID');
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw coded('The downloaded installer is empty.', 'CLAUDE_INSTALLER_DOWNLOAD_FAILED');
  const digest = digestOf(bytes);
  if (digest !== pin.sha256) {
    throw coded(
      'Anthropic has changed the Claude Code installer since this version of AI Usage was released, so AI Usage did not run it. '
      + `To install Claude Code yourself, open PowerShell and run: ${MANUAL_INSTALL_COMMAND}  Then choose Check again.`,
      'CLAUDE_INSTALLER_CHANGED',
    );
  }
  return digest;
}

module.exports = { MANUAL_INSTALL_COMMAND, MAX_SCRIPT_BYTES, digestOf, fetchInstaller, validPin, verifyInstallerScript };
