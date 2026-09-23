import { displayedRemaining } from './lib';
import type { QuotaWindow, Settings } from './types';

/** The active-hours schedule, in the shape the forecast engine reads it. */
export type Schedule = { activeDays: number[]; startHour: number; endHour: number };

export function scheduleOf(settings: Pick<Settings, 'activeDays' | 'activeStartHour' | 'activeEndHour'>): Schedule {
  return {
    activeDays: Array.isArray(settings.activeDays) ? settings.activeDays : [1, 2, 3, 4, 5, 6, 0],
    startHour: Number(settings.activeStartHour ?? 8),
    endHour: Number(settings.activeEndHour ?? 22),
  };
}

/** Same rule as electron/forecast.cjs isActiveHour: local weekday and [start, end) hours. */
export function isActiveAt(ms: number, schedule: Schedule) {
  const date = new Date(ms);
  if (!schedule.activeDays.includes(date.getDay())) return false;
  const hour = date.getHours() + date.getMinutes() / 60;
  return hour >= schedule.startHour && hour < schedule.endHour;
}

function nextLocalHour(ms: number) {
  const date = new Date(ms);
  date.setMinutes(60, 0, 0);
  return date.getTime();
}

/** Active hours in [startMs, endMs), stepping local hour boundaries like the forecast engine. */
export function activeHoursBetween(startMs: number, endMs: number, schedule: Schedule) {
  if (!(endMs > startMs)) return 0;
  let total = 0;
  let cursor = startMs;
  while (cursor < endMs) {
    const next = Math.min(endMs, nextLocalHour(cursor));
    if (isActiveAt((cursor + next) / 2, schedule)) total += (next - cursor) / 3_600_000;
    cursor = next;
  }
  return total;
}

export function hoursPerActiveDay(schedule: Schedule) {
  return Math.max(0, schedule.endHour - schedule.startHour);
}

/** Inactive stretches between two instants, for shading a runway chart. */
export function inactiveRanges(startMs: number, endMs: number, schedule: Schedule) {
  const ranges: { from: number; to: number }[] = [];
  let cursor = startMs;
  let open: number | null = null;
  while (cursor < endMs) {
    const next = Math.min(endMs, nextLocalHour(cursor));
    const active = isActiveAt((cursor + next) / 2, schedule);
    if (!active && open == null) open = cursor;
    if (active && open != null) {
      ranges.push({ from: open, to: cursor });
      open = null;
    }
    cursor = next;
  }
  if (open != null) ranges.push({ from: open, to: endMs });
  return ranges;
}

export type DailyBudget = {
  /** Share of the allowance that can be used per active day and still keep the reserve at reset. */
  budget: number;
  /** Average use per active day on the expected path. */
  expected: number;
  /** Average use per active day on the heavier path, or null when the forecast has none. */
  heavier: number | null;
  reserve: number;
  activeHoursLeft: number;
  activeDaysLeft: number;
  hoursPerDay: number;
  expectedFits: boolean;
  heavierFits: boolean;
  /** A rounded ceiling for drawing the three paces on one scale. */
  scaleMax: number;
};

function niceCeiling(value: number) {
  for (const step of [5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100]) if (value <= step) return step;
  return Math.ceil(value / 50) * 50;
}

/**
 * Turns a window's forecast into a per-active-day budget. Every figure comes
 * from the same endpoints the runway chart draws, so the budget, both paces and
 * the chart always agree: the expected pace fits the budget exactly when the
 * expected path keeps the reserve, and likewise for the heavier path. Use outside
 * active hours still draws on the allowance, so it is included in each pace.
 */
export function dailyBudget(
  window: QuotaWindow | null | undefined,
  settings: Pick<Settings, 'activeDays' | 'activeStartHour' | 'activeEndHour' | 'reservePercent'>,
  nowMs: number,
  reserveOverride?: number,
): DailyBudget | null {
  if (!window) return null;
  const forecast = window.forecast;
  if (forecast.expired || forecast.state === 'unknown' || forecast.expectedRemaining == null) return null;
  const schedule = scheduleOf(settings);
  const hoursPerDay = hoursPerActiveDay(schedule);
  const resetMs = Date.parse(window.resetsAt);
  const activeHoursLeft =
    Number.isFinite(forecast.activeHoursLeft) && forecast.activeHoursLeft > 0
      ? forecast.activeHoursLeft
      : activeHoursBetween(nowMs, resetMs, schedule);
  if (!(hoursPerDay > 0) || !(activeHoursLeft >= 0.5)) return null;
  const activeDaysLeft = activeHoursLeft / hoursPerDay;
  // A per-day budget only means something across whole days: a five-hour
  // session, or the last active day before a reset, would divide by a
  // fraction of a day and read as "use 280% a day".
  if ((window.windowMinutes != null && window.windowMinutes < 1_440) || activeDaysLeft < 1) return null;
  const remaining = Math.max(0, Math.min(100, displayedRemaining(window)));
  const reserve = Math.max(0, Math.min(90, reserveOverride ?? forecast.reservePercent ?? settings.reservePercent ?? 0));
  const paceUntil = (used: number, endsAt: string | null | undefined) => {
    const endMs = endsAt ? Date.parse(endsAt) : NaN;
    const hours =
      Number.isFinite(endMs) && endMs < resetMs ? activeHoursBetween(nowMs, endMs, schedule) : activeHoursLeft;
    // A run-out inside the first active day is paced over one day, not an hour.
    return (Math.max(0, used) / Math.max(hoursPerDay, hours)) * hoursPerDay;
  };
  const budget = Math.max(0, remaining - reserve) / activeDaysLeft;
  const expectedRemaining = Math.max(0, forecast.expectedRemaining);
  const expected = paceUntil(remaining - expectedRemaining, forecast.exhaustsAt);
  const heavyRemaining = forecast.heavyRemaining == null ? null : Math.max(0, forecast.heavyRemaining);
  const heavier = heavyRemaining == null ? null : paceUntil(remaining - heavyRemaining, forecast.heavyExhaustsAt);
  return {
    budget,
    expected,
    heavier,
    reserve,
    activeHoursLeft,
    activeDaysLeft,
    hoursPerDay,
    expectedFits: !forecast.exhaustsAt && expectedRemaining >= reserve,
    heavierFits: heavyRemaining != null && !forecast.heavyExhaustsAt && heavyRemaining >= reserve,
    scaleMax: niceCeiling(Math.max(budget, expected, heavier ?? 0, 1) * 1.15),
  };
}

/** "17.4%" with one decimal under 20 and whole numbers above, so small budgets keep their precision. */
export function paceLabel(value: number) {
  return `${value < 20 ? value.toFixed(1) : Math.round(value)}%`;
}
