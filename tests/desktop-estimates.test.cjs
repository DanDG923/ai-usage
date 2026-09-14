'use strict';
require('./setup.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageStore } = require('../electron/store.cjs');
const { parseDesktopExport, readDesktopExport, saveDesktopEstimates, desktopAnalytics, MAX_MODELS } = require('../electron/desktop-estimates.cjs');
const { createMaintenanceService } = require('../electron/maintenance-service.cjs');

const at = '2026-09-05T12:00:00.000Z';
const now = Date.parse('2026-09-06T12:00:00Z');
const message = (uuid, sender, text, extra = {}) => ({ uuid, sender, text, created_at: at, ...extra });
const fixture = () => [{ uuid: 'chat-1', name: 'PRIVATE TITLE', model: 'claude-fable-5', chat_messages: [
  message('human-1', 'human', 'abcdefgh'),
  message('reply-1', 'assistant', 'PRIVATE DUPLICATE TEXT', { model: 'claude-opus-5', content: [{ type: 'text', text: 'abcdefghijkl' }] }),
  message('human-2', 'human', 'abcdefgh'),
  message('reply-2', 'assistant', 'abcdefghijkl'),
] }];
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-desktop-'));
  const config = { databasePath: path.join(root, 'test.sqlite'), backupDirectory: path.join(root, 'Backups') };
  const store = new UsageStore(config.databasePath, config.backupDirectory);
  store.updateSettings({ currency: 'USD' });
  return { root, config, store };
}

test('exports use reply model evidence, count content once and retain no conversation text', () => {
  const result = parseDesktopExport(fixture());
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => [row.input_tokens, row.output_tokens, row.model]), [[2, 3, 'claude-opus-5'], [2, 3, null]]);
  assert.equal(result.summary.unknownModelReplies, 1, 'conversation model must not label past replies');
  assert.equal(result.summary.conversations, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|abcdefgh|chat-1|reply-1/);
});

test('branched replies use their own human parent and flag missing prompts and excluded content', () => {
  const input = fixture();
  input[0].chat_messages.push(message('other-human', 'human', 'x'.repeat(40)));
  input[0].chat_messages.push(message('branch', 'assistant', 'done', { parent_message_uuid: 'human-1', attachments: [{}] }));
  input[0].chat_messages.push(message('orphan', 'assistant', '', { parent_message_uuid: 'missing', content: [{ type: 'text', text: 'done' }, { type: 'thinking', thinking: 'PRIVATE' }] }));
  const { rows, summary } = parseDesktopExport(input);
  assert.equal(rows[2].input_tokens, 2);
  assert.equal(rows[2].excluded_content, 1);
  assert.equal(rows[3].input_tokens, 0);
  assert.equal(rows[3].input_missing, 1);
  assert.equal(rows[3].output_tokens, 1);
  assert.equal(summary.excludedContentReplies, 2);
});

test('invalid exports, malformed rows, unknown roles and invalid dates never create guessed activity', () => {
  for (const payload of [null, {}, [], [{ title: 'other product', messages: [] }]]) assert.throws(() => parseDesktopExport(payload), /conversations.json/);
  const input = fixture();
  input[0].chat_messages.push(null, message('bad', 'assistant', 'x', { created_at: 'not-a-date' }), message('tool', 'tool', 'x'));
  const result = parseDesktopExport(input);
  assert.equal(result.rows.length, 2);
  assert.equal(result.summary.skipped, 3);
  const onlyInvalid = [{ uuid: 'chat', chat_messages: [message('a', 'assistant', 'x', { created_at: '2200-01-01T00:00:00Z' })] }];
  assert.throws(() => parseDesktopExport(onlyInvalid), /No dated/);
});

test('imports deduplicate, preserve missing models and remain outside recorded usage and forecasts', () => {
  const { store } = setup();
  try {
    const before = store.getDashboardSnapshot(30, now);
    const { rows } = parseDesktopExport(fixture());
    assert.deepEqual(saveDesktopEstimates(store, rows), { imported: 2, duplicates: 0 });
    assert.deepEqual(saveDesktopEstimates(store, rows), { imported: 0, duplicates: 2 });
    const result = desktopAnalytics(store, 30, store.getSettings(), now);
    assert.equal(result.replies, 2);
    assert.equal(result.unpricedReplies, 1);
    assert.ok(Math.abs(result.estimatedCost - 0.000085) < 1e-12);
    assert.equal(result.byModel.find((row) => !row.model).estimatedCost, null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 0);
    const after = store.getDashboardSnapshot(30, now);
    assert.deepEqual(after.costs, before.costs);
    assert.deepEqual(after.quotas, before.quotas);
    assert.deepEqual(after.cycles, before.cycles);
  } finally { store.close(); }
});

test('explicit pricing assumptions never replace exported models and live price edits reprice estimates', () => {
  const { store } = setup();
  try {
    const { rows } = parseDesktopExport(fixture());
    assert.throws(() => saveDesktopEstimates(store, rows, 'gpt-6-astra'), /priced Claude/);
    saveDesktopEstimates(store, rows, 'claude-sonnet-5');
    let result = desktopAnalytics(store, 30, store.getSettings(), now);
    assert.equal(result.byModel.find((row) => row.modelOrigin === 'assumed').model, 'claude-sonnet-5');
    assert.equal(result.byModel.find((row) => row.modelOrigin === 'exported').model, 'claude-opus-5');
    store.updatePrice({ model: 'claude-opus-5', inputUsdPerMillion: 10, outputUsdPerMillion: 50,
      cacheWriteUsdPerMillion: 0, cacheWrite1hUsdPerMillion: 0, cacheReadUsdPerMillion: 0 });
    store.updateSettings({ currency: 'GBP', usdToCurrency: 0.5 });
    result = desktopAnalytics(store, 30, store.getSettings(), now);
    assert.ok(Math.abs(result.byModel.find((row) => row.model === 'claude-opus-5').estimatedCost - 0.000085) < 1e-12);
    assert.equal(desktopAnalytics(store, 1, store.getSettings(), now + 86400000).replies, 0);
  } finally { store.close(); }
});

test('chat estimates survive backup restore, preserve existing rows, and reject invalid restored records', () => {
  const first = setup(), second = setup();
  try {
    saveDesktopEstimates(first.store, parseDesktopExport(fixture()).rows, 'claude-opus-5');
    const backup = first.store.createBackup();
    const payload = first.store.readExport(backup.exportPath);
    assert.equal(payload.desktopEstimates.length, 2);
    assert.doesNotMatch(JSON.stringify(payload.desktopEstimates), /PRIVATE|abcdefgh/);
    payload.desktopEstimates.push({ ...payload.desktopEstimates[0], event_key: 'a'.repeat(64), input_tokens: -1 });
    assert.equal(second.store.restoreFromExport(payload).desktopEstimates, 2);
    assert.equal(second.store.restoreFromExport(payload).desktopEstimates, 0);
    assert.equal(second.store.db.prepare('SELECT COUNT(*) AS count FROM desktop_chat_estimates').get().count, 2);
    assert.equal(second.store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { first.store.close(); second.store.close(); }
});

test('a failing import rolls back every estimate', () => {
  const { store } = setup();
  try {
    const { rows } = parseDesktopExport(fixture());
    assert.throws(() => saveDesktopEstimates(store, [rows[0], { ...rows[1], input_tokens: -1 }]), /Invalid desktop/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM desktop_chat_estimates').get().count, 0);
  } finally { store.close(); }
});

test('malformed backup key types are skipped without rolling back valid data', () => {
  const { store } = setup();
  try {
    const { rows } = parseDesktopExport(fixture());
    const badKeys = [[rows[0].event_key], { key: rows[0].event_key }, 123, null];
    const result = store.restoreFromExport({ schemaVersion: 1, desktopEstimates: [
      rows[0], ...badKeys.map((key) => ({ ...rows[1], event_key: key })), rows[1],
    ] });
    assert.equal(result.desktopEstimates, 2);
    assert.equal(result.skipped, badKeys.length);
  } finally { store.close(); }
});

function modelsFixture(count, prefix = 'bounded') {
  return [{ uuid: prefix, chat_messages: Array.from({ length: count }, (_, index) =>
    message(`${prefix}-${index}`, 'assistant', 'four', { model: `claude-${prefix}-${index}` })) }];
}

test('model diversity is bounded in previews, cumulative imports and backup restore', () => {
  assert.throws(() => parseDesktopExport(modelsFixture(MAX_MODELS + 1)), /128 distinct/);
  const first = setup(), restored = setup();
  try {
    const bounded = parseDesktopExport(modelsFixture(MAX_MODELS)).rows;
    saveDesktopEstimates(first.store, bounded);
    const extra = parseDesktopExport(modelsFixture(1, 'new-label')).rows;
    const unknown = parseDesktopExport(fixture()).rows.filter((row) => !row.model);
    assert.throws(() => saveDesktopEstimates(first.store, [...unknown, ...extra]), /128 distinct/);
    assert.equal(desktopAnalytics(first.store, 30, first.store.getSettings(), now).storedReplies, MAX_MODELS,
      'overflow import must roll back earlier otherwise-valid rows');
    assert.equal(saveDesktopEstimates(first.store, [{ ...bounded[0], model: 'claude-changed-label' }]).duplicates, 1);
    assert.equal(saveDesktopEstimates(first.store, unknown).imported, 1, 'unknown models need no model label slot');
    assert.throws(() => saveDesktopEstimates(first.store, parseDesktopExport(fixture()).rows, 'claude-opus-5'), /128 distinct/);
    const result = restored.store.restoreFromExport({ schemaVersion: 1,
      desktopEstimates: [...bounded, ...extra, ...unknown],
    });
    assert.equal(result.desktopEstimates, MAX_MODELS + 1);
    assert.equal(result.skipped, 1);
    const restoredAgain = restored.store.restoreFromExport({ schemaVersion: 1, desktopEstimates: extra });
    assert.equal(restoredAgain.skipped, 1, 'restore must include models already stored');
    const analytics = desktopAnalytics(restored.store, 30, restored.store.getSettings(), now);
    assert.equal(analytics.byModel.length, MAX_MODELS + 1);
  } finally { first.store.close(); restored.store.close(); }
});

test('explicit desktop-only models can be repriced without creating recorded usage', () => {
  const { store } = setup();
  try {
    saveDesktopEstimates(store, parseDesktopExport(modelsFixture(1, 'new-model')).rows);
    assert.equal(desktopAnalytics(store, 30, store.getSettings(), now).byModel[0].estimatedCost, null);
    store.updatePrice({ model: 'claude-new-model-0', inputUsdPerMillion: 2, outputUsdPerMillion: 10,
      cacheWriteUsdPerMillion: 2.5, cacheWrite1hUsdPerMillion: 4, cacheReadUsdPerMillion: 0.2 });
    assert.equal(desktopAnalytics(store, 30, store.getSettings(), now).byModel[0].estimatedCost, 0.00001);
    assert.equal(store.getCostAnalytics(30, store.getSettings(), now).requestCount, 0);
  } finally { store.close(); }
});

test('worker previews without writes, supports cancel, imports reviewed counts despite file changes and clears reversibly', async () => {
  const { root, config, store } = setup();
  const service = createMaintenanceService(config);
  const filePath = path.join(root, 'conversations.json');
  fs.writeFileSync(filePath, '\uFEFF' + JSON.stringify(fixture()));
  try {
    assert.equal(readDesktopExport(filePath).rows.length, 2);
    const cancelled = await service.handle({ type: 'preview-desktop-export', filePath });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM desktop_chat_estimates').get().count, 0);
    await service.handle({ type: 'cancel-desktop-export', previewId: cancelled.id });
    await assert.rejects(service.handle({ type: 'import-desktop-export', previewId: cancelled.id }), /expired/);
    const preview = await service.handle({ type: 'preview-desktop-export', filePath });
    assert.doesNotMatch(JSON.stringify(preview), /PRIVATE|abcdefgh|event_key/);
    fs.writeFileSync(filePath, 'not json any more');
    const result = await service.handle({ type: 'import-desktop-export', previewId: preview.id, assumedModel: 'claude-opus-5' });
    assert.equal(result.imported, 2);
    const cleared = await service.handle({ type: 'clear-desktop-estimates' });
    assert.equal(cleared.removed, 2);
    assert.equal(store.readExport(cleared.safetyBackup.exportPath).desktopEstimates.length, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM desktop_chat_estimates').get().count, 0);
    await assert.rejects(service.handle({ type: 'preview-desktop-export', filePath }), /valid JSON/);
  } finally { await service.handle({ type: 'close' }); store.close(); }
});

test('oversized export files are rejected before parsing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-desktop-size-'));
  const filePath = path.join(root, 'conversations.json');
  const fd = fs.openSync(filePath, 'w');
  fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  assert.throws(() => readDesktopExport(filePath), /64 MB/);
  fs.unlinkSync(filePath);
});
