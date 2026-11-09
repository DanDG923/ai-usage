'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const forecastEngine = require('../../electron/forecast.cjs');
const { niceScale } = require('../../src/chart-scale.ts');

let server;
let demoSnapshot;
let budget;
let lib;
let header;
let ProviderDetail;
let providerViews;

test.before(async () => {
  const [{ createServer }, { default: react }] = await Promise.all([import('vite'), import('@vitejs/plugin-react')]);
  server = await createServer({
    root: path.resolve(__dirname, '..', '..'), configFile: false, plugins: [react()],
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  });
  [{ demoSnapshot }, budget, lib, header, { ProviderDetail }, { providerViews }] = await Promise.all([
    server.ssrLoadModule('/src/data/demo.ts'),
    server.ssrLoadModule('/src/budget.ts'),
    server.ssrLoadModule('/src/lib.ts'),
    server.ssrLoadModule('/src/components/Header.tsx'),
    server.ssrLoadModule('/src/components/ProviderDetail.tsx'),
    server.ssrLoadModule('/src/provider-view.ts'),
  ]);
});

test.after(async () => { await server?.close(); });

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const HOUR = 3_600_000;

test('the renderer counts active hours exactly as the forecast engine does, across a clock change', () => {
  const schedules = [
    { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 8, endHour: 22 },
    { activeDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17.5 },
  ];
  // 24 Oct 2026 12:00 local runs over the Europe/London change back to GMT.
  const ranges = [
    [new Date(2026, 8, 23, 19, 59).getTime(), new Date(2026, 8, 28, 7, 59).getTime()],
    [new Date(2026, 9, 24, 12, 0).getTime(), new Date(2026, 9, 27, 9, 30).getTime()],
    [new Date(2026, 8, 23, 23, 0).getTime(), new Date(2026, 8, 23, 23, 30).getTime()],
  ];
  for (const schedule of schedules) {
    for (const [from, to] of ranges) {
      assert.equal(budget.activeHoursBetween(from, to, schedule), forecastEngine.activeHoursBetween(from, to, schedule));
    }
  }
});

function window({ remaining = 60, expected = 30, heavy = 10, hoursLeft = 28, reserve = 0, heavyExhaustsAt = null,
  exhaustsAt = null, state = 'safe', expired = false, nowMs }) {
  return {
    bucketId: 'weekly', bucketName: 'Weekly', observedAt: new Date(nowMs).toISOString(), usedPercent: 100 - remaining,
    remainingPercent: remaining, resetsAt: new Date(nowMs + 3 * 24 * HOUR).toISOString(), windowMinutes: 10_080,
    planType: null, provenance: 'official', metadata: {},
    forecast: { state, expired, expectedRemaining: expected, heavyRemaining: heavy, activeHoursLeft: hoursLeft,
      reservePercent: reserve, heavyExhaustsAt, exhaustsAt, series: { observed: [], expected: [], heavy: [] } },
  };
}
const settings = { activeDays: [0, 1, 2, 3, 4, 5, 6], activeStartHour: 8, activeEndHour: 22, reservePercent: 0 };

test('the daily budget, both paces and the chart endpoints always agree', () => {
  const nowMs = new Date(2026, 8, 23, 12, 0).getTime();
  const plain = budget.dailyBudget(window({ nowMs }), settings, nowMs);
  // 28 active hours at 14 a day is two active days.
  assert.equal(plain.budget, 30);
  assert.equal(plain.expected, 15);
  assert.equal(plain.heavier, 25);
  assert.equal(plain.expectedFits, true);
  assert.equal(plain.heavierFits, true);
  const reserved = budget.dailyBudget(window({ nowMs, reserve: 20 }), settings, nowMs);
  assert.equal(reserved.budget, 20);
  assert.equal(reserved.expectedFits, true, 'expected keeps 30%, above the 20% reserve');
  assert.equal(reserved.heavierFits, false, 'heavier keeps 10%, below the reserve');
  assert.ok(reserved.heavier > reserved.budget);
  const override = budget.dailyBudget(window({ nowMs, reserve: 20 }), settings, nowMs, 40);
  assert.equal(override.reserve, 40);
  assert.equal(override.expectedFits, false);
  assert.ok(override.scaleMax >= Math.max(override.budget, override.expected, override.heavier));
});

test('after a stale reading the Now dot shows the estimated balance, where the expected path starts', async () => {
  const { RunwayChart } = await server.ssrLoadModule('/src/components/Charts.tsx');
  const nowMs = new Date(2026, 8, 23, 12, 0).getTime();
  // The last reading, three hours old, was 60%; the engine estimates 52% now.
  const current = window({ remaining: 60, nowMs: nowMs - 3 * HOUR });
  current.forecast = {
    ...current.forecast, currentIsEstimated: true, estimatedCurrentRemaining: 52,
    series: {
      observed: [{ at: nowMs - 30 * HOUR, remaining: 80 }, { at: nowMs - 3 * HOUR, remaining: 60 }],
      expected: [{ at: nowMs, remaining: 52 }, { at: nowMs + 60 * HOUR, remaining: 30 }],
      heavy: [{ at: nowMs, remaining: 52 }, { at: nowMs + 60 * HOUR, remaining: 10 }],
    },
  };
  const view = {
    id: 'codex', name: 'Codex', current, expired: false, state: 'safe',
    remaining: lib.displayedRemaining(current), expectedRemaining: 30, heavyRemaining: 10,
  };
  const html = render(RunwayChart, { view, schedule: { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 8, endHour: 22 } });
  const dotY = Number(html.match(/<circle class="runway-now"[^>]*cy="([\d.]+)"/)[1]);
  const pathStartY = Number(html.match(/<path d="M[\d.]+,([\d.]+)[^"]*" class="runway-expected"/)[1]);
  // Compact Flight Deck runway at the SSR width (360): 180 high, 22 on top for
  // the NOW / RESET captions and 26 below for the day labels.
  const y = (remaining) => 22 + (1 - remaining / 100) * (180 - 22 - 26);
  assert.ok(Math.abs(dotY - pathStartY) < 0.1, `dot ${dotY} vs expected path ${pathStartY}`);
  assert.ok(Math.abs(dotY - y(52)) < 0.1, `dot ${dotY} is at 52%, not the stale 60% (${y(60)})`);
});

test('a heavier run-out is paced over the hours before it, and learning or expired windows have no budget', () => {
  const nowMs = new Date(2026, 8, 23, 12, 0).getTime();
  // Runs out at 19:00 tomorrow: 10 active hours today and 11 tomorrow.
  const exhaust = new Date(2026, 8, 24, 19, 0).toISOString();
  const result = budget.dailyBudget(window({ nowMs, heavy: 0, heavyExhaustsAt: exhaust }), settings, nowMs);
  assert.equal(result.heavierFits, false);
  assert.ok(Math.abs(result.heavier - (60 / 21) * 14) < 1e-9);
  assert.equal(budget.dailyBudget(window({ nowMs, state: 'unknown' }), settings, nowMs), null);
  assert.equal(budget.dailyBudget(window({ nowMs, expired: true }), settings, nowMs), null);
  assert.equal(budget.dailyBudget(window({ nowMs, expected: null }), settings, nowMs), null);
  assert.equal(budget.dailyBudget(window({ nowMs, hoursLeft: 0.2 }), { ...settings, activeStartHour: 8, activeEndHour: 8 }, nowMs), null);
  assert.equal(budget.paceLabel(17.37), '17.4%');
  // Per-day figures need whole days: a five-hour session or the last active day gets none.
  const session = window({ nowMs, hoursLeft: 3 });
  session.windowMinutes = 300;
  assert.equal(budget.dailyBudget(session, settings, nowMs), null);
  assert.equal(budget.dailyBudget(window({ nowMs, hoursLeft: 10 }), settings, nowMs), null);
  assert.ok(budget.dailyBudget(window({ nowMs, hoursLeft: 14 }), settings, nowMs));
  assert.equal(budget.paceLabel(22.9), '23%');
});

test('inactive ranges cover exactly the hours outside the schedule', () => {
  const schedule = { activeDays: [0, 1, 2, 3, 4, 5, 6], startHour: 8, endHour: 22 };
  const from = new Date(2026, 8, 23, 20, 0).getTime();
  const to = new Date(2026, 8, 24, 10, 0).getTime();
  const ranges = budget.inactiveRanges(from, to, schedule);
  assert.deepEqual(ranges, [{ from: new Date(2026, 8, 23, 22, 0).getTime(), to: new Date(2026, 8, 24, 8, 0).getTime() }]);
});

test('chart axes use round steps that cover the peak', () => {
  assert.deepEqual(niceScale(60.23).ticks, [0, 20, 40, 60, 80]);
  assert.deepEqual(niceScale(3_200_000).ticks, [0, 1_000_000, 2_000_000, 3_000_000, 4_000_000]);
  assert.deepEqual(niceScale(0).ticks, [0, 0.25, 0.5, 0.75, 1]);
  for (const peak of [0.07, 1, 7.3, 14.99, 45, 101, 998, 12_345]) {
    const { max, step, ticks } = niceScale(peak);
    assert.ok(max >= peak, `${peak} fits under ${max}`);
    assert.ok(ticks.length >= 2 && ticks.length <= 6, `${peak}: ${ticks}`);
    assert.ok(ticks.every((tick, index) => Math.abs(tick - index * step) < 1e-9));
  }
});

test('freshness reads as a relative time and source health names what needs attention', () => {
  const now = Date.parse('2026-09-23T19:59:00Z');
  assert.equal(lib.relativeTime('2026-09-23T19:58:40Z', now), 'just now');
  assert.equal(lib.relativeTime('2026-09-23T19:55:00Z', now), '4 min ago');
  assert.equal(lib.relativeTime('2026-09-23T17:00:00Z', now), '2 h ago');
  assert.equal(lib.relativeTime(null, now), 'never');
  const snapshot = structuredClone(demoSnapshot);
  // "Updated" is the last successful collection, not when the snapshot was built.
  const collected = Date.parse('2026-09-23T19:40:00Z');
  for (const source of snapshot.sources) source.last_success_at = new Date(collected - 600_000).toISOString();
  snapshot.sources.find((source) => source.id === 'claude').last_success_at = new Date(collected).toISOString();
  snapshot.generatedAt = new Date(collected + 3 * HOUR).toISOString();
  assert.equal(header.lastCollectedAt(snapshot), collected);
  snapshot.settings.showClaudeSubscription = false;
  assert.equal(header.lastCollectedAt(snapshot), collected - 600_000, 'hidden subscriptions do not count');
  snapshot.settings.showCodexSubscription = false;
  assert.equal(header.lastCollectedAt(snapshot), null);
  // A restored setting can hold any number of minutes, not just the menu's whole hours.
  assert.deepEqual([0, 15, 60, 100, 240].map(header.refreshCadence),
    ['manual refresh', 'auto every 15 min', 'auto every hour', 'auto every 100 min', 'auto every 4 hours']);
  snapshot.settings.showClaudeSubscription = true;
  snapshot.settings.showCodexSubscription = true;
  assert.deepEqual(header.sourceHealth(snapshot), { tone: 'safe', text: '3 sources current' });
  // A successful refresh without an official allowance is still healthy.
  const status = (id, value) => { snapshot.sources.find((source) => source.id === id).status = value; };
  for (const [codex, claude, fable] of [['observing', 'ready', 'estimating'], ['connected', 'observing', 'activity-only']]) {
    status('codex', codex); status('claude', claude); status('claude-fable', fable);
    assert.deepEqual(header.sourceHealth(snapshot), { tone: 'safe', text: '3 sources current' }, `${codex}, ${claude}, ${fable}`);
  }
  status('claude', 'awaiting-installation');
  assert.deepEqual(header.sourceHealth(snapshot), { tone: 'unknown', text: '2 of 3 sources connected' });
  status('claude', 'connected');
  snapshot.sources.find((source) => source.id === 'codex').status = 'stale';
  assert.deepEqual(header.sourceHealth(snapshot), { tone: 'watch', text: 'Codex needs a refresh' });
  snapshot.sources.find((source) => source.id === 'claude').status = 'error';
  assert.deepEqual(header.sourceHealth(snapshot), { tone: 'critical', text: 'Claude unavailable' });
  snapshot.settings.showClaudeSubscription = false;
  assert.deepEqual(header.sourceHealth(snapshot), { tone: 'watch', text: 'Codex needs a refresh' }, 'hidden subscriptions are not reported');
});

test('source health does not call a connected source current once its allowance reading ages past the freshness limit', () => {
  const snapshot = structuredClone(demoSnapshot);
  for (const source of snapshot.sources) source.status = 'connected';
  const age = (id, staleHours) => { for (const entry of snapshot.quotas[id].windows) entry.forecast.staleHours = staleHours; };
  age('claude', 23.9);
  assert.deepEqual(header.sourceHealth(snapshot), { tone: 'safe', text: '3 sources current' });
  // A weekly reading is current for 24 hours after it was taken.
  age('claude', 25.9);
  const health = header.sourceHealth(snapshot);
  assert.equal(health.tone, 'watch');
  assert.match(health.text, /^Claude (and Fable )?needs? a refresh$/);
  snapshot.quotas.claude.windows.forEach((entry) => { entry.forecast.expired = true; });
  assert.deepEqual(header.sourceHealth(snapshot), { tone: 'safe', text: '3 sources current' },
    'an ended window waits for a reading; it is not an aged one');
});

test('a provider page plans the week, names the related allowance and shows its evidence', () => {
  const snapshot = structuredClone(demoSnapshot);
  const html = render(ProviderDetail, { snapshot, provider: 'fable', onBack() {}, onOpenProvider() {} });
  const content = text(html);
  assert.match(content, /Fable .*At risk/);
  assert.match(content, /Daily budget [^]*?\d+(\.\d)?% per active day/);
  assert.match(content, /Keep in reserve 0% of the allowance/);
  assert.match(content, /A typical week fits; a heavier one doesn’t/);
  assert.match(content, /Claude weekly limit Fable draws on your Claude weekly limit: up to half of it, and never more than is left\./);
  assert.match(content, /Fable limit 72% 41% Claude weekly 95% 78% Claude weekly, in Fable terms 100% 100% Usable Fable 72% 41%/);
  assert.match(content, /Limited by the Fable limit; Claude weekly has room to spare\./);
  assert.match(content, /Claude · 95% left On track/);
  assert.match(content, /Fable 5\.1 118 26\.4m £142\.60 Fable 5 28 5\.6m £61\.20/, 'this device’s Fable activity is split by version');
  assert.match(content, /Evidence Reading Official provider reading|Evidence Reading/);
  assert.match(content, /Learned from 29 days · 89% confidence/);
  assert.match(content, /Past weeks/);
  assert.match(html, /<input id="planner-reserve" type="range" min="0" max="50" step="1" aria-valuetext="0% of the allowance kept in reserve" value="0"/);
  assert.match(html, /aria-pressed="true"[^>]*>Heavier-week range/);
  const codex = text(render(ProviderDetail, { snapshot, provider: 'codex', onBack() {} }));
  assert.match(codex, /Fits, even in a heavier week/);
  assert.doesNotMatch(codex, /Related allowance/, 'Codex has no shared pool');
  const hidden = structuredClone(demoSnapshot);
  hidden.settings.showClaudeSubscription = false;
  assert.match(text(render(ProviderDetail, { snapshot: hidden, provider: 'fable', onBack() {} })), /This subscription is hidden/);
});

test('an expired provider page keeps history but offers no planner or current row figures', () => {
  const snapshot = structuredClone(demoSnapshot);
  const resetsAt = new Date(Date.parse(snapshot.generatedAt) - HOUR).toISOString();
  const expired = { ...snapshot.quotas.codex.windows[0], resetsAt,
    forecast: { ...snapshot.quotas.codex.forecast, expired: true, state: 'unknown', expectedRemaining: null, heavyRemaining: null } };
  snapshot.quotas.codex = { ...expired, windows: [expired] };
  assert.equal(providerViews(snapshot)[0].expired, true);
  const content = text(render(ProviderDetail, { snapshot, provider: 'codex', onBack() {} }));
  assert.match(content, /Needs reading/);
  assert.match(content, /Waiting for a new provider reading/);
  assert.match(content, /Awaiting current reading/);
  assert.doesNotMatch(content, /Daily budget|runway/);
});

test('an allowance with no current reading still links to its provider page', async () => {
  const { ProviderSummary } = await server.ssrLoadModule('/src/components/ProviderSummary.tsx');
  const snapshot = structuredClone(demoSnapshot);
  const resetsAt = new Date(Date.parse(snapshot.generatedAt) - HOUR).toISOString();
  const expired = { ...snapshot.quotas.codex.windows[0], resetsAt,
    forecast: { ...snapshot.quotas.codex.forecast, expired: true, state: 'unknown', expectedRemaining: null, heavyRemaining: null } };
  snapshot.quotas.codex = { ...expired, windows: [expired] };
  const view = providerViews(snapshot)[0];
  const html = render(ProviderSummary, { view, nowMs: Date.parse(snapshot.generatedAt), onOpen() {} });
  assert.match(text(html), /Codex history and evidence/);
});

test('a status line about a five-hour session gives no per-day budget', async () => {
  const { Overview } = await server.ssrLoadModule('/src/components/Overview.tsx');
  const snapshot = structuredClone(demoSnapshot);
  const weekly = snapshot.quotas.claude.windows[0];
  const session = { ...structuredClone(weekly), bucketId: 'five_hour', bucketName: 'Five hour', windowMinutes: 300,
    resetsAt: new Date(Date.parse(snapshot.generatedAt) + 3 * HOUR).toISOString() };
  session.forecast = { ...session.forecast, state: 'risk', activeHoursLeft: 3 };
  snapshot.quotas.claude = { ...weekly, windows: [weekly, session] };
  snapshot.dashboardVerdict = { ...snapshot.dashboardVerdict, state: 'risk', label: 'Claude 5-hour session could run out',
    details: [{ sourceId: 'claude', bucketId: 'five_hour', bucketName: 'Five hour', state: 'risk', reasons: ['pace'] }] };
  const html = render(Overview, { snapshot, refreshing: false, onRefresh: async () => {}, onSetupClaude() {}, onSources() {} });
  const status = text(html.slice(html.indexOf('class="overview-status'), html.indexOf('class="allowance-section"')));
  assert.match(status, /Claude 5-hour session could run out/);
  assert.doesNotMatch(status, /per active day|d{3}%/);
});

test('the Overview annunciator keeps a partial all-clear neutral: grey, dashed, no check', async () => {
  const { Overview } = await server.ssrLoadModule('/src/components/Overview.tsx');
  const statusOf = (snapshot) => {
    const html = render(Overview, { snapshot, refreshing: false, onRefresh: async () => {}, onSetupClaude() {}, onSources() {} });
    return html.slice(html.indexOf('class="overview-status'), html.indexOf('class="allowance-section"'));
  };
  const lozenge = (status) => status.slice(status.indexOf('annunciator-lozenge'), status.indexOf('annunciator-body'));
  const safe = structuredClone(demoSnapshot);
  safe.dashboardVerdict = { state: 'safe', reason: null, label: 'All allowances on track', windowsChecked: 3, affected: [], details: [] };
  // Control: every allowance assessed, so the all-clear is green with its check.
  const full = statusOf(safe);
  assert.match(full, /data-tone="safe"/);
  assert.match(lozenge(full), /circle-check/);
  assert.match(text(lozenge(full)), /On track/);
  // Partial: Fable has no forecast yet, so the same safe verdict stays neutral.
  const partial = structuredClone(safe);
  for (const q of [partial.quotas.fable, ...(partial.quotas.fable.windows ?? [])]) {
    q.forecast = { ...q.forecast, state: 'unknown', expectedRemaining: null, heavyRemaining: null };
  }
  const status = statusOf(partial);
  assert.match(status, /data-tone="unknown"/);
  assert.match(text(status), /Available allowances on track/);
  assert.match(lozenge(status), /circle-dashed/);
  assert.doesNotMatch(status, /circle-check/, 'green and its check belong to a verdict that assessed every allowance');
  assert.match(text(lozenge(status)), /Learning/);
});

test('banked resets: Codex reports its own, Claude free resets are recorded by hand and hide after expiry', async () => {
  const { bankedResetsFor } = await server.ssrLoadModule('/src/banked-resets.ts');
  const { Overview } = await server.ssrLoadModule('/src/components/Overview.tsx');
  const nowMs = new Date(2026, 8, 23, 22, 0).getTime();
  const base = { resetCredits: 3, settings: { claudeFreeResets: 1, claudeFreeResetsExpireOn: '2026-10-22' } };
  assert.equal(bankedResetsFor('codex', base, nowMs).label, '3 reset credits banked');
  const claude = bankedResetsFor('claude', base, nowMs);
  assert.equal(claude.label, '1 free reset available');
  assert.match(claude.note, /Expires Thu 22 Oct\./);
  assert.equal(bankedResetsFor('fable', base, nowMs), null, 'Fable shares the Claude pool');
  assert.ok(bankedResetsFor('claude', base, new Date(2026, 9, 22, 23, 59).getTime()), 'still claimable on its last day');
  assert.equal(bankedResetsFor('claude', base, new Date(2026, 9, 23, 0, 1).getTime()), null, 'hidden after expiry');
  assert.equal(bankedResetsFor('claude', { ...base, settings: { claudeFreeResets: 0 } }, nowMs), null);
  assert.equal(bankedResetsFor('codex', { ...base, resetCredits: 0 }, nowMs), null);

  const snapshot = structuredClone(demoSnapshot);
  snapshot.settings = { ...snapshot.settings, claudeFreeResets: 1, claudeFreeResetsExpireOn: '2099-12-31' };
  const html = render(Overview, { snapshot, refreshing: false, onRefresh: async () => {}, onSetupClaude() {}, onSources() {} });
  const claudeCard = text(html.slice(html.indexOf('aria-label="Claude allowance"'), html.indexOf('aria-label="Fable allowance"')));
  assert.match(claudeCard, /1 free reset available Recorded by you; claim it in Claude’s Usage settings\. Expires /);
  const fableCard = text(html.slice(html.indexOf('aria-label="Fable allowance"'), html.indexOf('id="attention-heading"')));
  assert.doesNotMatch(fableCard, /free reset|reset credit/);
});

test('the Claude free-reset record is validated, saved and offered in Settings', async () => {
  const { SubscriptionsSection } = await server.ssrLoadModule('/src/components/settings/SubscriptionsSection.tsx');
  const { UsageStore } = require('../../electron/store.cjs');
  const store = new UsageStore(':memory:', require('node:os').tmpdir());
  try {
    assert.equal(store.getSettings().claudeFreeResets, 0);
    assert.equal(store.getSettings().claudeFreeResetsExpireOn, null);
    store.updateSettings({ claudeFreeResets: 1, claudeFreeResetsExpireOn: '2026-10-22' });
    assert.equal(store.getSettings().claudeFreeResets, 1);
    assert.equal(store.getSettings().claudeFreeResetsExpireOn, '2026-10-22');
    for (const bad of [{ claudeFreeResets: -1 }, { claudeFreeResets: 1.5 }, { claudeFreeResets: 11 }, { claudeFreeResetsExpireOn: '22/10/2026' }]) {
      assert.throws(() => store.updateSettings(bad), undefined, JSON.stringify(bad));
    }
  } finally {
    store.close();
  }
  const snapshot = structuredClone(demoSnapshot);
  const html = render(SubscriptionsSection, { snapshot, update: async () => true });
  assert.match(text(html), /Claude free resets .*Free resets available.*Expires on/);
  assert.match(html, /id="claude-free-resets"/);
  snapshot.settings.showClaudeSubscription = false;
  assert.doesNotMatch(render(SubscriptionsSection, { snapshot, update: async () => true }), /claude-free-resets/);
});

test('Fable keeps its own reserve until the Claude weekly forecast is known, as the backend does', () => {
  const pool = { status: 'applied', bindingAtReset: 'pool', share: 0.5, pool: { expectedRemaining: 40 } };
  assert.equal(budget.forecastReserve({ sharedPool: pool }, 10), 20);
  assert.equal(budget.forecastReserve({ sharedPool: { ...pool, pool: { expectedRemaining: null } } }, 10), 10);
});
