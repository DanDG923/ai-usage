'use strict';

// Every number the forecaster is tuned with, grouped by the stage that uses
// it. Changing one changes what is forecast. Two constants with the same value
// are separate rules that happen to agree today.

const { HOUR_MS } = require('./calendar.cjs');

// ---- What a forecast assumes when the caller does not say ----

// Every day of the week counts as a working day...
const DEFAULT_ACTIVE_DAYS = [1, 2, 3, 4, 5, 6, 0];
// ...from this local hour...
const DEFAULT_START_HOUR = 8;
// ...until this one.
const DEFAULT_END_HOUR = 22;
// Allowance points per scheduled hour, used until history supplies a rate.
const DEFAULT_FALLBACK_RATE = 0.35;
// A pace above this multiple of the safe pace is a risk.
const DEFAULT_PACE_RISK_THRESHOLD = 1.2;
// The used share treated as the hard limit: a projection that leaves less
// than the rest of the allowance at reset puts the window on watch.
const DEFAULT_HARD_LIMIT_THRESHOLD = 90;
// The most of an allowance that can be kept in reserve.
const MAX_RESERVE_PERCENT = 90;

// ---- Telling one allowance window from the next ----

// A reset timestamp may drift by this share of the time between two readings,
// on top of the fixed tolerance, and still name the same window.
const RESET_DRIFT_PER_ELAPSED = 0.01;
// An idle window rolls its reset forward only while its used share moves by
// no more than this many points.
const IDLE_ROLLING_USED_TOLERANCE = 0.5;
// Readings further apart than this leave the time between them unobserved.
const COVERAGE_GAP_MS = 6 * HOUR_MS;

// ---- Learning samples ----

// A rise of more than this many points between two readings is another
// allowance or a fault, not use to learn from.
const MAX_LEARNABLE_RISE_POINTS = 70;
// The weight of an interval closed by an estimated reading, against 1 for a
// provider's own figure.
const ESTIMATED_READING_WEIGHT = 0.65;
// A span shorter than this (36 seconds) is too brief to learn from: it gives
// no rate, and no quiet sample.
const MIN_SAMPLE_HOURS = 0.01;
// A sample's weight falls by a factor of e for every this many days of age.
const SAMPLE_AGE_DECAY_DAYS = 28;
// A span with no change is learned as quiet time once it is this long.
const MIN_QUIET_SPAN_MS = HOUR_MS;

// ---- The pace of an allowance window (the anchor) ----

// A window gives a pace for scheduled or off-schedule time only once it has
// covered this many hours of it.
const MIN_WINDOW_PACE_HOURS = 1;
// An earlier window shorter than this is too brief for its pace to carry
// into the window after it...
const MIN_PRIOR_WINDOW_MINUTES = 360;
// ...and it needs this many scheduled hours of evidence.
const MIN_PRIOR_WINDOW_ACTIVE_HOURS = 6;
// Hours of exposure at which a window's pace reaches its full weight.
const ANCHOR_FULL_WEIGHT_HOURS = 30;
// The most a window's pace may outweigh the learned hourly rates.
const MAX_ANCHOR_WEIGHT = 0.9;
// The most an earlier window's pace may weigh, before the current window
// takes its share.
const MAX_PRIOR_ANCHOR_WEIGHT = 0.85;
// Off-schedule hours, about one night, after which this window's own
// off-schedule pace is trusted in full.
const OFF_WINDOW_FULL_TRUST_HOURS = 10;

// ---- Rates ----

// A sample within this many hours of the hour asked about describes it.
const RATE_NEIGHBOUR_HOURS = 1;
// Samples of the same weekday and hour are used once there are this many...
const MIN_WEEKDAY_HOUR_SAMPLES = 2;
// ...else samples of the same hour on any day, once there are this many.
const MIN_HOUR_SAMPLES = 3;
// Samples no older than this make up the recent pace.
const RECENT_WINDOW_MS = 36 * HOUR_MS;
// Among them, a sample's pull falls by a factor of e every this long.
const RECENT_DECAY_MS = 8 * HOUR_MS;
// The recent pace is blended in once a phase has this many samples.
const MIN_SAMPLES_FOR_RECENT_BLEND = 3;
// Each recent sample adds one part in this many to the recent pace's weight...
const RECENT_WEIGHT_SAMPLE_DIVISOR = 10;
// ...which is never less than this...
const MIN_RECENT_WEIGHT = 0.1;
// ...nor more than this.
const MAX_RECENT_WEIGHT = 0.38;

// ---- The heavier scenario ----

// The heavier scenario starts this far above expected consumption (22%).
const HEAVY_BASELINE_MARGIN = 1.22;
// Completed days of history at which the learned busy-day rate is trusted in full.
const HEAVY_HISTORY_DAYS = 7;
// A busy day is read from daily totals once there are this many days of them.
const MIN_DAYS_FOR_HEAVY_PERCENTILE = 2;
// The busy day: this far up the learned daily totals.
const HEAVY_DAY_PERCENTILE = 0.82;
// Without those days, a busy day is this multiple of the sustained pace...
const HEAVY_SUSTAINED_MULTIPLE = 1.6;
// ...or, with no window pace either, this multiple of the fallback rate.
const HEAVY_FALLBACK_MULTIPLE = 1.55;

// ---- What the forecast reports ----

// How far back the observed line of the chart reaches.
const OBSERVED_DISPLAY_MS = 48 * HOUR_MS;
// A current figure whose evidence is older than this (15 minutes) is shown as estimated.
const ESTIMATED_AFTER_STALE_HOURS = 0.25;
// A pace above this share of the risk threshold puts the window on watch.
const WATCH_PACE_SHARE = 0.75;
// Confidence with no evidence at all.
const CONFIDENCE_BASE = 0.18;
// Learned days add up to this much confidence...
const CONFIDENCE_DAYS_WEIGHT = 0.5;
// ...in full at this many days.
const CONFIDENCE_FULL_DAYS = 28;
// Hours covered by samples add up to this much...
const CONFIDENCE_HOURS_WEIGHT = 0.15;
// ...in full at this many hours.
const CONFIDENCE_FULL_HOURS = 80;
// Readings that showed a rise add up to this much...
const CONFIDENCE_CHANGES_WEIGHT = 0.08;
// ...in full at this many of them.
const CONFIDENCE_FULL_CHANGES = 12;
// Allowance windows seen add up to this much...
const CONFIDENCE_CYCLES_WEIGHT = 0.04;
// ...in full at this many windows.
const CONFIDENCE_FULL_CYCLES = 3;
// Confidence falls by a factor of e for every this many hours (a week) the
// latest evidence has aged.
const CONFIDENCE_STALE_DECAY_HOURS = 168;
// Confidence is never reported below this...
const MIN_CONFIDENCE = 0.12;
// ...nor above this.
const MAX_CONFIDENCE = 0.95;

// ---- Reusing what was learned ----

// A learned model serves forecasts made up to this long after it was learned.
const LEARNING_CACHE_TTL_MS = 60_000;
// The cache is emptied before it would hold more than this many models.
const LEARNING_CACHE_MAX_MODELS = 4;

// ---- An early reset after an unusually heavy day ----

// The share of its usual influence such a day keeps in the expected forecast.
const EARLY_RESET_DAY_WEIGHT = 0.25;
// The two readings around the drop are no further apart than this...
const EARLY_RESET_MAX_GAP_MS = 6 * HOUR_MS;
// ...nor than one part in this many of the window.
const EARLY_RESET_GAP_WINDOW_DIVISOR = 4;
// The drop comes ahead of the scheduled reset by one part in this many of the window...
const EARLY_RESET_LEAD_WINDOW_DIVISOR = 10;
// ...though never by less than this...
const EARLY_RESET_MIN_LEAD_MS = HOUR_MS / 2;
// ...and no more than this is asked of a long window.
const EARLY_RESET_MAX_LEAD_MS = 6 * HOUR_MS;
// The used share falls by at least this many points...
const EARLY_RESET_MIN_DROP_POINTS = 20;
// ...to no more than this share used.
const EARLY_RESET_MAX_USED_PERCENT = 2;
// Readings further apart than this that cross midnight cannot show on which
// day the use between them fell.
const DAY_ATTRIBUTION_MAX_GAP_MS = 6 * HOUR_MS;
// A day's use is known once readings cover this share of its hours.
const EARLY_RESET_DAY_COVERAGE = 0.75;
// The heavy day is compared with the days of this long before the reset...
const EARLY_RESET_BASELINE_DAYS = 28;
// ...of which there must be at least this many.
const EARLY_RESET_MIN_BASELINE_DAYS = 3;
// A typical day is this far up their totals: the median.
const EARLY_RESET_TYPICAL_PERCENTILE = 0.5;
// The day is heavy at this multiple of a typical day...
const EARLY_RESET_HEAVY_MULTIPLE = 3;
// ...and at least this many points above it.
const EARLY_RESET_HEAVY_EXTRA_POINTS = 10;

module.exports = {
  ANCHOR_FULL_WEIGHT_HOURS, CONFIDENCE_BASE, CONFIDENCE_CHANGES_WEIGHT, CONFIDENCE_CYCLES_WEIGHT, CONFIDENCE_DAYS_WEIGHT,
  CONFIDENCE_FULL_CHANGES, CONFIDENCE_FULL_CYCLES, CONFIDENCE_FULL_DAYS, CONFIDENCE_FULL_HOURS, CONFIDENCE_HOURS_WEIGHT,
  CONFIDENCE_STALE_DECAY_HOURS, COVERAGE_GAP_MS, DAY_ATTRIBUTION_MAX_GAP_MS, DEFAULT_ACTIVE_DAYS, DEFAULT_END_HOUR,
  DEFAULT_FALLBACK_RATE, DEFAULT_HARD_LIMIT_THRESHOLD, DEFAULT_PACE_RISK_THRESHOLD, DEFAULT_START_HOUR,
  EARLY_RESET_BASELINE_DAYS, EARLY_RESET_DAY_COVERAGE, EARLY_RESET_DAY_WEIGHT, EARLY_RESET_GAP_WINDOW_DIVISOR,
  EARLY_RESET_HEAVY_EXTRA_POINTS, EARLY_RESET_HEAVY_MULTIPLE, EARLY_RESET_LEAD_WINDOW_DIVISOR, EARLY_RESET_MAX_GAP_MS,
  EARLY_RESET_MAX_LEAD_MS, EARLY_RESET_MAX_USED_PERCENT, EARLY_RESET_MIN_BASELINE_DAYS, EARLY_RESET_MIN_DROP_POINTS,
  EARLY_RESET_MIN_LEAD_MS, EARLY_RESET_TYPICAL_PERCENTILE, ESTIMATED_AFTER_STALE_HOURS, ESTIMATED_READING_WEIGHT,
  HEAVY_BASELINE_MARGIN, HEAVY_DAY_PERCENTILE, HEAVY_FALLBACK_MULTIPLE, HEAVY_HISTORY_DAYS, HEAVY_SUSTAINED_MULTIPLE,
  IDLE_ROLLING_USED_TOLERANCE, LEARNING_CACHE_MAX_MODELS, LEARNING_CACHE_TTL_MS, MAX_ANCHOR_WEIGHT, MAX_CONFIDENCE,
  MAX_LEARNABLE_RISE_POINTS, MAX_PRIOR_ANCHOR_WEIGHT, MAX_RECENT_WEIGHT, MAX_RESERVE_PERCENT, MIN_CONFIDENCE,
  MIN_DAYS_FOR_HEAVY_PERCENTILE, MIN_HOUR_SAMPLES, MIN_PRIOR_WINDOW_ACTIVE_HOURS, MIN_PRIOR_WINDOW_MINUTES,
  MIN_QUIET_SPAN_MS, MIN_RECENT_WEIGHT, MIN_SAMPLE_HOURS, MIN_SAMPLES_FOR_RECENT_BLEND, MIN_WEEKDAY_HOUR_SAMPLES,
  MIN_WINDOW_PACE_HOURS, OBSERVED_DISPLAY_MS, OFF_WINDOW_FULL_TRUST_HOURS, RATE_NEIGHBOUR_HOURS, RECENT_DECAY_MS,
  RECENT_WEIGHT_SAMPLE_DIVISOR, RECENT_WINDOW_MS, RESET_DRIFT_PER_ELAPSED, SAMPLE_AGE_DECAY_DAYS, WATCH_PACE_SHARE,
};
