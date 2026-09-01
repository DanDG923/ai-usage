'use strict';

const DEFAULT_TIMEOUT_MS = 10_000;

class ClaudeUsageAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClaudeUsageAdapterError';
    this.code = code;
  }
}

async function defaultLoadSdk() {
  return import('@anthropic-ai/claude-agent-sdk');
}

function defaultFindClaudeBinary() {
  return require('./claude-collector.cjs').findClaudeBinary();
}

function idleInput() {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  return {
    // An async iterable that yields nothing and completes only when released:
    // the SDK gets a prompt stream, and the stream never carries a message.
    // oxlint-disable-next-line require-yield
    iterable: (async function* noMessages() { await released; }()),
    release,
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function schemaError() {
  return new ClaudeUsageAdapterError(
    'claude-usage-schema',
    'Claude returned an unsupported usage response.',
  );
}

function copyWindow(window) {
  if (window == null) return window;
  if (!isRecord(window)) throw schemaError();
  const utilization = window.utilization;
  const resetsAt = window.resets_at;
  if (utilization !== null
    && (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0 || utilization > 100)) {
    throw schemaError();
  }
  if (resetsAt !== null && (typeof resetsAt !== 'string' || !Number.isFinite(Date.parse(resetsAt)))) {
    throw schemaError();
  }
  return { utilization, resets_at: resetsAt };
}

function copyExtraUsage(extraUsage) {
  if (extraUsage == null) return extraUsage;
  if (!isRecord(extraUsage) || typeof extraUsage.is_enabled !== 'boolean') throw schemaError();
  const nonNegativeNumberOrNull = (value) => value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (!nonNegativeNumberOrNull(extraUsage.monthly_limit)
    || !nonNegativeNumberOrNull(extraUsage.used_credits)) {
    throw schemaError();
  }
  if (extraUsage.utilization !== null
    && (typeof extraUsage.utilization !== 'number'
      || !Number.isFinite(extraUsage.utilization)
      || extraUsage.utilization < 0
      || extraUsage.utilization > 100)) {
    throw schemaError();
  }
  if (extraUsage.currency !== undefined
    && extraUsage.currency !== null
    && typeof extraUsage.currency !== 'string') {
    throw schemaError();
  }
  const sanitized = {
    is_enabled: extraUsage.is_enabled,
    monthly_limit: extraUsage.monthly_limit,
    used_credits: extraUsage.used_credits,
    utilization: extraUsage.utilization,
  };
  if (extraUsage.currency !== undefined) sanitized.currency = extraUsage.currency;
  return sanitized;
}

function sanitizeUsage(raw) {
  if (!isRecord(raw)) throw schemaError();
  if (raw.subscription_type !== null && typeof raw.subscription_type !== 'string') throw schemaError();
  if (typeof raw.rate_limits_available !== 'boolean') throw schemaError();
  if (raw.rate_limits !== null && !isRecord(raw.rate_limits)) throw schemaError();
  const rateLimits = raw.rate_limits == null ? null : {};
  if (rateLimits) {
    for (const key of [
      'five_hour',
      'seven_day',
      'seven_day_oauth_apps',
      'seven_day_opus',
      'seven_day_sonnet',
    ]) {
      if (raw.rate_limits[key] !== undefined) rateLimits[key] = copyWindow(raw.rate_limits[key]);
    }
    if (raw.rate_limits.model_scoped !== undefined) {
      if (!Array.isArray(raw.rate_limits.model_scoped)) throw schemaError();
      rateLimits.model_scoped = raw.rate_limits.model_scoped.map((window) => ({
        ...(() => {
          if (!isRecord(window) || typeof window.display_name !== 'string' || !window.display_name.trim()) {
            throw schemaError();
          }
          return { display_name: window.display_name };
        })(),
        ...copyWindow(window),
      }));
    }
    if (raw.rate_limits.extra_usage !== undefined) {
      rateLimits.extra_usage = copyExtraUsage(raw.rate_limits.extra_usage);
    }
  }
  return {
    subscription_type: raw.subscription_type,
    rate_limits_available: raw.rate_limits_available,
    rate_limits: rateLimits,
  };
}

function withinTimeout(promise, timeoutMs, code, message, abortController) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const signal = abortController.signal;
    const removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeAbortListener();
      action(value);
    };
    const onAbort = () => {
      const error = signal.reason instanceof ClaudeUsageAdapterError
        ? signal.reason
        : new ClaudeUsageAdapterError(
          'claude-usage-aborted',
          'Claude usage reading was cancelled.',
        );
      finish(reject, error);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new ClaudeUsageAdapterError(code, message);
      finish(reject, error);
      abortController.abort(error);
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function usageWithinTimeout(promise, timeoutMs, abortController) {
  try {
    return await withinTimeout(
      promise,
      timeoutMs,
      'claude-usage-timeout',
      'Claude usage request timed out.',
      abortController,
    );
  } catch (error) {
    if (error instanceof ClaudeUsageAdapterError) throw error;
    throw new ClaudeUsageAdapterError('claude-usage-failed', 'Claude usage request failed.');
  }
}

async function initializationWithinTimeout(promise, timeoutMs, abortController) {
  try {
    return await withinTimeout(
      promise,
      timeoutMs,
      'claude-initialize-timeout',
      'Claude usage initialization timed out.',
      abortController,
    );
  } catch (error) {
    if (error instanceof ClaudeUsageAdapterError) throw error;
    throw new ClaudeUsageAdapterError('claude-initialize-failed', 'Claude usage initialization failed.');
  }
}

function cleanupWithinTimeout(query, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action(value);
    };
    timer = setTimeout(() => finish(
      reject,
      new ClaudeUsageAdapterError(
        'claude-cleanup-timeout',
        'Claude usage query cleanup timed out.',
      ),
    ), timeoutMs);
    Promise.resolve().then(() => query.return()).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function createClaudeAgentSdkUsagePort({
  loadSdk = defaultLoadSdk,
  findClaudeBinary = defaultFindClaudeBinary,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return {
    async read({ signal } = {}) {
      const abortController = new AbortController();
      const cancellationError = () => new ClaudeUsageAdapterError(
        'claude-usage-aborted',
        'Claude usage reading was cancelled.',
      );
      const onCallerAbort = () => abortController.abort(cancellationError());
      if (signal?.aborted) throw cancellationError();
      signal?.addEventListener?.('abort', onCallerAbort, { once: true });
      let input;
      let query;
      let primaryError;
      try {
        const claudePath = findClaudeBinary();
        if (typeof claudePath !== 'string' || !claudePath.trim()) {
          throw new ClaudeUsageAdapterError(
            'claude-not-installed',
            'Claude Code is not installed or available locally.',
          );
        }
        let sdk;
        try {
          sdk = await loadSdk();
        } catch {
          throw new ClaudeUsageAdapterError('claude-sdk-unavailable', 'Claude Agent SDK is unavailable.');
        }
        input = idleInput();
        try {
          query = sdk.query({
            prompt: input.iterable,
            options: {
              pathToClaudeCodeExecutable: claudePath,
              persistSession: false,
              settingSources: [],
              systemPrompt: '',
              tools: [],
              allowedTools: [],
              mcpServers: {},
              strictMcpConfig: true,
              plugins: [],
              permissionMode: 'dontAsk',
              abortController,
            },
          });
        } catch {
          throw new ClaudeUsageAdapterError(
            'claude-query-launch-failed',
            'Claude usage query could not be started.',
          );
        }
        if (typeof query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') {
          throw new ClaudeUsageAdapterError(
            'claude-usage-unsupported',
            'This Claude Code version does not support automated usage reading.',
          );
        }
        await initializationWithinTimeout(
          query.initializationResult(),
          timeoutMs,
          abortController,
        );
        const raw = await usageWithinTimeout(
          query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
          timeoutMs,
          abortController,
        );
        return sanitizeUsage(raw);
      } catch (error) {
        primaryError = error instanceof ClaudeUsageAdapterError
          ? error
          : new ClaudeUsageAdapterError('claude-usage-failed', 'Claude usage request failed.');
        throw primaryError;
      } finally {
        signal?.removeEventListener?.('abort', onCallerAbort);
        input?.release();
        abortController.abort();
        if (query) {
          try {
            await cleanupWithinTimeout(query, timeoutMs);
          } catch (error) {
            // A cleanup failure only becomes the result when the read itself
            // succeeded; a primary error is never masked by it. Throwing from
            // the finally block is the intent here, not an accident.
            if (!primaryError) {
              if (error instanceof ClaudeUsageAdapterError
                && error.code === 'claude-cleanup-timeout') {
                // oxlint-disable-next-line no-unsafe-finally
                throw error;
              }
              // oxlint-disable-next-line no-unsafe-finally
              throw new ClaudeUsageAdapterError(
                'claude-cleanup-failed',
                'Claude usage query could not be closed cleanly.',
              );
            }
          }
        }
      }
    },
  };
}

module.exports = { createClaudeAgentSdkUsagePort };
