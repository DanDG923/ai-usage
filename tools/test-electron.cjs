'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
// The tests are one folder per feature, as `npm test` lists them: tests/*/*.test.cjs.
const files = fs.readdirSync(path.join(root, 'tests'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((folder) => fs.readdirSync(path.join(root, 'tests', folder.name))
    .filter((name) => name.endsWith('.test.cjs'))
    .map((name) => path.join('tests', folder.name, name)))
  .sort();
if (!files.length) throw new Error('No test files found under tests/.');
const result = spawnSync(require('electron'), ['--require', './tests/setup.cjs', '--test', '--test-concurrency=2', ...files], {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TZ: 'Europe/London' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
