'use strict';

// Where the app keeps its files.

const path = require('node:path');
const { closed } = require('./closed.cjs');

/** @param {import('./application.cjs').Application} main */
function createPathsModule(main) {
  const { app } = main.electron;
  const paths = closed({
    storagePaths, getInboxPath, claudeCodeRoot, notificationStatePath,
  });

  function storagePaths() {
    const root = main.process.env.AI_USAGE_TEST_ROOT || app.getPath('userData');
    return { databasePath: path.join(root, 'ai-usage.sqlite'), backupDirectory: path.join(root, 'Backups') };
  }

  function getInboxPath() {
    return path.join(app.getPath('userData'), 'inbox', 'claude-statusline.jsonl');
  }

  // The Claude Code mod's folder: its installed copy, the glance it draws, and
  // the readings and requests it leaves for the app.
  function claudeCodeRoot() {
    return path.join(main.process.env.AI_USAGE_TEST_ROOT || app.getPath('userData'), 'claude-code');
  }

  function notificationStatePath() {
    return path.join(app.getPath('userData'), 'notification-state.json');
  }

  return paths;
}

module.exports = { createPathsModule };
