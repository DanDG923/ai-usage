'use strict';

// Fable fallback diagnostics.
//
// The app's primary allowance source is now the official experimental Claude
// Agent SDK usage reader. This support tool does not invoke that account-level
// reader; it inspects only the minimized optional status-line fallback and
// this device's transcripts. Its calibration report is exploratory evidence,
// not the formula or source of truth used by the current app.
//
// It reads three local surfaces, none of which it modifies:
//   1. The status-line inbox the dashboard's helper already writes. Claude Code
//      hands the status line a rich JSON payload per render; the helper stores
//      only capture time, model identity, and rate-limit fields.
//   2. The Claude Code transcripts under ~/.claude/projects.
//   3. The public Claude Code CLI command list, as a diagnostic only. The app's
//      SDK reader is a separate surface and is not disproved by no CLI command.
//
//   node tools/fable-probe.cjs surface   what Claude Code exposes, and how much of it we use
//   node tools/fable-probe.cjs report    calibrate allowance-per-token per model from history
//   node tools/fable-probe.cjs watch     follow both surfaces live while you work
//
// `watch` is the one to run in a spare terminal while you drive Fable: it prints
// each allowance movement next to the tokens that caused it, and appends the
// same records to tools/fable-probe.jsonl for a later `report`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = process.env.USERPROFILE || os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const INBOX = path.join(APPDATA, 'ai-usage', 'inbox');
const TRANSCRIPTS = path.join(HOME, '.claude', 'projects');
const OUTPUT = path.join(__dirname, 'fable-probe.jsonl');

const iso = (value) => new Date(value).toISOString();
const ms = (value) => new Date(value).getTime();

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line.replace(/^﻿/, '')));
    } catch { /* A partial trailing line is normal on a live file. */ }
  }
  return rows;
}

function inboxFiles() {
  if (!fs.existsSync(INBOX)) return [];
  return fs.readdirSync(INBOX)
    .filter((name) => name.startsWith('claude-statusline.jsonl'))
    .sort()
    .map((name) => path.join(INBOX, name));
}

// Every status-line payload Claude Code has handed the helper, flattened to the
// fields that bear on usage. Anything not listed here is still counted by
// `surface` so a new field cannot appear without being noticed.
function loadStatusLine() {
  const rows = [];
  for (const file of inboxFiles()) {
    for (const payload of readJsonLines(file)) {
      const at = payload.ai_usage_captured_at || payload.captured_at;
      if (!at || !Number.isFinite(ms(at))) continue;
      rows.push({
        at: iso(at),
        atMs: ms(at),
        sessionId: payload.session_id || null,
        model: payload.model?.id || null,
        displayName: payload.model?.display_name || null,
        version: payload.version || null,
        effort: payload.effort?.level || null,
        fastMode: Boolean(payload.fast_mode),
        thinking: Boolean(payload.thinking?.enabled),
        exceeds200k: Boolean(payload.exceeds_200k_tokens),
        sessionCostUsd: Number.isFinite(payload.cost?.total_cost_usd) ? payload.cost.total_cost_usd : null,
        contextWindowSize: payload.context_window?.context_window_size ?? null,
        rateLimits: payload.rate_limits || {},
        raw: payload,
      });
    }
  }
  return rows.sort((a, b) => a.atMs - b.atMs);
}

function transcriptFiles() {
  if (!fs.existsSync(TRANSCRIPTS)) return [];
  const found = [];
  const stack = [TRANSCRIPTS];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
    }
  }
  return found;
}

// One record per assistant message, de-duplicated the way the dashboard's
// importer does it: last entry wins for a given message id, because Claude Code
// writes a line per streaming update with accumulating output tokens.
function loadUsageEvents() {
  const byMessage = new Map();
  for (const file of transcriptFiles()) {
    for (const row of readJsonLines(file)) {
      if (row.type !== 'assistant') continue;
      const usage = row.message?.usage;
      const id = row.message?.id || row.requestId || row.uuid;
      if (!usage || !id || !row.timestamp) continue;
      const cacheCreation = usage.cache_creation || {};
      const cacheWrite1h = Number(cacheCreation.ephemeral_1h_input_tokens || 0);
      let cacheWrite5m = Number(cacheCreation.ephemeral_5m_input_tokens || 0);
      const cacheWriteTotal = Number(usage.cache_creation_input_tokens || cacheWrite5m + cacheWrite1h);
      if (cacheWrite5m + cacheWrite1h === 0 && cacheWriteTotal > 0) cacheWrite5m = cacheWriteTotal;
      byMessage.set(id, {
        at: iso(row.timestamp),
        atMs: ms(row.timestamp),
        sessionId: row.sessionId || null,
        model: row.message?.model || 'unknown',
        input: Number(usage.input_tokens || 0),
        cacheRead: Number(usage.cache_read_input_tokens || 0),
        cacheWrite: cacheWriteTotal,
        cacheWrite5m,
        cacheWrite1h,
        output: Number(usage.output_tokens || 0),
        reasoning: Number(usage.output_tokens_details?.reasoning_tokens || 0),
        sidechain: Boolean(row.isSidechain),
      });
    }
  }
  return [...byMessage.values()].sort((a, b) => a.atMs - b.atMs);
}

// Legacy exploratory weightings retained for comparing observed intervals.
// The shipped estimator uses its fixed, versioned allowance-pressure profile;
// it does not select one of these at runtime and user price edits cannot alter it.
const WEIGHTINGS = {
  billable: (e) => e.input + e.cacheWrite + e.output,
  dashboard: (e) => e.input + e.cacheWrite + e.output + e.cacheRead * 0.1,
  allTokens: (e) => e.input + e.cacheWrite + e.output + e.cacheRead,
  outputOnly: (e) => e.output,
};

function fmt(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

function compact(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// A pair of consecutive readings of the same limit, in the same window, where
// the percentage moved. The tokens spent in between are the cause; the movement
// is the effect. Window changes and provider jitter are dropped, not smoothed.
function buildIntervals(statusLine, events, limitKey) {
  const readings = statusLine
    .map((row) => ({ ...row, limit: row.rateLimits?.[limitKey] }))
    .filter((row) => row.limit && Number.isFinite(Number(row.limit.used_percentage)) && row.limit.resets_at != null);
  const intervals = [];
  for (let index = 1; index < readings.length; index += 1) {
    const before = readings[index - 1];
    const after = readings[index];
    if (String(before.limit.resets_at) !== String(after.limit.resets_at)) continue;
    const delta = Number(after.limit.used_percentage) - Number(before.limit.used_percentage);
    if (!(delta > 0)) continue;
    const spent = events.filter((event) => event.atMs > before.atMs && event.atMs <= after.atMs);
    if (!spent.length) continue;
    const byModel = new Map();
    for (const event of spent) {
      const bucket = byModel.get(event.model) || { model: event.model, count: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      bucket.count += 1;
      bucket.input += event.input;
      bucket.cacheRead += event.cacheRead;
      bucket.cacheWrite += event.cacheWrite;
      bucket.output += event.output;
      byModel.set(event.model, bucket);
    }
    intervals.push({
      from: before.at,
      to: after.at,
      deltaPercent: delta,
      minutes: (after.atMs - before.atMs) / 60_000,
      models: [...byModel.values()],
      messages: spent.length,
    });
  }
  return intervals;
}

// An interval is only usable for per-model calibration when one model produced
// essentially all of it. Mixed intervals cannot separate the models' rates
// without assuming the answer.
function isolate(intervals, weighting, purity = 0.95) {
  const perModel = new Map();
  for (const interval of intervals) {
    const totals = interval.models.map((m) => ({ model: m.model, weighted: weighting(m) }));
    const total = totals.reduce((sum, entry) => sum + entry.weighted, 0);
    if (total <= 0) continue;
    const dominant = totals.sort((a, b) => b.weighted - a.weighted)[0];
    if (dominant.weighted / total < purity) continue;
    const list = perModel.get(dominant.model) || [];
    // Percent of the weekly allowance consumed per million weighted tokens.
    list.push({ rate: interval.deltaPercent / (total / 1e6), interval, weighted: total });
    perModel.set(dominant.model, list);
  }
  return perModel;
}

let claudeBinary;
function findClaude() {
  if (claudeBinary !== undefined) return claudeBinary;
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], {
    encoding: 'utf8', windowsHide: true,
  });
  const found = (lookup.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  claudeBinary = found && fs.existsSync(found) ? found : null;
  return claudeBinary;
}

function runClaude(args) {
  const binary = findClaude();
  if (!binary) return { ok: false, output: '' };
  const run = spawnSync(binary, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return { ok: run.status === 0, output: (run.stdout || run.stderr || '').trim() };
}

// `claude <unknown> --help` prints the top-level help rather than failing, so a
// zero exit status proves nothing. Compare against the top-level help and treat
// an identical body as "no such subcommand".
function commandSurface() {
  const version = runClaude(['--version']);
  const help = runClaude(['--help']);
  const commands = [];
  const section = help.output.split(/^Commands:/m)[1];
  if (section) {
    for (const line of section.split(/\r?\n/)) {
      const match = line.match(/^\s{2}([a-z][\w:-]*)/);
      if (match) commands.push(match[1]);
    }
  }
  const probes = ['usage', 'cost', 'limits', 'quota'].map((name) => {
    const attempt = runClaude([name, '--help']);
    const distinct = attempt.ok && attempt.output && attempt.output !== help.output;
    return { name, exists: commands.includes(name) || distinct, output: attempt.output };
  });
  return { version: version.output, commands, probes };
}

function surface() {
  const statusLine = loadStatusLine();
  const events = loadUsageEvents();
  console.log('=== Status-line payloads captured by the AI Usage helper ===');
  console.log(`inbox            ${INBOX}`);
  console.log(`payloads         ${statusLine.length}`);
  if (statusLine.length) {
    console.log(`range            ${statusLine[0].at}  ->  ${statusLine.at(-1).at}`);
    console.log(`Claude Code      ${[...new Set(statusLine.map((r) => r.version).filter(Boolean))].join(', ')}`);
  }

  const fields = new Map();
  const walk = (object, prefix) => {
    for (const [key, value] of Object.entries(object || {})) {
      const label = prefix ? `${prefix}.${key}` : key;
      fields.set(label, (fields.get(label) || 0) + 1);
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, label);
    }
  };
  for (const row of statusLine) walk(row.raw, '');

  // Everything the dashboard actually consumes out of that payload today.
  const USED = new Set(['model.id', 'model.display_name', 'rate_limits', 'ai_usage_captured_at']);
  const usedPrefix = (label) => USED.has(label) || label.startsWith('rate_limits.') || [...USED].some((u) => label === u);
  console.log('\n=== Payload fields, and whether the dashboard reads them ===');
  for (const [label, count] of [...fields.entries()].sort()) {
    if (label.split('.').length > 2) continue;
    console.log(`  ${usedPrefix(label) ? 'used  ' : '      '} ${label.padEnd(34)} ${count}`);
  }

  const limitKeys = new Map();
  for (const row of statusLine) for (const key of Object.keys(row.rateLimits)) limitKeys.set(key, (limitKeys.get(key) || 0) + 1);
  console.log('\n=== Allowance buckets Claude Code exposes ===');
  if (!limitKeys.size) console.log('  (none seen)');
  for (const [key, count] of [...limitKeys.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${key.padEnd(24)} ${count} payloads`);
  const fableKey = [...limitKeys.keys()].find((key) => key.toLowerCase().includes('fable'));
  console.log(fableKey
    ? `\n  A Fable-specific fallback bucket EXISTS (${fableKey}) - the dashboard reads it directly.`
    : '\n  No Fable-specific bucket is present in the optional fallback payloads. The separate\n  account-level SDK reader may still supply an exact model-scoped Fable window.');

  const models = new Map();
  for (const event of events) models.set(event.model, (models.get(event.model) || 0) + 1);
  console.log('\n=== Models in local transcripts ===');
  for (const [model, count] of [...models.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${model.padEnd(34)} ${count} messages`);

  console.log('\n=== Claude Code CLI surface ===');
  const cli = commandSurface();
  console.log(`  version    ${cli.version || '(not found)'}`);
  console.log(`  commands   ${cli.commands.join(', ') || '(none listed)'}`);
  const found = cli.probes.filter((probe) => probe.exists);
  console.log(found.length
    ? `  usage-related subcommands: ${found.map((p) => p.name).join(', ')} - diagnostic only; the app uses the SDK reader.`
    : '  No usage, cost, limits or quota subcommand exists. This says nothing about the\n  separate experimental SDK usage method used by the app.');
}

// Why the derived Fable percentage is what it is, and whether it can be trusted.
function calibrate() {
  const statusLine = loadStatusLine();
  const events = loadUsageEvents().filter((event) => event.model.toLowerCase().includes('fable'));
  if (!events.length) {
    console.log('No local Fable messages found.');
    return;
  }
  const weekly = statusLine.map((row) => row.rateLimits?.seven_day).filter(Boolean).at(-1);
  console.log('=== What the Fable estimate is calibrated from ===');
  if (!weekly) {
    console.log('  No seven_day reading captured yet.');
    return;
  }
  const resetsAtMs = Number(weekly.resets_at) * (Number(weekly.resets_at) < 1e11 ? 1000 : 1);
  const windowStartMs = resetsAtMs - 7 * 24 * 3600 * 1000;
  const firstLocalMs = events[0].atMs;
  const uncovered = Math.max(0, firstLocalMs - windowStartMs);
  const coverage = 1 - uncovered / (7 * 24 * 3600 * 1000);
  console.log(`  weekly window opened      ${iso(windowStartMs)}`);
  console.log(`  earliest local Fable use  ${iso(firstLocalMs)}`);
  console.log(`  window covered locally    ${fmt(coverage * 100, 0)}%`);
  console.log(`  overall now               ${weekly.used_percentage}%`);
  console.log(`  same-time 2x ceiling     ${fmt(Math.min(100, weekly.used_percentage * 2), 0)}%`);
  console.log('  (That ceiling applies at this observation time only; later local activity is not capped by an older overall reading.)');
  if (coverage < 0.98) {
    console.log(`\n  ${fmt((1 - coverage) * 100, 0)}% of this window predates any local record. That no longer distorts`);
    console.log('  the estimate: only intervals bounded by two official overall readings are');
    console.log('  used, so history this machine never saw is simply absent rather than');
    console.log('  wrongly attributed. It does mean the total can understate a week that');
    console.log('  started elsewhere - one official Fable reading re-anchors it.');
  }

  const steps = [];
  const readings = statusLine.map((row) => row.rateLimits?.seven_day).filter(Boolean);
  let previous = null;
  for (const row of statusLine) {
    const limit = row.rateLimits?.seven_day;
    if (!limit) continue;
    if (previous && limit.used_percentage > previous.used) steps.push({ at: row.at, delta: limit.used_percentage - previous.used });
    previous = { used: limit.used_percentage, at: row.at };
  }
  console.log('\n=== Calibration steps available ===');
  console.log(`  ${readings.length} overall readings captured, ${steps.length} of them a forward step.`);
  if (!steps.length) {
    console.log('  The overall percentage has not moved, so there is nothing to split between');
    console.log('  models yet. It is a whole number on a weekly window - leave `watch` running');
    console.log('  and each tick becomes one calibration step.');
  } else {
    for (const step of steps.slice(-5)) console.log(`  ${step.at}  +${step.delta} point(s)`);
  }
}

function report() {
  const statusLine = loadStatusLine();
  const events = loadUsageEvents();
  if (!statusLine.length) {
    console.log('No status-line payloads found. Enable the helper in AI Usage and use Claude Code first.');
    return;
  }
  const limitKeys = new Set();
  for (const row of statusLine) for (const key of Object.keys(row.rateLimits)) limitKeys.add(key);

  console.log('Exploratory report only: the app uses a fixed allowance-pressure profile, not the candidate weightings below.');
  for (const limitKey of [...limitKeys].sort()) {
    const intervals = buildIntervals(statusLine, events, limitKey);
    console.log(`\n=== ${limitKey}: ${intervals.length} intervals where the percentage moved with local token activity ===`);
    if (!intervals.length) {
      // Distinguish "no data" from "the provider figure simply never moved" —
      // an integer percentage on a weekly window can sit still for hours.
      const readings = statusLine.map((row) => row.rateLimits?.[limitKey]).filter(Boolean);
      const values = [...new Set(readings.map((limit) => limit.used_percentage))];
      if (readings.length >= 2 && values.length === 1) {
        console.log(`  ${readings.length} readings, all at ${values[0]}% - the provider figure never moved, so there is`);
        console.log('  nothing to calibrate against. It is reported as a whole number, which on a');
        console.log('  weekly window can sit still through hours of heavy use. Leave `watch` running');
        console.log('  until it ticks; each tick is one usable calibration point.');
      } else if (readings.length < 2) {
        console.log('  Fewer than two readings captured. Run `watch` while you work.');
      } else {
        console.log('  The percentage moved, but no local token records fall between the readings.');
      }
      continue;
    }

    for (const [name, weighting] of Object.entries(WEIGHTINGS)) {
      const perModel = isolate(intervals, weighting);
      const parts = [];
      for (const [model, samples] of [...perModel.entries()].sort()) {
        const rates = samples.map((s) => s.rate);
        const mid = median(rates);
        const spread = rates.length > 1 ? (Math.max(...rates) - Math.min(...rates)) / (mid || 1) : 0;
        parts.push(`${model} ${fmt(mid, 3)}%/Mtok (n=${rates.length}, spread ${fmt(spread * 100, 0)}%)`);
      }
      console.log(`  ${name.padEnd(11)} ${parts.join('  |  ') || '(no single-model intervals)'}`);
    }

    const dashboard = isolate(intervals, WEIGHTINGS.dashboard);
    const fable = [...dashboard.entries()].find(([model]) => model.toLowerCase().includes('fable'));
    const others = [...dashboard.entries()].filter(([model]) => !model.toLowerCase().includes('fable'));
    if (fable && others.length) {
      const fableRate = median(fable[1].map((s) => s.rate));
      for (const [model, samples] of others) {
        const rate = median(samples.map((s) => s.rate));
        if (rate > 0) console.log(`  -> Fable costs ${fmt(fableRate / rate, 2)}x what ${model} costs per weighted token against ${limitKey}.`);
      }
    }
  }

  // Old helper rows may contain session cost. Helper 1.0.3 deliberately omits
  // it, so this cross-check is retained only for historical diagnostic data.
  const bySession = new Map();
  for (const row of statusLine) {
    if (row.sessionCostUsd == null || !row.sessionId) continue;
    const list = bySession.get(row.sessionId) || [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }
  let claudeCost = 0;
  for (const rows of bySession.values()) {
    const costs = rows.map((r) => r.sessionCostUsd).filter((value) => Number.isFinite(value));
    if (costs.length) claudeCost += Math.max(...costs);
  }
  console.log(`\n=== Cost cross-check ===`);
  if (bySession.size) {
    console.log(`  Historical helper rows expose Claude Code totals across ${bySession.size} sessions: $${fmt(claudeCost, 2)}`);
    console.log('  Current minimized helper rows intentionally do not retain session cost.');
  } else {
    console.log('  Unavailable by design: the minimized helper does not retain session-level cost.');
  }
}

function watch() {
  console.log('Watching the status line and transcripts. Drive Fable in another window; Ctrl+C to stop.');
  console.log(`Appending to ${OUTPUT}\n`);
  let seenStatus = loadStatusLine().length;
  let seenEvents = new Set(loadUsageEvents().map((e) => `${e.sessionId}:${e.atMs}:${e.model}`));
  let lastLimits = null;

  const tick = () => {
    const statusLine = loadStatusLine();
    const events = loadUsageEvents();
    const fresh = statusLine.slice(seenStatus);
    seenStatus = statusLine.length;

    const newEvents = events.filter((e) => !seenEvents.has(`${e.sessionId}:${e.atMs}:${e.model}`));
    for (const event of newEvents) seenEvents.add(`${event.sessionId}:${event.atMs}:${event.model}`);

    for (const event of newEvents) {
      fs.appendFileSync(OUTPUT, `${JSON.stringify({ kind: 'usage', ...event })}\n`);
      console.log(`  ${event.at}  ${event.model.padEnd(26)} in ${compact(event.input).padStart(7)}  cacheR ${compact(event.cacheRead).padStart(7)}  cacheW ${compact(event.cacheWrite).padStart(7)}  out ${compact(event.output).padStart(6)}`);
    }
    for (const row of fresh) {
      fs.appendFileSync(OUTPUT, `${JSON.stringify({ kind: 'statusline', at: row.at, model: row.model, sessionId: row.sessionId, rateLimits: row.rateLimits, sessionCostUsd: row.sessionCostUsd })}\n`);
      const summary = Object.entries(row.rateLimits)
        .map(([key, limit]) => `${key} ${limit?.used_percentage}%`).join('  ');
      if (summary && summary !== lastLimits) {
        console.log(`* ${row.at}  ALLOWANCE  ${summary}   session $${fmt(row.sessionCostUsd, 3)}`);
        lastLimits = summary;
      }
    }
  };

  tick();
  setInterval(tick, 5_000);
}

const command = process.argv[2] || 'surface';
if (command === 'surface') surface();
else if (command === 'report') report();
else if (command === 'calibrate') calibrate();
else if (command === 'watch') watch();
else {
  console.log('Usage: node tools/fable-probe.cjs [surface|report|calibrate|watch]');
  process.exit(1);
}
