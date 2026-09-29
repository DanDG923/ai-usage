'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

let server;
let demoSnapshot;
let sections;
let budget;
let preview;
let Settings;
let SubscriptionsSection;
let ForecastSection;
let fields;
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
    { demoSnapshot }, sections, budget, preview, { Settings }, { SubscriptionsSection }, { ForecastSection }, fields, lib,
  ] = await Promise.all([
    server.ssrLoadModule('/src/data/demo.ts'),
    server.ssrLoadModule('/src/components/settings/settings-sections.ts'),
    server.ssrLoadModule('/src/budget.ts'),
    server.ssrLoadModule('/src/components/settings/budget-preview.ts'),
    server.ssrLoadModule('/src/components/Settings.tsx'),
    server.ssrLoadModule('/src/components/settings/SubscriptionsSection.tsx'),
    server.ssrLoadModule('/src/components/settings/ForecastSection.tsx'),
    server.ssrLoadModule('/src/components/settings/fields.tsx'),
    server.ssrLoadModule('/src/lib.ts'),
  ]);
});

test.after(async () => { await server?.close(); });

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const noop = async () => {};
const actions = {
  dataOperation: null, onSetupClaude() {}, onSettings: noop, onPrice: noop, onInstallClaude: noop,
  onUninstallClaude: noop, onBackup: noop, onRestore: noop, onOpenBackups: noop, onManual: async () => true,
  onExportCsv: noop, onCopySummary: noop, onSnooze: noop, onCheckUpdates: async () => null,
};
const renderSettings = (snapshot) => render(Settings, { snapshot, actions });
const section = (html, id) => {
  const start = html.indexOf(`<section id="${id}"`);
  assert.ok(start >= 0, `section #${id} is rendered`);
  return html.slice(start, html.indexOf('</section>', start) + '</section>'.length);
};

// Every form control needs a name: an id a <label for> points at, an aria-label,
// or an enclosing <label>.
function unlabelledControls(html) {
  const labelled = new Set([...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((match) => match[1]));
  const missing = [];
  let depth = 0;
  for (const match of html.matchAll(/<(\/?)(label|input|select)\b([^>]*)>/g)) {
    const [, closing, tag, attributes] = match;
    if (tag === 'label') {
      depth += closing ? -1 : 1;
      continue;
    }
    if (closing || /type="hidden"/.test(attributes)) continue;
    const id = attributes.match(/\bid="([^"]+)"/)?.[1];
    if (depth > 0 || /aria-label="/.test(attributes) || (id && labelled.has(id))) continue;
    missing.push(`<${tag}${attributes}>`);
  }
  return missing;
}

// Walks the element tree a component returns, as tests/renderer-behavior.test.cjs does.
function elements(tree, predicate, found = []) {
  if (Array.isArray(tree)) {
    for (const node of tree) elements(node, predicate, found);
    return found;
  }
  if (!tree?.props) return found;
  if (predicate(tree)) found.push(tree);
  elements(tree.props.children, predicate, found);
  return found;
}

function captured(Component, props) {
  let tree;
  function Capture() {
    tree = Component(props);
    return null;
  }
  render(Capture, {});
  return tree;
}

test('matchesQuery ignores case, accents and word order and needs every word', () => {
  const { matchesQuery, normalizeSearchText } = sections;
  assert.equal(matchesQuery('Backup schedule', 'BACKUP'), true);
  assert.equal(matchesQuery('Backup schedule', 'schedule backup'), true);
  assert.equal(matchesQuery('Backup schedule', 'backup weekly'), false);
  assert.equal(matchesQuery('Café crème', 'cafe CREME'), true);
  assert.equal(matchesQuery('Fable 5’s shared pool', "fable 5's"), true);
  assert.equal(matchesQuery('anything', '   '), true);
  assert.equal(matchesQuery('', 'x'), false);
  assert.equal(normalizeSearchText('  Two\n  lines  '), 'two lines');
});

test('matchingSections uses rendered text, then titles and search keywords', () => {
  const { matchingSections, SETTINGS_SECTIONS } = sections;
  const matches = matchingSections({ storage: 'Backup schedule Daily Weekly', alerts: 'Digest time' }, 'digest');
  assert.deepEqual([...matches], ['alerts']);
  assert.deepEqual([...matchingSections({}, 'dark mode')], ['appearance'], 'keywords cover words a section never prints');
  assert.deepEqual([...matchingSections({}, 'advanced')], ['manual', 'diagnostics']);
  assert.deepEqual([...matchingSections({}, 'api pricing')], ['pricing']);
  assert.equal(matchingSections({}, 'no such setting anywhere').size, 0);
  assert.deepEqual(
    SETTINGS_SECTIONS.map((entry) => entry.title),
    ['Subscriptions', 'Sources', 'Forecast', 'Alerts', 'API pricing', 'Data & backups', 'Appearance & updates',
      'Manual observation', 'Diagnostics'],
  );
});

test('link targets resolve friendly and older names to section ids', () => {
  const { resolveSettingsTarget } = sections;
  assert.equal(resolveSettingsTarget('#schedule'), 'forecast');
  assert.equal(resolveSettingsTarget('fees'), 'subscription-fees');
  assert.equal(resolveSettingsTarget('subscription-fees'), 'subscription-fees');
  assert.equal(resolveSettingsTarget('backups'), 'storage');
  assert.equal(resolveSettingsTarget(null), '');
});

test('the Sources badge counts connected sources and names failing ones in words', () => {
  const { sourcesBadge } = sections;
  const of = (...statuses) => statuses.map((status) => ({ status }));
  assert.deepEqual(sourcesBadge(of('connected', 'observing', 'ready')), { tone: 'ok', label: '3 connected', connected: 3, attention: 0 });
  // A local Fable estimate or activity-only tracking is a working source too.
  assert.equal(sourcesBadge(of('connected', 'waiting', 'estimating')).label, '2 connected');
  assert.equal(sourcesBadge(of('connected', 'observing', 'activity-only')).label, '3 connected');
  assert.deepEqual(
    [...lib.HEALTHY_SOURCE_STATUSES].sort(),
    [...require('../electron/notifications.cjs').HEALTHY_SOURCE_STATUSES].sort(),
    'the renderer and notifications agree on which sources are healthy',
  );
  assert.deepEqual(sourcesBadge(of('pending', 'unavailable')), { tone: 'neutral', label: '0 connected', connected: 0, attention: 0 });
  assert.equal(sourcesBadge(of('connected', 'stale', 'observing')).label, '1 needs attention');
  const failing = sourcesBadge(of('error', 'degraded', 'connected'));
  assert.equal(failing.tone, 'warn');
  assert.equal(failing.label, '2 need attention');
});

test('the unpriced count lists each detected model once and skips priced ones', () => {
  const { unpricedModelCount } = sections;
  const snapshot = structuredClone(demoSnapshot);
  assert.equal(unpricedModelCount(snapshot), 1);
  snapshot.costs.unpricedModels = [
    { sourceId: 'codex', model: 'new-model', tokens: 1 },
    { sourceId: 'claude', model: 'NEW-MODEL', tokens: 1 },
    { sourceId: 'claude', model: snapshot.priceCatalog[0].model, tokens: 1 },
  ];
  assert.equal(unpricedModelCount(snapshot), 1);
  snapshot.costs.unpricedModels = [];
  assert.equal(unpricedModelCount(snapshot), 0);
});

test('the Settings page keeps one screen-reader heading, the tab panel and every section target', () => {
  const html = renderSettings(structuredClone(demoSnapshot));
  assert.match(html, /<main class="page settings-page" id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" tabindex="-1">/);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<h1 class="sr-only">Settings<\/h1>/);
  assert.match(text(html), /Everything stays on this PC/);
  assert.match(html, /<input type="search" aria-label="Search settings"[^>]*placeholder="Search settings"/);
  assert.match(html, /<nav class="settings-nav" aria-label="Settings sections">/);
  const hrefs = [...html.matchAll(/<a href="#([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(hrefs, sections.SETTINGS_SECTIONS.map((entry) => entry.id));
  for (const id of hrefs) {
    assert.match(html, new RegExp(`<section id="${id}" class="settings-section" aria-labelledby="${id}-heading">`));
    assert.match(html, new RegExp(`<h2 id="${id}-heading" tabindex="-1">`));
    assert.match(html, new RegExp(`data-settings-section="${id}"`));
  }
  assert.match(html, /<details class="settings-disclosure advanced-disclosure">[\s\S]*id="manual"[\s\S]*id="diagnostics"/);
  assert.ok(html.indexOf('<section id="pricing"') < html.indexOf('<details class="settings-disclosure'), 'pricing is not collapsed');
  assert.match(text(section(html, 'sources')), /Set up Claude/);
  assert.deepEqual(unlabelledControls(html), []);
});

test('pricing keeps the currency select and manual rate first for the currency flow', () => {
  const html = section(renderSettings(structuredClone(demoSnapshot)), 'pricing');
  assert.match(html.match(/<select[^>]*>[\s\S]*?<\/select>/)[0], /GBP · £[\s\S]*USD · \$[\s\S]*EUR · €/);
  assert.match(html.match(/<input[^>]*type="number"[^>]*>/)[0], /value="0.736"/);
});

test('navigation badges report connected sources, sources needing attention and unpriced models', () => {
  const snapshot = structuredClone(demoSnapshot);
  const nav = (html) => html.match(/<nav class="settings-nav"[\s\S]*?<\/nav>/)[0];
  let html = nav(renderSettings(snapshot));
  assert.match(html, /<a href="#sources"><span class="settings-nav-label">Sources<\/span><span class="settings-nav-status ok">/);
  assert.match(text(html), /Sources , 3 connected/);
  assert.match(html, /<span class="settings-nav-chip"><span class="sr-only">, <\/span>1 unpriced<\/span>/);
  snapshot.sources[1].status = 'stale';
  snapshot.sources[2].status = 'error';
  snapshot.costs.unpricedModels = [];
  html = nav(renderSettings(snapshot));
  assert.match(html, /settings-nav-status warn/);
  assert.match(text(html), /Sources , 2 need attention/);
  assert.doesNotMatch(html, /unpriced/);
});

test('monthly fees are back, shown per visible subscription, with the comparison note', () => {
  const snapshot = structuredClone(demoSnapshot);
  let html = section(renderSettings(snapshot), 'subscriptions');
  assert.match(html, /<div id="subscription-fees" class="setting-group" role="group"/);
  assert.match(text(html), /Codex subscription \(USD per month\)/);
  assert.match(text(html), /Claude subscription \(USD per month\)/);
  assert.match(
    text(html),
    /With a monthly fee set, the Overview compares the period’s API-equivalent value with the fees for the same number of days\. Leave a fee at zero to hide the comparison\. Fees are compared, never charged\./,
  );
  const fee = html.match(/<input[^>]*min="0" max="100000" step="1"[^>]*>/g);
  assert.equal(fee.length, 2);
  assert.match(fee[0], /value="200"/);
  snapshot.settings.showClaudeSubscription = false;
  html = section(renderSettings(snapshot), 'subscriptions');
  assert.match(text(html), /Codex subscription \(USD per month\)/);
  assert.doesNotMatch(text(html), /Claude subscription \(USD per month\)/);
  snapshot.settings.showCodexSubscription = false;
  html = section(renderSettings(snapshot), 'subscriptions');
  assert.doesNotMatch(html, /subscription-fees|USD per month/);
});

test('fee inputs commit the monthly fee settings with the stated limits', async () => {
  const patches = [];
  const tree = captured(SubscriptionsSection, {
    snapshot: structuredClone(demoSnapshot),
    update: async (patch) => { patches.push(patch); },
  });
  const numeric = elements(tree, (node) => node.type === fields.NumericSetting);
  assert.deepEqual(
    numeric.map(({ props }) => [props.label, props.min, props.max, props.step]),
    [
      ['Codex subscription (USD per month)', 0, 100_000, 1],
      ['Claude subscription (USD per month)', 0, 100_000, 1],
      ['Free resets available', 0, 10, 1],
    ],
  );
  await numeric[0].props.onCommit(20);
  await numeric[1].props.onCommit(100);
  // Recording none also clears the expiry, so a stale date cannot linger.
  await numeric[2].props.onCommit(0);
  await numeric[2].props.onCommit(2);
  assert.deepEqual(patches, [
    { codexPlanUsdPerMonth: 20 },
    { claudePlanUsdPerMonth: 100 },
    { claudeFreeResets: 0, claudeFreeResetsExpireOn: null },
    { claudeFreeResets: 2 },
  ]);
});

test('the free-reset expiry saves whole days and an emptied field, and skips a date still being typed', async () => {
  const patches = [];
  const snapshot = structuredClone(demoSnapshot);
  snapshot.settings.claudeFreeResets = 1;
  const tree = captured(SubscriptionsSection, { snapshot, update: async (patch) => { patches.push(patch); } });
  const [expiry] = elements(tree, (node) => typeof node.type === 'function' && node.type.name === 'FreeResetExpiry');
  assert.equal(expiry.props.disabled, false);
  const field = (value, predicate) => elements(captured(expiry.type, { ...expiry.props, value }), predicate)[0];
  const isDate = (node) => node.type === 'input' && node.props.type === 'date';
  const type = (saved, ...values) => {
    const input = field(saved, isDate);
    for (const value of values) input.props.onChange({ target: { value } });
  };
  assert.deepEqual(
    (({ min, max, value }) => ({ min, max, value }))(field('2026-10-22', isDate).props),
    { min: '2020-01-01', max: '2100-12-31', value: '2026-10-22' },
  );
  // A date input reports '' while a date is incomplete, and years such as 0002
  // while one is typed digit by digit; the store would reject those and 30 February.
  type(null, '', '0002-10-22', '0202-10-22', '2026-02-30', '2026-10-22');
  // Emptying a saved date clears it, as Clear does; picking the saved day again saves nothing.
  type('2026-10-22', '2026-10-22', '');
  assert.equal(field(null, (node) => node.type === 'button'), undefined, 'Clear only appears once a date is saved');
  field('2026-10-22', (node) => node.type === 'button').props.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(patches, [
    { claudeFreeResetsExpireOn: '2026-10-22' },
    { claudeFreeResetsExpireOn: null },
    { claudeFreeResetsExpireOn: null },
  ]);
});

test('switches expose their state as a switch and in words', () => {
  const html = section(renderSettings(structuredClone(demoSnapshot)), 'alerts');
  assert.match(html, /<input type="checkbox" role="switch" aria-checked="true" aria-label="Risk notifications"/);
  assert.match(html, /<input type="checkbox" role="switch" aria-checked="false" aria-label="Daily digest"/);
  assert.match(text(html), /Daily digest One summary a day with every allowance and the earliest run-out\. Off/);
});

test('the reserve preview shows each visible provider’s daily budget and omits those without one', () => {
  const snapshot = structuredClone(demoSnapshot);
  const nowMs = Date.parse(snapshot.generatedAt);
  const expected = [['codex', 'Codex'], ['claude', 'Claude'], ['fable', 'Fable']].flatMap(([id, name]) => {
    const current = lib.primaryWindow(snapshot.quotas[id]);
    const value = budget.dailyBudget(current, snapshot.settings, nowMs, snapshot.settings.reservePercent);
    return value ? [{ id, name, label: budget.paceLabel(value.budget) }] : [];
  });
  assert.ok(expected.length > 0, 'the demo has budgets to preview');
  const entries = preview.budgetPreview(snapshot, snapshot.settings.reservePercent);
  assert.deepEqual(entries.map(({ id, name, label }) => ({ id, name, label })), expected);
  const html = section(renderSettings(snapshot), 'forecast');
  const line = text(html.match(/<span class="budget-preview"[\s\S]*?per active day<\/span><\/span>/)[0]);
  assert.equal(line, `Daily budgets now: ${expected.map((entry) => `${entry.name} ${entry.label}`).join(' · ')} per active day`);
  for (const entry of expected) assert.match(html, new RegExp(`<span class="swatch ${entry.id}" aria-hidden="true"></span>`));

  // A larger reserve leaves less to spend per day.
  const reserved = preview.budgetPreview(snapshot, 40);
  assert.ok(reserved.every((entry, index) => entry.budget < entries[index].budget));

  // Provider views are cached per snapshot object, as each snapshot arrives whole.
  const codexOnly = { ...snapshot, settings: { ...snapshot.settings, showClaudeSubscription: false } };
  assert.deepEqual(preview.budgetPreview(codexOnly).map((entry) => entry.id), ['codex']);
  const expired = structuredClone(demoSnapshot);
  for (const entry of [expired.quotas.codex, ...expired.quotas.codex.windows]) entry.forecast.expired = true;
  assert.ok(!preview.budgetPreview(expired).some((entry) => entry.id === 'codex'));
  const learning = structuredClone(demoSnapshot);
  for (const quota of Object.values(learning.quotas)) {
    for (const entry of [quota, ...quota.windows]) entry.forecast.expectedRemaining = null;
  }
  assert.match(text(section(renderSettings(learning), 'forecast')), /Daily budgets appear here once a forecast has learned enough/);
});

test('the reserve field previews its draft before saving', async () => {
  const patches = [];
  const tree = captured(ForecastSection, {
    snapshot: structuredClone(demoSnapshot),
    update: async (patch) => { patches.push(patch); },
  });
  const [reserve] = elements(tree, (node) => node.type === fields.NumericSetting && node.props.label === 'Keep in reserve');
  assert.equal(typeof reserve.props.onDraftChange, 'function');
  assert.deepEqual([reserve.props.min, reserve.props.max, reserve.props.integer], [0, 50, true]);
  // A fraction is invalid while typed rather than rounded on save, so the
  // field never shows a value that was not saved.
  await reserve.props.onCommit(12);
  assert.deepEqual(patches, [{ reservePercent: 12 }]);
});

test('whole-number settings reject a fraction instead of rounding or failing to save it', () => {
  const snapshot = structuredClone(demoSnapshot);
  const numeric = (Component) => elements(captured(Component, { snapshot, update: noop, actions }), (node) => node.type === fields.NumericSetting);
  const integers = [...numeric(SubscriptionsSection), ...numeric(ForecastSection)]
    .filter((node) => node.props.integer).map((node) => node.props.label);
  assert.deepEqual(integers, ['Free resets available', 'Keep in reserve']);
  const html = render(fields.NumericSetting, { label: 'Backup sets kept', value: 30, min: 1, max: 365, step: 1, integer: true, onCommit: noop });
  assert.doesNotMatch(html, /aria-invalid/);
});

test('the pricing list and its count share one set of priceable models', () => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.costs.unpricedModels = [
    { sourceId: 'codex', model: 'new-model', tokens: 1 },
    // Records without a model name: no price could ever apply to them.
    { sourceId: 'codex', model: 'Unknown', tokens: 5, unnamed: true },
  ];
  snapshot.desktopEstimates = { ...snapshot.desktopEstimates, byModel: [
    { model: 'claude-desktop-only', estimatedCost: null },
    { model: 'NEW-MODEL', estimatedCost: null },
    { model: 'claude-priced', estimatedCost: 1 },
  ] };
  assert.deepEqual(sections.unpricedModels(snapshot), [
    { model: 'new-model', sourceId: 'codex' },
    { model: 'claude-desktop-only', sourceId: 'Claude desktop/web export' },
  ]);
  assert.equal(sections.unpricedModelCount(snapshot), 2);
  const pricing = text(section(renderSettings(snapshot), 'pricing'));
  assert.match(pricing, /claude-desktop-only/);
  assert.doesNotMatch(pricing, /\bUnknown\b/);
});

test('a local calendar day is not the UTC day', () => {
  // 00:30 on 30 September in London is still 29 September in UTC.
  assert.equal(lib.localDateKey(new Date('2026-09-29T23:30:00Z')), '2026-09-30');
});
