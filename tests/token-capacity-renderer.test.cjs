'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

let server;
let demoSnapshot;
let TokenCapacity;
let Overview;

test.before(async () => {
  const [{ createServer }, { default: react }] = await Promise.all([import('vite'), import('@vitejs/plugin-react')]);
  server = await createServer({
    root: path.resolve(__dirname, '..'), configFile: false, plugins: [react()],
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  });
  [{ demoSnapshot }, { TokenCapacity }, { Overview }] = await Promise.all([
    server.ssrLoadModule('/src/data/demo.ts'),
    server.ssrLoadModule('/src/components/TokenCapacity.tsx'),
    server.ssrLoadModule('/src/components/Overview.tsx'),
  ]);
});

test.after(async () => { await server?.close(); });

const render = (snapshot) => renderToStaticMarkup(React.createElement(TokenCapacity, { snapshot }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function fixture() {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.isPreview = false;
  const weekly = snapshot.quotas.codex.windows[0];
  weekly.tokenCapacity = {
    status: 'available', reason: null, weeklyTokens: 1_000_000,
    weeklyRange: { low: 800_000, high: 1_200_000 }, remainingTokens: 600_000,
    remainingRange: { low: 480_000, high: 720_000 }, remainingAsOf: weekly.observedAt,
    confidence: 'medium', intervals: 12, cycles: 3, observedPercent: 74.5,
    calibratedAt: weekly.observedAt,
    modelMix: [{ model: 'gpt-6-astra', share: 0.7 }, { model: 'gpt-5.6-sol', share: 0.3 }],
    tokenMix: { input: 0.2, cacheRead: 0.6, cacheWrite: 0.05, output: 0.15 },
    warnings: ['Some other-device usage may be missing.'],
  };
  snapshot.quotas = { codex: { ...weekly, windows: [weekly] }, claude: null, fable: null };
  return { snapshot, weekly, estimate: weekly.tokenCapacity };
}

test('weekly capacity renders estimates, ranges, timestamp, evidence confidence and separate token categories', () => {
  const { snapshot } = fixture();
  const html = render(snapshot);
  const content = text(html);
  assert.match(content, /Weekly token capacity/);
  assert.match(content, /Estimated token capacity at your recent usage mix/);
  assert.match(content, /Medium confidence/);
  assert.match(content, /Est\. full week ≈ 1m tokens Estimate range 800k–1\.2m tokens Calibrated/);
  assert.match(content, /Est\. remaining at reading ≈ 600k tokens Estimate range 480k–720k tokens/);
  assert.match(content, /Allowance reading .*Europe\/London\. This is not a live token balance/);
  assert.match(html, /<details class="token-capacity-details"><summary>Evidence and usage mix<\/summary>/);
  assert.match(content, /12 matched intervals across 3 cycles · 74\.5 percentage points of allowance change matched/);
  assert.match(content, /gpt-6-astra 70%.*gpt-5\.6-sol 30%/);
  assert.match(content, /Uncached input 20% Cache read 60% Cache write 5% Output 15%/);
  assert.match(content, /Cache categories are counted once/);
  assert.match(content, /Local records may miss web, cloud, or other-device activity/);
  assert.match(content, /Confidence describes consistency in the available local evidence/);
  assert.match(content, /capacities must not be added together/);
  assert.doesNotMatch(content, /Example estimates|confidence interval/i);
});

test('weekly capacity stays separate from a riskier five-hour summary and excludes longer windows', () => {
  const { snapshot, weekly } = fixture();
  const shorter = { ...structuredClone(weekly), bucketId: 'five_hour', bucketName: 'Five hour', windowMinutes: 300 };
  shorter.forecast.state = 'critical';
  shorter.tokenCapacity.weeklyTokens = 99_000_000;
  const longer = { ...structuredClone(weekly), bucketId: 'monthly', bucketName: 'Monthly', windowMinutes: 43_200 };
  longer.tokenCapacity.weeklyTokens = 77_000_000;
  snapshot.quotas.codex = { ...shorter, windows: [shorter, weekly, longer] };
  const content = text(render(snapshot));
  assert.match(content, /≈ 1m tokens/);
  assert.doesNotMatch(content, /99m|77m|Five hour|Monthly/);
});

test('Claude overall and model-scoped weekly limits retain separate estimates without a shared-pool total', () => {
  const { snapshot, weekly } = fixture();
  const overall = { ...structuredClone(weekly), sourceId: 'claude', bucketId: 'seven_day' };
  const second = { ...structuredClone(overall), bucketId: 'seven_day_opus', bucketName: 'Opus weekly' };
  second.tokenCapacity.weeklyTokens = 2_000_000;
  snapshot.quotas = { codex: null, claude: { ...overall, windows: [overall, second] }, fable: null };
  const html = render(snapshot);
  assert.equal((html.match(/class="token-capacity-card claude"/g) || []).length, 2);
  assert.match(text(html), /Opus weekly/);
  assert.match(text(html), /≈ 1m tokens/);
  assert.match(text(html), /≈ 2m tokens/);
  assert.doesNotMatch(text(html), /≈ 3m tokens/);
});

test('supplemental Codex limits with the same Weekly label do not duplicate the main capacity card', () => {
  const { snapshot, weekly } = fixture();
  weekly.bucketId = 'codex:primary';
  weekly.bucketName = 'Weekly';
  weekly.metadata = { limitId: 'codex' };
  const supplemental = { ...structuredClone(weekly), bucketId: 'codex_bengalfox:secondary',
    metadata: { limitId: 'codex_bengalfox' }, observedAt: snapshot.generatedAt };
  supplemental.tokenCapacity.status = 'unavailable';
  supplemental.tokenCapacity.reason = 'Supplemental limit cannot be matched to tokens.';
  snapshot.quotas.codex.windows = [supplemental, weekly];
  const html = render(snapshot);
  assert.equal((html.match(/class="token-capacity-card codex"/g) || []).length, 1);
  assert.match(text(html), /≈ 1m tokens/);
  assert.doesNotMatch(text(html), /Supplemental limit/);
});

test('Codex slot changes select the newest live account reading, even while its estimate is learning', () => {
  const { snapshot, weekly } = fixture();
  weekly.bucketId = 'codex:primary';
  weekly.observedAt = new Date(Date.parse(snapshot.generatedAt) - 3600000).toISOString();
  const current = { ...structuredClone(weekly), bucketId: 'codex:secondary', observedAt: snapshot.generatedAt };
  current.tokenCapacity.status = 'learning';
  current.tokenCapacity.reason = 'Learning the current account window.';
  const expired = { ...structuredClone(weekly), bucketId: 'codex:weekly', observedAt: snapshot.generatedAt };
  expired.forecast.expired = true;
  snapshot.quotas.codex.windows = [expired, weekly, current];
  const before = structuredClone(snapshot);
  const html = render(snapshot);
  assert.equal((html.match(/class="token-capacity-card codex"/g) || []).length, 1);
  assert.match(text(html), /Learning the current account window/);
  assert.doesNotMatch(text(html), /≈ 1m tokens/);
  assert.deepEqual(snapshot, before);
});

test('unsupported or conflicting Codex scopes cannot stand in for the account-wide estimate', () => {
  for (const bucketId of ['codex_bengalfox:secondary', 'codex:weekly']) {
    const { snapshot, weekly } = fixture();
    weekly.bucketId = bucketId;
    weekly.metadata = { limitId: 'codex_bengalfox' };
    const html = render(snapshot);
    assert.equal((html.match(/class="token-capacity-card codex"/g) || []).length, 1);
    assert.equal((text(html).match(/A weekly allowance reading is needed/g) || []).length, 1);
    assert.doesNotMatch(text(html), /≈ 1m tokens/);
  }
});

test('Claude weekly pools without a token scope are hidden beside a supported weekly window', () => {
  const { snapshot, weekly } = fixture();
  const overall = { ...structuredClone(weekly), sourceId: 'claude', bucketId: 'seven_day' };
  const oauth = { ...structuredClone(overall), bucketId: 'seven_day_oauth_apps', bucketName: 'OAuth apps weekly' };
  oauth.tokenCapacity = { ...oauth.tokenCapacity, status: 'unavailable', weeklyTokens: null,
    reason: 'This limit cannot be matched safely to a known weekly token scope.' };
  snapshot.quotas = { codex: null, claude: { ...overall, windows: [overall, oauth] }, fable: null };
  let html = render(snapshot);
  assert.equal((html.match(/class="token-capacity-card claude"/g) || []).length, 1);
  assert.match(text(html), /≈ 1m tokens/);
  assert.doesNotMatch(text(html), /OAuth apps weekly|cannot be matched safely/);
  // The sole weekly window keeps its reason so the user can see why nothing is estimated.
  snapshot.quotas.claude = { ...oauth, windows: [oauth] };
  html = render(snapshot);
  assert.equal((html.match(/class="token-capacity-card claude"/g) || []).length, 1);
  assert.match(text(html), /OAuth apps weekly.*Unavailable.*cannot be matched safely/);
});

test('providers without any allowance reading are omitted and an empty panel is not rendered', () => {
  const { snapshot } = fixture();
  let html = render(snapshot);
  assert.equal((html.match(/class="token-capacity-card /g) || []).length, 1);
  assert.doesNotMatch(text(html), /Claude|Fable 5/);
  snapshot.quotas = { codex: null, claude: null, fable: null };
  html = render(snapshot);
  assert.equal(html, '');
});

test('learning and unavailable estimates show the supplied reason instead of invented capacity', () => {
  const { snapshot, estimate } = fixture();
  estimate.status = 'learning';
  estimate.weeklyTokens = null;
  estimate.remainingTokens = null;
  estimate.reason = 'Waiting for three matching official usage intervals.';
  let content = text(render(snapshot));
  assert.match(content, /Learning Waiting for three matching official usage intervals/);
  assert.doesNotMatch(content, /≈|Est\. full week|Est\. remaining/);
  estimate.status = 'unavailable';
  estimate.reason = 'This allowance cannot be matched to local activity.';
  content = text(render(snapshot));
  assert.match(content, /Unavailable This allowance cannot be matched to local activity/);
  assert.doesNotMatch(content, /≈/);
});

test('missing weekly readings render unavailable provider states without borrowing short-window estimates', () => {
  const { snapshot, weekly } = fixture();
  weekly.windowMinutes = 300;
  const html = render(snapshot);
  assert.equal((text(html).match(/A weekly allowance reading is needed/g) || []).length, 1);
  assert.doesNotMatch(text(html), /≈|600k|Est\. full week/);
});

test('a stale or expired remainder never appears as current while the calibrated full-week estimate is retained', () => {
  const { snapshot, weekly, estimate } = fixture();
  estimate.remainingTokens = null;
  estimate.remainingAsOf = null;
  let content = text(render(snapshot));
  assert.match(content, /Est\. full week ≈ 1m tokens .*Calibrated/);
  assert.match(content, /Est\. remaining at reading Needs current reading/);
  assert.doesNotMatch(content, /600k|Allowance reading/);
  estimate.remainingTokens = 600_000;
  estimate.remainingAsOf = weekly.observedAt;
  weekly.forecast.expired = true;
  content = text(render(snapshot));
  assert.match(content, /≈ 1m tokens/);
  assert.match(content, /Needs current reading/);
  assert.doesNotMatch(content, /600k|Allowance reading/);
});

test('zero remaining tokens stays an explicit timestamped estimate rather than a missing-reading state', () => {
  const { snapshot, estimate } = fixture();
  estimate.remainingTokens = 0;
  estimate.remainingRange = { low: 0, high: 0 };
  const content = text(render(snapshot));
  assert.match(content, /Est\. remaining at reading ≈ 0 tokens Estimate range 0–0 tokens/);
  assert.match(content, /Allowance reading/);
});

test('browser examples are explicitly labelled and the Overview places the runway above token capacity', () => {
  const html = renderToStaticMarkup(React.createElement(Overview, {
    snapshot: demoSnapshot, refreshing: false, onRefresh: async () => {}, onSetupClaude: () => {}, onSources: () => {},
  }));
  assert.match(text(html), /Example estimates/);
  assert.match(text(html), /Synthetic preview figures, not your actual account capacity/);
  assert.ok(html.indexOf('id="token-capacity-heading"') > html.indexOf('class="provider-strip"'));
  const runway = html.indexOf('<h2>Allowance runway</h2>');
  assert.ok(runway > html.indexOf('class="provider-strip"'));
  assert.ok(runway < html.indexOf('id="token-capacity-heading"'));
  assert.ok(html.indexOf('class="overview-workspace"') < html.indexOf('id="token-capacity-heading"'));
});
