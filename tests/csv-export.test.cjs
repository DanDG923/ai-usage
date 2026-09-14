'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');
const { createMaintenanceService } = require('../electron/maintenance-service.cjs');

// Decode CSV quoting independently of the exporter, including embedded newlines.
function parseCsv(csv) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(cell); cell = '';
    } else if (!quoted && char === '\r' && csv[index + 1] === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; index += 1;
    } else cell += char;
  }
  assert.equal(quoted, false);
  assert.equal(cell, '');
  assert.deepEqual(row, []);
  return rows;
}

test('restored formula labels stay literal in the saved ledger CSV', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-csv-'));
  const config = { databasePath: path.join(root, 'usage.sqlite'), backupDirectory: path.join(root, 'Backups') };
  const store = new UsageStore(config.databasePath, config.backupDirectory);
  const service = createMaintenanceService(config);
  try {
    const labels = [
      '=1+1', '+1+1', '-1+1', '@SUM(1,1)',
      ' \t=1+1', '\r=1+1', '\n+1+1', '\u0000-1+1', '\u001f@SUM(1,1)',
      '\u00a0=1+1', '\ufeff+1+1', '\u200b=1+1', '\tordinary',
      '\uff1d1+1', '\uff0b1+1', '\uff0d1+1', '\uff20SUM(1,1)',
      '=SUM(1,1),"quoted"\r\n=2+2',
    ];
    const now = Date.now();
    const counts = store.restoreFromExport({ schemaVersion: 1, usageEvents: labels.map((label, index) => ({
      event_key: `formula-${index}`, source_id: 'codex', occurred_at: new Date(now - index * 1000).toISOString(),
      model: label, project: label, session_id: label, input_tokens: 10, output_tokens: 1,
    })) });
    assert.equal(counts.usageEvents, labels.length);
    assert.equal(counts.skipped, 0);
    const filePath = path.join(root, 'ledger.csv');
    assert.equal((await service.handle({ type: 'export-csv', filePath, days: 30 })).rows, labels.length);
    const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
    assert.equal(rows.length, labels.length + 1);
    for (const [index, cells] of rows.slice(1).entries()) {
      const label = labels[labels.length - 1 - index];
      assert.equal(cells.length, 13);
      const project = label === '\tordinary' ? 'ordinary' : "'" + label.trim();
      assert.deepEqual(cells.slice(2, 5), ["'" + label, project, "'" + label]);
      assert.deepEqual(cells.slice(5), ['10', '0', '0', '0', '1', '0', '0', 'no']);
    }
    assert.equal(store.db.prepare("SELECT model FROM usage_events WHERE event_key = 'formula-0'").get().model, '=1+1');
  } finally {
    await service.handle({ type: 'close' });
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CSV preserves ordinary labels, cell boundaries, empty fields and numeric types', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-csv-'));
  const store = new UsageStore(path.join(root, 'usage.sqlite'), path.join(root, 'Backups'));
  try {
    const now = Date.now();
    const labels = ['gpt-5.6-sol', 'C:\\work, "alpha"', 'Unicode \u03bb\u65e5\u672c\ud83d\ude80', 'line one\r\n=1+1', 'text,=1+1', "'already literal", 'ordinary + text', ' leading spaces', null, ''];
    for (const [index, label] of labels.entries()) {
      store.recordUsageEvent({ eventKey: `normal-${index}`, sourceId: 'codex', occurredAt: new Date(now - index * 1000).toISOString(), model: 'gpt-5.6-sol', sessionId: label, inputTokens: 100, outputTokens: 2 });
    }
    // Numeric values must not receive the text guard, even for a signed value
    // already in a database (new imports correctly reject negative tokens).
    store.db.prepare("UPDATE usage_events SET input_tokens = -2 WHERE event_key = 'normal-0'").run();
    const rows = parseCsv(store.exportLedgerCsv(30, now).csv);
    assert.equal(rows.length, labels.length + 1);
    for (const [index, cells] of rows.slice(1).entries()) {
      assert.equal(cells.length, 13);
      assert.equal(cells[4], labels[labels.length - 1 - index] ?? '');
      assert.equal(cells[3], '');
      assert.match(cells[11], /^-?\d+(?:\.\d+)?$/);
      assert.equal(cells[12], 'yes');
    }
    assert.equal(rows.at(-1)[5], '-2');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
