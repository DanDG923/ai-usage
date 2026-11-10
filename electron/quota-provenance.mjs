// Manual official readings calibrate estimates but do not prove a live connection.
export const OFFICIAL_PROVENANCES = Object.freeze([
  'official', 'local-official', 'official-statusline', 'official-claude-usage', 'manual-official',
]);
/** @param {unknown} value */
export function isProviderProvenance(value) {
  return typeof value === 'string' && (value.startsWith('official') || value === 'local-official');
}
/** @param {unknown} value */
export function isOfficialProvenance(value) {
  return isProviderProvenance(value) || value === 'manual-official';
}
