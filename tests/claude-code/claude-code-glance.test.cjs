'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildGlance } = require('../../electron/claude-code-glance.cjs');
const { flyoutPayload } = require('../../electron/flyout.cjs');
const { buildDashboardVerdict } = require('../../electron/dashboard-decision.cjs');
const { startRendererServer } = require('../helpers/renderer-server.cjs');
const { decodedText: text } = require('../helpers/markup.cjs');

// The glance is the flyout's figures for the Claude Code mod, built in the
// main process. These tests hold it to the renderer's own rules.
let server;
let demo;
let flyoutModule;
let providerViews;

test.before(async () => {
  server = await startRendererServer();
  [demo, flyoutModule, { providerViews }] = await Promise.all([
    server.ssrLoadModule('/src/data/demo.ts'),
    server.ssrLoadModule('/src/components/TrayFlyout.tsx'),
    server.ssrLoadModule('/src/provider-view.ts'),
  ]);
});

test.after(async () => { await server?.close(); });

const flyoutText = (snapshot) => text(renderToStaticMarkup(React.createElement(flyoutModule.TrayFlyout, {
  snapshot, nowMs: Date.parse(snapshot.generatedAt),
})));

function variants() {
  const base = demo.demoSnapshot;
  const safe = structuredClone(base);
  for (const quota of Object.values(safe.quotas)) {
    for (const window of quota?.windows?.length ? quota.windows : [quota]) if (window) window.forecast.state = 'safe';
  }
  safe.dashboardVerdict = buildDashboardVerdict(safe);
  const noFable = structuredClone(base);
  noFable.quotas.fable = null;
  noFable.dashboardVerdict = buildDashboardVerdict(noFable);
  const codexOnly = structuredClone(base);
  codexOnly.settings.showClaudeSubscription = false;
  codexOnly.dashboardVerdict = buildDashboardVerdict(codexOnly);
  const staleClaude = structuredClone(base);
  staleClaude.sources = staleClaude.sources.map((source) => (source.id === 'claude' ? { ...source, status: 'stale' } : source));
  return { demo: base, sharedPool: demo.sharedPoolDemoSnapshot(), safe, noFable, codexOnly, staleClaude };
}

test('each provider row carries the figures the flyout and cards show', () => {
  for (const [name, snapshot] of Object.entries(variants())) {
    const glance = buildGlance(snapshot);
    const views = providerViews(snapshot);
    assert.deepEqual(glance.providers.map((row) => row.id), views.map((view) => view.id), name);
    views.forEach((view, index) => {
      const row = glance.providers[index];
      const label = `${name}/${view.id}`;
      assert.equal(row.name, view.name, label);
      assert.equal(row.subtitle, view.subtitle, label);
      assert.equal(row.state, view.state, label);
      assert.equal(row.waiting, !view.current || view.expired, label);
      assert.equal(row.remaining, view.remaining, label);
      assert.equal(row.expectedRemaining, view.expectedRemaining, label);
      assert.equal(row.estimated, view.estimated, label);
      assert.equal(row.usable, view.poolLimited, label);
      assert.equal(row.resetsAt, view.resetAt, label);
      assert.equal(row.stale, view.stale, label);
      assert.deepEqual(row.secondary.map((entry) => entry.resetsAt), view.secondaryWindows.map((window) => window.resetsAt), label);
    });
  }
});

test('the verdict reads as the flyout annunciator, daily budget included', () => {
  for (const [name, snapshot] of Object.entries(variants())) {
    const glance = buildGlance(snapshot);
    const shown = flyoutText(snapshot);
    assert.ok(shown.includes(glance.verdict.headline), `${name}: ${glance.verdict.headline}`);
    if (glance.verdict.detail) assert.ok(shown.includes(glance.verdict.detail), `${name}: ${glance.verdict.detail}`);
    const state = snapshot.dashboardVerdict.state;
    assert.equal(glance.verdict.state, state, name);
  }
  // The demo's one affected provider has a pace to keep.
  assert.match(buildGlance(demo.demoSnapshot).verdict.detail, /^Stay under [\d.]+% a day to reach the reset\.$/);
  assert.deepEqual(buildGlance(variants().safe).verdict, { state: 'safe', headline: 'All allowances on track', detail: '' });
});

test('the flyout payload carries everything the glance needs', () => {
  for (const [name, snapshot] of Object.entries(variants())) {
    const nowMs = Date.parse('2026-10-01T12:00:00.000Z');
    const full = buildGlance(snapshot, { nowMs });
    const light = buildGlance(JSON.parse(JSON.stringify(flyoutPayload(snapshot))), { nowMs });
    assert.deepEqual(light, full, name);
  }
});

test('an empty or unreadable snapshot waits honestly and invents no figure', () => {
  for (const snapshot of [null, {}, { settings: {}, sources: [], quotas: {} }]) {
    const glance = buildGlance(snapshot, { nowMs: Date.parse('2026-10-01T12:00:00.000Z'), appVersion: '1.0.56' });
    assert.equal(glance.schema, 1);
    assert.equal(glance.appVersion, '1.0.56');
    assert.equal(glance.verdict.headline, 'Waiting for allowance readings');
    assert.ok(glance.providers.every((row) => row.waiting && row.remaining == null && row.expectedRemaining == null));
  }
  const hidden = buildGlance({ settings: { showCodexSubscription: false, showClaudeSubscription: false }, sources: [], quotas: {} });
  assert.equal(hidden.verdict.headline, 'No subscriptions shown');
  assert.deepEqual(hidden.providers, []);
});
