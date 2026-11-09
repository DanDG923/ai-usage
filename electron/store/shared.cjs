'use strict';

// Helpers and constants every part of the store shares. A leaf: it requires
// none of the other store modules.

/** @typedef {import('../types').IsoTime} IsoTime */
/** @typedef {import('../types').Ms} Ms */
/** @typedef {Record<string, string>} LocalParts The fields of a local date and time: year, month, day, hour, weekday. */

// id, display name, kind
/** @type {[import('../types').SourceId, string, string][]} */
const SOURCE_DEFINITIONS = [
  ['codex', 'Codex', 'codex'],
  ['claude', 'Claude', 'claude'],
  ['claude-fable', 'Fable', 'fable'],
];
/** @type {Set<string>} */
const KNOWN_SOURCE_IDS = new Set(SOURCE_DEFINITIONS.map(([id]) => id));
// Stored by versions before 1.0.52 and still present in their backups.
const LEGACY_FABLE_BUCKET_NAME = 'Fable 5 weekly';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {Ms} [value]
 * @returns {IsoTime}
 */
function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

/**
 * @param {string | number | Date | null | undefined} value
 * @param {string} label
 * @returns {IsoTime}
 */
function validIso(value, label) {
  if (value == null || value === '') throw new Error(`${label} must be a valid date and time.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date and time.`);
  if (date.getUTCFullYear() < 2020 || date.getUTCFullYear() > 2100) {
    throw new Error(`${label} is outside the supported date range.`);
  }
  return date.toISOString();
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string | null}
 */
function optionalText(value, label) {
  if (value != null && typeof value !== 'string') throw new Error(`${label} must be text when supplied.`);
  return value || null;
}

/**
 * @param {string | null | undefined} value
 * @param {any} [fallback]
 * @returns {any}
 */
function json(value, fallback = /** @type {any} */ (null)) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Quota metadata is an object even when its JSON text parses successfully.
// Keep the generic JSON decoder unchanged for settings and cursor values.
/**
 * @param {unknown} value
 * @returns {Record<string, any> | null}
 */
function quotaMetadata(value) {
  const decoded = typeof value === 'string' ? json(value) : value;
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : null;
}

/**
 * @param {number} value
 * @param {number} [digits]
 */
function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

// Analytics call these once per usage event; constructing an Intl formatter
// each time was the dominant cost of a snapshot, so they are cached per zone.
// Callers on a hot path resolve the zone once and pass it in: the default
// argument below is itself an Intl construction.
/** @type {Map<string, Intl.DateTimeFormat>} */
const dateFormatters = new Map();
/**
 * @param {Ms | IsoTime | Date} value
 * @param {string} [timeZone]
 * @returns {LocalParts}
 */
function localParts(value, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23',
    });
    dateFormatters.set(timeZone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
}

/**
 * @param {Ms | IsoTime | Date} value
 * @param {string} [timeZone]
 */
function dateKey(value, timeZone) {
  const values = localParts(value, timeZone);
  return `${values.year}-${values.month}-${values.day}`;
}

// The ledger is read in time order, so consecutive events nearly always fall
// in the same quarter hour. Every zone offset is a multiple of fifteen
// minutes, so a quarter-hour slot never straddles a local hour, day or DST
// boundary and one formatted answer serves the whole slot. Formatting was
// otherwise a third of the aggregation.
const QUARTER_HOUR_MS = 15 * 60_000;
/**
 * @param {string} [timeZone]
 * @returns {(value: Ms | IsoTime) => LocalParts}
 */
function createLocalPartsLookup(timeZone) {
  /** @type {number | null} */
  let slot = null;
  /** @type {LocalParts | null} */
  let parts = null;
  return (value) => {
    const ms = typeof value === 'number' ? value : Date.parse(value);
    const current = Math.floor(ms / QUARTER_HOUR_MS);
    if (current !== slot || parts === null) {
      parts = localParts(ms, timeZone);
      slot = current;
    }
    return parts;
  };
}

/** @type {Record<string, number>} */
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

module.exports = {
  SOURCE_DEFINITIONS, KNOWN_SOURCE_IDS, LEGACY_FABLE_BUCKET_NAME, DAY_MS, iso, validIso, optionalText, json,
  quotaMetadata, round, dateKey, QUARTER_HOUR_MS, createLocalPartsLookup, WEEKDAY_INDEX,
};
