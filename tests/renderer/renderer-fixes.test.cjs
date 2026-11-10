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

// ---------- 12. Store and actions: one data operation at a time, periods matched ----------

async function dashboardWith(desktop, period = 30) {
  const { createDashboard } = await server.ssrLoadModule('/src/app/dashboard.ts');
  return createDashboard({ source: { desktop, preview: null }, period });
}

test('backup, restore and export refuse to start while another data operation runs', async () => {
  const held = [];
  const calls = { createBackup: 0, restoreBackup: 0, exportCsv: 0 };
  const hold = (name, value) => () => {
    calls[name] += 1;
    return new Promise((resolve) => held.push(() => resolve(value)));
  };
  const snapshot = structuredClone(demoSnapshot);
  const { store, actions } = await dashboardWith({
    createBackup: hold('createBackup', { snapshot, result: { databasePath: 'backup.sqlite' } }),
    restoreBackup: hold('restoreBackup', { cancelled: true }),
    exportCsv: hold('exportCsv', { cancelled: true }),
  });
  // Two presses in the same tick, before the controls are redrawn.
  const first = actions.backup();
  const again = [actions.backup(), actions.restore(), actions.exportCsv(30)];
  assert.deepEqual(calls, { createBackup: 1, restoreBackup: 0, exportCsv: 0 });
  await Promise.all(again);
  assert.equal(store.get().dataOperation, 'backup', 'a refused call does not release the slot it did not take');
  held.shift()();
  await first;
  assert.equal(store.get().dataOperation, null);
  // Once the slot is free each operation runs again, still one at a time.
  const restore = actions.restore();
  await actions.exportCsv(30);
  assert.deepEqual(calls, { createBackup: 1, restoreBackup: 1, exportCsv: 0 });
  held.shift()();
  await restore;
  const exported = actions.exportCsv(30);
  assert.equal(calls.exportCsv, 1);
  held.shift()();
  await exported;
  assert.equal(store.get().dataOperation, null);
});

test('a push for another period that lands before the first read is shown under its own period', async (t) => {
  let pushed;
  let answer;
  const { store, actions } = await dashboardWith({
    getSnapshot: () => new Promise((resolve) => { answer = resolve; }),
    onUpdated(listener) { pushed = listener; return () => {}; },
  }, 30);
  // The display clock runs while connected; stopping it lets the test exit.
  t.after(actions.connect());
  const ninety = structuredClone(demoSnapshot);
  ninety.costs.periodDays = 90;
  pushed(ninety);
  // The costs on screen are the 90-day costs, so the period shown is 90 days.
  assert.equal(store.get().snapshot.costs.periodDays, 90);
  assert.equal(store.get().period, 90);
  // The read the window asked for still lands, under its own period.
  const thirty = structuredClone(demoSnapshot);
  thirty.costs.periodDays = 30;
  answer(thirty);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get().snapshot, thirty);
  assert.equal(store.get().period, 30);
  // A later push for another period keeps the 30-day costs, as before.
  pushed(ninety);
  assert.equal(store.get().snapshot.costs, thirty.costs);
  assert.equal(store.get().period, 30);
});
