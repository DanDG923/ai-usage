'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

let server;
let demoSnapshot;
let providerViews;
let ProviderSummary;
let Overview;
let Activity;
let ForecastSection;
let ErrorFallback;
let lib;

test.before(async () => {
  const [{ createServer }, { default: react }] = await Promise.all([import('vite'), import('@vitejs/plugin-react')]);
  server = await createServer({
    root: path.resolve(__dirname, '..'),
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  [
    { demoSnapshot }, { providerViews }, { ProviderSummary }, { Overview }, { Activity }, { ForecastSection },
    { ErrorFallback }, lib,
  ] = await Promise.all([
    server.ssrLoadModule('/src/data/demo.ts'),
    server.ssrLoadModule('/src/provider-view.ts'),
    server.ssrLoadModule('/src/components/ProviderSummary.tsx'),
    server.ssrLoadModule('/src/components/Overview.tsx'),
    server.ssrLoadModule('/src/components/Activity.tsx'),
    server.ssrLoadModule('/src/components/settings/ForecastSection.tsx'),
    server.ssrLoadModule('/src/components/ErrorBoundary.tsx'),
    server.ssrLoadModule('/src/lib.ts'),
  ]);
});

test.after(async () => { await server?.close(); });

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('subscription visibility removes allowance surfaces and restores them without changing history', () => {
  const { buildDashboardVerdict } = require('../electron/dashboard-decision.cjs');
  const snapshot = structuredClone(demoSnapshot);
  const original = structuredClone(snapshot);
  const props = { refreshing: false, onRefresh: async () => {}, onSetupClaude: () => {}, onSources: () => {} };
  snapshot.settings.showClaudeSubscription = false;
  snapshot.dashboardVerdict = buildDashboardVerdict(snapshot);
  assert.deepEqual(providerViews(snapshot).map((view) => view.id), ['codex']);
  const overview = render(Overview, { ...props, snapshot }).replace(/<span role="tooltip"[^>]*>[\s\S]*?<\/span>/g, '');
  assert.doesNotMatch(text(overview), /Claude|Fable/);
  assert.doesNotMatch(text(render(Activity, { snapshot, days: 30 })), /Claude|Fable/);
  const none = { ...snapshot, settings: { ...snapshot.settings, showCodexSubscription: false } };
  none.dashboardVerdict = buildDashboardVerdict(none);
  const empty = text(render(Overview, { ...props, snapshot: none }));
  assert.match(empty, /No subscriptions shown.*Choose subscriptions/);
  assert.doesNotMatch(empty, /on track|Waiting for allowance/);
  const activity = text(render(Activity, { snapshot: none, days: 30 }));
  assert.match(activity, /No subscriptions shown.*saved history is retained/);
  assert.doesNotMatch(activity, /0 reset cycles retained|Reset history appears once/);
  const restored = { ...snapshot, settings: { ...snapshot.settings, showClaudeSubscription: true } };
  assert.deepEqual(providerViews(restored).map((view) => view.id), ['codex', 'claude', 'fable']);
  assert.deepEqual(snapshot.quotas, original.quotas);
  assert.deepEqual(snapshot.costs, original.costs);
  assert.deepEqual(snapshot.cycles, original.cycles);
});

function expiredSnapshot() {
  const snapshot = structuredClone(demoSnapshot);
  const resetsAt = new Date(Date.parse(snapshot.generatedAt) - 3_600_000).toISOString();
  const expired = {
    ...snapshot.quotas.codex.windows[0],
    resetsAt,
    remainingPercent: 73,
    forecast: {
      ...snapshot.quotas.codex.forecast,
      expired: true,
      state: 'unknown',
      expectedRemaining: null,
      heavyRemaining: null,
      estimatedCurrentRemaining: null,
      currentIsEstimated: false,
    },
  };
  snapshot.quotas.codex = { ...expired, windows: [expired] };
  snapshot.cycles.codex = [{ ...snapshot.cycles.codex[0], resetsAt, current: false }];
  return snapshot;
}

function currentCycleRow(snapshot) {
  const html = render(Overview, {
    snapshot, refreshing: false, onRefresh: async () => {}, onSetupClaude: () => {}, onSources: () => {},
  });
  const table = html.match(/<table class="overview-cycle-table">[\s\S]*?<\/table>/)?.[0];
  assert.ok(table, 'the actual Overview rendered its current-cycle table');
  return table.match(/<tbody><tr>[\s\S]*?<\/tr>/)?.[0];
}

test('manual Codex reading keeps rendered current cycles aligned with the main card', () => {
  const { UsageStore } = require('../electron/store.cjs');
  const store = new UsageStore(':memory:', require('node:os').tmpdir());
  try {
    const now = Date.now(), hour = 3_600_000;
    const record = (bucketId, usedPercent, at, reset, metadata, provenance = 'official') => store.recordObservation({
      sourceId: 'codex', bucketId, bucketName: 'Weekly', usedPercent, observedAt: new Date(at).toISOString(),
      resetsAt: new Date(reset).toISOString(), metadata, provenance, windowMinutes: 10080,
    });
    record('codex:primary', 60, now - 2 * hour, now + 24 * hour, { limitId: 'codex' });
    record('codex_bengalfox:secondary', 0, now - 2 * hour, now + 144 * hour,
      { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark' });
    record(store.getManualBucketId('codex'), 61, now - hour, now + 24 * hour,
      { note: 'Manual reading', sharedWithOverall: false }, 'manual-official');
    store.updateSettings({ showClaudeSubscription: false });
    const snapshot = store.getDashboardSnapshot(30, now);
    assert.equal(providerViews(snapshot)[0].current.bucketId, 'codex:primary');
    const row = text(currentCycleRow(snapshot));
    assert.match(row, /61%/);
    assert.doesNotMatch(row, /Spark/);
    assert.match(row, new RegExp(lib.dateTimeLabel(new Date(now + 24 * hour).toISOString())));
  } finally { store.close(); }
});

test('Activity renders the actual early cycle end and marks only the replacement current', async () => {
  const { CycleHistory } = await server.ssrLoadModule('/src/components/details/CycleHistory.tsx');
  const current = { ...demoSnapshot.cycles.codex[0], current: true,
    resetsAt: '2026-09-16T12:00:00Z', endsAt: '2026-09-16T12:00:00Z' };
  const ended = { ...current, current: false, resetsAt: '2026-09-14T12:00:00Z', endsAt: '2026-09-09T12:00:00Z' };
  const html = render(CycleHistory, { cycles: { codex: [current, ended], claude: [], fable: [] }, currency: 'GBP' });
  assert.equal((html.match(/<tr class="current">/g) || []).length, 1);
  assert.match(text(html), /Reset early/);
  assert.ok(text(html).includes(lib.dayDate(ended.endsAt)));
  assert.ok(!text(html).includes(lib.dayDate(ended.resetsAt)));
});

test('expired allowance cards retain history without presenting a current balance or countdown', () => {
  const snapshot = expiredSnapshot();
  const view = providerViews(snapshot)[0];
  assert.equal(view.remaining, null);
  assert.equal(view.expectedRemaining, null);
  assert.equal(view.heavyRemaining, null);
  assert.equal(view.expired, true);
  const html = render(ProviderSummary, { view, nowMs: Date.parse(snapshot.generatedAt) });
  assert.match(text(html), /Needs reading.*Waiting for a new provider reading/);
  assert.match(text(html), /Last observed 73% before reset/);
  assert.doesNotMatch(html, /Current balance|Resets in|73% left|scenario-bar/);
});

test('Activity does not call a connected source current when its allowance window expired', () => {
  const snapshot = expiredSnapshot();
  snapshot.sources.find((source) => source.id === 'codex').status = 'connected';
  const html = render(Activity, { snapshot, days: snapshot.costs.periodDays });
  const table = html.match(/<table class="evidence-table">[\s\S]*?<\/table>/)?.[0];
  const row = table?.match(/<tbody><tr>[\s\S]*?<\/tr>/)?.[0];
  assert.ok(row);
  assert.match(text(row), /Needs reading/);
  assert.match(text(row), /— Window expired/);
  assert.doesNotMatch(text(row), /Current|73%/);
});

test('the card headlines the weekly allowance and lists a riskier five-hour session beneath it', () => {
  const snapshot = structuredClone(demoSnapshot);
  const weekly = snapshot.quotas.codex.windows[0];
  weekly.forecast.state = 'safe';
  weekly.forecast.expectedRemaining = 42;
  const shorter = {
    ...structuredClone(weekly), bucketId: 'five_hour', bucketName: 'Five hour', windowMinutes: 300,
    resetsAt: new Date(Date.parse(snapshot.generatedAt) + 3_600_000).toISOString(),
  };
  shorter.forecast.state = 'critical';
  shorter.forecast.expectedRemaining = 0;
  shorter.forecast.paceRatio = 1.5;
  snapshot.quotas.codex = { ...weekly, windows: [weekly, shorter] };
  snapshot.cycles.codex = [{ ...snapshot.cycles.codex[0], resetsAt: weekly.resetsAt, current: true, cost: 123.45 }];
  const view = providerViews(snapshot)[0];
  assert.equal(view.current.bucketId, weekly.bucketId, 'the headline is the weekly plan, as on the provider\'s own summary');
  assert.equal(view.state, 'safe');
  assert.deepEqual(view.secondaryWindows.map((window) => window.bucketId), ['five_hour']);
  const card = render(ProviderSummary, { view, nowMs: Date.parse(snapshot.generatedAt) });
  assert.match(text(card), /5-hour session/);
  assert.match(card, /provider-session[\s\S]*state-pill critical/);
  assert.match(text(card), /0% expected at reset · resets in (\d+ min|\d+h \d+m)/);
  const overview = render(Overview, {
    snapshot, refreshing: false, onRefresh: async () => {}, onSetupClaude: () => {}, onSources: () => {},
  });
  // The attention panel reports the session window under its own name.
  assert.match(text(overview), /Codex 5-hour session is above its safe pace/);
  const row = currentCycleRow(snapshot);
  assert.match(text(row), /Codex weekly/);
  assert.match(text(row), /123\.45/);
  assert.match(text(row), /42% expected at reset/);
  assert.doesNotMatch(text(row), /0% expected at reset/);
  assert.match(row, /forecast-outcome safe/);
});

test('provider reassurance checks shorter windows and stale evidence as well as the weekly headline', () => {
  const snapshot = structuredClone(demoSnapshot);
  for (const quota of Object.values(snapshot.quotas)) {
    if (!quota) continue;
    quota.windows = [{ ...quota, windows: undefined,
      forecast: { ...quota.forecast, state: 'safe', staleHours: 0, expired: false } }];
  }
  const verdict = { state: 'critical', label: 'Codex will reach its limit', affected: ['Codex · Weekly'] };
  const claude = snapshot.quotas.claude;
  const shorter = { ...structuredClone(claude.windows[0]), bucketId: 'five_hour', windowMinutes: 300 };
  shorter.forecast.state = 'risk';
  claude.windows.push(shorter);
  assert.equal(lib.verdictSentence(verdict, snapshot.quotas).secondary, 'Fable 5 is on track.');
  shorter.forecast.state = 'safe';
  shorter.forecast.staleHours = 2;
  assert.equal(lib.verdictSentence(verdict, snapshot.quotas).secondary, 'Fable 5 is on track.');
  shorter.forecast.staleHours = 0;
  assert.equal(lib.verdictSentence(verdict, snapshot.quotas).secondary, 'Claude and Fable 5 are on track.');
  assert.equal(lib.verdictSentence(verdict, snapshot.quotas, [{ id: 'claude', status: 'degraded' }]).secondary, 'Fable 5 is on track.');
});

test('current-cycle rows do not borrow totals from another reset or show expired history as current', () => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.cycles.codex = [{ ...snapshot.cycles.codex[0], resetsAt: '2026-01-01T00:00:00Z', current: true, cost: 987.65 }];
  assert.doesNotMatch(text(currentCycleRow(snapshot)), /987\.65/);
  const expired = expiredSnapshot();
  expired.cycles.codex[0].cost = 987.65;
  const row = currentCycleRow(expired);
  assert.match(text(row), /Awaiting current reading/);
  assert.doesNotMatch(text(row), /987\.65|expected at reset|Sept|Jan/);
});

test('current-cycle matching tolerates merged reset jitter without crossing window durations', () => {
  const snapshot = structuredClone(demoSnapshot);
  const quota = snapshot.quotas.codex;
  snapshot.cycles.codex = [{
    ...snapshot.cycles.codex[0],
    resetsAt: new Date(Date.parse(quota.resetsAt) + 1000).toISOString(),
    windowMinutes: quota.windowMinutes,
    current: true,
    cost: 123.45,
  }];
  assert.match(text(currentCycleRow(snapshot)), /123\.45/);
  snapshot.cycles.codex[0].windowMinutes = 300;
  assert.doesNotMatch(text(currentCycleRow(snapshot)), /123\.45/);
});

// Capture the actual element callbacks during a normal React server render.
// Hooks receive React's dispatcher; tests do not replace hooks or inspect internals.
function activeDayButtons(snapshot, update) {
  let tree;
  function Capture() {
    tree = ForecastSection({ snapshot, update });
    return null;
  }
  render(Capture, {});
  const buttons = new Map();
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node?.props) return;
    if (node.type === 'button') buttons.set(node.props.children, node.props);
    visit(node.props.children);
  }
  visit(tree);
  return buttons;
}

test('rapid active-day clicks cannot queue whole-array writes based on the same saved selection', async () => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.settings.activeDays = [1, 2, 3, 4, 5];
  const patches = [];
  let finish;
  const buttons = activeDayButtons(snapshot, (patch) => {
    patches.push(patch);
    return new Promise((resolve) => { finish = resolve; });
  });
  const saving = buttons.get('Tue').onClick();
  await buttons.get('Thu').onClick();
  assert.deepEqual(patches, [{ activeDays: [1, 3, 4, 5] }]);
  finish();
  await saving;
  snapshot.settings.activeDays = patches[0].activeDays;
  const nextButtons = activeDayButtons(snapshot, async (patch) => { patches.push(patch); });
  await nextButtons.get('Thu').onClick();
  assert.deepEqual(patches[1], { activeDays: [1, 3, 5] });
});

test('a rejected active-day save releases the synchronous guard so the user can retry', async () => {
  const snapshot = structuredClone(demoSnapshot);
  let attempts = 0;
  const buttons = activeDayButtons(snapshot, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Temporary local save failure');
  });
  await assert.rejects(buttons.get('Tue').onClick(), /Temporary local save failure/);
  await buttons.get('Tue').onClick();
  assert.equal(attempts, 2);
});

test('an applied early-reset adjustment explains reduced expected influence while preserving heavier-case context', () => {
  const snapshot = structuredClone(demoSnapshot);
  const weekly = snapshot.quotas.codex.windows[0];
  weekly.forecast.resetAdjustment = {
    resetAt: snapshot.generatedAt, dates: ['2026-09-06'], weight: 0.25,
  };
  const view = providerViews(snapshot)[0];
  const html = render(ProviderSummary, { view, nowMs: Date.parse(snapshot.generatedAt) });
  assert.match(text(html), /Codex weekly: Heavy usage before an early reset has less influence on the expected forecast/);
  assert.match(text(html), /Recorded usage is kept; the heavier case still includes it/);
  assert.doesNotMatch(text(html), /purchase|paid reset|credit redeemed/i);
});

test('a weekly reset adjustment stays visible alongside a critical five-hour session window', () => {
  const snapshot = structuredClone(demoSnapshot);
  const weekly = snapshot.quotas.codex.windows[0];
  weekly.forecast.resetAdjustment = { resetAt: snapshot.generatedAt, dates: ['2026-09-06'], weight: 0.25 };
  const shorter = { ...structuredClone(weekly), bucketId: 'five_hour', bucketName: 'Five hour', windowMinutes: 300 };
  delete shorter.forecast.resetAdjustment;
  shorter.forecast.state = 'critical';
  snapshot.quotas.codex.windows = [shorter, weekly];
  const view = providerViews(snapshot)[0];
  assert.equal(view.current.bucketId, weekly.bucketId);
  assert.equal(view.secondaryWindows[0].bucketId, 'five_hour');
  const html = render(ProviderSummary, { view, nowMs: Date.parse(snapshot.generatedAt) });
  assert.match(text(html), /Codex weekly: Heavy usage before an early reset/);
  assert.doesNotMatch(text(html), /Five hour: Heavy usage before an early reset/);
});

test('unchanged and expired forecasts do not claim an early-reset adjustment', () => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.quotas.codex.windows[0].forecast.resetAdjustment = {
    resetAt: snapshot.generatedAt, dates: ['2026-09-06'], weight: 1,
  };
  let html = render(ProviderSummary, { view: providerViews(snapshot)[0], nowMs: Date.parse(snapshot.generatedAt) });
  assert.doesNotMatch(html, /provider-adjustment-note/);
  const expired = expiredSnapshot();
  expired.quotas.codex.windows[0].forecast.resetAdjustment = {
    resetAt: expired.generatedAt, dates: ['2026-09-06'], weight: 0.25,
  };
  html = render(ProviderSummary, { view: providerViews(expired)[0], nowMs: Date.parse(expired.generatedAt) });
  assert.doesNotMatch(html, /provider-adjustment-note/);
});

test('the error fallback names the failure and offers a reload, and main.tsx mounts App inside the boundary', () => {
  const html = render(ErrorFallback, { message: 'Cannot read properties of undefined (reading windows)' });
  assert.match(html, /role="alert"/);
  assert.match(text(html), /AI Usage hit a rendering error/);
  assert.match(text(html), /Cannot read properties of undefined \(reading windows\)/);
  assert.match(text(html), /Reload dashboard/);
  const main = fs.readFileSync(path.resolve(__dirname, '../src/main.tsx'), 'utf8');
  assert.match(main, /<ErrorBoundary>\s*<App \/>\s*<\/ErrorBoundary>/);
});

test('date formatters degrade to a dash on unparseable input instead of throwing', () => {
  assert.equal(lib.shortDate('not a date'), '—');
  assert.equal(lib.dayDate('not a date'), '—');
  assert.equal(lib.dateTimeLabel('nope'), '—');
  assert.equal(lib.timeLabel('nope'), '—');
  assert.equal(lib.whenLabel('nope'), '—');
  assert.equal(lib.resetDistance('nope'), 'Reset unknown');
  assert.equal(lib.shortDate('2026-09-08T09:30:00Z'), '8 Sept, 10:30');
});

test('formatInt follows the fixed renderer locale and windowLabel names monthly windows', () => {
  assert.equal(lib.LOCALE, 'en-GB');
  assert.equal(lib.formatInt(1234567.8), '1,234,568');
  assert.equal(lib.windowLabel(300), '5-hour');
  assert.equal(lib.windowLabel(10_080), 'weekly');
  assert.equal(lib.windowLabel(40_320), 'monthly');
  assert.equal(lib.windowLabel(43_200), 'monthly');
});

test('reset distance under a day shows hours and minutes like the provider does', () => {
  const now = Date.now();
  assert.equal(lib.resetDistance(new Date(now + (4 * 60 + 18) * 60_000 + 20_000).toISOString()), '4h 18m');
  assert.equal(lib.resetDistance(new Date(now + 25 * 60_000).toISOString()), '25 min');
  assert.equal(lib.resetDistance(new Date(now + 10_000).toISOString()), '1 min');
  assert.equal(lib.resetDistance(new Date(now + 59.8 * 60_000).toISOString()), '1h 0m');
  assert.equal(lib.resetDistance(new Date(now + 47.6 * 3_600_000).toISOString()), '2 days 0h');
});

test('Spark limits are separate from the main Pro allowance and do not look like Codex sessions', () => {
  const snapshot = structuredClone(demoSnapshot);
  const main = { ...snapshot.quotas.codex.windows[0], bucketId: 'codex:primary', remainingPercent: 98,
    metadata: { limitId: 'codex' }, forecast: { ...snapshot.quotas.codex.forecast, state: 'safe', expectedRemaining: 49 } };
  const spark = { ...structuredClone(main), bucketId: 'codex_bengalfox:secondary', usedPercent: 0, remainingPercent: 100,
    metadata: { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark' },
    forecast: { ...main.forecast, state: 'safe', expectedRemaining: 100, exhaustsAt: null, heavyExhaustsAt: null, paceRatio: 0, currentIsEstimated: false } };
  const fiveHour = { ...structuredClone(spark), bucketId: 'codex_bengalfox:primary', windowMinutes: 300 };
  snapshot.quotas.codex = { ...main, windows: [spark, fiveHour, main] };
  let view = providerViews(snapshot)[0];
  assert.equal(view.current.bucketId, 'codex:primary', 'main quota wins regardless of endpoint ordering');
  let html = render(ProviderSummary, { view, nowMs: Date.parse(snapshot.generatedAt) });
  assert.match(text(html), /49% expected at reset/);
  assert.match(html, /<details class="provider-model-allowances">/);
  assert.match(text(html), /GPT-5.3-Codex-Spark · weekly/);
  assert.match(text(html), /GPT-5.3-Codex-Spark · 5-hour/);
  assert.match(text(html), /No usage reported in this window/);
  assert.doesNotMatch(text(html), /weekly session|5-hour session|100% expected at reset/);
  const risky = structuredClone(snapshot);
  risky.quotas.codex.windows[1].forecast.state = 'critical';
  view = providerViews(risky)[0];
  html = render(ProviderSummary, { view, nowMs: Date.parse(snapshot.generatedAt) });
  assert.match(html, /<details class="provider-model-allowances" open="">/, 'model-specific risk is visible without expanding details');
});

test('recorded allowance changes are listed in Settings with their source, instant and earlier allowance', () => {
  const snapshot = structuredClone(demoSnapshot);
  const update = async () => {};
  const empty = text(render(ForecastSection, { snapshot, update }));
  assert.match(empty, /Allowance changes/);
  assert.match(empty, /No allowance changes recorded\./);
  assert.match(empty, /Claude \(including Fable 5\)/, 'the subscription choice names the shared pool');
  snapshot.settings.allowanceChanges = [
    { source: 'codex', at: '2026-08-20T10:00:00.000Z', previousAllowancePercent: 80 },
    { source: 'claude', at: '2026-09-13T06:00:00.000Z', previousAllowancePercent: 150 },
  ];
  const html = render(ForecastSection, { snapshot, update });
  const listed = text(html);
  assert.match(listed, /2 changes recorded\./);
  assert.match(listed, /Claude \(including Fable 5\) 13 Sept 2026, 07:00\s*, previously 150% of the current allowance/);
  assert.match(listed, /Codex 20 Aug 2026, 11:00\s*, previously 80% of the current allowance/);
  assert.ok(listed.indexOf('13 Sept 2026') < listed.indexOf('20 Aug 2026'), 'latest change first');
  assert.match(html, /<time dateTime="2026-09-13T06:00:00.000Z">/);
  assert.match(html, /aria-label="Remove the allowance change for Codex, 20 Aug 2026, 11:00"/);
});
