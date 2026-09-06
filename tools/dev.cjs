'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

// The supervised browser preview forwards Vite flags. An ordinary `npm run
// dev` retains the Electron workflow, with an explicit dev:desktop alias too.
const args = process.argv.slice(2);
const browserPreview = args.includes('--host') || args.includes('--port');
if (!browserPreview && !process.env.npm_execpath) {
  throw new Error('Start desktop development with npm run dev.');
}
const program = browserPreview
  ? path.join(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js')
  : process.env.npm_execpath;
const child = spawn(process.execPath, [program, ...(browserPreview ? args : ['run', 'dev:desktop'])], {
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
