'use strict';

// A temporary provider home for collector tests: USERPROFILE, CLAUDE_CONFIG_DIR
// and CODEX_HOME point into a fresh folder with a store beside them. After the
// test the store is closed, the variables are restored and the folder removed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageStore } = require('../../electron/store.cjs');

function providerHome(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previous = Object.fromEntries(['USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  process.env.USERPROFILE = root;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
  process.env.CODEX_HOME = path.join(root, '.codex');
  const store = new UsageStore(path.join(root, 'usage.sqlite'), path.join(root, 'Backups'));
  t.after(() => {
    store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Writes rows as JSON lines to a file under the home, creating its folders.
  const write = (relative, rows) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
    return file;
  };
  return { root, store, write };
}

module.exports = { providerHome };
