'use strict';

// One definition of "a provider timestamp, as ISO" for every collector. Codex
// reports epoch seconds or milliseconds; the Claude status line reports either
// of those or an ISO string. Anything outside 2020–2100 is a parse accident,
// not a reset time, and must not become an observation.
function epochToIso(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 2020 && date.getUTCFullYear() <= 2100
    ? date.toISOString() : null;
}

// An ISO string for a provider timestamp that is already text. Unlike
// epochToIso, a numeric string is not a timestamp here: the Claude usage
// payload reports ISO text, and honouring "1700000000" in it would paper
// over a malformed field rather than reject it.
function asIso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const year = new Date(timestamp).getUTCFullYear();
  return year >= 2020 && year <= 2100 ? new Date(timestamp).toISOString() : null;
}

function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Inclusive local calendar days, today included. Zero gives tomorrow's
// midnight for caches whose period changes at the next local day boundary.
function periodStart(days, nowMs) {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

module.exports = { asIso, epochToIso, localDayKey, periodStart };
