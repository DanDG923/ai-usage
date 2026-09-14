'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');
const { runCollectors } = require('../electron/collector-runner.cjs');

test('a synchronous collector failure does not abort successful collectors', async () => {
  const outcomes = await runCollectors({
    codex: async () => ({ observations: 2 }),
    claude: () => { throw new Error('unreadable inbox'); },
  });
  assert.equal(outcomes.codex.status, 'fulfilled');
  assert.equal(outcomes.codex.value.observations, 2);
  assert.equal(outcomes.claude.status, 'rejected');
  assert.match(outcomes.claude.reason.message, /unreadable inbox/);
});
