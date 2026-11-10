'use strict';

// The local calendar as the forecast walks it: hour by hour, split between
// the hours a person has scheduled for work and the rest, and by local day.

/** @typedef {import('../types').Schedule} Schedule */

/**
 * Whether a span of time touches an ignored day.
 * @typedef {(startMs: number, endMs: number) => boolean} Excluded
 */

/**
 * The two parts of a day a forecast learns and projects separately: the
 * scheduled hours, and every other hour.
 * @typedef {'active' | 'off-schedule'} Phase
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** @param {number} cursor */
function nextLocalHour(cursor) {
  const date = new Date(cursor);
  // Advance elapsed time to the next local hour boundary. Arithmetic on local
  // minutes also visits the repeated hour at a DST fallback instead of skipping
  // it with Date.setHours, and supports half/quarter-hour UTC offsets.
  return cursor + HOUR_MS - date.getMinutes() * MINUTE_MS - date.getSeconds() * SECOND_MS - date.getMilliseconds();
}

/**
 * @param {Date} date
 * @param {Schedule} schedule
 */
function isActiveHour(date, schedule) {
  if (!schedule.activeDays.includes(date.getDay())) return false;
  const hour = date.getHours() + date.getMinutes() / 60;
  return hour >= schedule.startHour && hour < schedule.endHour;
}

/** @param {Date} date */
function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Exclusions describe local calendar days, including the real 23/25-hour DST
// boundaries. Quota deltas cover [before, after), so a midnight reading can
// still close the preceding clean day. Never infer where a delta crossing an
// excluded day was spent: discard that interval and resume at its next reading.
/**
 * @param {string[]} [dates]
 * @returns {Excluded}
 */
function exclusionLookup(dates = []) {
  const ranges = (Array.isArray(dates) ? dates : []).flatMap((day) => {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    const [year, month, date] = day.split('-').map(Number);
    const start = new Date(year, month - 1, date);
    if (localDayKey(start) !== day) return [];
    return [{ start: start.getTime(), end: new Date(year, month - 1, date + 1).getTime() }];
  });
  return (start, end) => end > start && ranges.some((range) => range.start < end && range.end > start);
}

/**
 * @param {number} startMs
 * @param {number} endMs
 * @param {Schedule} schedule
 */
function activeHoursBetween(startMs, endMs, schedule) {
  if (endMs <= startMs) return 0;
  let total = 0;
  let cursor = startMs;
  while (cursor < endMs) {
    const next = Math.min(endMs, nextLocalHour(cursor));
    if (isActiveHour(new Date((cursor + next) / 2), schedule)) total += (next - cursor) / HOUR_MS;
    cursor = next;
  }
  return total;
}

/**
 * @param {string} day
 * @param {Schedule} schedule
 */
function offScheduleHoursForLocalDay(day, schedule) {
  const parts = String(day).split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return 0;
  const [year, month, date] = parts;
  const startMs = new Date(year, month - 1, date).getTime();
  const endMs = new Date(year, month - 1, date + 1).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || localDayKey(new Date(startMs)) !== day) return 0;
  const elapsedHours = (endMs - startMs) / HOUR_MS;
  return Math.max(0, elapsedHours - activeHoursBetween(startMs, endMs, schedule));
}

module.exports = {
  DAY_MS, HOUR_MS, MINUTE_MS,
  activeHoursBetween, exclusionLookup, isActiveHour, localDayKey, nextLocalHour, offScheduleHoursForLocalDay,
};
