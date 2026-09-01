'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildDashboardVerdict } = require('../electron/dashboard-decision.cjs');

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
    state: 'safe', label: 'All allowances on track', windowsChecked: 4, affected: [],
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
    state: 'safe', label: 'All allowances on track', windowsChecked: 3, affected: [],
  });
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
