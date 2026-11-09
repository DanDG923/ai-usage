'use strict';

// The debug log and the two small log files a person can read after a
// failure: renderer-errors.log and update.log.

const fs = require('node:fs');
const path = require('node:path');
const { closed } = require('./closed.cjs');

// A failed update used to leave no trace once the app had quit. Stage changes
// and the sanitised failure messages the updater already shows are appended
// here; request details, URLs and credentials never reach this file.
const UPDATE_LOG_MAX_BYTES = 256 * 1024;

/** @param {import('./application.cjs').Application} main */
function createLogsModule(main) {
  const { app } = main.electron;
  const logs = closed({
    log, logRendererError, updateLogPath, updateLog,
  });

  function log(message) {
    if (main.process.env.AI_USAGE_DEBUG === '1') main.process.stderr.write(`[ai-usage] ${message}\n`);
  }

  function logRendererError(message) {
    logs.log(message);
    try {
      const file = path.join(app.getPath('userData'), 'renderer-errors.log');
      try { if (fs.statSync(file).size > 64 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* First log or unavailable rotation. */ }
      fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
    } catch { /* Reporting must not fail the renderer recovery. */ }
  }

  function updateLogPath() {
    return path.join(app.getPath('userData'), 'update.log');
  }

  function updateLog(message) {
    const line = String(message).replace(/[\r\n\t]+/g, ' ').trim();
    logs.log(`Update: ${line}`);
    try {
      const file = logs.updateLogPath();
      try {
        if (fs.statSync(file).size > UPDATE_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
      } catch { /* No log yet, or rotation is not possible; append anyway. */ }
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch { /* Diagnostics must never affect the update itself. */ }
  }

  return logs;
}

module.exports = { createLogsModule };
