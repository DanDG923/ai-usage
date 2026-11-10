'use strict';
require('../setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { importClaudeTranscripts } = require('../../electron/claude-collector.cjs');
const { importLocalSessions } = require('../../electron/codex-collector.cjs');
const { providerHome } = require('../helpers/provider-home.cjs');

// A transcript that is mostly garbage must not look like a quiet one: every
// whole line that is not JSON is counted where rejected records already are,
// the import goes on, and the record still being written at the end of the
// file is left for the next refresh without being counted.
const sources = {
  claude: {
    file: '.claude/projects/demo/session.jsonl',
    record: (index, timestamp) => ({
      type: 'assistant', timestamp, sessionId: 'session-1',
      message: { id: `message-${index}`, model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 10 } },
    }),
    run: (store) => {
      const result = importClaudeTranscripts(store);
      return { imported: result.usageEvents, rejected: result.rejectedRows, lastRejection: result.lastRejection, readErrors: result.readErrors };
    },
  },
  codex: {
    file: '.codex/sessions/2026/11/rollout.jsonl',
    record: (index, timestamp) => ({
      type: 'event_msg', timestamp,
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100 + index, output_tokens: 10 } } },
    }),
    run: (store) => {
      const result = importLocalSessions(store);
      return { imported: result.events, rejected: result.rejected, lastRejection: result.lastRejection, readErrors: result.readErrors };
    },
  },
};

for (const [name, source] of Object.entries(sources)) {
  test(`${name} import counts whole lines that are not JSON and still imports the rest`, (t) => {
    const { store, write } = providerHome(t, `ai-usage-unparseable-${name}-`);
    const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();
    const file = write(source.file, []);
    const last = JSON.stringify(source.record(3, at(10)));
    fs.writeFileSync(file, [
      JSON.stringify(source.record(1, at(30))),
      'not json at all',
      '{"type":"assistant","message":',
      '   ',
      '\u0000\u0000\u0000\u0000',
      JSON.stringify(source.record(2, at(20))),
      // Still being written: no newline yet.
      last.slice(0, 25),
    ].join('\n'));

    const first = source.run(store);
    assert.equal(first.imported, 2, 'the records around the damage are imported');
    assert.equal(first.rejected, 3, 'each damaged line is counted; the blank one and the unfinished tail are not');
    assert.match(first.lastRejection, /not valid JSON/);
    assert.equal(first.readErrors, 0, 'damaged lines do not fail the import');

    fs.appendFileSync(file, `${last.slice(25)}\n`);
    const second = source.run(store);
    assert.deepEqual({ imported: second.imported, rejected: second.rejected }, { imported: 1, rejected: 0 },
      'the finished record is imported and the damage is not counted twice');
  });
}
