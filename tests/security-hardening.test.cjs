'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UsageStore } = require('../electron/store.cjs');
const { stderrExcerpt } = require('../electron/codex-collector.cjs');
const { createGitHubUpdateAuth } = require('../electron/update-auth.cjs');

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-hardening-'));
  const store = new UsageStore(path.join(root, 'test.sqlite'), path.join(root, 'Backups'));
  try { return run(store); } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('settings keys are validated by own validators only, never by inherited object members', () => withStore((store) => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.throws(() => store.updateSettings({ [key]: 1 }), /Unknown setting/);
  }
  assert.throws(() => store.updateSettings(JSON.parse('{"constructor": true}')), /Unknown setting/);
  const restored = store.restoreFromExport({ schemaVersion: 1, settings: JSON.parse('{"constructor": 1, "__proto__": {"theme": "dark"}, "theme": "light"}') });
  assert.equal(restored.settings, 1);
  assert.equal(restored.skipped, 2);
  assert.equal(store.getSettings().theme, 'light');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key IN ('constructor', '__proto__')").get().n, 0);
  // A junk row written by an earlier version is ignored by the repair pass.
  store.db.prepare("INSERT INTO settings(key, value_json, updated_at) VALUES ('constructor', '1', '2026-01-01T00:00:00.000Z')").run();
  store.repairSettings();
  assert.equal(Object.hasOwn(store.getSettings(), 'constructor'), false);
}));

test('price catalogue text fields are bounded and shaped from the settings screen and from restores', () => withStore((store) => {
  const rates = { inputUsdPerMillion: 1, cacheWriteUsdPerMillion: 1, cacheWrite1hUsdPerMillion: 1, cacheReadUsdPerMillion: 1, outputUsdPerMillion: 1 };
  const bad = [
    { model: 'x'.repeat(121) }, { model: ' ' }, { model: 'evil\u0000model' }, { model: 42 }, { model: null },
    { model: 'ok', effectiveFrom: 'yesterday' }, { model: 'ok', effectiveFrom: '2026-13-40' }, { model: 'ok', effectiveFrom: 20260101 },
    { model: 'ok', sourceUrl: 'javascript:alert(1)' }, { model: 'ok', sourceUrl: 'file:///C:/secret' }, { model: 'ok', sourceUrl: 'not a url' },
    { model: 'ok', sourceUrl: `https://example.test/${'a'.repeat(2048)}` }, { model: 'ok', inputUsdPerMillion: 1e9 },
  ];
  for (const row of bad) assert.throws(() => store.updatePrice({ ...rates, ...row }), Error, JSON.stringify(row));
  const catalog = store.updatePrice({ ...rates, model: '  custom-model ', effectiveFrom: '2026-09-01', sourceUrl: 'https://example.test/pricing' });
  const saved = catalog.find((row) => row.model === 'custom-model');
  assert.equal(saved.effective_from, '2026-09-01');
  assert.equal(saved.source_url, 'https://example.test/pricing');
  assert.equal(store.updatePrice({ ...rates, model: 'no-source', effectiveFrom: '', sourceUrl: '' }).find((row) => row.model === 'no-source').source_url, null);

  const price = (overrides) => ({ model: 'restored', input_usd_per_million: 1, cache_write_usd_per_million: 1,
    cache_read_usd_per_million: 1, output_usd_per_million: 1, effective_from: '2026-09-01', ...overrides });
  const result = store.restoreFromExport({ schemaVersion: 1, prices: [
    price({ model: 'x'.repeat(121) }), price({ effective_from: 'soon' }), price({ input_usd_per_million: 1e9 }),
    price({ model: 'restored-ok', source_url: 'https://example.test' }),
    price({ model: 'restored-script', source_url: 'javascript:alert(1)' }),
  ] });
  assert.equal(result.prices, 2);
  assert.equal(result.skipped, 3);
  const restored = Object.fromEntries(store.getPriceCatalog().map((row) => [row.model, row.source_url]));
  assert.equal(restored['restored-ok'], 'https://example.test');
  // An unusable link is dropped from a restored row rather than costing the row.
  assert.equal(restored['restored-script'], null);
}));

test('Codex exit diagnostics are reduced to one short line before they reach status text or notifications', () => {
  assert.equal(stderrExcerpt(''), '');
  assert.equal(stderrExcerpt('  \n\t '), '');
  assert.equal(stderrExcerpt('line one\r\nline\u0000two\u200b\n'), 'line one line two');
  const long = `${'x'.repeat(5000)}\n${'tail'.repeat(100)}`;
  const excerpt = stderrExcerpt(long);
  assert.equal(excerpt.length, 241);
  assert.ok(excerpt.startsWith('…'));
  assert.ok(excerpt.endsWith('tail'));
  assert.ok(!/[\r\n\p{Cc}]/u.test(excerpt));
});

test('the GitHub CLI is never taken from, or handed, the launch directory even when PATH names it absolutely', async () => {
  const launch = 'C:\\Users\\tester\\Downloads\\ai-usage-launch';
  const alias = 'C:\\Users\\tester\\Downloads\\LAUNCH-ALIAS';
  const trusted = 'D:\\Tools\\GitHub CLI';
  const calls = [];
  const inspected = [];
  const auth = createGitHubUpdateAuth({
    environment: { PATH: `${launch};"${launch.toUpperCase()}";${alias};${launch}\\.;${trusted}` },
    // The process was started from the planted directory; the alias is a junction to it.
    realpath: (value) => (value === process.cwd() || value.toLowerCase().startsWith(alias.toLowerCase()) ? launch : value),
    stat(executable) {
      inspected.push(executable);
      return { isFile: () => executable.toLowerCase().startsWith(launch.toLowerCase()) || executable === path.win32.join(trusted, 'gh.exe') };
    },
    execute(file, args, options, callback) {
      calls.push({ file, args, options });
      callback(null, `gho_${'a'.repeat(36)}\r\n`);
    },
  });
  await auth.getToken();
  assert.equal(calls[0].file, path.win32.join(trusted, 'gh.exe'));
  assert.ok(inspected.every((candidate) => !candidate.toLowerCase().startsWith(launch.toLowerCase()) && !candidate.toLowerCase().startsWith(alias.toLowerCase())));
  assert.equal(calls[0].options.env.PATH, trusted);
});
