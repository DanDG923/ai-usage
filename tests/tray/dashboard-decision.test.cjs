'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildDashboardVerdict } = require('../../electron/dashboard-decision.cjs');

function window(bucketId, state, overrides = {}) {
  return {
    bucketId,
    bucketName: bucketId,
    resetsAt: '2026-09-03T08:00:00.000Z',
    forecast: { state, expired: false },
    ...overrides,
  };
}

function quota(...windows) {
  return { ...windows[0], windows };
}

test('hidden subscriptions contribute neither risk nor missing-data warnings', () => {
  const snapshot = {
    settings: { showClaudeSubscription: false },
    quotas: { codex: quota(window('weekly', 'safe')), claude: null, fable: quota(window('weekly', 'critical')) },
  };
  const verdict = buildDashboardVerdict(snapshot);
  assert.equal(verdict.state, 'safe');
  assert.equal(verdict.windowsChecked, 1);
  snapshot.settings.showClaudeSubscription = true;
  assert.equal(buildDashboardVerdict(snapshot).state, 'critical');
  snapshot.settings.showCodexSubscription = false;
  snapshot.settings.showClaudeSubscription = false;
  assert.equal(buildDashboardVerdict(snapshot).state, 'unknown');
  assert.equal(buildDashboardVerdict(snapshot).label, 'No subscriptions shown');
});

test('the verdict reports a risky secondary window even when the primary window is safe', () => {
  const verdict = buildDashboardVerdict({
    quotas: {
      codex: quota(window('codex:weekly', 'safe'), window('model:fable', 'risk')),
      claude: quota(window('seven_day', 'safe')),
      fable: quota(window('fable_seven_day', 'safe')),
    },
  });

  assert.equal(verdict.state, 'risk');
  assert.match(verdict.label, /Codex.*model:fable/i);
  assert.equal(verdict.windowsChecked, 4);
});

test('a heavier-only exhaustion is possible, not described as likely', () => {
  const verdict = buildDashboardVerdict({
    quotas: {
      codex: quota(window('codex:weekly', 'safe')),
      claude: quota(window('seven_day', 'safe')),
      fable: quota(window('fable_seven_day', 'risk', {
        forecast: {
          state: 'risk',
          expectedRemaining: 41,
          heavyRemaining: 0,
          exhaustsAt: null,
          heavyExhaustsAt: '2026-09-02T09:19:00.000Z',
        },
      })),
    },
  });

  assert.equal(verdict.reason, 'heavy-exhaustion');
  assert.equal(verdict.label, 'Fable could reach its limit under heavier usage');
  assert.doesNotMatch(verdict.label, /likely/i);
});

test('pace-only risk is described as above safe pace', () => {
  const verdict = buildDashboardVerdict({
    quotas: {
      codex: quota(window('codex:weekly', 'risk', {
        forecast: { state: 'risk', expectedRemaining: 24, heavyRemaining: 8, paceRatio: 1.4 },
      })),
      claude: quota(window('seven_day', 'safe')),
      fable: quota(window('fable_seven_day', 'safe')),
    },
  });

  assert.equal(verdict.reason, 'pace');
  assert.equal(verdict.label, 'Codex is above its safe pace');
});

test('missing or expired allowance data is unknown, never all-on-track', () => {
  const missing = buildDashboardVerdict({
    quotas: { codex: quota(window('codex:weekly', 'safe')), claude: null, fable: null },
  });
  assert.equal(missing.state, 'unknown');
  assert.match(missing.label, /needs data/i);

  const expired = buildDashboardVerdict({
    quotas: {
      codex: quota(window('codex:weekly', 'safe')),
      claude: quota(window('seven_day', 'safe', { forecast: { state: 'safe', expired: true } })),
      fable: quota(window('fable_seven_day', 'safe')),
    },
  });
  assert.equal(expired.state, 'unknown');
  assert.match(expired.label, /needs data/i);
});

test('all-on-track requires every expected allowance and every live window to be safe', () => {
  const verdict = buildDashboardVerdict({
    quotas: {
      codex: quota(window('codex:weekly', 'safe')),
      claude: quota(window('five_hour', 'safe'), window('seven_day', 'safe')),
      fable: quota(window('fable_seven_day', 'safe')),
    },
  });
  assert.deepEqual(verdict, {
    state: 'safe', reason: null, label: 'All allowances on track', windowsChecked: 4, affected: [], details: [],
  });
});

test('an expired historical bucket does not override another active safe window', () => {
  const verdict = buildDashboardVerdict({
    quotas: {
      codex: quota(
        window('five_hour', 'safe'),
        window('old_weekly', 'unknown', { forecast: { state: 'unknown', expired: true } }),
      ),
      claude: quota(window('seven_day', 'safe')),
      fable: quota(window('fable_seven_day', 'safe')),
    },
  });

  assert.deepEqual(verdict, {
    state: 'safe', reason: null, label: 'All allowances on track', windowsChecked: 3, affected: [], details: [],
  });
});

test('mixed risk reasons use a neutral aggregate and keep per-window evidence', () => {
  const verdict = buildDashboardVerdict({
    quotas: {
      codex: quota(window('codex:weekly', 'risk', {
        forecast: { state: 'risk', expectedRemaining: 30, heavyRemaining: 12, paceRatio: 1.5 },
      })),
      claude: quota(window('seven_day', 'safe')),
      fable: quota(window('fable_seven_day', 'risk', {
        forecast: {
          state: 'risk', expectedRemaining: 20, heavyRemaining: 0, paceRatio: 0.8,
          heavyExhaustsAt: '2026-09-02T09:19:00.000Z',
        },
      })),
    },
  });

  assert.equal(verdict.reason, 'mixed');
  assert.equal(verdict.label, '2 allowances need attention');
  assert.deepEqual(verdict.details.map((detail) => detail.reasons), [['pace'], ['heavy-exhaustion']]);
});

test('a null heavy projection never masquerades as heavy exhaustion', () => {
  const verdict = buildDashboardVerdict({
    quotas: {
      codex: quota(window('codex:weekly', 'risk', {
        forecast: { state: 'risk', expectedRemaining: 24, heavyRemaining: null, paceRatio: 1.4 },
      })),
      claude: quota(window('seven_day', 'safe')),
      fable: quota(window('fable_seven_day', 'safe')),
    },
  });

  assert.equal(verdict.reason, 'pace');
  assert.equal(verdict.label, 'Codex is above its safe pace');
});

test('stale or failed evidence cannot produce the all-clear verdict', () => {
  const quotas = {
    codex: quota(window('codex:weekly', 'safe')),
    claude: quota(window('seven_day', 'safe', { forecast: { state: 'safe', expired: false, staleHours: 72, currentIsEstimated: true } })),
    fable: quota(window('fable_seven_day', 'safe')),
  };
  const verdict = buildDashboardVerdict({
    quotas,
    sources: [
      { id: 'codex', status: 'connected' },
      { id: 'claude', status: 'stale' },
      { id: 'claude-fable', status: 'connected' },
    ],
  });

  assert.equal(verdict.state, 'unknown');
  assert.match(verdict.label, /current data/i);
  assert.deepEqual(verdict.affected, ['Claude']);
});
