'use strict';

// Settings: the defaults, the validator for every key, and the reads and
// writes of the settings table.

/** @typedef {import('../../src/types').Settings} Settings */

const { isAllowanceChange, isAllowanceChangeList, normalizeAllowanceChanges } = require('../allowance-changes.cjs');
const { iso, json } = require('./shared.cjs');

/** @type {Settings} */
const DEFAULT_SETTINGS = {
  showCodexSubscription: true,
  showClaudeSubscription: true,
  currency: 'GBP',
  usdToCurrency: 0.736,
  currencyRates: { USD: 1, GBP: 0.736 },
  activeDays: [1, 2, 3, 4, 5, 6, 0],
  activeStartHour: 8,
  activeEndHour: 22,
  forecastFallbackRate: 0.35,
  paceRiskThreshold: 1.2,
  hardLimitThreshold: 90,
  reservePercent: 0,
  forecastExcludedDates: [],
  allowanceChanges: [],
  codexPlanUsdPerMonth: 0,
  claudePlanUsdPerMonth: 0,
  // A free reset Claude offers in its own Usage settings. No Claude API
  // reports it, so it is recorded by hand and hidden after its expiry date.
  claudeFreeResets: 0,
  claudeFreeResetsExpireOn: null,
  notifyDesktop: true,
  notifyResets: true,
  notifyFallback: true,
  notifyDigest: false,
  digestHour: 9,
  alertsSnoozedUntil: null,
  launchAtLogin: false,
  theme: 'system',
  // Software rendering keeps Chromium's GPU process small while the dashboard
  // sits in the tray. Applied at the next launch; see startup-preferences.cjs.
  softwareRendering: true,
  autoUpdate: true,
  backupFrequency: 'daily',
  backupRetentionCount: 30,
  refreshIntervalMinutes: 15,
};

// Settings renamed between releases. Old exports and databases carry the old
// key; both read paths map it forward instead of counting it as unusable.
const SETTING_ALIASES = { notifyInApp: 'notifyDesktop' };

function isIsoOrNull(value) {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function isForecastDate(value) {
  return typeof value === 'string' && /^(?:20\d{2}|2100)-\d{2}-\d{2}$/.test(value)
    && value >= '2020-01-01' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function normalizedSetting(key, value) {
  if (key === 'forecastExcludedDates') return [...new Set(value)].sort();
  if (key === 'allowanceChanges') return normalizeAllowanceChanges(value);
  return value;
}

const SETTING_VALIDATORS = {
  showCodexSubscription: (value) => typeof value === 'boolean',
  showClaudeSubscription: (value) => typeof value === 'boolean',
  currency: (value) => ['GBP', 'USD', 'EUR'].includes(value),
  usdToCurrency: (value) => Number.isFinite(value) && value > 0 && value <= 10_000,
  currencyRates: (value) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([currency, rate]) => ['GBP', 'USD', 'EUR'].includes(currency)
      && Number.isFinite(rate) && rate > 0 && rate <= 10_000 && (currency !== 'USD' || rate === 1)),
  activeDays: (value) => Array.isArray(value)
    && value.length > 0
    && value.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    && new Set(value).size === value.length,
  activeStartHour: (value) => Number.isInteger(value) && value >= 0 && value <= 23,
  activeEndHour: (value) => Number.isInteger(value) && value >= 1 && value <= 24,
  forecastFallbackRate: (value) => Number.isFinite(value) && value > 0 && value <= 100,
  paceRiskThreshold: (value) => Number.isFinite(value) && value >= 0.1 && value <= 20,
  hardLimitThreshold: (value) => Number.isFinite(value) && value >= 0 && value <= 100,
  reservePercent: (value) => Number.isFinite(value) && value >= 0 && value <= 50,
  forecastExcludedDates: (value) => Array.isArray(value) && value.length <= 366 && value.every(isForecastDate),
  allowanceChanges: (value) => isAllowanceChangeList(value),
  codexPlanUsdPerMonth: (value) => Number.isFinite(value) && value >= 0 && value <= 100_000,
  claudePlanUsdPerMonth: (value) => Number.isFinite(value) && value >= 0 && value <= 100_000,
  claudeFreeResets: (value) => Number.isInteger(value) && value >= 0 && value <= 10,
  claudeFreeResetsExpireOn: (value) => value === null || isForecastDate(value),
  notifyDesktop: (value) => typeof value === 'boolean',
  notifyResets: (value) => typeof value === 'boolean',
  notifyFallback: (value) => typeof value === 'boolean',
  notifyDigest: (value) => typeof value === 'boolean',
  digestHour: (value) => Number.isInteger(value) && value >= 0 && value <= 23,
  alertsSnoozedUntil: isIsoOrNull,
  launchAtLogin: (value) => typeof value === 'boolean',
  theme: (value) => ['system', 'dark', 'light'].includes(value),
  softwareRendering: (value) => typeof value === 'boolean',
  autoUpdate: (value) => typeof value === 'boolean',
  backupFrequency: (value) => ['off', 'daily', 'weekly'].includes(value),
  backupRetentionCount: (value) => Number.isInteger(value) && value >= 1 && value <= 365,
  // Zero disables the background timer. The floor keeps a mistyped value from
  // rescanning every local transcript once a second.
  refreshIntervalMinutes: (value) => Number.isInteger(value) && (value === 0 || (value >= 5 && value <= 240)),
};

// Inherited names such as `constructor` are not settings. Only an own entry
// of the validator table may vouch for a key from IPC, an export, or a row.
function settingValidator(key) {
  return typeof key === 'string' && Object.hasOwn(SETTING_VALIDATORS, key) ? SETTING_VALIDATORS[key] : null;
}

// The settings a backup carries, whether exported or restored from its
// SQLite copy: the known keys only, as the export has always written them.
function backupSettings(database) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of database.prepare('SELECT key, value_json FROM settings').iterate()) {
    if (Object.hasOwn(DEFAULT_SETTINGS, row.key)) settings[row.key] = json(row.value_json, settings[row.key]);
  }
  return settings;
}

// The settings a SQLite backup actually stored. A restore writes every key it
// is given, so filling the gaps with defaults, as an export does, would reset
// settings the backed-up version never had. A renamed key maps forward, and
// the current name wins when a database holds both.
const UNREADABLE = Symbol('unreadable');
function storedSettings(database) {
  const settings = {};
  for (const row of database.prepare('SELECT key, value_json FROM settings').iterate()) {
    const renamed = Object.hasOwn(SETTING_ALIASES, row.key);
    const key = renamed ? SETTING_ALIASES[row.key] : row.key;
    if (!Object.hasOwn(DEFAULT_SETTINGS, key) || (renamed && Object.hasOwn(settings, key))) continue;
    const value = json(row.value_json, UNREADABLE);
    if (value !== UNREADABLE) settings[key] = value;
  }
  return settings;
}

/** @param {import('../store.cjs').Store} store */
function repairSettings(store) {
  const update = store.prepare('UPDATE settings SET value_json = ?, updated_at = ? WHERE key = ?');
  const repaired = { ...DEFAULT_SETTINGS };
  for (const row of store.prepare('SELECT key, value_json FROM settings').all()) {
    const validate = settingValidator(row.key);
    if (!validate) continue;
    const stored = json(row.value_json, undefined);
    const value = row.key === 'allowanceChanges' && Array.isArray(stored)
      ? stored.filter((entry) => isAllowanceChange(entry, Infinity)).slice(-24) : stored;
    if (row.key === 'allowanceChanges' ? isAllowanceChangeList(value, Infinity) : validate(value)) {
      repaired[row.key] = normalizedSetting(row.key, value);
      if (JSON.stringify(repaired[row.key]) !== JSON.stringify(stored)) {
        update.run(JSON.stringify(repaired[row.key]), iso(), row.key);
      }
    }
    else update.run(JSON.stringify(DEFAULT_SETTINGS[row.key]), iso(), row.key);
  }
  if (repaired.activeStartHour >= repaired.activeEndHour) {
    update.run(JSON.stringify(DEFAULT_SETTINGS.activeStartHour), iso(), 'activeStartHour');
    update.run(JSON.stringify(DEFAULT_SETTINGS.activeEndHour), iso(), 'activeEndHour');
  }
  // USD is the canonical currency of the ledger. A stale GBP/EUR conversion
  // rate paired with the USD label would make every displayed total wrong.
  if (repaired.currency === 'USD' && repaired.usdToCurrency !== 1) {
    update.run(JSON.stringify(1), iso(), 'usdToCurrency');
  }
  const currencyRates = { ...repaired.currencyRates, USD: 1,
    [repaired.currency]: repaired.currency === 'USD' ? 1 : repaired.usdToCurrency };
  store.prepare('INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
    .run('currencyRates', JSON.stringify(currencyRates), iso());
}

/**
 * @param {import('../store.cjs').Store} store
 * @returns {Settings}
 */
function getSettings(store) {
  const result = { ...DEFAULT_SETTINGS };
  for (const row of store.prepare('SELECT key, value_json FROM settings').all()) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, row.key)) continue;
    result[row.key] = json(row.value_json, result[row.key]);
  }
  return result;
}

/**
 * @param {import('../store.cjs').Store} store
 * @returns {Settings}
 */
function updateSettings(store, patch) {
  const statement = store.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
  const current = store.getSettings();
  const normalizedPatch = { ...patch };
  const candidateCurrency = normalizedPatch.currency ?? current.currency;
  if (candidateCurrency === 'USD') {
    if (Object.hasOwn(normalizedPatch, 'usdToCurrency') && normalizedPatch.usdToCurrency !== 1) {
      throw new Error('USD conversion rate must be 1.');
    }
    // Selecting USD is one coherent setting change, not a currency label
    // followed by a separate rate edit the caller might forget to make.
    normalizedPatch.usdToCurrency = 1;
  }
  else if (candidateCurrency !== current.currency && !Object.hasOwn(normalizedPatch, 'usdToCurrency')) {
    const savedRate = current.currencyRates?.[candidateCurrency];
    if (!savedRate) throw new Error(`Enter a USD to ${candidateCurrency} conversion rate.`);
    normalizedPatch.usdToCurrency = savedRate;
  }
  if (Object.hasOwn(normalizedPatch, 'currency') || Object.hasOwn(normalizedPatch, 'usdToCurrency')) {
    normalizedPatch.currencyRates = { ...current.currencyRates, ...normalizedPatch.currencyRates,
      [current.currency]: current.usdToCurrency,
      [candidateCurrency]: normalizedPatch.usdToCurrency ?? current.usdToCurrency, USD: 1 };
  }
  const candidate = { ...current, ...normalizedPatch };
  if (candidate.activeStartHour >= candidate.activeEndHour) {
    throw new Error('Active day end must be later than its start.');
  }
  // Validate the complete patch before writing any part of it, so a rejected
  // cross-field update cannot leave settings half changed.
  for (const [key, value] of Object.entries(normalizedPatch)) {
    const validate = settingValidator(key);
    if (!validate) throw new Error(`Unknown setting: ${key}`);
    if (!validate(value)) throw new Error(`Invalid value for ${key}.`);
  }
  // One transaction: a disk error part-way through cannot leave a validated
  // patch half applied, and one fsync covers every key.
  store.transaction(() => {
    for (const [key, value] of Object.entries(normalizedPatch)) {
      statement.run(key, JSON.stringify(normalizedSetting(key, value)), iso());
    }
  });
  return store.getSettings();
}

module.exports = {
  DEFAULT_SETTINGS, SETTING_ALIASES, isForecastDate, normalizedSetting, settingValidator, backupSettings,
  storedSettings, repairSettings, getSettings, updateSettings,
};
