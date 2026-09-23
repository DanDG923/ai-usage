import { SOURCES, evidenceNeedsRefresh } from '../electron/dashboard-decision.mjs';
import { selectDisplayedWindows } from '../electron/quota-selection.mjs';
import type { DashboardVerdict, Quota, QuotaWindow, Snapshot } from './types';

/**
 * Every formatter in the renderer uses this locale rather than the OS one, so
 * numbers and dates read the same way in every table and in the tests.
 */
export const LOCALE = 'en-GB';

// Intl formatters are expensive to construct and these run once per table
// cell, so each shape is built once and reused.
const COMPACT = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
const INTEGER = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const SHORT_DATE = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const DAY_DATE = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
const WEEKDAY_TIME = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const DATE_TIME = new Intl.DateTimeFormat(LOCALE, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const TIME = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const moneyFormats = new Map<string, Intl.NumberFormat>();

export function money(value: number, currency: string) {
  const minimumFractionDigits = 2;
  const key = `${currency}|${minimumFractionDigits}`;
  let format = moneyFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency,
      minimumFractionDigits,
      maximumFractionDigits: 2,
    });
    moneyFormats.set(key, format);
  }
  return format.format(value);
}

export function compactNumber(value: number) {
  return COMPACT.format(value);
}

/** Whole numbers with grouping ("12,345"), for counts. */
export function formatInt(value: number) {
  return INTEGER.format(value);
}

/**
 * A parsed instant, or null when the value is not a date. Intl throws a
 * RangeError on an invalid Date, which would take the whole dashboard down
 * for one malformed timestamp in the database.
 */
function parseDate(value: string | number) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function shortDate(value?: string | number | null) {
  if (!value) return 'Not observed yet';
  const date = parseDate(value);
  return date ? SHORT_DATE.format(date) : '—';
}

export function dayDate(value?: string | number | null) {
  if (!value) return '—';
  const date = parseDate(value);
  return date ? DAY_DATE.format(date) : '—';
}

/** "Thu 14:00" for something inside the coming week, otherwise a dated form. */
export function whenLabel(value?: string | number | null, nowMs = Date.now()) {
  if (!value) return '—';
  const date = parseDate(value);
  if (!date) return '—';
  const withinWeek = Math.abs(date.getTime() - nowMs) < 7 * 86_400_000;
  return (withinWeek ? WEEKDAY_TIME : SHORT_DATE).format(date);
}

export function resetDistance(value?: string | null) {
  if (!value) return 'Reset unknown';
  const date = parseDate(value);
  if (!date) return 'Reset unknown';
  if (date.getTime() <= Date.now()) return 'Reset passed';
  const hours = (date.getTime() - Date.now()) / 3_600_000;
  // Under a day the provider shows minutes, so rounding 4h 18m up to
  // "5 hours" read as a disagreement with it.
  const minutes = Math.round(hours * 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  if (hours < 24) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  // Round the total first so 47.6h reads "1 day 24h" never; it is "2 days 0h".
  const whole = Math.round(hours);
  const days = Math.floor(whole / 24);
  return `${days} day${days === 1 ? '' : 's'} ${whole % 24}h`;
}

/** "Wed 10 Sept, 03:21": a reset or run-out instant in full. */
export function dateTimeLabel(value?: string | number | null) {
  if (!value) return '—';
  const date = parseDate(value);
  return date ? DATE_TIME.format(date) : '—';
}

/** "20:05" for an instant on the same local day as `nowMs`, otherwise a dated form. */
export function timeLabel(value?: string | number | null, nowMs = Date.now()) {
  if (!value) return '—';
  const date = parseDate(value);
  if (!date) return '—';
  const now = new Date(nowMs);
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? TIME.format(date) : shortDate(value);
}

/** "just now", "4 min ago", "2 h ago", then a dated form: how fresh a reading is. */
export function relativeTime(value?: string | number | null, nowMs = Date.now()) {
  if (!value) return 'never';
  const date = parseDate(value);
  if (!date) return '—';
  const minutes = Math.round((nowMs - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return shortDate(value);
}

export function percent(value: number | null | undefined, digits = 0) {
  return value == null ? '—' : `${value.toFixed(digits)}%`;
}

export function priceCoverage(value: number) {
  return value >= 1 ? '100%' : `${Math.min(99, Math.floor(Math.max(0, value) * 100 + 1e-9))}%`;
}

export function sourceLabel(id: string) {
  return SOURCES.find((source) => source.id === id || source.healthId === id)?.label ?? id;
}

/** The last path segment of a working directory, for project labels. */
export function projectName(project: string | null | undefined) {
  if (!project) return 'No project recorded';
  const trimmed = project.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || trimmed;
}

/** Every window of a quota, active ones first; the quota itself when it carries none. */
export function quotaWindows(quota: Quota | null | undefined): QuotaWindow[] {
  if (!quota) return [];
  return quota.windows?.length ? quota.windows : [quota];
}

export function modelAllowanceName(window: QuotaWindow): string | null {
  const { limitId, limitName } = window.metadata || {};
  return typeof limitId === 'string' && limitId !== 'codex'
    ? typeof limitName === 'string' && limitName.trim()
      ? limitName
      : limitId
    : null;
}

export function allowanceWindowLabel(window: QuotaWindow): string {
  const model = modelAllowanceName(window);
  const duration = windowLabel(window.windowMinutes);
  return model ? `${model} · ${duration}` : `${duration} ${window.windowMinutes === 300 ? 'session' : 'allowance'}`;
}

/**
 * The window that headlines a card, by the same rule the store, tray and
 * notifications use: the subscription's own weekly allowance, so the figure
 * matches the provider's own summary. Headlining the riskiest window instead
 * made a Claude card read "79% left" while the weekly allowance stood at 93%.
 * Shorter session windows are listed beneath the headline with their own
 * state; the dashboard verdict still weighs every window.
 */
export function primaryWindow(quota: Quota | null | undefined): QuotaWindow | null {
  return selectDisplayedWindows(quotaWindows(quota)).primary;
}

export function displayedRemaining(entry: QuotaWindow) {
  return entry.forecast.currentIsEstimated && entry.forecast.estimatedCurrentRemaining != null
    ? entry.forecast.estimatedCurrentRemaining
    : entry.remainingPercent;
}

export function isEstimated(entry: QuotaWindow) {
  return Boolean(entry.forecast.currentIsEstimated && entry.forecast.estimatedCurrentRemaining != null);
}

/**
 * The Overview's status line, written as a sentence from the backend verdict.
 * The verdict's affected entries look like "Fable 5 · Fable 5 weekly"; the
 * provider name is the part before the separator.
 */
export function verdictSentence(
  verdict: DashboardVerdict,
  quotas: Snapshot['quotas'],
  sources: Snapshot['sources'] = [],
) {
  const providers = SOURCES.map(({ id, label }) => ({ name: label, quota: quotas[id] }));
  const affectedNames = [...new Set(verdict.affected.map((entry) => entry.split(' · ')[0].trim()))];
  const join = (names: string[]) =>
    names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const others = providers
    .filter((entry) => !affectedNames.includes(entry.name))
    .filter(
      (entry) =>
        !sources.some(
          (source) => sourceLabel(source.id) === entry.name && ['error', 'stale', 'degraded'].includes(source.status),
        ),
    )
    .filter((entry) => {
      const active = quotaWindows(entry.quota).filter((window) => !window.forecast.expired);
      return (
        active.length > 0 &&
        active.every((window) => {
          return window.forecast.state === 'safe' && !evidenceNeedsRefresh(window);
        })
      );
    })
    .map((entry) => entry.name);
  const secondary = others.length ? `${join(others)} ${others.length === 1 ? 'is' : 'are'} on track.` : '';
  return {
    headline: verdict.state === 'safe' ? 'All allowances on track' : verdict.label,
    secondary: verdict.state === 'safe' ? '' : secondary,
  };
}

export function windowLabel(minutes: number | null) {
  if (minutes == null) return 'allowance window';
  if (minutes >= 40_320) return 'monthly';
  if (minutes >= 10_080) return 'weekly';
  if (minutes >= 1_440) return `${Math.round(minutes / 1_440)}-day`;
  return `${Math.round(minutes / 60)}-hour`;
}
