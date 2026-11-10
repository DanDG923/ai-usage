'use strict';

// The arithmetic the forecast's stages share.

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

/**
 * @param {number[]} values
 * @param {number} fraction
 */
function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/** @param {{ value: number, weight: number }[]} entries */
function weightedMean(entries) {
  let numerator = 0;
  let denominator = 0;
  for (const entry of entries) {
    numerator += entry.value * entry.weight;
    denominator += entry.weight;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

module.exports = { clamp, percentile, weightedMean };
