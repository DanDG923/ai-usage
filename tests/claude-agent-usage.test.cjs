'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');
const adapterPath = require.resolve('../electron/claude-agent-usage.cjs');
const collectorPath = require.resolve('../electron/claude-collector.cjs');
delete require.cache[collectorPath];
const { createClaudeAgentSdkUsagePort } = require(adapterPath);

test('loading the SDK usage adapter does not eagerly load the Claude collector', () => {
  assert.equal(require.cache[collectorPath], undefined);
});

test('one read returns only plan windows and closes a no-message Claude query', async () => {
  let queryOptions;
  let idleResult;
  let usageCalls = 0;
  let returnCalls = 0;
  const raw = {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12, resets_at: '2026-08-30T20:00:00.000Z', ignored: true },
      seven_day: { utilization: 34, resets_at: '2026-09-03T08:00:00.000Z' },
      seven_day_oauth_apps: { utilization: 21, resets_at: '2026-09-03T08:00:00.000Z', ignored: true },
      seven_day_opus: { utilization: 99, resets_at: '2026-09-03T08:00:00.000Z' },
      seven_day_sonnet: null,
      model_scoped: [
        { display_name: 'Fable', utilization: 68, resets_at: '2026-09-03T08:00:00.000Z', ignored: true },
        { display_name: 'Research model', utilization: 23, resets_at: '2026-09-03T08:00:00.000Z', ignored: true },
      ],
      extra_usage: { is_enabled: true, monthly_limit: 250, used_credits: 99, utilization: 39.6, currency: 'USD', ignored: true },
    },
    session: { total_cost_usd: 123 },
    behaviors: { private_local_detail: true },
    credential_material: 'fixture-secret-that-must-not-escape',
  };
  const loadSdk = async () => ({
    query(params) {
      queryOptions = params.options;
      const idleNext = params.prompt[Symbol.asyncIterator]().next();
      return {
        initializationResult: async () => ({ account: { email: 'not-returned@example.test' } }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
          usageCalls += 1;
          return raw;
        },
        async return() {
          returnCalls += 1;
          idleResult = await idleNext;
          params.options.stderr('[DEBUG] fetchUtilization: 200 after 1 attempt(s)\n');
          return { done: true };
        },
      };
    },
  });
  const usagePort = createClaudeAgentSdkUsagePort({
    loadSdk,
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
  });

  const result = await usagePort.read();

  assert.deepEqual(result, {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12, resets_at: '2026-08-30T20:00:00.000Z' },
      seven_day: { utilization: 34, resets_at: '2026-09-03T08:00:00.000Z' },
      seven_day_oauth_apps: { utilization: 21, resets_at: '2026-09-03T08:00:00.000Z' },
      seven_day_opus: { utilization: 99, resets_at: '2026-09-03T08:00:00.000Z' },
      seven_day_sonnet: null,
      model_scoped: [
        { display_name: 'Fable', utilization: 68, resets_at: '2026-09-03T08:00:00.000Z' },
        { display_name: 'Research model', utilization: 23, resets_at: '2026-09-03T08:00:00.000Z' },
      ],
      extra_usage: { is_enabled: true, monthly_limit: 250, used_credits: 99, utilization: 39.6, currency: 'USD' },
    },
  });
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.equal(usageCalls, 1);
  assert.equal(returnCalls, 1);
  assert.deepEqual(idleResult, { value: undefined, done: true });
  assert.equal(queryOptions.pathToClaudeCodeExecutable, 'C:\\fixture\\claude.exe');
  assert.equal(queryOptions.persistSession, false);
  assert.deepEqual(queryOptions.settingSources, []);
  assert.equal(queryOptions.cwd, 'C:\\fixture');
  assert.ok(Object.hasOwn(queryOptions.env, 'PATH'));
  assert.equal(queryOptions.systemPrompt, '');
  assert.deepEqual(queryOptions.tools, []);
  assert.deepEqual(queryOptions.allowedTools, []);
  assert.deepEqual(queryOptions.mcpServers, {});
  assert.equal(queryOptions.strictMcpConfig, true);
  assert.deepEqual(queryOptions.plugins, []);
  assert.equal(queryOptions.permissionMode, 'dontAsk');
  assert.equal(queryOptions.abortController.signal.aborted, true);
});

test('an initialization timeout aborts and closes the idle query without starting usage', { timeout: 100 }, async () => {
  let idleResult;
  let usageCalls = 0;
  let returnCalls = 0;
  let querySignal;
  const usagePort = createClaudeAgentSdkUsagePort({
    timeoutMs: 5,
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({
      query(params) {
        querySignal = params.options.abortController.signal;
        const idleNext = params.prompt[Symbol.asyncIterator]().next();
        return {
          initializationResult: async () => new Promise(() => {}),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
            usageCalls += 1;
            return null;
          },
          async return() {
            returnCalls += 1;
            idleResult = await idleNext;
            return { done: true };
          },
        };
      },
    }),
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-initialize-timeout');
    assert.equal(error.message, 'Claude usage initialization timed out.');
    return true;
  });
  assert.equal(usageCalls, 0);
  assert.equal(returnCalls, 1);
  assert.equal(querySignal.aborted, true);
  assert.deepEqual(idleResult, { value: undefined, done: true });
});

test('a usage timeout aborts and closes an initialized query', { timeout: 100 }, async () => {
  let returnCalls = 0;
  let querySignal;
  const usagePort = createClaudeAgentSdkUsagePort({
    timeoutMs: 5,
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({
      query(params) {
        querySignal = params.options.abortController.signal;
        return {
          initializationResult: async () => ({}),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => new Promise(() => {}),
          async return() { returnCalls += 1; return { done: true }; },
        };
      },
    }),
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-usage-timeout');
    assert.equal(error.message, 'Claude usage request timed out.');
    return true;
  });
  assert.equal(returnCalls, 1);
  assert.equal(querySignal.aborted, true);
});

test('malformed experimental usage data fails with a safe schema error and still closes', async () => {
  let returnCalls = 0;
  const usagePort = createClaudeAgentSdkUsagePort({
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({
      query() {
        return {
          initializationResult: async () => ({}),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
            subscription_type: 'max',
            rate_limits_available: true,
            rate_limits: {
              model_scoped: [{
                display_name: 'Fable',
                utilization: 1_000,
                resets_at: '2026-09-03T08:00:00.000Z',
                credential_material: 'fixture-secret-that-must-not-escape',
              }],
            },
          }),
          async return() { returnCalls += 1; return { done: true }; },
        };
      },
    }),
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-usage-schema');
    assert.equal(error.message, 'Claude returned an unsupported usage response.');
    assert.equal(error.message.includes('fixture-secret'), false);
    return true;
  });
  assert.equal(returnCalls, 1);
});

test('malformed extra usage metadata is rejected without exposing unrecognized fields', async () => {
  let returnCalls = 0;
  const usagePort = createClaudeAgentSdkUsagePort({
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({
      query() {
        return {
          initializationResult: async () => ({}),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
            subscription_type: 'max',
            rate_limits_available: true,
            rate_limits: {
              extra_usage: {
                is_enabled: true,
                monthly_limit: -1,
                used_credits: 0,
                utilization: 0,
                credential_material: 'fixture-secret-that-must-not-escape',
              },
            },
          }),
          async return() { returnCalls += 1; return { done: true }; },
        };
      },
    }),
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-usage-schema');
    assert.equal(error.message, 'Claude returned an unsupported usage response.');
    assert.equal(error.message.includes('fixture-secret'), false);
    return true;
  });
  assert.equal(returnCalls, 1);
});

test('an SDK usage failure is sanitized and the query is still closed', async () => {
  let returnCalls = 0;
  const usagePort = createClaudeAgentSdkUsagePort({
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({
      query() {
        return {
          initializationResult: async () => ({}),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
            throw new Error('provider included fixture-secret credential material');
          },
          async return() { returnCalls += 1; return { done: true }; },
        };
      },
    }),
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-usage-failed');
    assert.equal(error.message, 'Claude usage request failed.');
    assert.equal(error.message.includes('fixture-secret'), false);
    return true;
  });
  assert.equal(returnCalls, 1);
});

test('an SDK initialization failure is sanitized before it reaches the tracker', async () => {
  let returnCalls = 0;
  const usagePort = createClaudeAgentSdkUsagePort({
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({
      query() {
        return {
          initializationResult: async () => {
            throw new Error('authentication failed for fixture-secret');
          },
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => null,
          async return() { returnCalls += 1; return { done: true }; },
        };
      },
    }),
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-initialize-failed');
    assert.equal(error.message, 'Claude usage initialization failed.');
    assert.equal(error.message.includes('fixture-secret'), false);
    return true;
  });
  assert.equal(returnCalls, 1);
});

test('a missing external Claude executable is reported before loading the SDK', async () => {
  let sdkLoads = 0;
  const usagePort = createClaudeAgentSdkUsagePort({
    findClaudeBinary: () => null,
    loadSdk: async () => { sdkLoads += 1; return {}; },
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-not-installed');
    assert.equal(error.message, 'Claude Code is not installed or available locally.');
    return true;
  });
  assert.equal(sdkLoads, 0);
});

test('an SDK load failure is sanitized without exposing module or environment detail', async () => {
  const usagePort = createClaudeAgentSdkUsagePort({
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => { throw new Error('failed beside fixture-secret path'); },
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-sdk-unavailable');
    assert.equal(error.message, 'Claude Agent SDK is unavailable.');
    assert.equal(error.message.includes('fixture-secret'), false);
    return true;
  });
});

test('an SDK query launch failure is sanitized and releases the idle input', async () => {
  let idleCompletion;
  let querySignal;
  const usagePort = createClaudeAgentSdkUsagePort({
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({
      query(params) {
        querySignal = params.options.abortController.signal;
        idleCompletion = params.prompt[Symbol.asyncIterator]().next();
        throw new Error('query launch exposed fixture-secret credential material');
      },
    }),
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-query-launch-failed');
    assert.equal(error.message, 'Claude usage query could not be started.');
    assert.equal(error.message.includes('fixture-secret'), false);
    return true;
  });
  assert.equal(querySignal.aborted, true);
  assert.deepEqual(await idleCompletion, { value: undefined, done: true });
});

test('an SDK without the experimental usage method reports unsupported and closes', async () => {
  let returnCalls = 0;
  const usagePort = createClaudeAgentSdkUsagePort({
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({
      query() {
        return {
          initializationResult: async () => ({}),
          async return() { returnCalls += 1; return { done: true }; },
        };
      },
    }),
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-usage-unsupported');
    assert.equal(error.message, 'This Claude Code version does not support automated usage reading.');
    return true;
  });
  assert.equal(returnCalls, 1);
});

test('a query cleanup failure after success is sanitized', async () => {
  let returnCalls = 0;
  const usagePort = createClaudeAgentSdkUsagePort({
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({
      query() {
        return {
          initializationResult: async () => ({}),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
            subscription_type: 'max',
            rate_limits_available: false,
            rate_limits: null,
          }),
          async return() {
            returnCalls += 1;
            throw new Error('cleanup exposed fixture-secret process detail');
          },
        };
      },
    }),
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-cleanup-failed');
    assert.equal(error.message, 'Claude usage query could not be closed cleanly.');
    assert.equal(error.message.includes('fixture-secret'), false);
    return true;
  });
  assert.equal(returnCalls, 1);
});

test('a query cleanup failure never masks the primary sanitized usage failure', async () => {
  let returnCalls = 0;
  const usagePort = createClaudeAgentSdkUsagePort({
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({
      query() {
        return {
          initializationResult: async () => ({}),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
            throw new Error('usage exposed fixture-secret-primary');
          },
          async return() {
            returnCalls += 1;
            throw new Error('cleanup exposed fixture-secret-secondary');
          },
        };
      },
    }),
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-usage-failed');
    assert.equal(error.message, 'Claude usage request failed.');
    assert.equal(error.message.includes('fixture-secret'), false);
    return true;
  });
  assert.equal(returnCalls, 1);
});

test('a query cleanup that never settles is bounded and cannot wedge later refreshes', { timeout: 100 }, async () => {
  const usagePort = createClaudeAgentSdkUsagePort({
    timeoutMs: 5,
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({
      query() {
        return {
          initializationResult: async () => ({}),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
            subscription_type: 'max', rate_limits_available: false, rate_limits: null,
          }),
          return: async () => new Promise(() => {}),
        };
      },
    }),
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-cleanup-timeout');
    assert.equal(error.message, 'Claude usage query cleanup timed out.');
    return true;
  });
});

test('a cleanup timeout never masks a primary sanitized usage failure', { timeout: 100 }, async () => {
  const usagePort = createClaudeAgentSdkUsagePort({
    timeoutMs: 5,
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({
      query() {
        return {
          initializationResult: async () => ({}),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
            throw new Error('usage exposed fixture-secret-primary');
          },
          return: async () => new Promise(() => {}),
        };
      },
    }),
  });

  await assert.rejects(usagePort.read(), (error) => {
    assert.equal(error.code, 'claude-usage-failed');
    assert.equal(error.message, 'Claude usage request failed.');
    assert.equal(error.message.includes('fixture-secret'), false);
    return true;
  });
});

test('caller cancellation aborts and closes a pending control-only query', { timeout: 100 }, async () => {
  let returnCalls = 0;
  let querySignal;
  const caller = new AbortController();
  const usagePort = createClaudeAgentSdkUsagePort({
    timeoutMs: 1_000,
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({
      query(params) {
        querySignal = params.options.abortController.signal;
        queueMicrotask(() => caller.abort());
        return {
          initializationResult: async () => new Promise(() => {}),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => null,
          async return() { returnCalls += 1; return { done: true }; },
        };
      },
    }),
  });

  await assert.rejects(usagePort.read({ signal: caller.signal }), (error) => {
    assert.equal(error.code, 'claude-usage-aborted');
    assert.equal(error.message, 'Claude usage reading was cancelled.');
    return true;
  });
  assert.equal(returnCalls, 1);
  assert.equal(querySignal.aborted, true);
});
