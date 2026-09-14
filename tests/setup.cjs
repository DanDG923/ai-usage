'use strict';

// Loaded by every test file as well as the suite runner, so direct runs have
// the same timezone and cannot inspect a signed-in user's provider folders.
if (!globalThis.aiUsageTestSetupLoaded) {
  globalThis.aiUsageTestSetupLoaded = true;
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const sqlite = require('node:sqlite');
  const originalMkdtemp = fs.mkdtempSync;
  const roots = new Set();
  fs.mkdtempSync = function (...args) {
    const root = originalMkdtemp.apply(this, args);
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('ai-usage-')) roots.add(root);
    return root;
  };
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-test-environment-'));
  process.env.TZ = 'Europe/London';
  process.env.USERPROFILE = sandbox;
  process.env.HOME = sandbox;
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  const Database = sqlite.DatabaseSync;
  const databases = new Set();
  sqlite.DatabaseSync = class TestDatabase extends Database {
    constructor(...args) {
      super(...args);
      databases.add(this);
      try { this.exec('PRAGMA synchronous = OFF'); }
      catch (error) { this.close(); throw error; }
    }
    close() { databases.delete(this); return super.close(); }
  };
  process.on('exit', () => {
    for (const db of databases) { try { db.close(); } catch { /* Already closed. */ } }
    for (const root of roots) {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); }
      catch (error) { process.stderr.write(`Test temporary folder cleanup failed: ${error.code}\n`); process.exitCode = 1; }
    }
  });
}
