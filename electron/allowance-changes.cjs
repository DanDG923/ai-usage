'use strict';

// A provider percentage is a share of whatever allowance was in force when it
// was read. When the allowance itself changes size — a promotional boost ends,
// a plan is upgraded — every earlier reading is a share of a different whole,
// and the first reading afterwards steps by the ratio of the two allowances
// without a token being spent. Learning treats that step as usage and the
// earlier readings as smaller than they were in today's terms.
//
// A recorded change says "before `at`, this subscription's allowance was
// `previousAllowancePercent` of the allowance that replaced it". Readings
// before it are multiplied by that ratio; readings after it are untouched.
// Each entry compares neighbouring allowances, never today's, so a reading
// before two changes is scaled by both ratios and an entry stays correct
// when the allowance changes again later.

const ALLOWANCE_CHANGE_SOURCES = ['claude', 'codex'];
const MAX_ALLOWANCE_CHANGES = 24;
const EARLIEST_CHANGE_MS = Date.parse('2020-01-01T00:00:00Z');
const FUTURE_TOLERANCE_MS = 5 * 60_000;

// Fable shares Claude's weekly pool (its cap is half of it), so a Claude
// allowance change moves both readings by the same ratio.
function allowanceFamily(sourceId) {
  return sourceId === 'claude-fable' ? 'claude' : sourceId;
}

function isAllowanceChange(value, nowMs = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'at,previousAllowancePercent,source') return false;
  if (!ALLOWANCE_CHANGE_SOURCES.includes(value.source)) return false;
  if (typeof value.at !== 'string') return false;
  const atMs = Date.parse(value.at);
  if (!Number.isFinite(atMs) || new Date(atMs).toISOString() !== value.at
    || atMs < EARLIEST_CHANGE_MS || atMs > nowMs + FUTURE_TOLERANCE_MS) return false;
  const percent = value.previousAllowancePercent;
  // 100% is not a change; the bounds keep a mistyped value from multiplying
  // history by a thousand.
  return Number.isFinite(percent) && percent >= 1 && percent <= 10_000 && percent !== 100;
}

function isAllowanceChangeList(value, nowMs = Date.now()) {
  return Array.isArray(value) && value.length <= MAX_ALLOWANCE_CHANGES
    && value.every((entry) => isAllowanceChange(entry, nowMs));
}

// Stored in time order with one entry per source and instant, so equal
// settings compare equal and cache keys built from them are stable.
function normalizeAllowanceChanges(value) {
  const byKey = new Map();
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== 'object') continue;
    byKey.set(`${entry.source}|${entry.at}`, {
      source: entry.source, at: entry.at, previousAllowancePercent: entry.previousAllowancePercent,
    });
  }
  return [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at) || a.source.localeCompare(b.source));
}

// The multiplier that expresses a reading taken at `observedMs` in the current
// allowance, or null when nothing recorded applies to this source so callers
// can skip the work entirely.
function createAllowanceScaler(changes, sourceId) {
  const family = allowanceFamily(sourceId);
  const relevant = normalizeAllowanceChanges(changes)
    .filter((entry) => entry.source === family && Number.isFinite(Date.parse(entry.at))
      && Number.isFinite(entry.previousAllowancePercent) && entry.previousAllowancePercent > 0)
    .map((entry) => ({ atMs: Date.parse(entry.at), factor: entry.previousAllowancePercent / 100 }));
  if (!relevant.length) return null;
  return (observedMs) => relevant.reduce((factor, entry) => (observedMs < entry.atMs ? factor * entry.factor : factor), 1);
}

module.exports = {
  ALLOWANCE_CHANGE_SOURCES, MAX_ALLOWANCE_CHANGES, allowanceFamily, createAllowanceScaler,
  isAllowanceChange, isAllowanceChangeList, normalizeAllowanceChanges,
};
