'use strict';

function durationLabel(minutes, fallback = 'Allowance') {
  if (minutes === 300) return 'Five hour';
  if (minutes === 10_080) return 'Weekly';
  if (minutes === 1440) return 'Daily';
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) return String(minutes / 1440) + '-day';
  if (minutes % 60 === 0) return String(minutes / 60) + '-hour';
  return String(minutes) + '-minute';
}

function codexQuotaLabel(bucketName, windowMinutes, metadata = {}) {
  // Persisted/provider metadata can contain JSON values with unsafe coercions.
  const limitId = typeof metadata?.limitId === 'string' ? metadata.limitId : null;
  const limitName = typeof metadata?.limitName === 'string' ? metadata.limitName : null;
  if (!limitId || limitId === 'codex') return bucketName;
  const name = limitName || limitId;
  // Retain descriptive/manual names; older collectors only lost model identity
  // when replacing it with one of these generic window names.
  if (!['Weekly', 'Five hour', durationLabel(windowMinutes), limitId, limitName].includes(bucketName)) return bucketName;
  const duration = durationLabel(windowMinutes, bucketName);
  return `${name} · ${duration}`;
}

module.exports = { codexQuotaLabel, durationLabel };
