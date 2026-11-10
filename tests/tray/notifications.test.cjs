'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildSummaryText, buildTrayTooltip, decideNotifications, emptyState } = require('../../electron/notifications.cjs');

const NOW = Date.parse('2026-09-01T10:30:00Z');

test('Claude summary, tray and digest prefer the overall weekly pool in any response order', () => {
  const overall = window({ bucketId: 'seven_day', remainingPercent: 83, usedPercent: 17 });
  const scoped = window({ bucketId: 'model_scoped:opus', remainingPercent: 12, usedPercent: 88, metadata: { scope: 'model' } });
  for (const windows of [[scoped, overall], [overall, scoped]]) {
    const current = snapshot({ quotas: { claude: { ...overall, windows } } });
    assert.match(buildSummaryText(current, NOW), /Claude: 83% left/);
    assert.match(buildTrayTooltip(current, NOW), /Claude 83%/);
    current.settings.notifyDigest = true;
    assert.match(decideNotifications({ current, nowMs: NOW }).notifications.find((entry) => entry.kind === 'digest').body, /Claude: 83% left/);
  }
});

test('hidden subscriptions are omitted from summaries, reset and fallback reminders', () => {
  const previous = snapshot();
  const initial = decideNotifications({ previous: null, current: previous, nowMs: NOW });
  const current = structuredClone(previous);
  current.settings.showClaudeSubscription = false;
  current.quotas.claude.windows[0].resetsAt = '2026-09-12T08:00:00.000Z';
  current.sources.find((source) => source.id === 'claude').status = 'error';
  current.sources.find((source) => source.id === 'claude-fable').status = 'error';
  assert.doesNotMatch(buildSummaryText(current, NOW), /Claude|Fable/);
  assert.doesNotMatch(buildTrayTooltip(current, NOW), /Claude|Fable/);
  const result = decideNotifications({ previous, current, state: initial.state, nowMs: NOW + 60_000 });
  assert.deepEqual(result.notifications, []);
  current.settings.showCodexSubscription = false;
  current.settings.notifyDigest = true;
  assert.deepEqual(decideNotifications({ previous, current, nowMs: NOW }).notifications, []);
});

function window(overrides = {}) {
  return {
    bucketId: 'seven_day',
    bucketName: 'Weekly',
    windowMinutes: 10_080,
    usedPercent: 40,
    remainingPercent: 60,
    resetsAt: '2026-09-05T08:00:00.000Z',
    forecast: { state: 'safe', expectedRemaining: 30, currentIsEstimated: false, exhaustsAt: null, expired: false },
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  const codex = window();
  const claude = window({ bucketId: 'claude', usedPercent: 10, remainingPercent: 90 });
  return {
    settings: { notifyDesktop: true, notifyResets: true, notifyFallback: true, notifyDigest: false, digestHour: 9, alertsSnoozedUntil: null },
    dashboardVerdict: { state: 'safe', label: 'All allowances on track', affected: [] },
    quotas: { codex: { ...codex, windows: [codex] }, claude: { ...claude, windows: [claude] }, fable: null },
    sources: [
      { id: 'codex', status: 'connected', status_detail: 'ok' },
      { id: 'claude', status: 'connected', status_detail: 'ok' },
      { id: 'claude-fable', status: 'connected', status_detail: 'ok' },
    ],
    costs: { currency: 'GBP', actual: 12.5, periodDays: 30, isLowerBound: false },
    ...overrides,
  };
}

test('tray retains percentages within Windows limit and uses collection time rather than redraw time', () => {
  const current = snapshot({
    dashboardVerdict: { label: 'A long verdict '.repeat(40) },
    sources: [{ lastSuccessAt: '2026-09-14T08:12:00.000Z' }],
  });
  const tooltip = buildTrayTooltip(current, Date.parse('2026-09-14T21:00:00Z'));
  assert.ok(tooltip.length <= 127);
  assert.match(tooltip, /^Codex 60%/);
  assert.match(tooltip, /Updated 09:12/);
  assert.doesNotMatch(tooltip, /22:00/);
});

test('a safe dashboard produces no notifications and clears the risk episode', () => {
  const result = decideNotifications({ previous: null, current: snapshot(), state: { ...emptyState(), lastRiskSignature: 'risk|Codex' }, nowMs: NOW });
  assert.deepEqual(result.notifications, []);
  assert.equal(result.state.lastRiskSignature, '');
});

test('risk fires once per episode and includes the earliest run-out time', () => {
  const codex = window({ forecast: { state: 'risk', expectedRemaining: 2, exhaustsAt: '2026-09-04T14:00:00.000Z', currentIsEstimated: false } });
  const current = snapshot({
    dashboardVerdict: { state: 'risk', label: 'Codex may hit the limit', affected: ['Codex · Weekly'] },
    quotas: { codex: { ...codex, windows: [codex] }, claude: null, fable: null },
  });
  const first = decideNotifications({ previous: null, current, state: emptyState(), nowMs: NOW });
  assert.equal(first.notifications.length, 1);
  assert.equal(first.notifications[0].kind, 'risk');
  assert.match(first.notifications[0].body, /earliest run-out is/);
  const second = decideNotifications({ previous: current, current, state: first.state, nowMs: NOW + 60_000 });
  assert.equal(second.notifications.length, 0);
});

test('heavy-only risk uses conditional wording rather than pace wording', () => {
  const fable = window({
    bucketId: 'fable_seven_day',
    forecast: {
      state: 'risk', expectedRemaining: 41, heavyRemaining: 0, exhaustsAt: null,
      heavyExhaustsAt: '2026-09-04T14:00:00.000Z', currentIsEstimated: false,
    },
  });
  const current = snapshot({
    dashboardVerdict: {
      state: 'risk', reason: 'heavy-exhaustion',
      label: 'Fable could reach its limit under heavier usage', affected: ['Fable · Weekly'],
    },
    quotas: { codex: null, claude: null, fable: { ...fable, windows: [fable] } },
  });

  const result = decideNotifications({ previous: null, current, state: emptyState(), nowMs: NOW });
  assert.equal(result.notifications[0].title, 'An allowance could run out under heavier usage');
  assert.doesNotMatch(result.notifications[0].body, /current pace/i);
  assert.match(result.notifications[0].body, /expected forecast/i);
});

test('escalation to critical always notifies even inside the cooldown', () => {
  const risk = snapshot({ dashboardVerdict: { state: 'risk', label: 'Codex may hit the limit', affected: ['Codex · Weekly'] } });
  const first = decideNotifications({ previous: null, current: risk, state: emptyState(), nowMs: NOW });
  const critical = snapshot({ dashboardVerdict: { state: 'critical', label: 'Codex may hit the limit', affected: ['Codex · Weekly'] } });
  const second = decideNotifications({ previous: risk, current: critical, state: first.state, nowMs: NOW + 60_000 });
  assert.equal(second.notifications.length, 1);
  assert.equal(second.notifications[0].title, 'An allowance is projected to run out');
});

test('a reset moving forward notifies once, with the new allowance', () => {
  const before = snapshot();
  const seeded = decideNotifications({ previous: null, current: before, state: emptyState(), nowMs: NOW });
  assert.equal(seeded.notifications.length, 0);
  const rolled = window({ usedPercent: 0, remainingPercent: 100, resetsAt: '2026-09-12T08:00:00.000Z' });
  const after = snapshot({ quotas: { codex: { ...rolled, windows: [rolled] }, claude: before.quotas.claude, fable: null } });
  const result = decideNotifications({ previous: before, current: after, state: seeded.state, nowMs: NOW });
  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0].kind, 'reset');
  assert.match(result.notifications[0].body, /100% is available/);
  const again = decideNotifications({ previous: after, current: after, state: result.state, nowMs: NOW + 1000 });
  assert.equal(again.notifications.length, 0);
});

test('a collector falling back from healthy to stale notifies once', () => {
  const healthy = snapshot();
  const seeded = decideNotifications({ previous: null, current: healthy, state: emptyState(), nowMs: NOW });
  const stale = snapshot({ sources: [
    { id: 'codex', status: 'connected', status_detail: 'ok' },
    { id: 'claude', status: 'stale', status_detail: 'The last official Claude allowance is still active, but this refresh did not replace it.' },
    { id: 'claude-fable', status: 'connected', status_detail: 'ok' },
  ] });
  const result = decideNotifications({ previous: healthy, current: stale, state: seeded.state, nowMs: NOW });
  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0].kind, 'fallback');
  assert.match(result.notifications[0].title, /Claude/);
  const again = decideNotifications({ previous: stale, current: stale, state: result.state, nowMs: NOW });
  assert.equal(again.notifications.length, 0);
});

// An automatic refresh does not read Claude plan usage, so Claude turning
// 'stale' after one only means its last reading aged. That is no fallback;
// a requested read that failed, or a degraded or failed collector, still is.
test('a Claude reading that only aged on an automatic refresh raises no fallback notice', () => {
  const healthy = snapshot();
  const seeded = decideNotifications({ previous: null, current: healthy, state: emptyState(), nowMs: NOW });
  const withClaude = (claude, fable) => snapshot({ sources: [
    { id: 'codex', status: 'connected', status_detail: 'ok' },
    { id: 'claude', status_detail: 'press Refresh', ...claude },
    { id: 'claude-fable', status_detail: 'press Refresh', ...fable },
  ] });
  const decide = (current) => decideNotifications({ previous: healthy, current, state: seeded.state, nowMs: NOW }).notifications;

  const aged = withClaude(
    { status: 'stale', metadata: { planUsage: { requested: false } } },
    { status: 'stale', metadata: { automatic: { provider: { kind: 'not-requested' } } } },
  );
  assert.deepEqual(decide(aged), []);

  const failedRead = withClaude(
    { status: 'stale', metadata: { planUsage: { requested: true } } },
    { status: 'stale', metadata: { automatic: { provider: { kind: 'failed' } } } },
  );
  assert.deepEqual(decide(failedRead).map((entry) => entry.kind), ['fallback', 'fallback']);

  for (const status of ['degraded', 'error']) {
    const broken = withClaude(
      { status, metadata: { planUsage: { requested: false } } },
      { status, metadata: { automatic: { provider: { kind: 'not-requested' } } } },
    );
    assert.deepEqual(decide(broken).map((entry) => entry.kind), ['fallback', 'fallback'], status);
  }
});

test('ageing preserves the next fallback alert without rearming an ongoing failure', () => {
  for (const suppressed of [null, 'snoozed', 'disabled']) {
    const healthy = snapshot();
    const aged = snapshot();
    aged.sources[1] = { id: 'claude', status: 'stale', metadata: { planUsage: { requested: false } } };
    aged.sources[2] = { id: 'claude-fable', status: 'stale', metadata: { automatic: { provider: { kind: 'not-requested' } } } };
    const failed = snapshot();
    failed.sources[1] = { id: 'claude', status: 'stale', metadata: { planUsage: { requested: true } } };
    failed.sources[2] = { id: 'claude-fable', status: 'stale', metadata: { automatic: { provider: { kind: 'failed' } } } };
    let previous = null;
    let state = emptyState();
    const check = (current) => {
      const result = decideNotifications({ previous, current, state, nowMs: NOW });
      state = JSON.parse(JSON.stringify(result.state));
      previous = { sources: current.sources.map(({ id, status }) => ({ id, status })) };
      return result.notifications.filter((entry) => entry.kind === 'fallback').map((entry) => entry.title);
    };
    const expected = ['Claude readings are running on cached data', 'Fable readings are running on cached data'];
    assert.deepEqual(check(healthy), []);
    assert.deepEqual(check(aged), []);
    assert.deepEqual(check(aged), []);
    if (suppressed === 'snoozed') failed.settings.alertsSnoozedUntil = new Date(NOW + 60_000).toISOString();
    if (suppressed === 'disabled') failed.settings.notifyFallback = false;
    assert.deepEqual(check(failed), suppressed ? [] : expected, suppressed || 'enabled');
    failed.settings.alertsSnoozedUntil = null;
    failed.settings.notifyFallback = true;
    assert.deepEqual(check(aged), []);
    assert.deepEqual(check(failed), [], 'one failure episode is not repeated or deferred');
    assert.deepEqual(check(healthy), []);
    assert.deepEqual(check(aged), []);
    assert.deepEqual(check(failed), expected, 'recovery permits a new failure alert');
  }
});

test('snoozed alerts drop every notification kind', () => {
  const current = snapshot({
    settings: { notifyDesktop: true, notifyResets: true, notifyFallback: true, notifyDigest: true, digestHour: 9, alertsSnoozedUntil: new Date(NOW + 3_600_000).toISOString() },
    dashboardVerdict: { state: 'critical', label: 'Codex may hit the limit', affected: ['Codex · Weekly'] },
  });
  const result = decideNotifications({ previous: null, current, state: emptyState(), nowMs: NOW });
  assert.deepEqual(result.notifications, []);
});

test('the daily digest fires once per local day at or after the configured hour', () => {
  const current = snapshot({ settings: { notifyDesktop: true, notifyResets: true, notifyFallback: true, notifyDigest: true, digestHour: 9, alertsSnoozedUntil: null } });
  const early = decideNotifications({ previous: null, current, state: emptyState(), nowMs: Date.parse('2026-09-01T06:00:00Z') });
  assert.equal(early.notifications.length, 0);
  const due = decideNotifications({ previous: current, current, state: early.state, nowMs: NOW });
  assert.equal(due.notifications.length, 1);
  assert.equal(due.notifications[0].kind, 'digest');
  assert.match(due.notifications[0].body, /Codex: 60% left/);
  const repeat = decideNotifications({ previous: current, current, state: due.state, nowMs: NOW + 3_600_000 });
  assert.equal(repeat.notifications.length, 0);
});

test('the summary text and tray tooltip share the same headline numbers', () => {
  const current = snapshot();
  const text = buildSummaryText(current, NOW);
  assert.match(text, /All allowances on track/);
  assert.match(text, /Codex: 60% left · resets in 3d 22h · expected 30% at reset/);
  assert.match(text, /Fable: no allowance reading yet/);
  assert.match(text, /GBP 12\.50 API-equivalent over the last 30 days/);
  const tooltip = buildTrayTooltip(current, NOW);
  assert.match(tooltip, /^Codex 60% · Claude 90% · Fable —\n/);
});

test('the tray tooltip headlines the weekly window even when a shorter window is riskier', () => {
  const weekly = window();
  const fiveHour = window({
    bucketId: 'five_hour',
    bucketName: '5-hour',
    windowMinutes: 300,
    usedPercent: 95,
    remainingPercent: 5,
    resetsAt: '2026-09-01T13:00:00.000Z',
    forecast: { state: 'risk', expectedRemaining: 0, currentIsEstimated: false, exhaustsAt: '2026-09-01T12:00:00.000Z', expired: false },
  });
  const current = snapshot({ quotas: { codex: { ...weekly, windows: [weekly, fiveHour] }, claude: null, fable: null } });
  assert.match(buildTrayTooltip(current, NOW), /^Codex 60% · Claude — · Fable —\n/);
});

test('a forecast-only change never announces a reset and a real shorter-window reset still does', () => {
  const weekly = window();
  const shorter = window({ bucketId: 'five_hour', bucketName: 'Five hour', windowMinutes: 300,
    usedPercent: 70, remainingPercent: 30, resetsAt: '2026-09-01T13:00:00Z',
    forecast: { state: 'risk', expired: false } });
  const before = snapshot({ quotas: { codex: { ...weekly, windows: [weekly, shorter] } } });
  const state = decideNotifications({ current: before, nowMs: NOW }).state;
  const improved = structuredClone(before);
  improved.quotas.codex.windows[1].forecast.state = 'safe';
  const result = decideNotifications({ previous: before, current: improved, state, nowMs: NOW });
  assert.deepEqual(result.notifications, []);
  const reset = structuredClone(improved);
  Object.assign(reset.quotas.codex.windows[1], { usedPercent: 0, remainingPercent: 100, resetsAt: '2026-09-01T18:00:00Z' });
  const actual = decideNotifications({ previous: improved, current: reset, state: result.state, nowMs: NOW });
  assert.equal(actual.notifications.length, 1);
  assert.match(actual.notifications[0].body, /new Five hour/);
  assert.deepEqual(decideNotifications({ previous: reset, current: reset, state: actual.state, nowMs: NOW }).notifications, []);
});

test('a same-bucket replenishment is detected even before its reset timestamp advances', () => {
  const before = snapshot();
  const seeded = decideNotifications({ current: before, nowMs: NOW });
  const after = structuredClone(before);
  Object.assign(after.quotas.codex.windows[0], { usedPercent: 0, remainingPercent: 100 });
  const result = decideNotifications({ previous: before, current: after, state: seeded.state, nowMs: NOW });
  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0].kind, 'reset');
});

test('the tray keeps the main Codex balance when Spark windows arrive first', () => {
  const main = window({ bucketId: 'codex:primary', remainingPercent: 98, metadata: { limitId: 'codex' } });
  const spark = window({ bucketId: 'codex_bengalfox:secondary', remainingPercent: 100, metadata: { limitId: 'codex_bengalfox' } });
  const current = snapshot({ quotas: { codex: { ...main, windows: [spark, main] }, claude: null, fable: null } });
  assert.match(buildTrayTooltip(current), /Codex 98%/);
});
