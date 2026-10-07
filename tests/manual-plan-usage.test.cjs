'use strict';
require('./setup.cjs');

// Claude plan usage is read by starting the user's own Claude Code through the
// Agent SDK. To keep the app's use of a Claude subscription within Anthropic's
// Consumer Terms, that read happens only when the user explicitly asks for a
// refresh; every automatic refresh still imports local activity.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');
const { REFRESH_TRIGGERS, createRefreshCoalescer, readsPlanUsage, refreshOptionsFor } = require('../electron/refresh-policy.cjs');
const { createCollectorHost, createInlineCollectorHost } = require('../electron/collector-host.cjs');
const { createCollectorService } = require('../electron/collector-service.cjs');
const { registerIpc } = require('../electron/ipc-handlers.cjs');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// The trigger classification.

test('only the three explicit user refreshes read Claude plan usage', () => {
  const expected = {
    'dashboard-refresh': true,
    'flyout-refresh': true,
    'tray-menu-refresh': true,
    launch: false,
    schedule: false,
    'window-show': false,
    'flyout-show': false,
    wake: false,
    'backup-restore': false,
    'manual-observation': false,
    'helper-change': false,
    'claude-code-sync': false,
  };
  assert.deepEqual(Object.values(REFRESH_TRIGGERS).sort(), Object.keys(expected).sort(), 'every trigger is classified here');
  for (const [trigger, reads] of Object.entries(expected)) {
    assert.equal(readsPlanUsage(trigger), reads, trigger);
    assert.deepEqual(refreshOptionsFor(trigger), { trigger, readPlanUsage: reads });
  }
  // No implicit default can read plan usage.
  for (const unknown of [undefined, null, '', 'refresh', 'DASHBOARD-REFRESH', true, {}]) {
    assert.equal(readsPlanUsage(unknown), false, String(unknown));
  }
});

// ---------------------------------------------------------------------------
// Coalescing never swallows a user's request.

test('a user refresh during an automatic run waits for it, then performs one shared plan-usage run', async () => {
  const runs = [];
  const coalescer = createRefreshCoalescer(({ readPlanUsage }) => {
    const gate = deferred();
    runs.push({ readPlanUsage, gate });
    return gate.promise;
  });
  const automatic = coalescer.request({ readPlanUsage: false });
  const joined = coalescer.request({});
  assert.equal(joined, automatic, 'automatic requests join the run in flight');
  const user = coalescer.request({ readPlanUsage: true });
  const secondUser = coalescer.request({ readPlanUsage: true });
  assert.equal(secondUser, user, 'user requests share one follow-up');
  assert.notEqual(user, automatic);
  assert.deepEqual(runs.map((run) => run.readPlanUsage), [false], 'the running automatic run is never upgraded');

  runs[0].gate.resolve('automatic');
  assert.equal(await automatic, 'automatic');
  await flush();
  assert.deepEqual(runs.map((run) => run.readPlanUsage), [false, true]);
  // A request of either kind during the plan-usage run joins it.
  assert.equal(coalescer.request({ readPlanUsage: true }), coalescer.request({ readPlanUsage: false }));
  runs[1].gate.resolve('plan usage');
  assert.equal(await user, 'plan usage');
  assert.equal(await secondUser, 'plan usage');
  assert.equal(runs.length, 2);
  assert.equal(coalescer.running, false);
});

test('a user refresh while a plan-usage run is in flight joins it rather than queuing another', async () => {
  const runs = [];
  const coalescer = createRefreshCoalescer(async ({ readPlanUsage }) => { runs.push(readPlanUsage); await flush(); return readPlanUsage; });
  const first = coalescer.request({ readPlanUsage: true });
  assert.equal(coalescer.request({ readPlanUsage: true }), first);
  assert.equal(await first, true);
  assert.deepEqual(runs, [true]);
});

test('a failed automatic run still lets the waiting user refresh read plan usage', async () => {
  const runs = [];
  const coalescer = createRefreshCoalescer(async ({ readPlanUsage }) => {
    runs.push(readPlanUsage);
    await flush();
    if (!readPlanUsage) throw new Error('automatic failed');
    return 'read';
  });
  const automatic = coalescer.request({ readPlanUsage: false });
  const user = coalescer.request({ readPlanUsage: true });
  await assert.rejects(automatic, /automatic failed/);
  assert.equal(await user, 'read');
  assert.deepEqual(runs, [false, true]);
});

// ---------------------------------------------------------------------------
// The main process: every trigger passes its classification.

function mainHarness({ stubRefreshAll = true, captureTimeouts = false } = {}) {
  const handlers = new Map();
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => false;
  app.quit = () => {};
  const timers = [];
  const timeouts = [];
  const filename = path.resolve(__dirname, '../electron/main.cjs');
  const localRequire = createRequire(filename);
  const electron = { app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, Menu: { buildFromTemplate: (template) => template } };
  const context = vm.createContext({
    require: (id) => (id === 'electron' ? electron : localRequire(id)),
    __dirname: path.dirname(filename), Buffer, console, URL,
    process: { env: {}, argv: [], on() {}, execPath: process.execPath, stderr: process.stderr },
    setTimeout: captureTimeouts ? (fn, ms) => { const timer = { fn, ms, unref() {} }; timeouts.push(timer); return timer; } : setTimeout,
    clearTimeout: captureTimeouts ? () => {} : clearTimeout,
    setInterval: (fn) => { const timer = { fn }; timers.push(timer); return timer; },
    clearInterval: () => {},
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  const run = (code) => vm.runInContext(code, context);
  if (stubRefreshAll) run('globalThis.refreshCalls = []; refreshAll = (options) => { refreshCalls.push(options); return Promise.resolve({}); };');
  return { handlers, timers, timeouts, run, calls: () => plain(run('refreshCalls')) };
}

test('the tray menu and flyout refreshes are user requests that read plan usage', async () => {
  const h = mainHarness();
  const menu = h.run('buildTrayMenu()');
  menu.find((item) => item.label === 'Refresh').click();
  assert.deepEqual(h.calls(), [{ trigger: 'tray-menu-refresh', readPlanUsage: true }]);

  h.run('trayFlyout = { isSender: () => true }; flyoutSnapshot = () => ({ flyout: true }); registerFlyoutIpc();');
  assert.deepEqual(plain(await h.handlers.get('flyout:refresh')({})), { flyout: true });
  assert.deepEqual(h.calls()[1], { trigger: 'flyout-refresh', readPlanUsage: true });
});

test('the schedule timer and every refreshIfStale trigger never read plan usage', () => {
  const h = mainHarness();
  h.run('store = { getSettings: () => ({ refreshIntervalMinutes: 15 }) }; lastRefreshAt = 0; scheduleAutomaticRefresh();');
  h.timers[0].fn();
  assert.deepEqual(h.calls(), [{ trigger: 'schedule', readPlanUsage: false }]);

  for (const trigger of ['launch', 'window-show', 'flyout-show', 'wake']) {
    h.run(`refreshCalls.length = 0; lastRefreshAt = 0; refreshIfStale({ trigger: '${trigger}', ignoreSchedule: true });`);
    assert.deepEqual(h.calls(), [{ trigger, readPlanUsage: false }], trigger);
  }
  // A caller that names no trigger cannot read plan usage either.
  h.run('refreshCalls.length = 0; lastRefreshAt = 0; refreshIfStale();');
  assert.deepEqual(h.calls(), [{ readPlanUsage: false }]);
});

test('the Claude Code mod never reads plan usage: its sync and its readings collect locally', () => {
  const h = mainHarness();
  h.run(`globalThis.claudeOnly = 0; refreshClaudeOnly = () => { claudeOnly += 1; return Promise.resolve(); };
    globalThis.opened = []; openDashboardAt = (target) => { opened.push(target); };
    store = { getSettings: () => ({ refreshIntervalMinutes: 15 }) }; isQuitting = false;`);
  h.run("answerClaudeCodeRequest('sync'); answerClaudeCodeRequest('open'); answerClaudeCodeRequest('read-plan-usage');");
  assert.deepEqual(h.calls(), [{ trigger: 'claude-code-sync', readPlanUsage: false }]);
  assert.deepEqual(plain(h.run('opened')), [{ tab: 'overview' }]);
  h.run('importClaudeCodeReading()');
  assert.equal(h.run('claudeOnly'), 1);
  // Collecting only on Refresh holds the reading until the next collection.
  h.run('store = { getSettings: () => ({ refreshIntervalMinutes: 0 }) }; importClaudeCodeReading();');
  assert.equal(h.run('claudeOnly'), 1);
});

test('every refresh call site names its trigger', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../electron/main.cjs'), 'utf8');
  const ipc = fs.readFileSync(path.resolve(__dirname, '../electron/ipc-handlers.cjs'), 'utf8');
  for (const [name, source] of [['main.cjs', main], ['ipc-handlers.cjs', ipc]]) {
    const calls = [...source.matchAll(/(?<![.\w])refreshAll\(([^)]*)/g)].map((match) => match[1])
      .filter((argument) => !argument.startsWith('{ readPlanUsage = false }'));
    assert.ok(calls.length > 0, name);
    // refreshIfStale forwards its own caller's trigger, checked below.
    for (const argument of calls) assert.match(argument, /^refreshOptionsFor\((REFRESH_TRIGGERS\.[A-Z_]+|trigger)$/, `${name}: refreshAll(${argument})`);
    const staleCalls = [...source.matchAll(/\brefreshIfStale\(([^)]*)\)/g)].map((match) => match[1])
      .filter((argument) => !argument.startsWith('{ trigger, ignoreSchedule'));
    for (const argument of staleCalls) assert.match(argument, /^\{ trigger: REFRESH_TRIGGERS\.[A-Z_]+/, `${name}: refreshIfStale(${argument})`);
  }
});

test('the launch and wake collections go through refreshIfStale as automatic triggers', () => {
  const h = mainHarness({ captureTimeouts: true });
  h.run(`globalThis.staleCalls = []; refreshIfStale = (options) => { staleCalls.push(options); };
    isQuitting = false;`);
  const runTimers = () => { for (const timer of h.timeouts.splice(0)) timer.fn(); };
  h.timeouts.length = 0;

  h.run('scheduleLaunchRefresh()');
  assert.deepEqual(h.timeouts.map((timer) => timer.ms), [900]);
  runTimers();
  assert.deepEqual(plain(h.run('staleCalls')), [{ trigger: 'launch', ignoreSchedule: true }]);

  h.run('staleCalls.length = 0; onResume()');
  assert.deepEqual(h.timeouts.map((timer) => timer.ms), [15_000]);
  runTimers();
  assert.deepEqual(plain(h.run('staleCalls')), [{ trigger: 'wake' }]);

  // A wake while quitting collects nothing.
  h.run('staleCalls.length = 0; isQuitting = true; onResume()');
  runTimers();
  assert.deepEqual(plain(h.run('staleCalls')), []);
  assert.deepEqual(h.calls(), [], 'neither calls refreshAll directly');

  // whenReady wires exactly these two.
  const main = fs.readFileSync(path.resolve(__dirname, '../electron/main.cjs'), 'utf8');
  assert.match(main, /\n\s+scheduleLaunchRefresh\(\);\n/);
  assert.match(main, /powerMonitor\.on\('resume', onResume\)/);
});

test('the main refresh passes the flag to the collectors and queues one plan-usage run behind an automatic one', async () => {
  const h = mainHarness({ stubRefreshAll: false });
  const source = fs.readFileSync(path.resolve(__dirname, '../electron/main.cjs'), 'utf8');
  h.run(`globalThis.runs = []; globalThis.gates = [];
    collectAll = (options) => { runs.push(options.readPlanUsage); return new Promise((resolve) => gates.push(resolve)); };`);
  const automatic = h.run('refreshAll(refreshOptionsFor(REFRESH_TRIGGERS.SCHEDULE))');
  const show = h.run('refreshAll(refreshOptionsFor(REFRESH_TRIGGERS.WINDOW_SHOW))');
  const user = h.run('refreshAll(refreshOptionsFor(REFRESH_TRIGGERS.DASHBOARD_REFRESH))');
  const flyout = h.run('refreshAll(refreshOptionsFor(REFRESH_TRIGGERS.FLYOUT_REFRESH))');
  assert.equal(show, automatic);
  assert.equal(flyout, user);
  assert.deepEqual(plain(h.run('runs')), [false]);
  h.run("gates[0]('automatic')");
  assert.equal(await automatic, 'automatic');
  await flush();
  assert.deepEqual(plain(h.run('runs')), [false, true]);
  h.run("gates[1]('user')");
  assert.equal(await user, 'user');
  assert.equal(await flyout, 'user');
  assert.equal(h.run('refreshRuns.running'), false);

  // The collection itself hands the flag to the collector host.
  const collectSource = source.match(/async function collectAll\(\{ readPlanUsage \}\) \{[\s\S]*?\n\}/)[0];
  assert.match(collectSource, /collectors\.refreshAll\(\{ readPlanUsage \}\)/);
});

// ---------------------------------------------------------------------------
// IPC: the dashboard's Refresh reads plan usage; a restore and the Claude-only
// refreshes after a local change do not.

test('the dashboard Refresh is a user request; the refresh after a restore is automatic', async () => {
  const calls = [];
  const claudeOnly = [];
  const handlers = new Map();
  registerIpc({
    handleIpc: (channel, handler) => handlers.set(channel, handler),
    refreshAll: async (options) => { calls.push(options); return {}; },
    refreshClaudeOnly: async (...args) => { claudeOnly.push(args); },
    store: { backupDirectory: 'backups' },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['backup.sqlite'] }) },
    databaseJobs: { exclusive: (run) => run() },
    maintenance: { request: async () => ({ restored: true }) },
    invalidateSnapshot() {}, applySettingsEffects() {}, publishAfterWrite() {}, snapshot: () => ({}), getWindow: () => null,
    installClaudeHelper: () => ({}), uninstallClaudeHelper: () => ({}), getInboxPath: () => 'inbox', log() {},
  });
  await handlers.get('dashboard:refresh')({});
  assert.deepEqual(calls, [{ trigger: 'dashboard-refresh', readPlanUsage: true }]);
  await handlers.get('dashboard:restore-backup')({});
  assert.deepEqual(calls[1], { trigger: 'backup-restore', readPlanUsage: false });
  await handlers.get('dashboard:install-claude-helper')({});
  await handlers.get('dashboard:uninstall-claude-helper')({});
  // Claude-only refreshes carry no plan-usage request at all.
  assert.deepEqual(claudeOnly, [[], []]);
});

// ---------------------------------------------------------------------------
// The collector hosts carry the flag, and a Claude-only refresh is always false.

test('both collector hosts send readPlanUsage explicitly, false unless asked', async () => {
  const child = new EventEmitter();
  child.sent = [];
  child.postMessage = (message) => child.sent.push(message);
  child.kill = () => {};
  const host = createCollectorHost({ fork: () => child, modulePath: 'x', config: {}, idleTimeoutMs: 0 });
  const pending = [host.refreshAll(), host.refreshAll({ readPlanUsage: true }), host.refreshAll({ readPlanUsage: 'yes' }), host.refreshClaude()];
  assert.deepEqual(child.sent.map(({ type, payload }) => ({ type, payload })), [
    { type: 'refresh-all', payload: { readPlanUsage: false } },
    { type: 'refresh-all', payload: { readPlanUsage: true } },
    { type: 'refresh-all', payload: { readPlanUsage: false } },
    { type: 'refresh-claude', payload: { readPlanUsage: false } },
  ]);
  host.stop();
  await Promise.allSettled(pending);

  const inline = createInlineCollectorHost({ handle: async (request) => request, close() {} });
  assert.deepEqual(await inline.refreshAll(), { type: 'refresh-all', readPlanUsage: false });
  assert.deepEqual(await inline.refreshAll({ readPlanUsage: true }), { type: 'refresh-all', readPlanUsage: true });
  assert.deepEqual(await inline.refreshClaude(), { type: 'refresh-claude', readPlanUsage: false });
});

// ---------------------------------------------------------------------------
// The collector service: a waiting Claude run is upgraded, a running one never.

function serviceWith(collectors) {
  return createCollectorService({ databasePath: 'db', inboxPath: 'inbox', openStore: () => ({ close() {} }), collectors });
}

test('a user request that joins a waiting Claude run upgrades it to read plan usage', async () => {
  const codexGate = deferred();
  const calls = [];
  const service = serviceWith({
    codex: async () => { calls.push('codex'); await codexGate.promise; return {}; },
    claude: async (_store, inbox, options) => { calls.push(['claude', inbox, options.readPlanUsage]); return {}; },
  });
  const automatic = service.handle({ type: 'refresh-all', readPlanUsage: false });
  await flush();
  assert.deepEqual(calls, ['codex'], 'Claude is still waiting behind Codex');
  const user = service.handle({ type: 'refresh-all', readPlanUsage: true });
  const claudeOnly = service.handle({ type: 'refresh-claude' });
  await flush();
  codexGate.resolve();
  await Promise.all([automatic, user, claudeOnly]);
  assert.deepEqual(calls.filter((call) => call !== 'codex'), [['claude', 'inbox', true]], 'one Claude run, upgraded');
});

test('a Claude run already executing is never upgraded; the user request gets its own follow-up', async () => {
  const claudeGate = deferred();
  const reads = [];
  const service = serviceWith({
    codex: async () => ({}),
    claude: async (_store, _inbox, options) => { reads.push(options.readPlanUsage); if (reads.length === 1) await claudeGate.promise; return {}; },
  });
  const automatic = service.handle({ type: 'refresh-all' });
  for (let turn = 0; turn < 5 && !reads.length; turn += 1) await flush();
  assert.deepEqual(reads, [false]);
  const user = service.handle({ type: 'refresh-all', readPlanUsage: true });
  await flush();
  assert.deepEqual(reads, [false], 'the running run keeps its flag');
  claudeGate.resolve();
  await Promise.all([automatic, user]);
  assert.deepEqual(reads, [false, true]);
});

test('a Claude-only refresh never reads plan usage, whatever the request says', async () => {
  const reads = [];
  const service = serviceWith({ codex: async () => ({}), claude: async (_store, _inbox, options) => { reads.push(options.readPlanUsage); return {}; } });
  await service.handle({ type: 'refresh-claude', readPlanUsage: true });
  await service.handle({ type: 'refresh-all', readPlanUsage: 'true' });
  await service.handle({ type: 'refresh-all', readPlanUsage: true });
  assert.deepEqual(reads, [false, false, true]);
});

// ---------------------------------------------------------------------------
// The Claude collector.

// Load the collector with the Agent SDK port factory replaced, to prove when
// a port is (and is not) created. The replacement never starts Claude Code.
function collectorWithPortSpy() {
  const agentUsage = require('../electron/claude-agent-usage.cjs');
  const modulePath = require.resolve('../electron/claude-collector.cjs');
  const original = agentUsage.createClaudeAgentSdkUsagePort;
  const created = [];
  agentUsage.createClaudeAgentSdkUsagePort = () => {
    const port = { reads: 0, read: async () => { port.reads += 1; return { rate_limits_available: false }; } };
    created.push(port);
    return port;
  };
  delete require.cache[modulePath];
  try {
    return { refreshClaude: require(modulePath).refreshClaude, created };
  } finally {
    agentUsage.createClaudeAgentSdkUsagePort = original;
    delete require.cache[modulePath];
  }
}

function collectorFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-manual-plan-usage-'));
  const previous = { USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.USERPROFILE = root;
  process.env.APPDATA = root;
  process.env.LOCALAPPDATA = root;
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  t.after(() => {
    store.close();
    Object.assign(process.env, previous);
  });
  const source = (id) => {
    const row = store.prepare('SELECT status, status_detail, metadata_json, last_success_at FROM sources WHERE id = ?').get(id);
    return { ...row, metadata: JSON.parse(row.metadata_json || '{}') };
  };
  // A status-line reading is dated as the current helper dates it: its
  // session was seen opening, just before the fetch.
  const reading = ({ sourceId = 'claude', bucketId = 'seven_day', hoursAgo, provenance = 'official-claude-usage', dated = true }) => store.recordObservation({
    sourceId, bucketId, bucketName: 'Weekly', observedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    usedPercent: 30, remainingPercent: 70, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    windowMinutes: 10_080, provenance, confidence: 1, metadata: {},
    fetchedAfter: provenance === 'official-statusline' && dated ? new Date(Date.now() - hoursAgo * 3_600_000 - 5_000).toISOString() : null,
  });
  return { root, store, source, reading };
}

const countingPort = () => {
  const port = { reads: 0, read: async () => { port.reads += 1; return { rate_limits_available: false }; } };
  return port;
};

test('an automatic Claude refresh never creates or calls the usage port, yet imports transcripts and the status-line inbox', async (t) => {
  const { root, store, source } = collectorFixture(t);
  const project = path.join(root, '.claude', 'projects', 'manual-plan-usage');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'session.jsonl'), `${JSON.stringify({
    type: 'assistant', sessionId: 'session-test', requestId: 'request-1', uuid: 'uuid-1',
    timestamp: new Date(Date.now() - 60_000).toISOString(), entrypoint: 'cli', isSidechain: false,
    message: { id: 'message-1', model: 'claude-fable-5', role: 'assistant',
      usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } },
  })}\n`);
  const inbox = path.join(root, 'inbox.jsonl');
  // A session seen opening, then redrawn with the limits its first response brought.
  fs.writeFileSync(inbox, `${[
    { ai_usage_captured_at: new Date(Date.now() - 10_000).toISOString(), session_id: 'working-session', api_ms: 0, rate_limits: null },
    { ai_usage_captured_at: new Date(Date.now() - 5_000).toISOString(), session_id: 'working-session', api_ms: 1_200,
      rate_limits: { seven_day: { used_percentage: 22, resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() } } },
  ].map((line) => JSON.stringify(line)).join('\n')}\n`);
  const { refreshClaude, created } = collectorWithPortSpy();
  const injected = countingPort();

  const result = await refreshClaude(store, inbox, { usagePort: injected });
  const omitted = await refreshClaude(store, inbox, {});
  const explicitFalse = await refreshClaude(store, inbox, { readPlanUsage: false, usagePort: injected });

  assert.equal(created.length, 0, 'no Agent SDK usage port is created');
  assert.equal(injected.reads, 0, 'an injected port is never called');
  assert.equal(result.transcripts.usageEvents, 1, 'transcripts still import');
  assert.equal(store.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE source_id = 'claude'").get().count, 1);
  assert.equal(result.statusLine.claudeObservations, 1, 'the status-line inbox still imports');
  for (const outcome of [result, omitted, explicitFalse]) {
    assert.deepEqual(outcome.fableTracking.provider, {
      kind: 'not-requested', attempted: false, attemptSucceeded: false, overallWindowsRecorded: 0,
      extraUsage: null, durationMs: null, errorCode: null,
    });
  }
  assert.equal(result.fableTracking.health.detail, '', 'not reading is no failure');
  // The fresh status-line reading keeps Claude connected.
  const claude = source('claude');
  assert.equal(claude.status, 'connected');
  assert.match(claude.status_detail, /last read .*read again when you press Refresh/);
  assert.equal(claude.metadata.provider, null, 'diagnostics show the SDK read as not attempted');
  assert.equal(claude.metadata.planUsage.requested, false);
});

test('without a plan-usage read, Claude is judged by the age of its latest official reading', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  await t.test('a recent reading stays connected', async (tt) => {
    const { store, source, reading } = collectorFixture(tt);
    reading({ hoursAgo: 2 });
    reading({ sourceId: 'claude-fable', bucketId: 'fable_seven_day', hoursAgo: 2 });
    await refreshClaude(store, path.join(store.backupDirectory, 'missing.jsonl'), { activityReader: { import: async () => ({ usageEvents: 0 }) } });
    const claude = source('claude');
    assert.equal(claude.status, 'connected');
    assert.match(claude.status_detail, /^Claude plan usage was last read .+; it is read again when you press Refresh\. Scanned 0 transcript messages\.$/);
    assert.notEqual(claude.last_success_at, null);
    const fable = source('claude-fable');
    assert.equal(fable.status, 'connected');
    assert.match(fable.status_detail, /last read .*press Refresh/);
    assert.equal(fable.metadata.automatic.health.officialSource, 'connected');
    assert.equal(fable.metadata.automatic.allowance.kind, 'official');
  });
  await t.test('an old but active reading is stale and asks for Refresh', async (tt) => {
    const { store, source, reading } = collectorFixture(tt);
    reading({ hoursAgo: 30 });
    reading({ sourceId: 'claude-fable', bucketId: 'fable_seven_day', hoursAgo: 30 });
    await refreshClaude(store, path.join(store.backupDirectory, 'missing.jsonl'), { activityReader: { import: async () => ({ usageEvents: 0 }) } });
    const claude = source('claude');
    assert.equal(claude.status, 'stale');
    assert.match(claude.status_detail, /out of date; press Refresh to read it again/);
    assert.notEqual(claude.last_success_at, null, 'the local work of an automatic run succeeded');
    const fable = source('claude-fable');
    assert.equal(fable.status, 'stale');
    assert.match(fable.status_detail, /press Refresh/);
    assert.equal(fable.metadata.automatic.health.officialSource, 'not-requested');
    assert.equal(fable.metadata.automatic.health.detail, '');
    assert.equal(fable.metadata.automatic.allowance.usedPercent, 30, 'the last official reading is kept as the allowance');
    assert.notEqual(fable.last_success_at, null);
  });
  await t.test('a fresh status-line reading counts as official evidence too', async (tt) => {
    const { store, source, reading } = collectorFixture(tt);
    reading({ hoursAgo: 3, provenance: 'official-statusline' });
    await refreshClaude(store, path.join(store.backupDirectory, 'missing.jsonl'), { activityReader: { import: async () => ({ usageEvents: 0 }) } });
    assert.equal(source('claude').status, 'connected');
  });
  await t.test('a status-line reading from a helper that did not record sessions has no known fetch', async (tt) => {
    const { store, source, reading } = collectorFixture(tt);
    // A Refresh thirty hours ago, then the old helper, not yet rewritten,
    // redraws a higher figure it may have fetched at any point this week.
    reading({ hoursAgo: 30 });
    store.recordObservation({ sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly',
      observedAt: new Date(Date.now() - 60_000).toISOString(), usedPercent: 34, remainingPercent: 66,
      resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), windowMinutes: 10_080,
      provenance: 'official-statusline', confidence: 1, metadata: {} });
    reading({ sourceId: 'claude-fable', bucketId: 'fable_seven_day', hoursAgo: 1 / 60, provenance: 'official-statusline', dated: false });
    await refreshClaude(store, path.join(store.backupDirectory, 'missing.jsonl'), { activityReader: { import: async () => ({ usageEvents: 0 }) } });
    assert.equal(store.getQuota('claude', store.getSettings()).usedPercent, 34, 'it is still the figure shown');
    assert.equal(source('claude').status, 'stale');
    assert.equal(source('claude-fable').status, 'stale');
    assert.equal(source('claude-fable').metadata.automatic.health.officialSource, 'not-requested');
  });
  await t.test('a status-line reading after an allowance change is judged in the new allowance', async (tt) => {
    const { store, source } = collectorFixture(tt);
    // A Refresh three hours ago read 40% of an allowance a quarter the size
    // of the one in force from an hour later: ten points of it. The old helper
    // then redraws 11%, newer use that the card shows but cannot date.
    store.updateSettings({ allowanceChanges: [{ source: 'claude', at: new Date(Date.now() - 2 * 3_600_000).toISOString(), previousAllowancePercent: 25 }] });
    for (const [sourceId, bucketId] of [['claude', 'seven_day'], ['claude-fable', 'fable_seven_day']]) {
      for (const [hoursAgo, usedPercent, provenance] of [[3, 40, 'official-claude-usage'], [1 / 60, 11, 'official-statusline']]) {
        store.recordObservation({ sourceId, bucketId, bucketName: 'Weekly',
          observedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), usedPercent, remainingPercent: 100 - usedPercent,
          resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), windowMinutes: 10_080, provenance, confidence: 1, metadata: {} });
      }
    }
    await refreshClaude(store, path.join(store.backupDirectory, 'missing.jsonl'), { activityReader: { import: async () => ({ usageEvents: 0 }) } });
    assert.equal(store.getQuota('claude', store.getSettings()).usedPercent, 11, 'it is the figure shown');
    assert.equal(source('claude').status, 'stale');
    assert.equal(store.getQuota('claude-fable', store.getSettings()).usedPercent, 11);
    assert.equal(source('claude-fable').metadata.automatic.allowance.usedPercent, 11);
    assert.equal(source('claude-fable').status, 'stale');
  });
  await t.test('a manual entry is not a plan-usage reading', async (tt) => {
    const { store, source, reading } = collectorFixture(tt);
    reading({ hoursAgo: 1, provenance: 'manual-official' });
    await refreshClaude(store, path.join(store.backupDirectory, 'missing.jsonl'), { activityReader: { import: async () => ({ usageEvents: 0 }) } });
    assert.equal(source('claude').status, 'stale');
    assert.match(source('claude').status_detail, /press Refresh/);
  });
  await t.test('no reading keeps the setup statuses and says when plan usage is read', async (tt) => {
    const { store, source } = collectorFixture(tt);
    await refreshClaude(store, path.join(store.backupDirectory, 'missing.jsonl'), { activityReader: { import: async () => ({ usageEvents: 0 }) } });
    const claude = source('claude');
    assert.ok(['ready', 'awaiting-installation'].includes(claude.status), claude.status);
    assert.match(claude.status_detail, /when you press Refresh/);
    const fable = source('claude-fable');
    assert.equal(fable.status, 'waiting');
    assert.equal(fable.metadata.automatic.allowance.reason, 'not-requested');
  });
});

test('a user refresh reads plan usage through the port exactly as before', async (t) => {
  const { refreshClaude, created } = collectorWithPortSpy();
  const { store, source } = collectorFixture(t);
  await refreshClaude(store, path.join(store.backupDirectory, 'missing.jsonl'), {
    readPlanUsage: true, activityReader: { import: async () => ({ usageEvents: 0 }) },
  });
  assert.equal(created.length, 1, 'the Agent SDK port is created for a user refresh');
  assert.equal(created[0].reads, 1);
  const injected = countingPort();
  const result = await refreshClaude(store, path.join(store.backupDirectory, 'missing.jsonl'), {
    readPlanUsage: true, usagePort: injected, activityReader: { import: async () => ({ usageEvents: 0 }) },
  });
  assert.equal(injected.reads, 1);
  assert.equal(result.fableTracking.provider.kind, 'unavailable');
  assert.equal(result.fableTracking.provider.attemptSucceeded, true);
  assert.equal(source('claude').metadata.planUsage.requested, true);
  assert.doesNotMatch(source('claude').status_detail, /press Refresh/);
});

// ---------------------------------------------------------------------------
// Finishing Claude setup is not a refresh request.

test('finishing Claude setup imports local activity but never reads plan usage', async () => {
  const calls = [];
  const claudeOnly = [];
  const handlers = new Map();
  registerIpc({
    handleIpc: (channel, handler) => handlers.set(channel, handler),
    refreshAll: async (options) => { calls.push(options); return {}; },
    refreshClaudeOnly: async (...args) => { claudeOnly.push(args); },
    claudeSetup: { finish: async ({ enableHelper }) => ({ finished: true, enableHelper }) },
    log() {},
  });
  assert.deepEqual(await handlers.get('claude-setup:configure')({}, 'finish', true), { finished: true, enableHelper: true });
  await flush();
  assert.deepEqual(calls, [], 'no refreshAll, so no plan-usage read');
  assert.deepEqual(claudeOnly, [[]], 'one Claude-only refresh, which never reads plan usage');
});

// ---------------------------------------------------------------------------
// Judging Claude by age: several windows, windows the provider stopped
// returning, and a failed Refresh.

const MINUTE = 60_000;
const quietActivity = { import: async () => ({ usageEvents: 0 }) };
const missingInbox = (store) => path.join(store.backupDirectory, 'missing.jsonl');
const readingLabel = (value) => new Date(value).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const WINDOW_MINUTES = { five_hour: 300, seven_day: 10_080, seven_day_opus: 10_080, seven_day_sonnet: 10_080 };

// Rows as one read writes them: every window shares one observed_at.
// A status-line read is dated as the current helper dates a working session's.
function recordRead(store, { minutesAgo, windows, provenance = 'official-claude-usage', nowMs = Date.now() }) {
  const observedAt = new Date(nowMs - minutesAgo * MINUTE).toISOString();
  for (const [bucketId, resetInMinutes] of Object.entries(windows)) {
    store.recordObservation({
      sourceId: 'claude', bucketId, bucketName: bucketId, observedAt, usedPercent: 30, remainingPercent: 70,
      resetsAt: new Date(nowMs + resetInMinutes * MINUTE).toISOString(), windowMinutes: WINDOW_MINUTES[bucketId],
      provenance, confidence: 1, metadata: {},
      fetchedAfter: provenance === 'official-statusline' ? new Date(Date.parse(observedAt) - 5_000).toISOString() : null,
    });
  }
  return observedAt;
}

const usageResponse = (windows, nowMs = Date.now()) => ({
  subscription_type: 'max', rate_limits_available: true,
  rate_limits: Object.fromEntries(Object.entries(windows).map(([key, resetInMinutes]) => [key,
    resetInMinutes == null ? null : { utilization: 25, resets_at: new Date(nowMs + resetInMinutes * MINUTE).toISOString() }])),
});

test('an automatic run judges a five-hour window by its own one-hour freshness limit', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const cases = [
    { name: 'a five-hour reading under an hour old is current', minutesAgo: 30, windows: { five_hour: 240, seven_day: 3 * 1440 }, status: 'connected' },
    { name: 'a five-hour reading over an hour old is stale', minutesAgo: 90, windows: { five_hour: 180, seven_day: 3 * 1440 }, status: 'stale' },
    { name: 'a five-hour window that has reset no longer decides', minutesAgo: 290, windows: { five_hour: -10, seven_day: 3 * 1440 }, status: 'connected' },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (tt) => {
      const { store, source } = collectorFixture(tt);
      recordRead(store, entry);
      await refreshClaude(store, missingInbox(store), { activityReader: quietActivity });
      assert.equal(source('claude').status, entry.status);
    });
  }
});

test('Claude ageing past the five-hour limit after a Refresh raises no fallback notice', async (t) => {
  const { decideNotifications, emptyState } = require('../electron/notifications.cjs');
  const { refreshClaude } = collectorWithPortSpy();
  const { store, source } = collectorFixture(t);
  const nowMs = Date.now();
  const userAt = nowMs - 150 * MINUTE;
  const automaticAt = nowMs - 75 * MINUTE;
  await refreshClaude(store, missingInbox(store), {
    readPlanUsage: true, clock: () => new Date(userAt), activityReader: quietActivity,
    usagePort: { read: async () => usageResponse({ five_hour: 240, seven_day: 3 * 1440 }, userAt) },
  });
  assert.equal(source('claude').status, 'connected');
  const previous = store.getTraySnapshot(userAt);
  const seeded = decideNotifications({ previous: null, current: previous, state: emptyState(), nowMs: userAt });

  await refreshClaude(store, missingInbox(store), { clock: () => new Date(automaticAt), activityReader: quietActivity });
  assert.equal(source('claude').status, 'stale');
  assert.match(source('claude').status_detail, /press Refresh/);
  const current = store.getTraySnapshot(automaticAt);
  const { notifications } = decideNotifications({ previous, current, state: seeded.state, nowMs: automaticAt });
  assert.deepEqual(notifications.filter((entry) => entry.kind === 'fallback'), []);
});

test('a window the latest plan-usage read did not return does not keep Claude stale', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const { store, source } = collectorFixture(t);
  recordRead(store, { minutesAgo: 30 * 60, windows: { seven_day_opus: 100 * 60 } });
  await refreshClaude(store, missingInbox(store), {
    readPlanUsage: true, activityReader: quietActivity,
    usagePort: { read: async () => usageResponse({ seven_day: 3 * 1440, seven_day_opus: null }) },
  });
  await refreshClaude(store, missingInbox(store), { activityReader: quietActivity });
  assert.equal(source('claude').status, 'connected');
  // An idle session then redraws that window from a fetch older than the read:
  // the redraw is newer, but it does not renew the window.
  store.recordObservation({ sourceId: 'claude', bucketId: 'seven_day_opus', bucketName: 'seven_day_opus',
    observedAt: new Date().toISOString(), usedPercent: 30, remainingPercent: 70,
    resetsAt: new Date(Date.now() + 100 * 60 * MINUTE).toISOString(), windowMinutes: 10_080, provenance: 'official-statusline',
    confidence: 1, metadata: {}, fetchedAfter: new Date(Date.now() - 30 * 60 * MINUTE).toISOString() });
  await refreshClaude(store, missingInbox(store), { activityReader: quietActivity });
  assert.equal(source('claude').status, 'connected');
});

test('a Refresh that returns no window at all leaves no earlier window current', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const { store, source } = collectorFixture(t);
  const nowMs = Date.now() - 15 * MINUTE;
  recordRead(store, { minutesAgo: 30, windows: { seven_day: 3 * 1440 }, nowMs });
  // The next Refresh succeeds, but the provider reports no allowance windows.
  await refreshClaude(store, missingInbox(store), {
    readPlanUsage: true, activityReader: quietActivity, clock: () => new Date(nowMs),
    usagePort: { read: async () => ({ subscription_type: 'max', rate_limits_available: false }) },
  });
  assert.equal(source('claude').metadata.planUsage.lastRequest.succeeded, true);
  assert.equal(source('claude').status, 'stale');
  // Automatic runs do not bring the half-hour-old window back as current.
  await refreshClaude(store, missingInbox(store), { activityReader: quietActivity, clock: () => new Date(nowMs + MINUTE) });
  assert.equal(source('claude').status, 'stale');
  // A session that fetches the window after that read renews it.
  store.recordObservation({ sourceId: 'claude', bucketId: 'seven_day', bucketName: 'seven_day',
    observedAt: new Date(nowMs + 2 * MINUTE).toISOString(), usedPercent: 31, remainingPercent: 69,
    resetsAt: new Date(nowMs + 3 * 1440 * MINUTE).toISOString(), windowMinutes: 10_080, provenance: 'official-statusline',
    confidence: 1, metadata: {}, fetchedAfter: new Date(nowMs + 90_000).toISOString() });
  await refreshClaude(store, missingInbox(store), { activityReader: quietActivity, clock: () => new Date(nowMs + 3 * MINUTE) });
  assert.equal(source('claude').status, 'connected');
});

test('a window the latest plan-usage read returned stays, whatever redraws of it followed', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const { store, source } = collectorFixture(t);
  const readAt = Date.now() - 10 * MINUTE;
  const record = (at, provenance, fetchedAfter = null) => store.recordObservation({ sourceId: 'claude', bucketId: 'seven_day',
    bucketName: 'Weekly', observedAt: new Date(at).toISOString(), usedPercent: 30, remainingPercent: 70,
    resetsAt: new Date(Date.now() + 3 * 1440 * MINUTE).toISOString(), windowMinutes: 10_080, provenance, confidence: 1,
    metadata: {}, fetchedAfter: fetchedAfter == null ? null : new Date(fetchedAfter).toISOString() });
  record(readAt, 'official-claude-usage');
  // An idle session then redraws the same 30% it fetched five hours ago.
  record(Date.now() - MINUTE, 'official-statusline', Date.now() - 5 * 60 * MINUTE);
  await refreshClaude(store, missingInbox(store), { activityReader: quietActivity });
  const claude = source('claude');
  assert.equal(claude.status, 'connected');
  assert.equal(claude.metadata.planUsage.lastReadAt, new Date(readAt).toISOString());
});

test('the stale detail quotes the oldest out-of-date reading, not the newest', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const { store, source } = collectorFixture(t);
  const sdkAt = recordRead(store, { minutesAgo: 30 * 60, windows: { seven_day: 3 * 1440, seven_day_sonnet: 3 * 1440 } });
  recordRead(store, { minutesAgo: 10, windows: { seven_day: 3 * 1440 }, provenance: 'official-statusline' });
  await refreshClaude(store, missingInbox(store), { activityReader: quietActivity });
  const claude = source('claude');
  assert.equal(claude.status, 'stale');
  assert.ok(claude.status_detail.includes(`(${readingLabel(sdkAt)}) is still active but out of date`), claude.status_detail);
});

test('importing a fresh helper window still judges every active Claude window', async (t) => {
  for (const minutesAgo of [30, 30 * 60]) {
    await t.test(`the other window is ${minutesAgo} minutes old`, async (tt) => {
      const { refreshClaude, created } = collectorWithPortSpy();
      const { store, source } = collectorFixture(tt);
      const nowMs = Date.now();
      recordRead(store, { minutesAgo, windows: { seven_day: 3 * 1440, seven_day_sonnet: 3 * 1440 }, nowMs });
      const inbox = missingInbox(store);
      fs.writeFileSync(inbox, `${[
        { ai_usage_captured_at: new Date(nowMs - 5_000).toISOString(), session_id: 'working-session', api_ms: 0, rate_limits: null },
        { ai_usage_captured_at: new Date(nowMs).toISOString(), session_id: 'working-session', api_ms: 1_200,
          rate_limits: { seven_day: { used_percentage: 35, resets_at: new Date(nowMs + 3 * 1440 * MINUTE).toISOString() } } },
      ].map((line) => JSON.stringify(line)).join('\n')}\n`);
      const statuses = [];
      for (let run = 0; run < 2; run += 1) {
        const result = await refreshClaude(store, inbox, { activityReader: quietActivity, clock: () => new Date(nowMs) });
        assert.equal(result.statusLine.claudeObservations, run === 0 ? 1 : 0);
        statuses.push(source('claude').status);
      }
      const expected = minutesAgo < 1440 ? 'connected' : 'stale';
      assert.deepEqual(statuses, [expected, expected], 'importing and then reusing the same evidence must agree');
      assert.equal(created.length, 0, 'the helper import never starts a plan-usage read');
    });
  }
});

test('a failed Refresh after natural ageing alerts once through automatic runs', async (t) => {
  const { decideNotifications, emptyState } = require('../electron/notifications.cjs');
  const { refreshClaude } = collectorWithPortSpy();
  const { store, source } = collectorFixture(t);
  const nowMs = Date.now();
  const userAt = nowMs - 150 * MINUTE;
  let previous = null;
  let state = emptyState();
  const check = (at) => {
    const current = store.getTraySnapshot(at);
    current.settings.notifyFallback = true;
    const result = decideNotifications({ previous, current, state, nowMs: at });
    state = JSON.parse(JSON.stringify(result.state));
    // The tray-idle lifecycle discards source metadata from the old snapshot.
    previous = { sources: current.sources.map(({ id, status }) => ({ id, status })) };
    return result.notifications.filter((entry) => entry.kind === 'fallback');
  };
  await refreshClaude(store, missingInbox(store), {
    readPlanUsage: true, clock: () => new Date(userAt), activityReader: quietActivity,
    usagePort: { read: async () => usageResponse({ five_hour: 240, seven_day: 3 * 1440 }, userAt) },
  });
  assert.deepEqual(check(userAt), []);
  await refreshClaude(store, missingInbox(store), { clock: () => new Date(nowMs - 75 * MINUTE), activityReader: quietActivity });
  assert.equal(source('claude').status, 'stale');
  assert.deepEqual(check(nowMs - 75 * MINUTE), []);

  const failure = Object.assign(new Error('Not signed in'), { code: 'authentication_failed' });
  const fail = (at) => refreshClaude(store, missingInbox(store), {
    readPlanUsage: true, clock: () => new Date(at), activityReader: quietActivity,
    usagePort: { read: async () => { throw failure; } },
  });
  await fail(nowMs - 60 * MINUTE);
  assert.equal(source('claude').status, 'stale');
  assert.deepEqual(check(nowMs - 60 * MINUTE).map((entry) => entry.title), ['Claude readings are running on cached data']);
  await refreshClaude(store, missingInbox(store), { clock: () => new Date(nowMs - 30 * MINUTE), activityReader: quietActivity });
  assert.deepEqual(check(nowMs - 30 * MINUTE), []);
  await fail(nowMs);
  assert.deepEqual(check(nowMs), [], 'automatic runs must not rearm an ongoing failure');
});

test('five-hour and weekly windows from one read two hours ago are stale', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const { store, source } = collectorFixture(t);
  recordRead(store, { minutesAgo: 120, windows: { five_hour: 120, seven_day: 3 * 1440 } });
  await refreshClaude(store, missingInbox(store), { activityReader: quietActivity });
  assert.equal(source('claude').status, 'stale');
});

test('a failed Refresh stays visible through automatic runs until a Refresh succeeds', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const { store, source } = collectorFixture(t);
  recordRead(store, { minutesAgo: 120, windows: { seven_day: 3 * 1440 } });
  const failure = Object.assign(new Error('Not signed in'), { code: 'authentication_failed' });
  await refreshClaude(store, missingInbox(store), {
    readPlanUsage: true, activityReader: quietActivity, usagePort: { read: async () => { throw failure; } },
  });
  assert.equal(source('claude').status, 'stale');

  // The two-hour-old reading is within the weekly limit, but the failed
  // Refresh is newer, so the automatic run must not call Claude current.
  await refreshClaude(store, missingInbox(store), { activityReader: quietActivity });
  let claude = source('claude');
  assert.equal(claude.status, 'stale');
  assert.match(claude.status_detail, /The last Refresh could not read Claude plan usage \(authentication_failed\)\./);
  assert.equal(claude.metadata.planUsage.lastRequest.succeeded, false);
  assert.equal(claude.metadata.planUsage.lastRequest.provider.errorCode, 'authentication_failed');
  assert.equal(claude.metadata.provider, null);

  await refreshClaude(store, missingInbox(store), {
    readPlanUsage: true, activityReader: quietActivity, usagePort: { read: async () => usageResponse({ seven_day: 3 * 1440 }) },
  });
  assert.equal(source('claude').status, 'connected');
  await refreshClaude(store, missingInbox(store), { activityReader: quietActivity });
  claude = source('claude');
  assert.equal(claude.status, 'connected');
  assert.equal(claude.metadata.planUsage.lastRequest.succeeded, true);
  assert.doesNotMatch(claude.status_detail, /could not read/);
});

test('a Refresh tells the usage port whether the account is known to have a subscription', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const { store } = collectorFixture(t);
  const seen = [];
  const usagePort = { read: async ({ expectSubscription }) => {
    seen.push(expectSubscription);
    return { subscription_type: null, rate_limits_available: false, rate_limits: null };
  } };
  await refreshClaude(store, missingInbox(store), { readPlanUsage: true, usagePort, activityReader: quietActivity });
  recordRead(store, { minutesAgo: 6, windows: { five_hour: 240, seven_day: 3 * 1440 }, provenance: 'official-statusline' });
  await refreshClaude(store, missingInbox(store), { readPlanUsage: true, usagePort, activityReader: quietActivity });
  assert.deepEqual(seen, [false, true], 'only a plan window still running shows a subscription');
});

test('a Refresh Claude Code answers without the subscription sign-in fails and says why on both cards', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const { createClaudeAgentSdkUsagePort } = require('../electron/claude-agent-usage.cjs');
  const { store, source } = collectorFixture(t);
  // The mod left a reading six minutes before the Refresh.
  recordRead(store, { minutesAgo: 6, windows: { five_hour: 240, seven_day: 3 * 1440 }, provenance: 'official-statusline' });
  await refreshClaude(store, missingInbox(store), { activityReader: quietActivity });
  const lastGood = source('claude').last_success_at;
  assert.ok(lastGood);
  let launches = 0;
  const usagePort = createClaudeAgentSdkUsagePort({
    retryDelayMs: 0,
    findClaudeBinary: () => 'C:\\fixture\\claude.exe',
    loadSdk: async () => ({ query: () => {
      launches += 1;
      return {
        initializationResult: async () => ({}),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
          subscription_type: null, rate_limits_available: false, rate_limits: null,
        }),
        return: async () => ({ done: true }),
      };
    } }),
  });
  await refreshClaude(store, missingInbox(store), { readPlanUsage: true, usagePort, activityReader: quietActivity });
  assert.equal(launches, 2, 'retried once');
  let claude = source('claude');
  assert.equal(claude.status, 'stale');
  assert.equal(claude.last_success_at, lastGood, 'not counted as a good scan');
  assert.equal(claude.metadata.planUsage.lastRequest.succeeded, false);
  assert.equal(claude.metadata.provider.errorCode, 'claude-usage-signed-out');
  assert.match(claude.status_detail, /This Refresh could not read Claude plan usage because Claude Code did not report your Claude subscription sign-in\. If Claude Code is signed in, press Refresh again\./);
  assert.match(source('claude-fable').status_detail, /This Refresh could not read Claude plan usage because Claude Code did not report your Claude subscription sign-in\./);

  // Automatic runs keep saying why until a newer reading replaces it.
  await refreshClaude(store, missingInbox(store), { activityReader: quietActivity });
  claude = source('claude');
  assert.equal(claude.status, 'stale');
  assert.match(claude.status_detail, /The last Refresh could not read Claude plan usage because Claude Code did not report your Claude subscription sign-in\./);
  assert.doesNotMatch(source('claude-fable').status_detail, /This Refresh/);
});

// A lower status-line reading for the same reset is held back from the card
// while the provider's last read is inside the grace period. The source status
// and the Refresh outcome are judged on the same accepted readings.
test('a status-line restatement the card holds back cannot make Claude current or a failed Refresh succeed', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const { root, store, source } = collectorFixture(t);
  // In the past, so every capture below is accepted as already taken.
  const nowMs = Date.now() - 15 * MINUTE;
  const fiveReset = new Date(nowMs + 180 * MINUTE).toISOString();
  const weekReset = new Date(nowMs + 3 * 1440 * MINUTE).toISOString();
  for (const [bucketId, usedPercent, resetsAt] of [['five_hour', 40, fiveReset], ['seven_day', 20, weekReset]]) {
    store.recordObservation({
      sourceId: 'claude', bucketId, bucketName: bucketId, observedAt: new Date(nowMs - 90 * MINUTE).toISOString(),
      usedPercent, remainingPercent: 100 - usedPercent, resetsAt, windowMinutes: WINDOW_MINUTES[bucketId],
      provenance: 'official-claude-usage', confidence: 1, metadata: {},
    });
  }
  const inbox = path.join(root, 'inbox.jsonl');
  // An idle session, first seen with its 1% in hand, restates it; a working
  // session opens and fetches 41% later on.
  const capture = (at, fiveUsed, { weekly = true, session = 'idle-session', apiMs = 1_000, limits = true } = {}) => fs.appendFileSync(inbox, `${JSON.stringify({
    ai_usage_captured_at: new Date(at).toISOString(), session_id: session, api_ms: apiMs,
    rate_limits: limits ? {
      five_hour: { used_percentage: fiveUsed, resets_at: fiveReset },
      ...(weekly ? { seven_day: { used_percentage: 20, resets_at: weekReset } } : {}),
    } : null,
  })}\n`);
  const rateLimited = { read: async () => { throw Object.assign(new Error('HTTP 429'), { code: 'rate_limited' }); } };

  capture(nowMs - 30_000, 1);
  await refreshClaude(store, inbox, { activityReader: quietActivity, clock: () => new Date(nowMs) });
  const card = store.getQuota('claude', store.getSettings(), nowMs).windows.find((window) => window.bucketId === 'five_hour');
  assert.equal(card.usedPercent, 40, 'the card holds the lower restatement back');
  assert.equal(source('claude').status, 'stale', 'the ninety-minute-old five-hour reading it shows is out of date');

  capture(nowMs + 20_000, 1);
  await refreshClaude(store, inbox, { readPlanUsage: true, usagePort: rateLimited, activityReader: quietActivity, clock: () => new Date(nowMs + 60_000) });
  let claude = source('claude');
  assert.equal(claude.status, 'stale');
  assert.equal(claude.metadata.planUsage.lastRequest.succeeded, false);
  assert.match(claude.status_detail, /did not replace it/);

  await refreshClaude(store, inbox, { activityReader: quietActivity, clock: () => new Date(nowMs + 120_000) });
  claude = source('claude');
  assert.equal(claude.status, 'stale');
  assert.match(claude.status_detail, /The last Refresh could not read Claude plan usage \(rate_limited\)\./,
    'a held-back status-line row is not a newer reading that replaces the failed Refresh');

  // A status-line reading the card accepts, freshly fetched by a working
  // session, still stands in for the provider.
  capture(nowMs + 140_000, 0, { session: 'working-session', apiMs: 0, limits: false });
  capture(nowMs + 150_000, 41, { session: 'working-session', apiMs: 2_000 });
  await refreshClaude(store, inbox, { readPlanUsage: true, usagePort: rateLimited, activityReader: quietActivity, clock: () => new Date(nowMs + 180_000) });
  claude = source('claude');
  assert.equal(claude.status, 'connected');
  assert.equal(claude.metadata.planUsage.lastRequest.succeeded, true);

  // The next Refresh imports only a held-back restatement. The accepted 41%
  // reading is still recent, but an earlier collection imported it, so it
  // cannot stand in for this failed request.
  capture(nowMs + 380_000, 1, { weekly: false });
  await refreshClaude(store, inbox, { readPlanUsage: true, usagePort: rateLimited, activityReader: quietActivity, clock: () => new Date(nowMs + 400_000) });
  const five = store.getQuota('claude', store.getSettings(), nowMs + 400_000).windows.find((window) => window.bucketId === 'five_hour');
  assert.equal(five.usedPercent, 41);
  assert.equal(five.observedAt, new Date(nowMs + 150_000).toISOString());
  claude = source('claude');
  assert.equal(claude.metadata.planUsage.lastRequest.succeeded, false);
  assert.doesNotMatch(claude.status_detail, /evidence was refreshed/);
});

test('an idle session’s redraw cannot make Claude current or a failed Refresh succeed; its next fetch can', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const { root, store, source } = collectorFixture(t);
  // In the past, so every capture below is accepted as already taken.
  const nowMs = Date.now() - 15 * MINUTE;
  const weekReset = new Date(nowMs + 3 * 1440 * MINUTE).toISOString();
  const inbox = path.join(root, 'inbox.jsonl');
  const capture = (at, { apiMs, used } = {}) => fs.appendFileSync(inbox, `${JSON.stringify({
    ai_usage_captured_at: new Date(at).toISOString(), session_id: 'idle-session', api_ms: apiMs ?? 0,
    rate_limits: used == null ? null : { seven_day: { used_percentage: used, resets_at: weekReset } },
  })}\n`);
  const rateLimited = { read: async () => { throw Object.assign(new Error('HTTP 429'), { code: 'rate_limited' }); } };
  // The session opened and fetched 20% a day and a half ago, then sat idle,
  // its status line redrawing that 20% every minute.
  const fetchedAt = nowMs - 36 * 60 * MINUTE;
  capture(fetchedAt);
  capture(fetchedAt + 5_000, { apiMs: 2_500, used: 20 });
  capture(nowMs - 30_000, { apiMs: 2_500, used: 20 });
  await refreshClaude(store, inbox, { activityReader: quietActivity, clock: () => new Date(nowMs) });
  let claude = source('claude');
  assert.equal(claude.status, 'stale', 'a redraw thirty seconds ago carries a fetch a day and a half old');
  assert.ok(claude.status_detail.includes(`(${readingLabel(fetchedAt)}) is still active but out of date`), claude.status_detail);
  const card = store.getQuota('claude', store.getSettings(), nowMs);
  assert.equal(card.evidenceAt, new Date(fetchedAt).toISOString());
  assert.ok(card.forecast.staleHours > 35, `stale ${card.forecast.staleHours}`);

  capture(nowMs + 30_000, { apiMs: 2_500, used: 20 });
  await refreshClaude(store, inbox, { readPlanUsage: true, usagePort: rateLimited, activityReader: quietActivity, clock: () => new Date(nowMs + 60_000) });
  claude = source('claude');
  assert.equal(claude.metadata.planUsage.lastRequest.succeeded, false, 'the redraw is not new evidence');
  assert.equal(claude.status, 'stale');

  // The session is used again: its next redraw shows a new response.
  capture(nowMs + 90_000, { apiMs: 4_100, used: 21 });
  await refreshClaude(store, inbox, { readPlanUsage: true, usagePort: rateLimited, activityReader: quietActivity, clock: () => new Date(nowMs + 120_000) });
  claude = source('claude');
  assert.equal(claude.metadata.planUsage.lastRequest.succeeded, true);
  assert.equal(claude.status, 'connected');
});

test('an idle session first seen with limits in hand is not new evidence for a failed Refresh', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const { root, store, source } = collectorFixture(t);
  const nowMs = Date.now() - 15 * MINUTE;
  const weekReset = new Date(nowMs + 3 * 1440 * MINUTE).toISOString();
  // The helper never saw this session open, so its fetch cannot be dated; it
  // has redrawn the same 20% every ten minutes for three hours.
  const inbox = path.join(root, 'inbox.jsonl');
  const lines = [];
  for (let at = nowMs - 180 * MINUTE; at <= nowMs - MINUTE; at += 10 * MINUTE) {
    lines.push(JSON.stringify({ ai_usage_captured_at: new Date(at).toISOString(), session_id: 'already-open', api_ms: 9_000,
      rate_limits: { seven_day: { used_percentage: 20, resets_at: weekReset } } }));
  }
  fs.writeFileSync(inbox, `${lines.join('\n')}\n`);
  const rateLimited = { read: async () => { throw Object.assign(new Error('HTTP 429'), { code: 'rate_limited' }); } };
  await refreshClaude(store, inbox, { readPlanUsage: true, usagePort: rateLimited, activityReader: quietActivity, clock: () => new Date(nowMs) });
  const claude = source('claude');
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM quota_observations WHERE fetched_after IS NOT NULL').get().count, 0);
  assert.equal(claude.metadata.planUsage.lastRequest.succeeded, false, 'a redraw a minute ago shows no fetch that recent');
  // The limits are known to hold only from the start of the week they show.
  assert.equal(store.getQuota('claude', store.getSettings(), nowMs).evidenceAt, new Date(nowMs - 4 * 1440 * MINUTE).toISOString());
});

test('an automatic collection does not count a session first seen with limits in hand as a recent read', async (t) => {
  const { refreshClaude, created } = collectorWithPortSpy();
  const { root, store, source } = collectorFixture(t);
  const nowMs = Date.now() - 15 * MINUTE;
  const weekReset = new Date(nowMs + 3 * 1440 * MINUTE).toISOString();
  // The helper was just installed; an open session redraws the 20% it
  // fetched at some point this week.
  const inbox = path.join(root, 'inbox.jsonl');
  const line = (at, session, apiMs, used) => JSON.stringify({ ai_usage_captured_at: new Date(at).toISOString(),
    session_id: session, api_ms: apiMs, rate_limits: used == null ? null : { seven_day: { used_percentage: used, resets_at: weekReset } } });
  fs.writeFileSync(inbox, `${line(nowMs - 30_000, 'already-open', 9_000, 20)}\n`);
  await refreshClaude(store, inbox, { activityReader: quietActivity, clock: () => new Date(nowMs) });
  assert.equal(created.reduce((sum, port) => sum + port.reads, 0), 0, 'an automatic collection reads no plan usage');
  let claude = source('claude');
  assert.equal(claude.status, 'stale', 'a redraw thirty seconds ago proves no fetch this recent');
  const weekStart = nowMs - 4 * 1440 * MINUTE;
  assert.ok(claude.status_detail.includes(`(${readingLabel(weekStart)}) is still active but out of date`), claude.status_detail);
  let card = store.getQuota('claude', store.getSettings(), nowMs);
  assert.equal(card.evidenceAt, new Date(weekStart).toISOString());
  assert.ok(card.forecast.staleHours > 95, `stale ${card.forecast.staleHours}`);

  // A session seen opening dates its fetch, and that is a recent read.
  fs.appendFileSync(inbox, `${line(nowMs + 30_000, 'new-session', 0, null)}\n${line(nowMs + 60_000, 'new-session', 1_200, 20)}\n`);
  await refreshClaude(store, inbox, { activityReader: quietActivity, clock: () => new Date(nowMs + 90_000) });
  claude = source('claude');
  assert.equal(claude.status, 'connected');
  card = store.getQuota('claude', store.getSettings(), nowMs + 90_000);
  assert.equal(card.evidenceAt, new Date(nowMs + 30_000).toISOString());
});

test('a single redraw from a session first seen with limits in hand is not new evidence for a failed Refresh', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const { root, store, source } = collectorFixture(t);
  const nowMs = Date.now() - 15 * MINUTE;
  // The helper was just installed; an open session redraws once, thirty
  // seconds ago, with limits it may have fetched hours before.
  const inbox = path.join(root, 'inbox.jsonl');
  fs.writeFileSync(inbox, `${JSON.stringify({ ai_usage_captured_at: new Date(nowMs - 30_000).toISOString(),
    session_id: 'already-open', api_ms: 9_000,
    rate_limits: { seven_day: { used_percentage: 20, resets_at: new Date(nowMs + 3 * 1440 * MINUTE).toISOString() } } })}\n`);
  const rateLimited = { read: async () => { throw Object.assign(new Error('HTTP 429'), { code: 'rate_limited' }); } };
  await refreshClaude(store, inbox, { readPlanUsage: true, usagePort: rateLimited, activityReader: quietActivity, clock: () => new Date(nowMs) });
  assert.equal(source('claude').metadata.planUsage.lastRequest.succeeded, false);
});

test('an idle redraw that agrees with a recent Refresh is still not new evidence for a failed one', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const { root, store, source } = collectorFixture(t);
  const nowMs = Date.now() - 15 * MINUTE;
  const weekReset = new Date(nowMs + 3 * 1440 * MINUTE).toISOString();
  // A Refresh two minutes ago read 20%.
  store.recordObservation({ sourceId: 'claude', bucketId: 'seven_day', bucketName: 'Weekly',
    observedAt: new Date(nowMs - 2 * MINUTE).toISOString(), usedPercent: 20, remainingPercent: 80, resetsAt: weekReset,
    windowMinutes: 10_080, provenance: 'official-claude-usage', confidence: 1, metadata: {} });
  // An idle session that fetched the same 20% a day and a half ago redraws it.
  const inbox = path.join(root, 'inbox.jsonl');
  const fetchedAt = nowMs - 36 * 60 * MINUTE;
  fs.writeFileSync(inbox, `${[
    { ai_usage_captured_at: new Date(fetchedAt).toISOString(), session_id: 'idle-session', api_ms: 0, rate_limits: null },
    ...[fetchedAt + 5_000, nowMs - 30_000].map((at) => ({ ai_usage_captured_at: new Date(at).toISOString(),
      session_id: 'idle-session', api_ms: 2_500, rate_limits: { seven_day: { used_percentage: 20, resets_at: weekReset } } })),
  ].map((line) => JSON.stringify(line)).join('\n')}\n`);
  const rateLimited = { read: async () => { throw Object.assign(new Error('HTTP 429'), { code: 'rate_limited' }); } };
  await refreshClaude(store, inbox, { readPlanUsage: true, usagePort: rateLimited, activityReader: quietActivity, clock: () => new Date(nowMs) });
  const claude = source('claude');
  assert.equal(claude.metadata.statusLine.claudeObservations, 2, 'this collection imported the redraw');
  // The card is current through the earlier Refresh, but this one failed.
  assert.equal(store.getQuota('claude', store.getSettings(), nowMs).evidenceAt, new Date(nowMs - 2 * MINUTE).toISOString());
  assert.equal(claude.metadata.planUsage.lastRequest.succeeded, false);
  assert.doesNotMatch(claude.status_detail, /evidence was refreshed/);
});

test('Fable is judged by the newest read of its figure, not by an idle redraw of it', async (t) => {
  const { refreshClaude } = collectorWithPortSpy();
  const nowMs = Date.now() - 15 * MINUTE;
  const resetsAt = new Date(nowMs + 3 * 1440 * MINUTE).toISOString();
  const fable = (store, at, provenance, fetchedAfter = null) => store.recordObservation({ sourceId: 'claude-fable',
    bucketId: 'fable_seven_day', bucketName: 'Fable weekly', observedAt: new Date(at).toISOString(), usedPercent: 30,
    remainingPercent: 70, resetsAt, windowMinutes: 10_080, provenance, confidence: 1, metadata: {},
    fetchedAfter: fetchedAfter == null ? null : new Date(fetchedAfter).toISOString() });
  // An idle session fetched 30% a day and a half ago and has redrawn it every
  // minute since; more than fifty redraws follow the reading that matters.
  const idle = (store) => {
    for (let at = nowMs - 90 * MINUTE; at <= nowMs - MINUTE; at += MINUTE) fable(store, at, 'official-statusline', nowMs - 36 * 60 * MINUTE);
  };
  await t.test('a Refresh two hours ago that read the same figure keeps Fable current', async (tt) => {
    const { store, source } = collectorFixture(tt);
    fable(store, nowMs - 120 * MINUTE, 'official-claude-usage');
    idle(store);
    await refreshClaude(store, missingInbox(store), { activityReader: quietActivity, clock: () => new Date(nowMs) });
    const fableSource = source('claude-fable');
    assert.equal(fableSource.status, 'connected');
    assert.equal(fableSource.metadata.automatic.allowance.evidenceAt, new Date(nowMs - 120 * MINUTE).toISOString());
    assert.ok(fableSource.status_detail.includes(readingLabel(nowMs - 120 * MINUTE)), fableSource.status_detail);
  });
  await t.test('with only the idle redraws, Fable is out of date', async (tt) => {
    const { store, source } = collectorFixture(tt);
    idle(store);
    await refreshClaude(store, missingInbox(store), { activityReader: quietActivity, clock: () => new Date(nowMs) });
    assert.equal(source('claude-fable').status, 'stale');
  });
  await t.test('a recent manual entry of the same figure is no provider read', async (tt) => {
    const { store, source } = collectorFixture(tt);
    fable(store, nowMs - 120 * MINUTE, 'manual-official');
    idle(store);
    await refreshClaude(store, missingInbox(store), { activityReader: quietActivity, clock: () => new Date(nowMs) });
    const fableSource = source('claude-fable');
    assert.equal(fableSource.status, 'stale');
    assert.equal(fableSource.metadata.automatic.allowance.evidenceAt, new Date(nowMs - 36 * 60 * MINUTE).toISOString());
  });
});
