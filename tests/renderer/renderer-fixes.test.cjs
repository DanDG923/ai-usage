'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');
const { startRendererServer } = require('../helpers/renderer-server.cjs');
const { render, text } = require('../helpers/markup.cjs');

let server;
let demoSnapshot;
let cycleMatch;
let CycleHistory;
let ProviderDetail;
let Overview;
let Activity;
let Costs;
let Settings;

test.before(async () => {
  server = await startRendererServer();
  [
    { demoSnapshot },
    cycleMatch,
    { CycleHistory },
    { ProviderDetail },
    { Overview },
    { Activity },
    { Costs },
    { Settings },
  ] = await Promise.all([
    server.ssrLoadModule('/src/data/demo.ts'),
    server.ssrLoadModule('/src/cycle-match.ts'),
    server.ssrLoadModule('/src/components/details/CycleHistory.tsx'),
    server.ssrLoadModule('/src/components/ProviderDetail.tsx'),
    server.ssrLoadModule('/src/components/Overview.tsx'),
    server.ssrLoadModule('/src/components/Activity.tsx'),
    server.ssrLoadModule('/src/components/Costs.tsx'),
    server.ssrLoadModule('/src/components/Settings.tsx'),
  ]);
});

test.after(async () => {
  await server?.close();
});

const noop = async () => {};
const settingsActions = {
  dataOperation: null,
  onSetupClaude() {},
  onSettings: noop,
  onPrice: noop,
  onInstallClaude: noop,
  onUninstallClaude: noop,
  onClaudeCodeMod: async () => null,
  onBackup: noop,
  onRestore: noop,
  onOpenBackups: noop,
  onManual: async () => true,
  onExportCsv: noop,
  onCopySummary: noop,
  onSnooze: noop,
  onCheckUpdates: async () => null,
};

/** Every page root, rendered as App mounts it. */
function pages(snapshot = structuredClone(demoSnapshot)) {
  return {
    overview: render(Overview, {
      snapshot,
      refreshing: false,
      onRefresh: noop,
      onSetupClaude() {},
      onSources() {},
    }),
    detail: render(ProviderDetail, { snapshot, provider: 'codex', onBack() {}, onOpenProvider() {} }),
    activity: render(Activity, { snapshot, days: snapshot.costs.periodDays }),
    costs: render(Costs, {
      snapshot,
      days: snapshot.costs.periodDays,
      onDays() {},
      query: '',
      onQuery() {},
      onSnapshot() {},
    }),
    settings: render(Settings, { snapshot, actions: settingsActions }),
  };
}

test('a reset reported a second apart is not "Reset early", in both cycle tables', () => {
  const { cycleEndedEarly } = cycleMatch;
  const resetsAt = '2026-09-14T12:00:00.000Z';
  assert.equal(cycleEndedEarly({ resetsAt }), false);
  assert.equal(cycleEndedEarly({ resetsAt, endsAt: '2026-09-14T12:00:01Z' }), false);
  assert.equal(cycleEndedEarly({ resetsAt, endsAt: '2026-09-14T11:59:00Z' }), false);
  assert.equal(cycleEndedEarly({ resetsAt, endsAt: '2026-09-14T11:58:59Z' }), true);
  assert.equal(cycleEndedEarly({ resetsAt, endsAt: '2026-09-09T12:00:00Z' }), true);

  const withEnds = (offsetMs) => {
    const snapshot = structuredClone(demoSnapshot);
    snapshot.cycles.codex = snapshot.cycles.codex.map((row) =>
      row.current ? row : { ...row, endsAt: new Date(Date.parse(row.resetsAt) - offsetMs).toISOString() },
    );
    return snapshot;
  };
  const jitter = withEnds(1_000);
  assert.doesNotMatch(text(render(CycleHistory, { cycles: jitter.cycles, currency: 'GBP' })), /Reset early/);
  assert.doesNotMatch(text(render(ProviderDetail, { snapshot: jitter, provider: 'codex', onBack() {} })), /Reset early/);

  const early = withEnds(2 * 86_400_000);
  assert.match(text(render(CycleHistory, { cycles: early.cycles, currency: 'GBP' })), /Reset early/);
  assert.match(text(render(ProviderDetail, { snapshot: early, provider: 'codex', onBack() {} })), /Reset early/);
});

test('every table header has a scope and every data table has a name', () => {
  const snapshot = structuredClone(demoSnapshot);
  // Sessions and the chat-estimate table render only with rows.
  snapshot.costs.sessions = [
    {
      sourceId: 'codex',
      sessionId: 'session-example',
      project: 'Example',
      model: 'gpt-5',
      occurredAt: snapshot.generatedAt,
      totalTokens: 170,
      cost: 0.15,
      coverage: 1,
    },
  ];
  const rendered = pages(snapshot);
  let tables = 0;
  for (const [name, html] of Object.entries(rendered)) {
    for (const th of html.match(/<th\b[^>]*>/g) || []) assert.match(th, /\bscope="(col|row)"/, `${name}: ${th}`);
    for (const match of html.matchAll(/<table\b([^>]*)>(\s*<[a-z]+)/g)) {
      tables++;
      // A table is named by its caption, or by an attribute where a caption would move the layout.
      assert.ok(match[2].trim() === '<caption' || /\baria-label="[^"]+"/.test(match[1]), `${name}: a table has a caption or a label`);
    }
  }
  assert.ok(tables >= 7, `checked ${tables} tables`);
  assert.match(rendered.activity, /<caption class="sr-only">Source evidence for each provider<\/caption>/);
  assert.match(rendered.costs, /<caption class="sr-only">API-equivalent cost by project<\/caption>/);
  assert.match(rendered.costs, /<caption class="sr-only">API-equivalent cost and tokens by model<\/caption>/);
  assert.match(rendered.costs, /<caption class="sr-only">Tracked sessions by API-equivalent cost<\/caption>/);
  assert.match(rendered.costs, /<table class="costs-table desktop-table" aria-label="Claude desktop and web chat estimates by model">/);
  assert.match(rendered.settings, /<caption class="sr-only">Model prices in US dollars per million tokens<\/caption>/);
  assert.match(rendered.detail, /<caption class="sr-only">Codex reset windows, the current one first<\/caption>/);
});

// ---------- 10. Main stays a landmark; the tab panel sits inside it ----------

test('each page root is a main landmark holding its tab panel', () => {
  const panels = {
    overview: 'tab-overview',
    detail: 'tab-overview',
    activity: 'tab-activity',
    costs: 'tab-costs',
    settings: 'tab-settings',
  };
  for (const [name, html] of Object.entries(pages())) {
    const tab = panels[name];
    const id = tab.replace('tab-', 'panel-');
    assert.match(
      html,
      new RegExp(`^<main><div class="page [^"]+"[^>]* id="${id}" role="tabpanel" aria-labelledby="${tab}" tabindex="-1">`),
      name,
    );
    assert.ok(html.endsWith('</div></main>'), `${name} closes its panel inside main`);
    assert.doesNotMatch(html, /<main[^>]*role=/, `${name}: main keeps its landmark role`);
  }
  const hidden = structuredClone(demoSnapshot);
  hidden.settings.showClaudeSubscription = false;
  assert.match(render(ProviderDetail, { snapshot: hidden, provider: 'fable', onBack() {} }), /^<main><div class="page detail-page pd-hidden" id="panel-overview" role="tabpanel"/);
  const empty = structuredClone(demoSnapshot);
  empty.settings.showClaudeSubscription = false;
  empty.settings.showCodexSubscription = false;
  const overview = render(Overview, { snapshot: empty, refreshing: false, onRefresh: noop, onSetupClaude() {}, onSources() {} });
  assert.match(overview, /^<main><div class="page overview-page" id="panel-overview" role="tabpanel"/);
});

// ---------- 11. Heatmap cells and cycle bars carry an accessible name ----------

test('heatmap cells and cycle bars name their value, not only in a tooltip', () => {
  const snapshot = structuredClone(demoSnapshot);
  const activity = render(Activity, { snapshot, days: snapshot.costs.periodDays });
  const cells = activity.match(/<i class="hm-cell[^"]*"[^>]*>/g) || [];
  assert.ok(cells.length > 0, 'the heatmap renders');
  for (const cell of cells) {
    const title = cell.match(/title="([^"]+)"/)[1];
    assert.match(cell, new RegExp(`aria-label="${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
  const bars = render(CycleHistory, { cycles: snapshot.cycles, currency: 'GBP' }).match(/<div class="cycle-bar( current)?"[^>]*>/g);
  assert.ok(bars.length > 0);
  for (const bar of bars) {
    const title = bar.match(/title="([^"]+)"/)[1];
    assert.equal(bar.match(/aria-label="([^"]+)"/)?.[1], title);
    assert.match(title, /\d+% used/);
  }
});
