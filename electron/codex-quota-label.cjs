'use strict';

function codexQuotaLabel(bucketName, windowMinutes, metadata = {}) {
  // Persisted/provider metadata can contain JSON values with unsafe coercions.
  const limitId = typeof metadata?.limitId === 'string' ? metadata.limitId : null;
  const limitName = typeof metadata?.limitName === 'string' ? metadata.limitName : null;
  if (!limitId || limitId === 'codex') return bucketName;
  const name = limitName || limitId;
  // Retain descriptive/manual names; older collectors only lost model identity
  // when replacing it with one of these generic window names.
  if (!['Weekly', 'Five hour', limitId, limitName].includes(bucketName)) return bucketName;
  const duration = windowMinutes >= 10_000 ? 'Weekly' : windowMinutes === 300 ? 'Five hour' : bucketName;
  return `${name} · ${duration}`;
}

module.exports = { codexQuotaLabel };
