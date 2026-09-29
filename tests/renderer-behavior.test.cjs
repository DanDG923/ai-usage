'use strict';
require('./setup.cjs');

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
  ({ ProviderDetail } = await server.ssrLoadModule('/src/components/ProviderDetail.tsx'));
});

// The current-cycle table moved from the Overview to each provider's page.
let ProviderDetail;

test.after(async () => { await server?.close(); });

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('Claude headlines the overall pool ahead of model windows and uses its own Pro label', () => {
  for (const modelFirst of [true, false]) {
    const snapshot = structuredClone(demoSnapshot);
    const overall = { ...snapshot.quotas.claude, bucketId: 'seven_day', planType: 'pro', metadata: {},
      usedPercent: 17, remainingPercent: 83 };
    const scoped = { ...overall, bucketId: 'model_scoped:opus', metadata: { scope: 'model' }, remainingPercent: 12 };
    snapshot.quotas.claude.windows = modelFirst ? [scoped, overall] : [overall, scoped];
    const view = providerViews(snapshot).find((entry) => entry.id === 'claude');
    assert.equal(view.current, overall);
    assert.equal(view.secondaryWindows[0], scoped);
    assert.match(view.subtitle, /Claude Pro/);
    assert.doesNotMatch(view.subtitle, /ChatGPT/);
  }
});

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

function currentCycleRow(snapshot, provider = 'codex') {
  const html = render(ProviderDetail, { snapshot, provider, onBack() {} });
  const table = html.match(/<table class="cycle-detail-table">[\s\S]*?<\/table>/)?.[0];
  assert.ok(table, 'the provider page rendered its cycle table');
  return table.match(/<tr class="current">[\s\S]*?<\/tr>/)?.[0];
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

test('Activity does not call a connected source current once its allowance reading ages past the freshness limit', () => {
  const codexRow = (staleHours) => {
    const snapshot = structuredClone(demoSnapshot);
    snapshot.sources.find((source) => source.id === 'codex').status = 'connected';
    for (const entry of snapshot.quotas.codex.windows) entry.forecast.staleHours = staleHours;
    const html = render(Activity, { snapshot, days: snapshot.costs.periodDays });
    const table = html.match(/<table class="evidence-table">[\s\S]*?<\/table>/)?.[0];
    return text(table?.match(/<tr>(?:(?!<\/tr>)[\s\S])*?Codex[\s\S]*?<\/tr>/)?.[0] ?? '');
  };
  assert.match(codexRow(0.5), /Current/);
  // Collection succeeded, but the balance it shows is older than the rule allows.
  const aged = codexRow(26);
  assert.match(aged, /Needs refresh/);
  assert.doesNotMatch(aged, /Current/);
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
  assert.equal(lib.verdictSentence(verdict, snapshot.quotas).secondary, 'Fable is on track.');
  shorter.forecast.state = 'safe';
  shorter.forecast.staleHours = 2;
  assert.equal(lib.verdictSentence(verdict, snapshot.quotas).secondary, 'Fable is on track.');
  shorter.forecast.staleHours = 0;
  assert.equal(lib.verdictSentence(verdict, snapshot.quotas).secondary, 'Claude and Fable are on track.');
  assert.equal(lib.verdictSentence(verdict, snapshot.quotas, [{ id: 'claude', status: 'degraded' }]).secondary, 'Fable is on track.');
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
  assert.match(text(html), /Expected at reset 49% left/);
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
  assert.match(empty, /Claude weekly \(including Fable\)/, 'the subscription choice names the shared pool');
  snapshot.settings.allowanceChanges = [
    { source: 'codex', at: '2026-08-20T10:00:00.000Z', previousAllowancePercent: 80 },
    { source: 'claude', at: '2026-09-13T06:00:00.000Z', previousAllowancePercent: 150 },
  ];
  const html = render(ForecastSection, { snapshot, update });
  const listed = text(html);
  assert.match(listed, /2 changes recorded\./);
  assert.match(listed, /Claude weekly \(including Fable\) 13 Sept 2026, 07:00\s*, previously 150% of the allowance that followed/);
  assert.match(listed, /Codex main weekly 20 Aug 2026, 11:00\s*, previously 80% of the allowance that followed/);
  assert.ok(listed.indexOf('13 Sept 2026') < listed.indexOf('20 Aug 2026'), 'latest change first');
  assert.match(html, /<time dateTime="2026-09-13T06:00:00.000Z">/);
  assert.match(html, /aria-label="Remove the allowance change for Codex main weekly, 20 Aug 2026, 11:00"/);
});

test('coverage never rounds incomplete evidence to 100 percent and money has consistent precision', () => {
  assert.equal(lib.priceCoverage(0.996), '99%');
  assert.equal(lib.priceCoverage(1), '100%');
  assert.equal(lib.money(1755.8, 'GBP'), '£1,755.80');
  assert.equal(lib.resetDistance(new Date(Date.now() - 1).toISOString()), 'Reset passed');
});

test('attention preserves late critical rows and sorts urgency before provider order', () => {
  const snapshot = structuredClone(demoSnapshot);
  for (const quota of Object.values(snapshot.quotas)) {
    for (const entry of [quota, ...quota.windows]) {
      entry.forecast = { ...entry.forecast, expired: false, exhaustsAt: null, heavyExhaustsAt: null, paceRatio: 1.1, staleHours: 30 };
    }
  }
  const current = lib.primaryWindow(snapshot.quotas.fable);
  current.forecast.exhaustsAt = new Date(Date.now() + 3600000).toISOString();
  // With the status line about another allowance, the Fable row must stay listed and lead.
  snapshot.dashboardVerdict = { ...snapshot.dashboardVerdict, details: [] };
  const html = render(Overview, { snapshot, refreshing: false, onRefresh: async () => {}, onSetupClaude() {}, onSources() {} });
  const attention = html.slice(html.indexOf('class="insight-list"'));
  assert.ok(attention.indexOf('Fable is expected to run out') >= 0);
  assert.ok(attention.indexOf('Fable is expected to run out') < attention.indexOf('Codex is above its safe pace'));
  assert.match(attention, /Last 30 days/);
});

test('the status line states its window once, with a daily budget, and the list keeps every other note', () => {
  const snapshot = structuredClone(demoSnapshot);
  const html = render(Overview, {
    snapshot, refreshing: false, onRefresh: async () => {}, onSetupClaude() {}, onSources() {}, onOpenProvider() {},
  });
  const status = text(html.slice(html.indexOf('class="overview-status'), html.indexOf('class="allowance-section"')));
  assert.match(status, /Fable could reach its limit under heavier usage/);
  assert.match(status, /Keep Fable under \d+(\.\d)?% of its allowance per active day to reach its .+ reset\./);
  assert.match(status, /Plan Fable usage/);
  const attention = text(html.slice(html.indexOf('id="attention-heading"'), html.indexOf('id="value-heading"')));
  assert.doesNotMatch(attention, /Fable could run out under heavier usage/, 'the status line already says it');
  // Banked resets sit on their provider's card, not in the list.
  assert.doesNotMatch(attention, /reset credit/);
  const codexCard = text(html.slice(html.indexOf('aria-label="Codex allowance"'), html.indexOf('aria-label="Claude allowance"')));
  assert.match(codexCard, /1 reset credit banked Reported by Codex. Never counted as allowance or used automatically./);
});

test('View sources opens Settings at its Sources section, not at the top', () => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.quotas.codex = null; // an allowance still waiting for its first reading
  const opened = [];
  let tree;
  function Capture() {
    tree = Overview({
      snapshot, refreshing: false, onRefresh: async () => {}, onSetupClaude() {},
      onSources: () => opened.push('settings'), onOpenSettings: (section) => opened.push(section),
    });
    return null;
  }
  render(Capture, {});
  const find = (node) => {
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    if (!node?.props) return null;
    return node.type === 'button' && node.props.children === 'View sources' ? node : find(node.props.children);
  };
  find(tree).props.onClick();
  assert.deepEqual(opened, ['sources']);
});

test('subscription value weighs only the usage of plans with a visible fee, and keeps a lower bound', () => {
  const snapshot = structuredClone(demoSnapshot);
  const overview = (next) => text(render(Overview, {
    snapshot: next, refreshing: false, onRefresh: async () => {}, onSetupClaude() {}, onSources() {},
  }));
  snapshot.settings = { ...snapshot.settings, codexPlanUsdPerMonth: 200, claudePlanUsdPerMonth: 0, usdToCurrency: 1 };
  // 600 of API-equivalent use in the period: 400 on Codex and 200 on Claude.
  snapshot.costs = {
    ...snapshot.costs, actual: 600, isLowerBound: false, periodDays: 30, unpricedModels: [],
    chart: [{ date: '2026-09-01', codex: 250, claude: 150 }, { date: '2026-09-02', codex: 150, claude: 50 }],
  };
  // Only Codex has a fee: 200 USD a month over 30 of 30.4375 days is 197.13,
  // and Codex's 400 is 2.03 times that. Claude's 200 is not credited to it.
  assert.match(overview(snapshot), /Subscription value 2\.0× Codex usage vs .*197\.13 of plan fees/);
  // With a 50 USD Claude fee as well, all 600 counts against 246.41.
  snapshot.settings.claudePlanUsdPerMonth = 50;
  assert.match(overview(snapshot), /Subscription value 2\.4× vs .*246\.41 of plan fees/);
  // Unpriced Claude usage makes that a lower bound, like the period's total…
  snapshot.costs.isLowerBound = true;
  snapshot.costs.unpricedModels = [{ sourceId: 'claude', model: 'claude-unpriced', tokens: 1_000 }];
  assert.match(overview(snapshot), /Subscription value ≥ 2\.4×/);
  // …but not the value of a Codex plan whose usage is fully priced. A hidden
  // subscription leaves its fee, usage and unpriced models out.
  snapshot.settings.showClaudeSubscription = false;
  assert.match(overview(snapshot), /Subscription value 2\.0× Codex usage vs .*197\.13 of plan fees/);
  assert.match(overview(snapshot), /≥ \D*600\.00 Lower bound · 1 model unpriced/, 'the period total stays a lower bound');
  snapshot.costs.unpricedModels.push({ sourceId: 'codex', model: 'codex-unpriced', tokens: 1_000 });
  assert.match(overview(snapshot), /Subscription value ≥ 2\.0× Codex usage/);
  snapshot.settings.showCodexSubscription = false;
  const hidden = overview(snapshot);
  assert.doesNotMatch(hidden, /Subscription value/);
  assert.match(hidden, /Add your monthly plan fees/);
});

test('short-window stale evidence requests refresh on the provider view', () => {
  const snapshot = structuredClone(demoSnapshot);
  const weekly = lib.primaryWindow(snapshot.quotas.codex);
  weekly.forecast.staleHours = 0;
  const short = { ...weekly, bucketId: 'short', windowMinutes: 300, forecast: { ...weekly.forecast, staleHours: 1.1 } };
  snapshot.quotas.codex.windows = [weekly, short];
  assert.equal(providerViews(snapshot)[0].stale, true);
});

test('learning runway descriptions never invent zero percent and exclude expired series', async () => {
  const { RunwayChart } = await server.ssrLoadModule('/src/components/Charts.tsx');
  const schedule = { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 8, endHour: 22 };
  const snapshot = structuredClone(demoSnapshot);
  const views = providerViews(snapshot).map((view) => ({ ...view, expectedRemaining: null, heavyRemaining: null,
    current: { ...view.current, forecast: { ...view.current.forecast, expectedRemaining: null, heavyRemaining: null } } }));
  for (const view of views) {
    const html = render(RunwayChart, { view, schedule, size: 'full' });
    assert.match(html, /forecast is learning/);
    assert.doesNotMatch(html, /expected 0%/);
    assert.doesNotMatch(html, /runway-expected" d="M|runway-band/, 'no projection is drawn while learning');
    assert.equal(render(RunwayChart, { view: { ...view, expired: true }, schedule }), '');
  }
});

test('each runway runs on its own window, shades inactive hours and marks a heavier run-out', async () => {
  const { RunwayChart } = await server.ssrLoadModule('/src/components/Charts.tsx');
  const schedule = { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 8, endHour: 22 };
  const [codex, , fable] = providerViews(structuredClone(demoSnapshot));
  const html = render(RunwayChart, { view: fable, schedule, size: 'full' });
  assert.match(html, /class="runway-chart full fable"/);
  assert.match(html, /class="runway-inactive"/);
  assert.match(html, /class="runway-band"/);
  assert.match(html, /Heavier week runs out/);
  assert.match(html, /View runway data/);
  assert.match(html, /aria-label="Fable: 72% left now; expected 41% at reset; a heavier week runs out /);
  const compact = render(RunwayChart, { view: codex, schedule });
  assert.doesNotMatch(compact, /View runway data/, 'cards leave the data table to the provider page');
  assert.doesNotMatch(render(RunwayChart, { view: fable, schedule, size: 'full', showHeavy: false }), /runway-band|Heavier week runs out/);
  assert.match(render(RunwayChart, { view: fable, schedule, size: 'full', reserve: 15 }), /Reserve 15%/);
});

test('empty hourly activity and chart data tables are available without pointer interaction', async () => {
  const { ActivityHeatmap } = await server.ssrLoadModule('/src/components/details/ActivityHeatmap.tsx');
  const { CostChart, DailyUsageChart } = await server.ssrLoadModule('/src/components/Charts.tsx');
  assert.match(render(ActivityHeatmap, { grid: Array.from({ length: 7 }, () => Array(24).fill(0)), currency: 'GBP', days: 30 }), /Hourly activity appears/);
  assert.match(render(CostChart, { costs: demoSnapshot.costs }), /View cost data.*<table>/);
  assert.match(render(DailyUsageChart, { rows: [{ date: '2026-09-14', tokens: 100 }], days: 30 }), /View daily token data.*<table>/);
});

test('Claude model-scoped weeks are named and grouped apart, never read as the plan weekly allowance', () => {
  const window = (bucketId, bucketName, metadata) => ({ bucketId, bucketName, windowMinutes: 10_080, metadata });
  assert.equal(lib.modelAllowanceName(window('seven_day', 'Weekly', { scope: 'overall' })), null);
  assert.equal(lib.modelAllowanceName(window('seven_day_opus', 'Opus weekly', { scope: 'model' })), 'Opus');
  // Status-line rows carry no scope; the bucket still says which week it is.
  assert.equal(lib.allowanceWindowLabel(window('seven_day_opus', 'Opus weekly', {})), 'Opus · weekly');
  assert.equal(lib.allowanceWindowLabel(window('seven_day_oauth_apps', 'OAuth apps weekly', { scope: 'oauth-apps' })), 'OAuth apps · weekly');
  assert.equal(lib.modelAllowanceName(window('codex:secondary', 'Weekly', { limitId: 'codex' })), null);
  assert.equal(lib.modelAllowanceName(window('gpt:secondary', 'Weekly', { limitId: 'gpt-5-codex', limitName: 'GPT-5 Codex' })), 'GPT-5 Codex');
  assert.equal(lib.modelAllowanceName(window('fable_seven_day', 'Fable weekly', {})), null);
  // A status-line Fable key outside the canonical ones, and a legacy bucket.
  assert.equal(lib.modelAllowanceName(window('fable:fable_five_hour', 'Fable weekly', {})), null);
  assert.equal(lib.modelAllowanceName(window('fable-weekly', 'Fable 5 weekly', {})), null);

  const snapshot = structuredClone(demoSnapshot);
  const weekly = lib.primaryWindow(snapshot.quotas.claude);
  const opus = { ...structuredClone(weekly), bucketId: 'seven_day_opus', bucketName: 'Opus weekly', metadata: { scope: 'model' } };
  snapshot.quotas.claude = { ...weekly, windows: [weekly, opus] };
  const view = providerViews(snapshot).find((entry) => entry.id === 'claude');
  const card = text(render(ProviderSummary, { view, nowMs: Date.parse(snapshot.generatedAt) }));
  assert.match(card, /Separate model allowances .*main Claude allowance.*Opus · weekly/);
});

test('the safe-pace note follows the pace the user treats as a risk and never prints a placeholder multiple', () => {
  const snapshot = structuredClone(demoSnapshot);
  for (const quota of Object.values(snapshot.quotas)) {
    for (const entry of [quota, ...quota.windows]) {
      entry.forecast = { ...entry.forecast, expired: false, exhaustsAt: null, heavyExhaustsAt: null, paceRatio: 1, safePace: 1 };
    }
  }
  snapshot.dashboardVerdict = { ...snapshot.dashboardVerdict, details: [] };
  const codex = lib.primaryWindow(snapshot.quotas.codex);
  codex.forecast.paceRatio = 1.5;
  const overview = (paceRiskThreshold) => render(Overview, {
    snapshot: { ...snapshot, settings: { ...snapshot.settings, paceRiskThreshold } },
    refreshing: false, onRefresh: async () => {}, onSetupClaude() {}, onSources() {},
  });
  const tone = (html, title) => html.slice(html.lastIndexOf('<article', html.indexOf(title)), html.indexOf(title)).match(/class="insight (\w+)"/)?.[1];
  assert.equal(tone(overview(1.2), 'Codex is above its safe pace'), 'warm');
  // At a 3× risk pace, 1.5× is worth knowing but is not the warning the verdict would give.
  assert.equal(tone(overview(3), 'Codex is above its safe pace'), 'neutral');
  // No safe pace left: the backend's ratio is a placeholder, not "2.2× the sustainable pace".
  codex.forecast.safePace = 0;
  codex.forecast.paceRatio = 2.2;
  const html = text(overview(1.2));
  assert.match(html, /Codex has no safe pace left/);
  assert.doesNotMatch(html, /2\.2× the sustainable pace/);
});

test('a plan without a Fable allowance is not waited for, on its card or in the list', () => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.quotas.fable = null;
  snapshot.fableApplies = false;
  const html = render(Overview, { snapshot, refreshing: false, onRefresh: async () => {}, onSetupClaude() {}, onSources() {} });
  const attention = text(html.slice(html.indexOf('id="attention-heading"'), html.indexOf('id="value-heading"')));
  assert.doesNotMatch(attention, /Waiting for .*Fable/);
  const fableCard = text(html.slice(html.indexOf('aria-label="Fable allowance"'), html.indexOf('id="attention-heading"')));
  assert.match(fableCard, /Not in plan .*does not include a Fable allowance/);
  assert.doesNotMatch(fableCard, /Waiting for the provider/);
});

test('a weekday names only times within six days, so next week never reads as today', () => {
  const HOUR = 3_600_000;
  const now = Date.parse('2026-09-29T14:00:00Z'); // Tuesday 15:00 in London
  assert.notEqual(lib.whenLabel(now + 7 * 24 * HOUR - HOUR, now), lib.whenLabel(now - HOUR, now));
  assert.match(lib.whenLabel(now + 2 * 24 * HOUR, now), /^Thu/);
});

test('an empty period has no price coverage to report', () => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.costs = { ...snapshot.costs, totalTokens: 0, coverage: 0, isComplete: true, isLowerBound: false, unpricedModels: [] };
  const html = text(render(Overview, { snapshot, refreshing: false, onRefresh: async () => {}, onSetupClaude() {}, onSources() {} }));
  assert.match(html, /Price coverage — No usage in this period/);
  assert.doesNotMatch(html, /0% All tracked categories priced/);
});
