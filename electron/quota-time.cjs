'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_QUOTA_RESET_AHEAD_MS = 31 * DAY_MS;
const QUOTA_CLOCK_SKEW_MS = 5 * 60_000;
// Matches the store's learning horizon while retaining historical rows on disk.
const FORECAST_LOOKBACK_MS = 45 * DAY_MS;

function validQuotaTime(observedMs, resetMs, windowMinutes, nowMs) {
  return Number.isFinite(nowMs) && Number.isFinite(observedMs) && Number.isFinite(resetMs)
    && observedMs <= nowMs + QUOTA_CLOCK_SKEW_MS
    && resetMs - observedMs >= -QUOTA_CLOCK_SKEW_MS
    && resetMs - observedMs <= MAX_QUOTA_RESET_AHEAD_MS
    && (windowMinutes == null || (Number.isSafeInteger(windowMinutes)
      && windowMinutes >= 0 && windowMinutes <= MAX_QUOTA_RESET_AHEAD_MS / 60_000));
}

module.exports = { MAX_QUOTA_RESET_AHEAD_MS, QUOTA_CLOCK_SKEW_MS, FORECAST_LOOKBACK_MS, validQuotaTime };
