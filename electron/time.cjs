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

function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

module.exports = { epochToIso, localDayKey };
