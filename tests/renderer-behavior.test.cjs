'use strict';

const assert = require('node:assert/strict');
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
  ] = await Promise.all([
    server.ssrLoadModule('/src/data/demo.ts'),
    server.ssrLoadModule('/src/provider-view.ts'),
    server.ssrLoadModule('/src/components/ProviderSummary.tsx'),
    server.ssrLoadModule('/src/components/Overview.tsx'),
    server.ssrLoadModule('/src/components/Activity.tsx'),
    server.ssrLoadModule('/src/components/settings/ForecastSection.tsx'),
  ]);
});

test.after(async () => { await server?.close(); });

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

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

test('current-cycle evidence and forecast use the same primary bucket even when another window is riskier', () => {
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
  snapshot.quotas.codex = { ...weekly, windows: [weekly, shorter] };
  snapshot.cycles.codex = [{ ...snapshot.cycles.codex[0], resetsAt: weekly.resetsAt, current: true, cost: 123.45 }];
  assert.equal(providerViews(snapshot)[0].current.bucketId, 'five_hour', 'the summary still highlights the risky window');
  const row = currentCycleRow(snapshot);
  assert.match(text(row), /Codex weekly/);
  assert.match(text(row), /123\.45/);
  assert.match(text(row), /42% expected at reset/);
  assert.doesNotMatch(text(row), /0% expected at reset/);
  assert.match(row, /forecast-outcome safe/);
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

test('a weekly reset adjustment stays visible when a five-hour window headlines the provider card', () => {
  const snapshot = structuredClone(demoSnapshot);
  const weekly = snapshot.quotas.codex.windows[0];
  weekly.forecast.resetAdjustment = { resetAt: snapshot.generatedAt, dates: ['2026-09-06'], weight: 0.25 };
  const shorter = { ...structuredClone(weekly), bucketId: 'five_hour', bucketName: 'Five hour', windowMinutes: 300 };
  delete shorter.forecast.resetAdjustment;
  shorter.forecast.state = 'critical';
  snapshot.quotas.codex.windows = [shorter, weekly];
  const view = providerViews(snapshot)[0];
  assert.equal(view.current.bucketId, 'five_hour');
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
