'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createGitHubUpdateAuth } = require('../electron/update-auth.cjs');

// Synthetic credentials only: tests never invoke the installed GitHub CLI.
const TEST_TOKEN = `gho_${'a'.repeat(36)}`;
const DEFAULT_CLI = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const AUTH_MESSAGE = 'Private updates need GitHub CLI signed in to github.com with access to DanDG923/ai-usage. Sign in with gh auth login, then check again.';

function fixture({ environment = {}, installed = [DEFAULT_CLI], output = `${TEST_TOKEN}\r\n`, failure = null, throws = false } = {}) {
  const calls = [];
  const inspected = [];
  const auth = createGitHubUpdateAuth({
    environment,
    stat(executable) {
      inspected.push(executable);
      return { isFile: () => installed.includes(executable) };
    },
    execute(file, args, options, callback) {
      calls.push({ file, args, options });
      if (throws) throw failure;
      callback(failure, output, `stderr containing ${TEST_TOKEN}`);
    },
  });
  return { auth, calls, inspected };
}

async function rejectsSafely(auth) {
  await assert.rejects(auth.getToken(), (error) => {
    assert.equal(error.code, 'UPDATE_AUTH_REQUIRED');
    assert.equal(error.message, AUTH_MESSAGE);
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error), ['code']);
    assert.ok(!String(error.stack).includes(TEST_TOKEN));
    assert.ok(!JSON.stringify(error).includes(TEST_TOKEN));
    return true;
  });
}

test('private update authentication uses the stored github.com account without shell or interactive prompts', async () => {
  const environment = {
    ProgramFiles: 'C:\\Program Files',
    Path: '.;relative;C:drive-relative;\\rooted;\\\\server\\tools;"D:\\Tools";C:\\Windows\\System32',
    GH_TOKEN: 'environment override',
    github_token: 'second override',
    GH_ENTERPRISE_TOKEN: 'enterprise override',
    GITHUB_ENTERPRISE_TOKEN: 'another enterprise override',
    GH_HOST: 'enterprise.example',
    GH_DEBUG: 'api',
    DEBUG: '1',
    APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
    GH_CONFIG_DIR: 'C:\\Users\\tester\\gh-config',
  };
  const original = { ...environment };
  const { auth, calls } = fixture({ environment });
  assert.equal(await auth.getToken(), TEST_TOKEN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, DEFAULT_CLI);
  assert.deepEqual(calls[0].args, ['auth', 'token', '--hostname', 'github.com']);
  const options = calls[0].options;
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.ok(options.timeout > 0 && options.timeout <= 10_000);
  assert.ok(options.maxBuffer > 0 && options.maxBuffer <= 16 * 1024);
  assert.equal(options.encoding, 'utf8');
  assert.equal(options.cwd, 'C:\\Program Files\\GitHub CLI');
  assert.equal(options.env.PATH, 'D:\\Tools;C:\\Windows\\System32');
  assert.equal(options.env.GH_PROMPT_DISABLED, '1');
  assert.equal(options.env.GH_NO_UPDATE_NOTIFIER, '1');
  assert.equal(options.env.APPDATA, environment.APPDATA);
  assert.equal(options.env.GH_CONFIG_DIR, environment.GH_CONFIG_DIR);
  for (const key of ['GH_TOKEN', 'github_token', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_DEBUG', 'DEBUG', 'Path']) {
    assert.equal(options.env[key], undefined);
  }
  assert.deepEqual(environment, original, 'the application environment must remain untouched');
});

test('a missing GitHub CLI reports a stable sign-in instruction without executing a command', async () => {
  const { auth, calls } = fixture({ installed: [] });
  await rejectsSafely(auth);
  assert.equal(calls.length, 0);
});

test('CLI failures and synchronous launch errors cannot expose credentials or command diagnostics', async () => {
  for (const throws of [false, true]) {
    const failure = Object.assign(new Error(`command failed with ${TEST_TOKEN}`), {
      stdout: TEST_TOKEN,
      stderr: TEST_TOKEN,
      code: 'ETIMEDOUT',
      killed: true,
    });
    await rejectsSafely(fixture({ failure, throws }).auth);
  }
});

test('invalid token output is rejected without exposing output', async () => {
  for (const output of ['', '   \r\n', 'not signed in', `${TEST_TOKEN}\n${TEST_TOKEN}`, `${TEST_TOKEN}\r\nInjected: value`, `Bearer ${TEST_TOKEN}`, `gho_${'a'.repeat(300)}`, 'a'.repeat(16 * 1024 + 1), null, Buffer.from(TEST_TOKEN)]) {
    await rejectsSafely(fixture({ output }).auth);
  }
});

test('supported GitHub token formats are returned only to the main-process caller', async () => {
  for (const output of [TEST_TOKEN, `ghp_${'b'.repeat(36)}`, `github_pat_${'c'.repeat(22)}_${'d'.repeat(59)}`, 'abcdef0123'.repeat(4)]) {
    const { auth } = fixture({ output });
    assert.deepEqual(Object.keys(auth), ['getToken']);
    assert.equal(await auth.getToken(), output);
  }
});

test('CLI resolution supports per-user installs and absolute PATH entries without trusting relative locations', async () => {
  const local = 'C:\\Users\\tester\\AppData\\Local';
  for (const executable of [`${local}\\Programs\\GitHub CLI\\gh.exe`, `${local}\\Microsoft\\WinGet\\Links\\gh.exe`, 'D:\\Custom Tools\\gh.exe']) {
    const { auth, calls, inspected } = fixture({
      environment: { LOCALAPPDATA: local, PATH: '.;..\\bin;C:relative;\\rooted;\\\\server\\share;D:\\Custom Tools' },
      installed: [executable],
    });
    assert.equal(await auth.getToken(), TEST_TOKEN);
    assert.equal(calls[0].file, executable);
    assert.ok(inspected.every((candidate) => /^[a-z]:\\/i.test(candidate)));
    assert.ok(inspected.every((candidate) => !candidate.includes('relative') && !candidate.includes('rooted') && !candidate.includes('server')));
  }
});

test('credentials are retrieved afresh so signing out is not hidden by an authentication cache', async () => {
  let signedIn = true;
  const auth = createGitHubUpdateAuth({
    environment: {},
    stat: () => ({ isFile: () => true }),
    execute(_file, _args, _options, callback) {
      callback(signedIn ? null : new Error('signed out'), signedIn ? TEST_TOKEN : '');
    },
  });
  assert.equal(await auth.getToken(), TEST_TOKEN);
  signedIn = false;
  await rejectsSafely(auth);
});
