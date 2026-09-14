'use strict';
require('./setup.cjs');
process.env.TZ = 'Europe/London';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

test('renderer effects preserve selection and context across desktop pushes', { timeout: 45_000, skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Electron DOM tests need a display (run under xvfb-run)' : false }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-renderer-dom-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const [{ createServer }, { default: react }] = await Promise.all([import('vite'), import('@vitejs/plugin-react')]);
  const server = await createServer({ root: path.resolve(__dirname, '..'), configFile: false, cacheDir: path.join(directory, 'vite-cache'),
    plugins: [react(), { name: 'test-only-inline-preamble', transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") }],
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  t.after(() => server.close());
  await server.listen();
  const { demoSnapshot } = await server.ssrLoadModule('/src/data/demo.ts');
  const snapshot = structuredClone(demoSnapshot);
  snapshot.isPreview = false;
  snapshot.settings.currencyRates = { GBP: 0.736, USD: 1 };
  const totals = { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 50,
    reasoningOutputTokens: 0, totalTokens: 170, usageCount: 1, cost: 0.15, coverage: 1,
    startedAt: snapshot.generatedAt, occurredAt: snapshot.generatedAt, activitySpanMs: 0 };
  snapshot.costs.tasks = [{ ...totals, key: 'task', sourceId: 'codex', sessionId: 'session-example', taskId: 'task-example',
    project: 'Renderer test', subagentCount: 0, main: totals, subagent: { ...totals, usageCount: 0 }, unknown: { ...totals, usageCount: 0 }, agents: [] }];
  snapshot.costs.sessions = [{ sourceId: 'codex', sessionId: 'session-example', project: 'Renderer test', model: 'gpt-5', occurredAt: snapshot.generatedAt, totalTokens: 170, cost: 0.15, coverage: 1 }];
  const fixture = path.join(directory, 'fixture.json');
  fs.writeFileSync(fixture, JSON.stringify(snapshot));
  const env = { ...process.env, AI_USAGE_RENDERER_PROFILE: path.join(directory, 'profile'), AI_USAGE_RENDERER_FIXTURE: fixture,
    AI_USAGE_RENDERER_URL: `http://127.0.0.1:${server.httpServer.address().port}` };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [path.join(__dirname, 'fixtures/renderer-dom.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(result, 0, output);
  assert.match(output, /RENDERER_DOM_PASS/);
});
