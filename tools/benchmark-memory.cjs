'use strict';

// Run against two built source trees with the same Electron runtime:
// node tools/benchmark-memory.cjs <source-directory> baseline|optimized
// Synthetic data only; the installed app, login registry and provider profiles
// are never used. Results stay in work/ for a before/after comparison.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const source = path.resolve(process.argv[2] || '.');
const mode = process.argv[3] || 'optimized';
if (!['baseline', 'optimized', 'hidden'].includes(mode)) throw new Error('Choose baseline, optimized or hidden.');
const work = path.resolve(__dirname, '../work');
fs.mkdirSync(work, { recursive: true });
const root = fs.mkdtempSync(path.join(work, `memory-${mode}-`));
const env = { ...process.env, AI_USAGE_MEMORY_SOURCE: source, AI_USAGE_MEMORY_ROOT: root, AI_USAGE_MEMORY_MODE: mode,
  AI_USAGE_TEST_ROOT: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
  CODEX_BINARY: path.join(root, 'no-provider.exe'), PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_USAGE_DISABLE_GPU']) delete env[key];
const child = spawn(require('electron'), [path.resolve(__dirname, '../tests/fixtures/memory-app.cjs'), ...(mode === 'hidden' ? ['--hidden'] : [])], {
  // Native window visibility is under test. SW_HIDE startup flags can suppress
  // the first ShowWindow on Windows even after Electron emits its show event.
  env, windowsHide: false, stdio: 'inherit',
});
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 180_000);
child.on('error', (error) => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { clearTimeout(timeout); console.log(`Memory report: ${path.join(root, 'report.json')}`); process.exitCode = code ?? 1; });
