import type { DashboardVerdict, ForecastState, Quota, QuotaWindow, Snapshot } from './types';

export function money(value: number, currency = 'GBP') {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function compactNumber(value: number) {
  return new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function shortDate(value?: string | number | null) {
  if (!value) return 'Not observed yet';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function dayDate(value?: string | number | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(value));
}

/** "Thu 14:00" for something inside the coming week, otherwise a dated form. */
export function whenLabel(value?: string | number | null, nowMs = Date.now()) {
  if (!value) return '—';
  const date = new Date(value);
  const withinWeek = Math.abs(date.getTime() - nowMs) < 7 * 86_400_000;
  return new Intl.DateTimeFormat(
    'en-GB',
    withinWeek
      ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
  ).format(date);
}

export function resetDistance(value?: string | null) {
  if (!value) return 'Reset unknown';
  const hours = Math.max(0, (new Date(value).getTime() - Date.now()) / 3_600_000);
  if (hours < 24) return `${Math.ceil(hours)} hours`;
  // Round the total first so 47.6h reads "1 day 24h" never; it is "2 days 0h".
  const whole = Math.round(hours);
  const days = Math.floor(whole / 24);
  return `${days} day${days === 1 ? '' : 's'} ${whole % 24}h`;
}

/** "Wed 10 Sept, 03:21": a reset or run-out instant in full. */
export function dateTimeLabel(value?: string | number | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

/** "20:05" for an instant on the same local day as `nowMs`, otherwise a dated form. */
export function timeLabel(value?: string | number | null, nowMs = Date.now()) {
  if (!value) return '—';
  const date = new Date(value);
  const now = new Date(nowMs);
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay
    ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date)
    : shortDate(value);
}

/** Distance between two instants as "2d 5h" or "3h", for run-out timing. */
export function durationLabel(fromMs: number, toMs: number) {
  const hours = Math.max(0, (toMs - fromMs) / 3_600_000);
  if (hours < 1) return 'under an hour';
  if (hours < 24) return `${Math.round(hours)}h`;
  const whole = Math.round(hours);
  return `${Math.floor(whole / 24)}d ${whole % 24}h`;
}

export function percent(value: number | null | undefined, digits = 0) {
  return value == null ? '—' : `${value.toFixed(digits)}%`;
}

export function sourceLabel(id: string) {
  return id === 'codex' ? 'Codex' : id === 'claude-fable' ? 'Fable 5' : 'Claude';
}

/** The last path segment of a working directory, for project labels. */
export function projectName(project: string | null | undefined) {
  if (!project) return 'No project recorded';
  const trimmed = project.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || trimmed;
}

export const STATE_RANK: Record<ForecastState, number> = { critical: 5, risk: 4, watch: 3, unknown: 2, safe: 1 };

/** Every window of a quota, active ones first; the quota itself when it carries none. */
export function quotaWindows(quota: Quota | null | undefined): QuotaWindow[] {
  if (!quota) return [];
  return quota.windows?.length ? quota.windows : [quota];
}

/** The window that should headline a card: the worst active one, or the worst at all. */
export function primaryWindow(quota: Quota | null | undefined): QuotaWindow | null {
  const all = quotaWindows(quota);
  const active = all.filter((entry) => !entry.forecast.expired);
  const candidates = active.length ? active : all;
  if (!candidates.length) return null;
  return candidates.reduce((worst, entry) =>
    STATE_RANK[entry.forecast.state] > STATE_RANK[worst.forecast.state] ? entry : worst,
  );
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
export function verdictSentence(verdict: DashboardVerdict, quotas: Snapshot['quotas']) {
  const providers: { name: string; quota: Quota | null }[] = [
    { name: 'Codex', quota: quotas.codex },
    { name: 'Claude', quota: quotas.claude },
    { name: 'Fable 5', quota: quotas.fable },
  ];
  const affectedNames = [...new Set(verdict.affected.map((entry) => entry.split(' · ')[0].trim()))];
  const join = (names: string[]) =>
    names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const others = providers
    .filter((entry) => !affectedNames.includes(entry.name))
    .filter((entry) => primaryWindow(entry.quota)?.forecast.state === 'safe')
    .map((entry) => entry.name);
  const secondary = others.length ? `${join(others)} ${others.length === 1 ? 'is' : 'are'} on track.` : '';
  return {
    headline: verdict.state === 'safe' ? 'All allowances on track' : verdict.label,
    secondary: verdict.state === 'safe' ? '' : secondary,
  };
}

export function windowLabel(minutes: number | null) {
  if (minutes == null) return 'allowance window';
  if (minutes >= 10_080) return 'weekly';
  if (minutes >= 1_440) return `${Math.round(minutes / 1_440)}-day`;
  return `${Math.round(minutes / 60)}-hour`;
}
