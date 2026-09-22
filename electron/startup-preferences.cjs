'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_SETTINGS } = require('./store.cjs');

// Hardware acceleration can only be switched off before Electron is ready,
// well before the store opens and migrates. This reads the one setting that
// decides it straight from the settings table: no schema work, no writes, and
// any failure (first launch, unreadable file, an old row) keeps the default.
function readStartupPreferences(databasePath) {
  const preferences = { softwareRendering: DEFAULT_SETTINGS.softwareRendering };
  if (typeof databasePath !== 'string' || !databasePath || !fs.existsSync(databasePath)) return preferences;
  let db = null;
  try {
    db = new DatabaseSync(databasePath);
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'softwareRendering'").get();
    if (row) {
      const value = JSON.parse(row.value_json);
      if (typeof value === 'boolean') preferences.softwareRendering = value;
    }
  } catch { /* Missing table, locked or corrupt file: the default applies. */ } finally {
    try { db?.close(); } catch { /* Already closed. */ }
  }
  return preferences;
}

module.exports = { readStartupPreferences };
