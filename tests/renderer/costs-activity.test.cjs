'use strict';
require('../setup.cjs');

// Costs and Activity page behaviour, rendered through Vite's SSR loader like
// renderer-behavior.test.cjs. Only these pages and their dependencies load,
// so a change elsewhere in the renderer cannot mask these results.
const assert = require('node:assert/strict');
const test = require('node:test');
const { render, text } = require('../helpers/markup.cjs');
const { startRendererServer } = require('../helpers/renderer-server.cjs');
const { readRepoFile } = require('../helpers/repo.cjs');

let server;
let demoSnapshot;
let Costs;
let Activity;
let CycleHistory;
let DesktopEstimates;
let API_EQUIVALENT_EXPLAINER;
let lib;

test.before(async () => {
  server = await startRendererServer();
  [
    { demoSnapshot },
    { Costs },
    { Activity },
    { CycleHistory },
    { DesktopEstimates },
    { API_EQUIVALENT_EXPLAINER },
    lib,
  ] = await Promise.all([
    server.ssrLoadModule('/src/data/demo.ts'),
    server.ssrLoadModule('/src/components/Costs.tsx'),
    server.ssrLoadModule('/src/components/Activity.tsx'),
    server.ssrLoadModule('/src/components/details/CycleHistory.tsx'),
    server.ssrLoadModule('/src/components/DesktopEstimates.tsx'),
    server.ssrLoadModule('/src/components/InfoTip.tsx'),
    server.ssrLoadModule('/src/lib.ts'),
  ]);
});

test.after(async () => {
  await server?.close();
});

const costsPage = (snapshot) =>
  render(Costs, {
    snapshot,
    days: snapshot.costs.periodDays,
    onDays() {},
    query: '',
    onQuery() {},
    onSnapshot() {},
  });
const section = (html, className) => html.match(new RegExp(`<section class="${className}"[\\s\\S]*?</section>`))?.[0];
// Costs disclosures are the Deck .disclosure primitive now (was caveat-disclosure).
const disclosure = (html, className) =>
  html.match(new RegExp(`<details class="disclosure ${className}">[\\s\\S]*?</details>`))?.[0];
const minutesBefore = (iso, minutes) => new Date(Date.parse(iso) - minutes * 60_000).toISOString();

function headings(html) {
  const h1 = [...html.matchAll(/<h1>([\s\S]*?)<\/h1>/g)].map((match) => text(match[1]));
  const lead = html.match(/<\/h1><p>([\s\S]*?)<\/p>/)?.[1];
  return { h1, lead: lead && text(lead) };
}

test('every cost-by-model category cell names its unit, and output adds its reasoning share', () => {
  const html = costsPage(structuredClone(demoSnapshot));
  const table = html.match(/<table class="costs-table model-table">[\s\S]*?<\/table>/)?.[0];
  assert.ok(table, 'the cost-by-model table renders');
  const rows = table.match(/<tbody>[\s\S]*<\/tbody>/)[0].match(/<tr[\s\S]*?<\/tr>/g) ?? [];
  assert.ok(rows.length, 'the demo has model rows');
  for (const row of rows) {
    const cells = (row.match(/<td class="num">[\s\S]*?<\/td>/g) ?? []).slice(0, 5).map((cell) => cell.match(/<small>([\s\S]*?)<\/small>/)?.[1]);
    assert.equal(cells.length, 5);
    for (const note of cells.slice(0, 4)) assert.match(note, /^\S+ tokens$/);
    assert.match(cells[4], /^\S+ tokens · \S+ reasoning$/);
  }
});

test('Costs leads with one sentence and keeps the full scope text in a closed disclosure', () => {
  const html = costsPage(structuredClone(demoSnapshot));
  const { h1, lead } = headings(html);
  assert.deepEqual(h1, ['API-equivalent costs'], 'exactly one page heading');
  assert.equal(lead, 'Tracked Codex and Claude Code tokens, repriced at current API rates. Not an invoice.');
  assert.doesNotMatch(lead, /API-equivalent|costs/i, 'the description does not repeat the heading');
  assert.doesNotMatch(html, /Which usage is included\?/);

  const scope = disclosure(html, 'lead-disclosure');
  assert.ok(scope, 'the scope caveats sit in a disclosure, closed by default');
  assert.match(scope, /<summary>[\s\S]*What’s included and what isn’t<\/summary>/);
  assert.ok(html.indexOf(scope) < html.indexOf('class="cost-summary"'), 'the numbers follow the one-line summary');
  for (const sentence of [
    'Costs include models found in local Codex and Claude Code token records, including Opus, Sonnet, and Haiku.',
    'Their usage can also count toward the account allowance shown on Overview.',
    'Price coverage measures the recorded tokens we can price. Even 100% does not mean every chat on your account was captured. Adding a model price does not import missing activity.',
    API_EQUIVALENT_EXPLAINER,
  ])
    assert.ok(text(scope).includes(sentence), `kept verbatim: ${sentence.slice(0, 40)}…`);
  assert.match(scope, /<a href="#desktop-estimates">separate text estimates below<\/a>/);
  assert.match(html, /id="desktop-estimates"/, 'the link target is on the page');

  // Controls the Electron DOM test drives are unchanged.
  assert.equal(
    // The period keys are also the Deck segmented keys (.seg).
    (html.match(/<div class="seg period-switch"[\s\S]*?<\/div>/)?.[0].match(/aria-pressed="true"/g) || []).length,
    1,
  );
  assert.match(html, /<label class="table-search">[\s\S]*?<input type="search"/);
  assert.match(html, /<section class="panel task-panel" aria-busy="true"/);
});

test('lower-bound cost figures keep the ≥ floor and say what is excluded; complete figures do not', () => {
  const partial = structuredClone(demoSnapshot);
  assert.equal(partial.costs.isLowerBound, true, 'the demo carries an unpriced model');
  const html = costsPage(partial);
  const summary = section(html, 'cost-summary');
  const money = (value) => lib.money(value, partial.costs.currency);
  assert.match(summary, new RegExp(`<strong>≥ ${literal(money(partial.costs.actual))}</strong>`));
  assert.match(text(summary), /Lower bound; excludes Codex preview-unpriced-model \(11\.5m tokens\)/);
  assert.match(text(summary), new RegExp(`Cache discount ≥ ${literal(money(partial.costs.cacheSavings))}`));
  assert.match(text(summary), /Last 7 days ≥ /);
  assert.match(text(summary), /Some recorded models are unpriced/);
  const savings = html.match(/<div class="saving-bars">[\s\S]*?<\/article>/)?.[0];
  assert.match(text(savings), new RegExp(`With cache ≥ ${literal(money(partial.costs.actual))}`));
  assert.match(text(savings), /Without cache ≥ /);

  const complete = structuredClone(demoSnapshot);
  Object.assign(complete.costs, { isLowerBound: false, isComplete: true, coverage: 1, unpricedModels: [] });
  const full = costsPage(complete);
  assert.doesNotMatch(text(section(full, 'cost-summary')), /≥|Lower bound/);
  assert.match(text(section(full, 'cost-summary')), /tracked usage updates/);
  assert.doesNotMatch(text(full.match(/<div class="saving-bars">[\s\S]*?<\/article>/)[0]), /≥/);

  const css = readRepoFile('src/styles/pages/costs-activity-shared.css');
  assert.match(
    css,
    /\.cost-summary,[\s\S]*?\{\s*font-variant-numeric: tabular-nums;/,
    'KPI notes use tabular numerals too',
  );
});

test('task grouping and chat-import caveats move behind disclosures without losing text', () => {
  const html = costsPage(structuredClone(demoSnapshot));
  const grouping = disclosure(html, 'task-grouping');
  assert.ok(grouping);
  assert.match(grouping, /How tasks are grouped/);
  assert.ok(
    text(grouping).includes(
      'Task IDs are used when recorded; otherwise usage is grouped by session. ' +
        'Unlinked usage stays separate. Activity spans measure first to last recorded usage, including idle time—not execution time.',
    ),
  );
  assert.doesNotMatch(html, /<p class="task-guidance">Task IDs/);

  const snapshot = structuredClone(demoSnapshot);
  const chats = render(DesktopEstimates, { snapshot, onSnapshot() {} });
  assert.match(
    text(chats),
    /Import conversations\.json from a Claude data export\. Processing stays on this PC; conversation text and titles are never saved by AI Usage\. How to export/,
    'the privacy promise stays visible beside the import button',
  );
  // The plain Deck disclosure (was caveat-disclosure): still exactly two, with no modifier class.
  const details = [...chats.matchAll(/<details class="disclosure">[\s\S]*?<\/details>/g)].map((match) =>
    text(match[0]),
  );
  assert.equal(details.length, 2);
  assert.match(
    details[0],
    /^How to export your chats In Claude, open Settings → Privacy → Export data\. Download and extract the ZIP, then choose conversations\.json here\./,
  );
  assert.match(details[0], /Desktop and web chats cannot be distinguished in the export\./);
  assert.match(details[1], /^How the estimate works We divide the character count/);
  assert.match(
    details[1],
    /Named models without prices can be priced in Settings → API pricing\./,
  );
  assert.doesNotMatch(chats, /<h1/);
});

test('Activity shows each observation age relative to the snapshot with the exact instant beside it', () => {
  const snapshot = structuredClone(demoSnapshot);
  const nowMs = Date.parse(snapshot.generatedAt);
  const fresh = minutesBefore(snapshot.generatedAt, 4);
  const old = minutesBefore(snapshot.generatedAt, 3 * 24 * 60);
  for (const [id, observedAt] of [
    ['codex', fresh],
    ['claude', old],
  ]) {
    const quota = snapshot.quotas[id];
    quota.observedAt = observedAt;
    for (const window of quota.windows) window.observedAt = observedAt;
  }
  snapshot.sources.find((source) => source.id === 'codex').last_success_at = minutesBefore(snapshot.generatedAt, 2);
  const html = render(Activity, { snapshot, days: snapshot.costs.periodDays });
  const { h1, lead } = headings(html);
  assert.deepEqual(h1, ['Activity and evidence']);
  assert.doesNotMatch(lead, /activity|evidence/i);

  const rows = html
    .match(/<table class="evidence-table">[\s\S]*?<\/table>/)[0]
    .match(/<tr>[\s\S]*?<\/tr>/g)
    .slice(1);
  const cell = (row) => row.match(/<td class="evidence-time">([\s\S]*?)<\/td>/)[1];
  const codex = cell(rows[0]);
  assert.match(
    codex,
    new RegExp(`^<time dateTime="${fresh}" title="${literal(lib.dateTimeLabel(fresh))}">4 min ago</time>`),
  );
  assert.match(
    codex,
    new RegExp(`<small>${literal(lib.dateTimeLabel(fresh))}</small>`),
    'the exact instant is visible, not only on hover',
  );
  assert.match(text(codex), /Source succeeded 2 min ago/);
  assert.equal(lib.relativeTime(fresh, nowMs), '4 min ago');

  const claude = cell(rows[1]);
  assert.match(
    claude,
    new RegExp(
      `<time dateTime="${old}" title="${literal(lib.dateTimeLabel(old))}">${literal(lib.shortDate(old))}</time>`,
    ),
  );
  assert.doesNotMatch(
    claude,
    new RegExp(`<small>${literal(lib.dateTimeLabel(old))}</small>`),
    'a dated label is not repeated',
  );
  assert.match(text(rows[0]), /Current/);
});

test('an expired window still reads Needs reading with its last value withheld', () => {
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
  snapshot.sources.find((source) => source.id === 'codex').status = 'connected';
  const html = render(Activity, { snapshot, days: snapshot.costs.periodDays });
  const row = html
    .match(/<table class="evidence-table">[\s\S]*?<\/table>/)?.[0]
    .match(/<tbody><tr>[\s\S]*?<\/tr>/)?.[0];
  assert.ok(row);
  assert.match(text(row), /Needs reading/);
  assert.match(text(row), /— Window expired/);
  assert.match(row, /<time dateTime=/);
  assert.doesNotMatch(text(row), /Current|73%/);
});

test('reset-cycle bars carry the provider colour, mark the open window and describe every value', () => {
  const current = {
    ...demoSnapshot.cycles.codex[0],
    current: true,
    peakUsedPercent: 22,
    resetsAt: '2026-09-16T12:00:00Z',
    endsAt: '2026-09-16T12:00:00Z',
  };
  const ended = {
    ...current,
    current: false,
    peakUsedPercent: 91,
    resetsAt: '2026-09-14T12:00:00Z',
    endsAt: '2026-09-09T12:00:00Z',
  };
  const fable = demoSnapshot.cycles.fable.map((row, index) => ({ ...row, current: index === 0 }));
  const html = render(CycleHistory, { cycles: { codex: [current, ended], claude: [], fable }, currency: 'GBP' });

  // Existing semantics: one current row per provider, the early end date and its label.
  assert.equal((html.match(/<tr class="current">/g) || []).length, 2);
  const codexCard = text(html.match(/<article class="cycle-card">[\s\S]*?<\/article>/)[0]);
  assert.match(codexCard, /^Codex/);
  assert.match(codexCard, /Reset early/);
  assert.ok(codexCard.includes(lib.dayDate(ended.endsAt)));
  assert.ok(!codexCard.includes(lib.dayDate(ended.resetsAt)));

  const bars = html.match(/<div class="cycle-bars codex"[\s\S]*?(?=<div class="table-scroll">)/)?.[0];
  assert.ok(bars, 'codex bars are keyed to the provider');
  assert.match(html, /<div class="cycle-bars fable"/);
  assert.doesNotMatch(html, /cycle-bars claude/, 'a provider without history has no chart');
  assert.equal((bars.match(/class="cycle-bar current"/g) || []).length, 1);
  assert.match(bars, /<span class="cycle-limit" aria-hidden="true"><span>100%<\/span><\/span>/);
  const label = bars.match(/aria-label="([^"]+)"/)[1];
  assert.equal(
    label,
    `Codex peak allowance used per reset cycle, oldest first: ${lib.dayDate(ended.endsAt)}: 91% used; ` +
      `${lib.dayDate(current.resetsAt)}: 22% used (current).`,
  );
  assert.match(bars, /role="img"/);

  const css = readRepoFile('src/styles/pages/costs-activity-shared.css');
  for (const provider of ['codex', 'claude', 'fable'])
    assert.match(css, new RegExp(`\\.cycle-bars\\.${provider} \\{\\s*--series: var\\(--${provider}\\);`));
  const cycleRules = css.slice(css.indexOf('/* Reset cycles'));
  const barRules = cycleRules.slice(0, cycleRules.indexOf('@media')).match(/\.cycle-bar[^{]*\{[^}]*\}/g) ?? [];
  assert.ok(barRules.length >= 2, 'the shared stylesheet paints the past and the open bars');
  for (const rule of barRules)
    for (const fill of rule.match(/background[^;]*;/g) ?? [])
      assert.match(fill, /var\(--series\)/, 'bars take the provider colour, never chrome or status');
  // The flight-log layout is in a later layer than the shared stylesheet, so it must not repaint the bars (forced-colors excepted).
  const layout = readRepoFile('src/styles/pages/activity.css');
  for (const rule of layout.slice(0, layout.indexOf('@media (forced-colors')).match(/\.cycle-bar[^{]*\{[^}]*\}/g) ?? [])
    assert.doesNotMatch(rule, /background/, 'the cycle layout does not override the provider fill');
});

function literal(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('the cache saving bars keep their proportion for small totals, and an empty period has no coverage', () => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.costs = { ...snapshot.costs, actual: 0.05, withoutCache: 0.2 };
  assert.match(costsPage(snapshot), /class="with-cache"[\s\S]*?--fill:25%/);
  snapshot.costs = { ...snapshot.costs, actual: 0, withoutCache: 0, totalTokens: 0, coverage: 0, isLowerBound: false, unpricedModels: [] };
  const empty = costsPage(snapshot);
  assert.match(empty, /class="with-cache"[\s\S]*?--fill:2%/);
  assert.match(text(empty), /Recorded token price coverage — No usage in this period/);
});
