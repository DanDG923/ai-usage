'use strict';
require('./setup.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MOD_FILES, PLUGIN_ID, createClaudeCodeMod } = require('../electron/claude-code-mod.cjs');

const SOURCE = path.resolve(__dirname, '..', 'claude-code-mod');
const BINARY = 'C:\\Tools\\claude.exe';

// A stand-in for the user's Claude Code: it answers `claude plugin … --json`
// and records the plugin in its settings the way the real one does.
function fakeClaude({ version = '2.1.287 (Claude Code)', failures = {}, enabled } = {}) {
  const settings = { enabledPlugins: enabled === undefined ? {} : { [PLUGIN_ID]: enabled } };
  const calls = [];
  const run = async (binary, args) => {
    calls.push(args.filter((arg) => arg !== '--json').join(' '));
    if (args[0] === '--version') return { ok: true, stdout: `${version}\n` };
    const command = args.slice(0, args[1] === 'marketplace' ? 3 : 2).join(' ');
    const failure = failures[command];
    if (failure) return { ok: false, stdout: `${JSON.stringify({ outcome: 'failed', ...failure })}\n` };
    // Installing a plugin that was turned off turns it on again (Claude Code 2.1.287).
    if (command === 'plugin install') settings.enabledPlugins[PLUGIN_ID] = true;
    if (command === 'plugin uninstall') delete settings.enabledPlugins[PLUGIN_ID];
    return { ok: true, stdout: `${JSON.stringify({ outcome: 'ok', message: 'done' })}\n` };
  };
  return { settings, calls, run };
}

function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-claude-code-mod-'));
  const claude = fakeClaude(options);
  const requests = [];
  const readings = [];
  const watchers = new Map();
  const watchErrors = new Map();
  const mod = createClaudeCodeMod({
    root,
    sourceDirectory: SOURCE,
    readClaudeSettings: () => claude.settings,
    appVersion: '1.0.56',
    findBinary: () => (options.noBinary ? null : BINARY),
    run: claude.run,
    onRequest: (action) => requests.push(action),
    onReading: () => readings.push(Date.now()),
    now: options.now ?? Date.now,
    watch: (folder, _options, listener) => {
      const name = path.basename(folder);
      // A watch the file system refuses once, as it can for a moment.
      if (options.refuseWatchOnce?.delete(name)) throw new Error('EPERM: operation not permitted, watch');
      watchers.set(name, listener);
      return {
        close: () => watchers.delete(name),
        on: (event, handler) => { if (event === 'error') watchErrors.set(name, handler); },
      };
    },
  });
  t.after(() => mod.stop());
  return { root, mod, claude, requests, readings, watchers, watchErrors };
}

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

test('installing copies the mod into a local catalogue and installs it with Claude Code', async (t) => {
  const { root, mod, claude } = setup(t);
  assert.equal(mod.status().state, 'off');
  const status = await mod.install();
  assert.equal(status.state, 'on');
  assert.deepEqual(claude.calls, [
    '--version',
    `plugin marketplace add ${path.join(root, 'marketplace')}`,
    `plugin install ${PLUGIN_ID} --scope user`,
  ]);
  for (const file of MOD_FILES) {
    assert.equal(read(root, 'marketplace', 'ai-usage', ...file.split('/')), read(SOURCE, ...file.split('/')), file);
  }
  assert.equal(fs.existsSync(path.join(root, 'marketplace', 'ai-usage', 'tests')), false);
  assert.deepEqual(JSON.parse(read(root, 'marketplace', 'ai-usage', 'ai-usage.json')), {
    glance: path.join(root, 'glance.json'),
    readings: path.join(root, 'readings'),
    requests: path.join(root, 'requests'),
  });
  const catalogue = JSON.parse(read(root, 'marketplace', '.claude-plugin', 'marketplace.json'));
  assert.equal(catalogue.name, 'ai-usage-app');
  assert.deepEqual(catalogue.plugins.map((plugin) => [plugin.name, plugin.source]), [['ai-usage', './ai-usage']]);
  assert.ok(fs.statSync(path.join(root, 'readings')).isDirectory());
});

test('a Claude Code too old for mods is named, and nothing is installed', async (t) => {
  const { root, mod, claude } = setup(t, { version: '2.1.285 (Claude Code)' });
  await assert.rejects(mod.install(), /Claude Code 2\.1\.287 or later runs mods; this computer has 2\.1\.285/);
  assert.deepEqual(claude.calls, ['--version']);
  assert.equal(fs.existsSync(path.join(root, 'marketplace')), false);
  assert.equal(mod.status().state, 'off');
});

test('without Claude Code, installing asks for it first', async (t) => {
  const { mod } = setup(t, { noBinary: true });
  await assert.rejects(mod.install(), /Install Claude Code first/);
});

test('a mod turned off in Claude Code is turned back on by installing again', async (t) => {
  const { mod, claude } = setup(t, { enabled: false });
  fs.mkdirSync(path.join(mod.paths.plugin, '.claude-plugin'), { recursive: true });
  fs.copyFileSync(path.join(SOURCE, '.claude-plugin', 'plugin.json'), path.join(mod.paths.plugin, '.claude-plugin', 'plugin.json'));
  assert.equal(mod.status().state, 'disabled');
  assert.equal((await mod.install()).state, 'on');
  assert.equal(claude.calls.at(-1), `plugin install ${PLUGIN_ID} --scope user`);
});

test('a mod turned back on in Claude Code is followed without restarting the app', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { root, mod, claude, requests, watchers } = setup(t, { enabled: false });
  fs.mkdirSync(path.join(mod.paths.plugin, '.claude-plugin'), { recursive: true });
  fs.copyFileSync(path.join(SOURCE, '.claude-plugin', 'plugin.json'), path.join(mod.paths.plugin, '.claude-plugin', 'plugin.json'));
  assert.equal(mod.start(), 'disabled');
  assert.equal(watchers.size, 0);
  // The glance stays current while the mod is off, ready for when it is on again.
  mod.publish({ settings: {}, sources: [], quotas: {}, generatedAt: new Date().toISOString() });
  assert.ok(fs.existsSync(path.join(root, 'glance.json')));
  claude.settings.enabledPlugins[PLUGIN_ID] = true;
  t.mock.timers.tick(60_000);
  assert.deepEqual([...watchers.keys()].sort(), ['readings', 'requests']);
  fs.writeFileSync(path.join(root, 'requests', '1-open.json'), JSON.stringify({
    format: 'ai-usage-claude-code-request', version: 1, action: 'open', requested_at: new Date().toISOString(),
  }));
  watchers.get('requests')();
  assert.deepEqual(requests, ['open']);
  // Turned off again, its folders are no longer followed.
  claude.settings.enabledPlugins[PLUGIN_ID] = false;
  t.mock.timers.tick(60_000);
  assert.equal(watchers.size, 0);
});

test('a mod installed again from Claude Code after the app started without it is followed', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { root, mod, claude, watchers } = setup(t);
  // Removed in Claude Code's /plugin: the catalogue and the app's copy stay.
  fs.mkdirSync(path.join(mod.paths.plugin, '.claude-plugin'), { recursive: true });
  fs.copyFileSync(path.join(SOURCE, '.claude-plugin', 'plugin.json'), path.join(mod.paths.plugin, '.claude-plugin', 'plugin.json'));
  assert.equal(mod.start(), 'off');
  mod.publish({ settings: {}, sources: [], quotas: {}, generatedAt: new Date().toISOString() });
  assert.equal(fs.existsSync(path.join(root, 'glance.json')), false);
  claude.settings.enabledPlugins[PLUGIN_ID] = true;
  t.mock.timers.tick(60_000);
  assert.deepEqual([...watchers.keys()].sort(), ['readings', 'requests']);
  // The glance starts from what the app last showed, without waiting for a collection.
  assert.equal(JSON.parse(read(root, 'glance.json')).schema, 1);
});

test('a refused install reports Claude Code\'s own message', async (t) => {
  const { mod } = setup(t, { failures: { 'plugin install': { message: 'Plugin not found in marketplace.' } } });
  await assert.rejects(mod.install(), /Claude Code could not install the mod\. Plugin not found in marketplace\./);
});

test('removing uninstalls the plugin and its catalogue, then the app\'s copy and glance', async (t) => {
  const { root, mod, claude } = setup(t);
  await mod.install();
  mod.publish({ settings: {}, sources: [], quotas: {}, generatedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(root, 'readings', 'waiting.json'), '{}');
  assert.ok(fs.existsSync(path.join(root, 'glance.json')));
  const status = await mod.uninstall();
  assert.equal(status.state, 'off');
  assert.deepEqual(claude.calls.slice(-2), [`plugin uninstall ${PLUGIN_ID} --scope user`, 'plugin marketplace remove ai-usage-app']);
  assert.equal(fs.existsSync(path.join(root, 'marketplace')), false);
  assert.equal(fs.existsSync(path.join(root, 'glance.json')), false);
  // A reading not yet imported is still imported by the next collection.
  assert.ok(fs.existsSync(path.join(root, 'readings', 'waiting.json')));
});

test('removing a mod Claude Code already forgot still tidies the app\'s side', async (t) => {
  const { root, mod } = setup(t, { failures: {
    'plugin uninstall': { failureCode: 'not_installed', message: 'not found' },
    'plugin marketplace remove': { failureCode: 'not_configured', message: 'not found' },
  } });
  fs.mkdirSync(path.join(root, 'marketplace', 'ai-usage'), { recursive: true });
  assert.equal((await mod.uninstall()).state, 'off');
  assert.equal(fs.existsSync(path.join(root, 'marketplace')), false);
});

test('the glance is written after a publish only while the mod is on', async (t) => {
  const { root, mod } = setup(t);
  const snapshot = { settings: {}, sources: [], quotas: {}, generatedAt: '2026-10-01T12:00:00.000Z' };
  mod.publish(snapshot);
  assert.equal(fs.existsSync(path.join(root, 'glance.json')), false);
  await mod.install();
  mod.publish(snapshot);
  const glance = JSON.parse(read(root, 'glance.json'));
  assert.equal(glance.schema, 1);
  assert.equal(glance.appVersion, '1.0.56');
  assert.equal(glance.generatedAt, '2026-10-01T12:00:00.000Z');
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')), []);
});

test('the glance is rewritten every few minutes so the mod knows the app is running', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-01T12:00:00.000Z') });
  const { root, mod } = setup(t);
  await mod.install();
  mod.publish({ settings: {}, sources: [], quotas: {}, generatedAt: '2026-10-01T12:00:00.000Z' });
  assert.equal(JSON.parse(read(root, 'glance.json')).writtenAt, '2026-10-01T12:00:00.000Z');
  t.mock.timers.tick(5 * 60_000);
  assert.equal(JSON.parse(read(root, 'glance.json')).writtenAt, '2026-10-01T12:05:00.000Z');
});

test('fresh requests are acted on once; stale, foreign and unknown ones are only removed', async (t) => {
  const { root, mod, requests, watchers } = setup(t);
  await mod.install();
  const request = (name, value) => fs.writeFileSync(path.join(root, 'requests', name), JSON.stringify(value));
  const now = Date.now();
  const fresh = (action, at = now) => ({ format: 'ai-usage-claude-code-request', version: 1, action, requested_at: new Date(at).toISOString() });
  request('1-sync.json', fresh('sync'));
  request('2-sync.json', fresh('sync'));
  request('3-open.json', fresh('open'));
  request('4-old.json', fresh('open', now - 10 * 60_000));
  request('5-unknown.json', fresh('delete-everything'));
  request('6-foreign.json', { ...fresh('sync'), format: 'other' });
  // A file that never became readable is discarded once it is old.
  fs.writeFileSync(path.join(root, 'requests', '7-torn.json'), '{"format":');
  const old = new Date(now - 60_000);
  fs.utimesSync(path.join(root, 'requests', '7-torn.json'), old, old);
  watchers.get('requests')();
  assert.deepEqual(requests, ['sync', 'open']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'requests')), []);
  // A second sync straight after is folded into the first.
  request('8-sync.json', fresh('sync'));
  watchers.get('requests')();
  assert.deepEqual(requests, ['sync', 'open']);
});

test('a request still being written is kept, and acted on once it is complete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { root, mod, requests, watchers } = setup(t);
  await mod.install();
  const file = path.join(root, 'requests', '1-open.json');
  // The folder event for a new file can arrive before its content does.
  for (const partial of ['', '{"format":"ai-usage-claude-code-request","vers']) {
    fs.writeFileSync(file, partial);
    watchers.get('requests')();
    assert.deepEqual(requests, []);
    assert.deepEqual(fs.readdirSync(path.join(root, 'requests')), ['1-open.json']);
  }
  fs.writeFileSync(file, JSON.stringify({
    format: 'ai-usage-claude-code-request', version: 1, action: 'open', requested_at: new Date().toISOString(),
  }));
  // Retried shortly even when no further folder event arrives.
  t.mock.timers.tick(1_000);
  assert.deepEqual(requests, ['open']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'requests')), []);
});

test('requests left while the mod was off are never acted on', async (t) => {
  const { root, mod, requests } = setup(t);
  fs.mkdirSync(path.join(root, 'requests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'requests', 'open.json'), JSON.stringify({
    format: 'ai-usage-claude-code-request', version: 1, action: 'open', requested_at: new Date().toISOString(),
  }));
  mod.takeRequests();
  assert.deepEqual(requests, []);
  assert.deepEqual(fs.readdirSync(path.join(root, 'requests')), []);
});

test('a reading that lands is imported shortly after, and the import\'s own removals start nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { root, mod, readings, watchers } = setup(t);
  await mod.install();
  fs.writeFileSync(path.join(root, 'readings', '1.json'), '{}');
  watchers.get('readings')();
  watchers.get('readings')();
  t.mock.timers.tick(2_000);
  assert.equal(readings.length, 1);
  fs.unlinkSync(path.join(root, 'readings', '1.json'));
  watchers.get('readings')();
  t.mock.timers.tick(2 * 60_000);
  assert.equal(readings.length, 1);
});

test('starting refreshes mod files an app update changed and leaves the rest untouched', async (t) => {
  const { root, mod } = setup(t);
  await mod.install();
  const register = path.join(root, 'marketplace', 'ai-usage', 'hooks', 'register.js');
  const view = path.join(root, 'marketplace', 'ai-usage', 'hooks', 'view.js');
  fs.writeFileSync(register, '// an older mod\n');
  const old = new Date('2026-09-01T00:00:00Z');
  fs.utimesSync(view, old, old);
  mod.start();
  assert.equal(fs.readFileSync(register, 'utf8'), read(SOURCE, 'hooks', 'register.js'));
  assert.equal(fs.statSync(view).mtimeMs, old.getTime());
});

test('the release packages exactly the mod files the app installs, and the audit requires them', () => {
  const pkg = JSON.parse(read(__dirname, '..', 'package.json'));
  const { assertArchive } = require('../tools/audit-release.cjs');
  for (const file of MOD_FILES) {
    const entry = `claude-code-mod/${file}`;
    assert.ok(pkg.build.files.some((pattern) => pattern === entry || path.posix.matchesGlob(entry, pattern)), entry);
  }
  for (const development of ['claude-code-mod/tests/ai-usage.test.ts', 'claude-code-mod/tsconfig.json', 'claude-code-mod/.claude-plugin/types/claude-code/index.d.ts']) {
    assert.ok(!pkg.build.files.some((pattern) => !pattern.startsWith('!') && path.posix.matchesGlob(development, pattern)), development);
  }
  const base = ['dist/index.html', 'dist/flyout.html', 'electron/main.cjs', 'electron/preload.cjs', 'electron/flyout-preload.cjs',
    'electron/maintenance-host.cjs', 'electron/maintenance-service.cjs', 'electron/desktop-estimates.cjs',
    'node_modules/@anthropic-ai/claude-agent-sdk/package.json'];
  const mod = MOD_FILES.map((file) => `claude-code-mod/${file}`);
  assert.doesNotThrow(() => assertArchive([...base, ...mod]));
  assert.throws(() => assertArchive([...base, ...mod.slice(1)]), /required application file is absent from ASAR: claude-code-mod\/\.claude-plugin\/plugin\.json/);
  assert.throws(() => assertArchive([...base, ...mod, 'claude-code-mod/tests/ai-usage.test.ts']), /mod development files are packaged/);
});

test('requests left while the mod was off are not acted on when it is turned on again', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { root, mod, claude, requests, watchers } = setup(t, { enabled: false });
  fs.mkdirSync(path.join(mod.paths.plugin, '.claude-plugin'), { recursive: true });
  fs.copyFileSync(path.join(SOURCE, '.claude-plugin', 'plugin.json'), path.join(mod.paths.plugin, '.claude-plugin', 'plugin.json'));
  fs.mkdirSync(path.join(root, 'requests'), { recursive: true });
  mod.start();
  const request = (name, action) => fs.writeFileSync(path.join(root, 'requests', name), JSON.stringify({
    format: 'ai-usage-claude-code-request', version: 1, action, requested_at: new Date(Date.now() - 1_000).toISOString(),
  }));
  // A session that still has the mod loaded asks while it is off.
  request('1-open.json', 'open');
  claude.settings.enabledPlugins[PLUGIN_ID] = true;
  t.mock.timers.tick(60_000);
  assert.deepEqual(requests, []);
  assert.deepEqual(fs.readdirSync(path.join(root, 'requests')), []);
  // Once it is on, a new request (after the last time the mod was seen off) is acted on.
  fs.writeFileSync(path.join(root, 'requests', '2-sync.json'), JSON.stringify({
    format: 'ai-usage-claude-code-request', version: 1, action: 'sync', requested_at: new Date(Date.now() + 10).toISOString(),
  }));
  watchers.get('requests')();
  assert.deepEqual(requests, ['sync']);
});

test('installing publishes the figures the app already has before the collection that follows', async () => {
  const { registerIpc } = require('../electron/ipc-handlers.cjs');
  const handlers = new Map();
  const published = [];
  const shown = { generatedAt: '2026-10-01T12:00:00.000Z', settings: {}, sources: [], quotas: {} };
  registerIpc({
    handleIpc: (channel, handler) => handlers.set(channel, handler),
    storageClosing: () => false,
    currentView: () => shown,
    databaseJobs: { run: async (job) => job() },
    // The collection after an install can fail; the mod still has figures.
    refreshClaudeOnly: () => Promise.reject(new Error('collector unavailable')),
    log: () => {},
    claudeCodeMod: { install: async () => ({ state: 'on' }), publish: (snapshot) => published.push(snapshot) },
  });
  assert.deepEqual(await handlers.get('claude-code-mod:install')({}), { state: 'on' });
  assert.deepEqual(published, [shown]);
});

test('a request written after the mod is turned off is not acted on, even before the next check', async (t) => {
  const { root, mod, claude, requests, watchers } = setup(t);
  await mod.install();
  // Turned off in /plugin; a session that still has the mod loaded asks at once.
  claude.settings.enabledPlugins[PLUGIN_ID] = false;
  fs.writeFileSync(path.join(root, 'requests', '1-open.json'), JSON.stringify({
    format: 'ai-usage-claude-code-request', version: 1, action: 'open', requested_at: new Date().toISOString(),
  }));
  watchers.get('requests')();
  assert.deepEqual(requests, []);
  assert.deepEqual(fs.readdirSync(path.join(root, 'requests')), []);
  assert.equal(watchers.size, 0);
});

test('a folder that could not be watched is watched at the next check', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { mod, watchers, watchErrors } = setup(t, { refuseWatchOnce: new Set(['readings']) });
  await mod.install();
  assert.deepEqual([...watchers.keys()], ['requests']);
  t.mock.timers.tick(60_000);
  assert.deepEqual([...watchers.keys()].sort(), ['readings', 'requests']);
  // A watcher that fails later, as when its folder is removed, is made again too.
  watchErrors.get('requests')(new Error('EPERM'));
  assert.deepEqual([...watchers.keys()], ['readings']);
  t.mock.timers.tick(60_000);
  assert.deepEqual([...watchers.keys()].sort(), ['readings', 'requests']);
});
