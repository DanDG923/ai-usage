'use strict';

// The AI Usage mod for Claude Code (claude-code-mod/): installing it, keeping
// its files current, writing the glance it draws, and answering what it asks.
//
// The mod is installed the way Claude Code documents for any plugin: from a
// marketplace, here a local one the app keeps in its own folder, through the
// user's own `claude plugin` commands. A plugin from a local folder loads in
// place, so an app update refreshes the mod without reinstalling it.
//
// Nothing here contacts Anthropic. The mod's readings are the limits Claude
// Code already holds, and a sync it asks for is a local collection.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { findClaudeBinary, providerProcessOptions } = require('./provider-executable.cjs');
const { buildGlance } = require('./claude-code-glance.cjs');

const MARKETPLACE = 'ai-usage-app';
const PLUGIN = 'ai-usage';
const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
// Mods are on by default from this release of Claude Code.
const MINIMUM_CLAUDE_CODE = [2, 1, 287];
// What the app copies from its own claude-code-mod/ folder; tests stay behind.
const MOD_FILES = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.js', 'hooks/view.js'];
const REQUEST_FORMAT = 'ai-usage-claude-code-request';
const REQUEST_ACTIONS = new Set(['sync', 'open']);
// A request is acted on only while it is fresh: one left while the app was
// closed is not a reason to open the dashboard at the next launch.
const REQUEST_TTL_MS = 2 * 60_000;
const HEARTBEAT_MS = 5 * 60_000;
// Claude Code's /plugin can turn the mod off and on while the app runs.
const STATE_CHECK_MS = 60_000;
const SYNC_MIN_INTERVAL_MS = 15_000;
const READING_IMPORT_DELAY_MS = 2_000;
// Each import is a whole Claude collection, so a busy session's readings
// are gathered into one every couple of minutes.
const READING_IMPORT_MIN_INTERVAL_MS = 2 * 60_000;
// The mod writes a request in place, so the folder can report it before its
// content lands. One that does not parse is retried until it is this old.
const TORN_REQUEST_GRACE_MS = 10_000;
const TORN_REQUEST_RETRY_MS = 1_000;

function claudeCodeModPaths(root) {
  const marketplace = path.join(root, 'marketplace');
  return {
    root,
    marketplace,
    plugin: path.join(marketplace, PLUGIN),
    glance: path.join(root, 'glance.json'),
    readings: path.join(root, 'readings'),
    requests: path.join(root, 'requests'),
  };
}

function parseVersion(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function atLeast(version, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

function runClaude(binary, args, { environment, timeoutMs = 90_000 }) {
  return new Promise((resolve) => {
    execFile(binary, args, { ...providerProcessOptions(binary, environment), windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve({ ok: !error, timedOut: Boolean(error?.killed), stdout: String(stdout || '') }));
  });
}

// `claude plugin … --json` prints one result line; anything else on stdout is
// a human message.
function resultOf(stdout) {
  for (const line of String(stdout).split(/\r?\n/).toReversed()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && typeof value.outcome === 'string') return value;
    } catch { /* Not the result line. */ }
  }
  return null;
}

// Writes only what differs, so an unchanged mod keeps its files' times and a
// running Claude Code session sees nothing new.
function writeIfChanged(filePath, content) {
  try {
    if (fs.readFileSync(filePath).equals(Buffer.from(content))) return false;
  } catch { /* Missing: written below. */ }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return true;
}

// Replaces the glance in one step, so the mod never reads half a file. A
// reader holding the old one open can refuse the swap on Windows; the copy is
// then rewritten in place and the mod keeps its last good glance meanwhile.
function writeAtomically(filePath, text) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporary, text, 'utf8');
  try {
    fs.renameSync(temporary, filePath);
  } catch {
    fs.writeFileSync(filePath, text, 'utf8');
    try { fs.unlinkSync(temporary); } catch { /* Removed with the next write. */ }
  }
}

/**
 * @param {object} options
 * @param {string} options.root the app's folder for the mod (userData/claude-code)
 * @param {string} options.sourceDirectory the mod as the app ships it
 * @param {() => object} options.readClaudeSettings Claude Code's user settings, parsed
 * @param {(action: 'sync' | 'open') => void} options.onRequest
 * @param {() => void} options.onReading
 */
function createClaudeCodeMod({
  root,
  sourceDirectory,
  readClaudeSettings,
  appVersion = null,
  environment = process.env,
  findBinary = findClaudeBinary,
  run = runClaude,
  onRequest = () => {},
  onReading = () => {},
  log = () => {},
  now = Date.now,
  watch = fs.watch,
}) {
  const paths = claudeCodeModPaths(root);
  let busy = false;
  let state = 'off';
  let lastGlance = null;
  let lastSnapshot = null;
  let checker = null;
  let lastBeatAt = -Infinity;
  let watchers = [];
  let lastSyncAt = -Infinity;
  let readingTimer = null;
  let requestRetry = null;
  // Requests from before this moment were left while the mod was off.
  let ignoreRequestsBefore = -Infinity;
  let lastReadingImportAt = -Infinity;
  let stopped = false;

  // 'on', 'disabled' (turned off in Claude Code's /plugin) or 'off'.
  function readState() {
    const present = fs.existsSync(path.join(paths.plugin, '.claude-plugin', 'plugin.json'));
    let enabled;
    // Claude Code's settings are read only for a mod the app has installed.
    try { enabled = present ? readClaudeSettings()?.enabledPlugins?.[PLUGIN_ID] : undefined; } catch { enabled = undefined; }
    state = enabled === true ? 'on' : enabled === false ? 'disabled' : 'off';
    return state;
  }

  function status() {
    return { state: readState(), busy, pluginId: PLUGIN_ID, marketplace: paths.marketplace };
  }

  // The mod's files, where it finds the app's, and the one-plugin catalogue.
  function writeModFiles() {
    let changed = false;
    for (const file of MOD_FILES) {
      changed = writeIfChanged(path.join(paths.plugin, ...file.split('/')), fs.readFileSync(path.join(sourceDirectory, ...file.split('/')))) || changed;
    }
    const located = { glance: paths.glance, readings: paths.readings, requests: paths.requests };
    changed = writeIfChanged(path.join(paths.plugin, 'ai-usage.json'), `${JSON.stringify(located, null, 2)}\n`) || changed;
    const catalogue = {
      name: MARKETPLACE,
      owner: { name: 'AI Usage' },
      description: 'The AI Usage app\'s own plugins, kept on this computer by the app.',
      plugins: [{ name: PLUGIN, source: `./${PLUGIN}`, description: 'Your AI Usage allowances inside Claude Code' }],
    };
    changed = writeIfChanged(path.join(paths.marketplace, '.claude-plugin', 'marketplace.json'), `${JSON.stringify(catalogue, null, 2)}\n`) || changed;
    for (const folder of [paths.readings, paths.requests]) fs.mkdirSync(folder, { recursive: true });
    return changed;
  }

  async function claude(binary, args, failure, accepted = []) {
    const { stdout, timedOut } = await run(binary, [...args, '--json'], { environment });
    const result = resultOf(stdout);
    if (result?.outcome === 'ok' || accepted.includes(result?.failureCode)) return result;
    throw new Error(timedOut ? `${failure} Claude Code did not answer in time.` : `${failure}${result?.message ? ` ${result.message}` : ''}`);
  }

  async function exclusive(action) {
    if (busy) throw new Error('The Claude Code mod is already being changed.');
    busy = true;
    try {
      await action();
    } finally {
      busy = false;
    }
    return status();
  }

  const install = () => exclusive(async () => {
    const binary = findBinary();
    if (!binary) throw new Error('Install Claude Code first, from Set up Claude.');
    const { stdout } = await run(binary, ['--version'], { environment, timeoutMs: 20_000 });
    const version = parseVersion(stdout);
    if (!version || !atLeast(version, MINIMUM_CLAUDE_CODE)) {
      throw new Error(`Claude Code ${MINIMUM_CLAUDE_CODE.join('.')} or later runs mods${version ? `; this computer has ${version.join('.')}` : ''}. Update Claude Code (claude update), then try again.`);
    }
    writeModFiles();
    await claude(binary, ['plugin', 'marketplace', 'add', paths.marketplace], 'Claude Code could not add the AI Usage plugins.');
    await claude(binary, ['plugin', 'install', PLUGIN_ID, '--scope', 'user'], 'Claude Code could not install the mod.');
    if (readState() === 'disabled') {
      await claude(binary, ['plugin', 'enable', PLUGIN_ID, '--scope', 'user'], 'Claude Code could not turn the mod on.');
    }
    if (readState() !== 'on') throw new Error('Claude Code did not record the mod as installed. Try again.');
    start();
    log('Claude Code mod installed.');
  });

  // Claude Code removes the plugin and the catalogue; the app then removes
  // its copy and the glance. Readings not yet imported stay for the next
  // collection, which imports them whether or not the mod is installed.
  const uninstall = () => exclusive(async () => {
    const binary = findBinary();
    if (binary) {
      await claude(binary, ['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user'], 'Claude Code could not remove the mod.', ['not_installed']);
      await claude(binary, ['plugin', 'marketplace', 'remove', MARKETPLACE], 'Claude Code could not remove the AI Usage plugins.', ['not_configured']);
    } else if (readState() !== 'off') {
      throw new Error('Claude Code was not found, so the mod could not be removed from it.');
    }
    stopWatching();
    ignoreRequestsBefore = now();
    fs.rmSync(paths.marketplace, { recursive: true, force: true });
    fs.rmSync(paths.glance, { force: true });
    lastGlance = null;
    readState();
    log('Claude Code mod removed.');
  });

  function writeGlance(glance) {
    try {
      writeAtomically(paths.glance, `${JSON.stringify(glance)}\n`);
    } catch (error) {
      log(`Claude Code glance could not be written: ${error.message}`);
    }
  }

  // Called after every publish. The glance is written only while the mod is
  // installed, so an app without it leaves nothing behind; one turned off in
  // Claude Code keeps it current for when it is turned on again.
  function publish(snapshot) {
    if (stopped || !snapshot) return;
    lastSnapshot = snapshot;
    if (state === 'off') return;
    try {
      lastGlance = buildGlance(snapshot, { nowMs: now(), appVersion });
    } catch (error) {
      log(`Claude Code glance could not be built: ${error.message}`);
      return;
    }
    lastBeatAt = now();
    writeGlance(lastGlance);
  }

  // Requests the mod left: acted on once each, only while fresh, and removed
  // whether or not they were acted on.
  function takeRequests() {
    let names = [];
    try { names = fs.readdirSync(paths.requests).filter((name) => name.endsWith('.json')).sort(); } catch { return; }
    const actions = new Set();
    let writing = false;
    for (const name of names) {
      const filePath = path.join(paths.requests, name);
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      let request = null;
      try {
        if (stat.size <= 4096) request = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch { /* Still being written, or never readable: judged below. */ }
      if (request === null && stat.size <= 4096 && Date.now() - stat.mtimeMs < TORN_REQUEST_GRACE_MS) {
        writing = true;
        continue;
      }
      try { fs.unlinkSync(filePath); } catch { /* Seen again next time; actions are idempotent. */ }
      const at = Date.parse(request?.requested_at);
      if (request?.format !== REQUEST_FORMAT || request.version !== 1 || !REQUEST_ACTIONS.has(request.action)) continue;
      if (!Number.isFinite(at) || at <= ignoreRequestsBefore || at < now() - REQUEST_TTL_MS || at > now() + REQUEST_TTL_MS) continue;
      actions.add(request.action);
    }
    // The write that completes a request may raise no event of its own.
    if (writing && !requestRetry && !stopped) {
      requestRetry = setTimeout(() => {
        requestRetry = null;
        takeRequests();
      }, TORN_REQUEST_RETRY_MS);
      requestRetry.unref?.();
    }
    if (stopped || state !== 'on') return;
    if (actions.has('sync') && now() - lastSyncAt >= SYNC_MIN_INTERVAL_MS) {
      lastSyncAt = now();
      onRequest('sync');
    }
    if (actions.has('open')) onRequest('open');
  }

  // A new reading is imported a moment after it lands, and those that follow
  // at most every two minutes, so the dashboard and the glance follow Claude
  // Code without a collection after every response.
  function readingLanded() {
    if (stopped || readingTimer) return;
    const wait = Math.max(READING_IMPORT_DELAY_MS, lastReadingImportAt + READING_IMPORT_MIN_INTERVAL_MS - now());
    readingTimer = setTimeout(() => {
      readingTimer = null;
      // The import's own removals wake the watcher too; only a reading still
      // waiting is a reason to collect.
      let waiting = false;
      try { waiting = fs.readdirSync(paths.readings).some((name) => name.endsWith('.json')); } catch { /* Nothing to import. */ }
      if (stopped || !waiting) return;
      lastReadingImportAt = now();
      onReading();
    }, wait);
    readingTimer.unref?.();
  }

  function watchFolder(folder, listener) {
    try {
      const watcher = watch(folder, { persistent: false }, listener);
      watcher.on?.('error', () => { /* A removed folder stops its watcher; start() makes a new one. */ });
      watchers.push(watcher);
    } catch (error) {
      log(`Claude Code mod folder could not be watched: ${error.message}`);
    }
  }

  // The mod's folders are followed only while it is on.
  function follow() {
    if (watchers.length) return;
    watchFolder(paths.requests, () => takeRequests());
    watchFolder(paths.readings, () => readingLanded());
    takeRequests();
  }

  function unfollow() {
    for (const watcher of watchers) {
      try { watcher.close(); } catch { /* Already closed. */ }
    }
    watchers = [];
    clearTimeout(readingTimer);
    readingTimer = null;
    clearTimeout(requestRetry);
    requestRetry = null;
  }

  function stopWatching() {
    unfollow();
    clearInterval(checker);
    checker = null;
  }

  // Every minute: follow the mod being turned on or off in Claude Code, and
  // every few minutes rewrite the glance even without a collection, which
  // tells the mod the app is still there.
  function check() {
    if (readState() === 'on') follow();
    else {
      // A session that still has the mod loaded can ask while it is off;
      // turning it on again must not act on what it asked then.
      ignoreRequestsBefore = now();
      unfollow();
    }
    // Installed again from Claude Code's own /plugin: the glance starts from
    // what the app last showed.
    if (state !== 'off' && !lastGlance && lastSnapshot) publish(lastSnapshot);
    if (state !== 'off' && lastGlance && now() - lastBeatAt >= HEARTBEAT_MS) {
      lastBeatAt = now();
      writeGlance({ ...lastGlance, writtenAt: new Date(lastBeatAt).toISOString() });
    }
  }

  // At launch and after an install: refresh the mod's files if the app was
  // updated, then follow its folders while it is on. The check runs even
  // while the mod is off, since Claude Code's /plugin can install it again
  // from the catalogue the app left.
  function start() {
    stopped = false;
    stopWatching();
    if (readState() !== 'off') {
      try {
        if (writeModFiles()) log('Claude Code mod files updated; Claude Code loads them at its next session.');
      } catch (error) {
        log(`Claude Code mod files could not be updated: ${error.message}`);
      }
    }
    lastBeatAt = now();
    check();
    checker = setInterval(check, STATE_CHECK_MS);
    checker.unref?.();
    return state;
  }

  function stop() {
    stopped = true;
    stopWatching();
  }

  return { paths, status, install, uninstall, start, stop, publish, takeRequests, active: () => state === 'on' };
}

module.exports = { MARKETPLACE, MINIMUM_CLAUDE_CODE, MOD_FILES, PLUGIN_ID, claudeCodeModPaths, createClaudeCodeMod };
