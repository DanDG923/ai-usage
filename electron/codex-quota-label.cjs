'use strict';

function codexQuotaLabel(bucketName, windowMinutes, metadata = {}) {
  if (!metadata.limitId || metadata.limitId === 'codex') return bucketName;
  const name = metadata.limitName || metadata.limitId;
  // Retain descriptive/manual names; older collectors only lost model identity
  // when replacing it with one of these generic window names.
  if (!['Weekly', 'Five hour', metadata.limitId, metadata.limitName].includes(bucketName)) return bucketName;
  const duration = windowMinutes >= 10_000 ? 'Weekly' : windowMinutes === 300 ? 'Five hour' : bucketName;
  return `${name} · ${duration}`;
}

module.exports = { codexQuotaLabel };
