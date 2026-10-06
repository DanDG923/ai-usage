'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MANUAL_INSTALL_COMMAND, MAX_SCRIPT_BYTES, digestOf, fetchInstaller, verifyInstallerScript } = require('../electron/claude-installer.cjs');
const { checkPin, readPin, updatePin } = require('../tools/claude-installer-pin.cjs');

const script = Buffer.from('param([string]$Target = "latest")\nWrite-Output "install"\n');
const pin = { url: 'https://claude.ai/install.ps1', sha256: digestOf(script), bytes: script.length, verifiedOn: '2026-10-06' };

// A fake https.get: `routes` maps a URL to a response description.
function fakeGet(routes, calls = []) {
  return (url, options, onResponse) => {
    calls.push(url);
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = (error) => request.emit('error', error);
    options.signal?.addEventListener('abort', () => request.emit('error', Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' })));
    const route = routes[url];
    setImmediate(() => {
      if (options.signal?.aborted) return;
      if (!route) { request.emit('error', Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' })); return; }
      const response = new EventEmitter();
      response.statusCode = route.status ?? 200;
      response.headers = route.headers ?? {};
      response.resume = () => {};
      response.destroy = () => { response.destroyed = true; };
      onResponse(response);
      if (route.chunks) {
        for (const chunk of route.chunks) {
          if (response.destroyed) return;
          response.emit('data', Buffer.from(chunk));
        }
        if (!response.destroyed) response.emit('end');
      }
    });
    return request;
  };
}

test('the installer download follows HTTPS redirects only and returns the final script bytes', async () => {
  const calls = [];
  const get = fakeGet({
    'https://claude.ai/install.ps1': { status: 302, headers: { location: 'https://downloads.claude.ai/claude-code-releases/bootstrap.ps1' } },
    'https://downloads.claude.ai/claude-code-releases/bootstrap.ps1': { chunks: [script.subarray(0, 10), script.subarray(10)] },
  }, calls);
  const result = await fetchInstaller('https://claude.ai/install.ps1', { get });
  assert.equal(result.url, 'https://downloads.claude.ai/claude-code-releases/bootstrap.ps1');
  assert.deepEqual(result.bytes, script);
  assert.deepEqual(calls, ['https://claude.ai/install.ps1', 'https://downloads.claude.ai/claude-code-releases/bootstrap.ps1']);
});

test('a redirect to plain HTTP, a redirect loop, or a non-200 answer never yields a script', async () => {
  const downgrade = fakeGet({ 'https://claude.ai/install.ps1': { status: 302, headers: { location: 'http://claude.ai/install.ps1' } } });
  await assert.rejects(fetchInstaller('https://claude.ai/install.ps1', { get: downgrade }), (error) => error.code === 'CLAUDE_INSTALLER_DOWNLOAD_FAILED' && /HTTPS/.test(error.message));
  const loopCalls = [];
  const loop = fakeGet({ 'https://claude.ai/install.ps1': { status: 302, headers: { location: 'https://claude.ai/install.ps1' } } }, loopCalls);
  await assert.rejects(fetchInstaller('https://claude.ai/install.ps1', { get: loop }), /too many times/);
  assert.equal(loopCalls.length, 4);
  const missing = fakeGet({ 'https://claude.ai/install.ps1': { status: 404, chunks: [] } });
  await assert.rejects(fetchInstaller('https://claude.ai/install.ps1', { get: missing }), /HTTP 404/);
  const offline = fakeGet({});
  await assert.rejects(fetchInstaller('https://claude.ai/install.ps1', { get: offline }), (error) => error.code === 'CLAUDE_INSTALLER_DOWNLOAD_FAILED');
  await assert.rejects(fetchInstaller('http://claude.ai/install.ps1', { get: fakeGet({}) }), /HTTPS/);
});

test('an abort signal cancels the download before or during the request', async () => {
  const early = new AbortController();
  early.abort();
  const calls = [];
  await assert.rejects(fetchInstaller('https://claude.ai/install.ps1', { get: fakeGet({ 'https://claude.ai/install.ps1': { chunks: [script] } }, calls), signal: early.signal }),
    (error) => error.code === 'CLAUDE_INSTALLER_DOWNLOAD_CANCELLED');
  assert.equal(calls.length, 0, 'an already-cancelled download makes no request');
  const during = new AbortController();
  const seen = [];
  const get = (url, options, onResponse) => { seen.push(options.signal); return fakeGet({})(url, options, onResponse); };
  const pending = fetchInstaller('https://claude.ai/install.ps1', { get, signal: during.signal });
  during.abort();
  await assert.rejects(pending, (error) => error.code === 'CLAUDE_INSTALLER_DOWNLOAD_CANCELLED');
  assert.equal(seen[0], during.signal, 'the signal is handed to the request');
});

test('an oversized download is abandoned instead of buffered', async () => {
  const big = Buffer.alloc(MAX_SCRIPT_BYTES + 1, 0x41);
  const get = fakeGet({ 'https://claude.ai/install.ps1': { chunks: [big.subarray(0, 1000), big.subarray(1000)] } });
  await assert.rejects(fetchInstaller('https://claude.ai/install.ps1', { get }), /larger than expected/);
});

test('only a byte-exact script passes the pin, and a mismatch names the manual command', () => {
  assert.equal(verifyInstallerScript(script, pin), pin.sha256);
  const changed = Buffer.concat([script, Buffer.from('Invoke-Expression $env:EXTRA\n')]);
  assert.throws(() => verifyInstallerScript(changed, pin), (error) => error.code === 'CLAUDE_INSTALLER_CHANGED' && error.message.includes(MANUAL_INSTALL_COMMAND));
  assert.throws(() => verifyInstallerScript(Buffer.alloc(0), pin), (error) => error.code === 'CLAUDE_INSTALLER_DOWNLOAD_FAILED');
  for (const bad of [null, {}, { ...pin, sha256: 'abc' }, { ...pin, url: 'http://claude.ai/install.ps1' }, { ...pin, sha256: pin.sha256.toUpperCase() }]) {
    assert.throws(() => verifyInstallerScript(script, bad), (error) => error.code === 'CLAUDE_INSTALLER_PIN_INVALID');
  }
});

test('the shipped pin is well formed and names the vendor URL', () => {
  const shipped = readPin();
  assert.equal(shipped.url, 'https://claude.ai/install.ps1');
  assert.match(shipped.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(shipped.bytes) && shipped.bytes > 0 && shipped.bytes <= MAX_SCRIPT_BYTES);
  assert.match(shipped.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
});

test('the pin tool reports a drifted script and rewrites the pin only when asked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-pin-'));
  const file = path.join(root, 'pin.json');
  try {
    fs.writeFileSync(file, JSON.stringify(pin));
    const same = fakeGet({ 'https://claude.ai/install.ps1': { chunks: [script] } });
    assert.equal((await checkPin({ file, fetchOptions: { get: same } })).matches, true);
    const newScript = Buffer.from('Write-Output "new"\n');
    const drifted = fakeGet({ 'https://claude.ai/install.ps1': { chunks: [newScript] } });
    const check = await checkPin({ file, fetchOptions: { get: drifted } });
    assert.equal(check.matches, false);
    assert.equal(check.current, digestOf(newScript));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), pin, 'check never writes');
    const update = await updatePin({ file, fetchOptions: { get: drifted }, today: new Date('2026-10-07T12:00:00Z') });
    assert.equal(update.changed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { url: pin.url, sha256: digestOf(newScript), bytes: newScript.length, verifiedOn: '2026-10-07' });
    fs.writeFileSync(file, JSON.stringify({ url: pin.url, sha256: 'nope' }));
    await assert.rejects(checkPin({ file, fetchOptions: { get: same } }), /malformed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('digests are plain lowercase SHA-256 hex', () => {
  assert.equal(digestOf(Buffer.from('abc')), crypto.createHash('sha256').update('abc').digest('hex'));
});
