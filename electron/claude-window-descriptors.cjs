'use strict';
const PROVIDER_WINDOW_DESCRIPTORS = [
  { key: 'five_hour', bucketName: 'Five hour', windowMinutes: 300, scope: 'overall' },
  { key: 'seven_day', bucketName: 'Weekly', windowMinutes: 10_080, scope: 'overall' },
  { key: 'seven_day_oauth_apps', bucketName: 'OAuth apps weekly', windowMinutes: 10_080, scope: 'oauth-apps' },
  { key: 'seven_day_opus', bucketName: 'Opus weekly', windowMinutes: 10_080, scope: 'model' },
  { key: 'seven_day_sonnet', bucketName: 'Sonnet weekly', windowMinutes: 10_080, scope: 'model' },
];
function claudeWindowDescriptor(key) {
  return PROVIDER_WINDOW_DESCRIPTORS.find((descriptor) => descriptor.key === key)
    || { key, bucketName: key.replaceAll('_', ' '),
      windowMinutes: key.includes('five_hour') ? 300 : key.includes('seven_day') ? 10_080 : null };
}
module.exports = { PROVIDER_WINDOW_DESCRIPTORS, claudeWindowDescriptor };
