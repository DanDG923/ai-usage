'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const readText = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('release metadata, dependency pin, package exclusions, and docs agree', () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const readme = readText('README.md');
  const changelog = readText('CHANGELOG.md');

  assert.equal(pkg.version, '1.0.14');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.dependencies['@anthropic-ai/claude-agent-sdk'], '0.3.251');
  assert.equal(lock.packages[''].dependencies['@anthropic-ai/claude-agent-sdk'], '0.3.251');
  // Vite bundles the renderer, so its packages must never be packed as loose
  // files; the only runtime dependencies are the SDK and the updater.
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@anthropic-ai/claude-agent-sdk', 'electron-updater']);
  for (const name of ['react', 'react-dom', 'lucide-react']) assert.ok(pkg.devDependencies[name], `${name} is a devDependency`);
  assert.equal(pkg.scripts.lint, 'oxlint');
  assert.match(pkg.scripts['format:check'], /prettier --check/);
  assert.equal(pkg.scripts.typecheck, 'tsc -b');
  assert.equal(pkg.build.publish.provider, 'github');
  assert.ok(pkg.build.files.includes('!node_modules/@anthropic-ai/claude-agent-sdk-win32-*/**'));
  assert.ok(pkg.build.files.includes('!dist/**/*.map'));
  assert.ok(pkg.build.files.includes('!**/*.map'));
  assert.equal(pkg.build.electronDist, 'node_modules/electron/dist');
  assert.match(pkg.scripts.build, /release:audit/);
  assert.equal(pkg.scripts['release:audit'], 'node tools/audit-release.cjs');
  const releaseAudit = readText('tools/audit-release.cjs');
  assert.match(releaseAudit, /listPackage/);
  assert.match(releaseAudit, /SHA256SUMS\.txt/);
  assert.match(releaseAudit, /source map/i);
  assert.match(releaseAudit, /private local data/i);
  assert.match(readme, /AI-Usage-Setup-1.0.14-x64\.exe/);
  assert.match(readme, /actual local Fable token activity/i);
  assert.match(readme, /experimental/i);
  assert.match(changelog, /^# Changelog\s+## 1.0.14/m);
});

test('the desktop window integrates native controls into the app header', () => {
  const main = readText('electron/main.cjs');
  const app = readText('src/App.tsx');
  const styles = readText('src/styles.css');
  const overviewStyles = readText('src/overview.css');

  // Window chrome follows the theme: both palettes are declared once and the
  // overlay is re-applied whenever the effective theme changes.
  assert.match(main, /dark:\s*\{\s*background:\s*'#0f1113',\s*symbol:\s*'#c8cbd0'\s*\}/);
  assert.match(main, /light:\s*\{\s*background:\s*'#f5f5f6',\s*symbol:\s*'#3a3d43'\s*\}/);
  assert.match(main, /backgroundColor:\s*chrome\.background/);
  assert.match(main, /titleBarStyle:\s*'hidden'/);
  assert.match(main, /titleBarOverlay:\s*\{[^}]*color:\s*chrome\.background/s);
  assert.match(main, /titleBarOverlay:\s*\{[^}]*symbolColor:\s*chrome\.symbol/s);
  assert.match(main, /nativeTheme\.on\('updated'/);
  assert.match(main, /setTitleBarOverlay\(/);
  assert.match(styles, /\.app-header\s*\{[^}]*padding-left:[^}]*titlebar-area-x[^}]*padding-right:[^}]*titlebar-area-width/s);
  assert.match(styles, /\.app-header\s*\{[^}]*app-region:\s*drag/s);
  assert.match(styles, /\.app-header\s*>\s*\*\s*\{[^}]*app-region:\s*no-drag/s);
  assert.match(app, /if\s*\(!snapshot\)\s*\{[\s\S]*?<header className="app-header app-header-status">/s);
  assert.match(styles, /@media\s*\(max-width:\s*1250px\)\s*\{\s*\.app-header\s*\{[^}]*titlebar-area-height/s);
  assert.match(styles, /@media\s*\(max-width:\s*760px\)\s*\{\s*\.app-header\s*\{[^}]*padding-left:\s*max\(14px/s);
  assert.match(overviewStyles, /@media\s*\(max-width:\s*1250px\)\s*\{\s*\.status-line\s*\{[^}]*flex-wrap:\s*wrap/s);
});

test('the renderer scales the page to the window and fills the overview height', () => {
  const entry = readText('src/main.tsx');
  const fluid = readText('src/fluid.css');
  const scale = readText('src/scale.ts');
  const app = readText('src/App.tsx');
  const charts = readText('src/components/Charts.tsx');
  const rendererStyles = [
    'src/styles.css',
    'src/overview.css',
    'src/accessibility.css',
    'src/pricing.css',
    'src/fluid.css',
  ].map(readText).join('\n');

  assert.match(entry, /import ['"]\.\/pricing\.css['"];\s*import ['"]\.\/fluid\.css['"];/);
  // The scale is derived from both window dimensions, bounded, and applied as
  // CSS zoom to the page (never the header, whose safe areas are in real px).
  assert.match(scale, /DESIGN_WIDTH = 1600/);
  assert.match(scale, /DESIGN_HEIGHT = 1000/);
  assert.match(scale, /MIN_SCALE = 0\.7/);
  assert.match(scale, /MAX_SCALE = 1\.6/);
  assert.match(scale, /setProperty\('--ui-scale'/);
  assert.match(scale, /setProperty\('--header-height'/);
  assert.match(app, /watchViewportScale\(\)/);
  assert.match(fluid, /\.page,\s*\.app-footer,\s*\.toast,\s*\.saving-toast\s*\{\s*zoom:\s*var\(--ui-scale\);\s*\}/s);
  assert.match(fluid, /\.app-header > \*\s*\{\s*zoom:\s*var\(--ui-header-scale\);\s*\}/s);
  assert.doesNotMatch(fluid, /\.app-header\s*\{[^}]*zoom:/s);
  assert.match(fluid, /--rvw:\s*calc\(1vw \/ var\(--ui-scale\)\)/);
  assert.match(fluid, /--sticky-header-offset:\s*calc\(\(var\(--header-height\) \+ 26px\) \/ var\(--ui-scale\)\)/);
  assert.match(fluid, /--content-max:\s*1800px/);
  assert.match(fluid, /--page-gutter:\s*clamp\(/);
  assert.match(fluid, /\.page,\s*\.app-footer\s*\{[^}]*var\(--content-max\)[^}]*var\(--page-gutter\)/s);
  assert.match(fluid, /\.panel\s*\{[^}]*var\(--panel-padding\)/s);
  assert.match(fluid, /\.page-lead h1\s*\{[^}]*font-size:\s*clamp\(/s);
  assert.match(fluid, /\.qc-figure b\s*\{[^}]*font-size:\s*clamp\(/s);
  assert.match(fluid, /\.qc-grid\s*\{[^}]*minmax\(min\(100%,\s*440px\),\s*1fr\)/s);
  // Vertical fill: the overview takes the height under the header and the
  // forecast plot absorbs the spare height of its card.
  assert.match(fluid, /\.overview-page\s*\{[^}]*min-height:\s*calc\(\(100vh - var\(--header-height\)\) \/ var\(--ui-scale\)/s);
  assert.match(fluid, /\.forecast-plot\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.match(fluid, /\.forecast-plot > svg\s*\{[^}]*position:\s*absolute[^}]*height:\s*100%/s);
  assert.match(charts, /new ResizeObserver\(/);
  assert.match(charts, /PLOT_MAX_HEIGHT = 520/);
  assert.match(fluid, /\.cost-chart,\s*\.daily-usage-chart\s*\{[^}]*height:\s*auto/s);
  assert.match(fluid, /\.settings-nav\s*\{[^}]*top:\s*var\(--sticky-header-offset\)/s);
  assert.match(fluid, /\.settings-section\s*\{[^}]*scroll-margin-top:\s*var\(--sticky-header-offset\)/s);
  assert.match(fluid, /@media\s*\(min-width:\s*1251px\)[^{]*\{\s*\.app-header\s*\{[^}]*titlebar-area-x[^}]*titlebar-area-width/s);
  const summaryStart = fluid.indexOf('@media (max-width: 1500px)');
  const compactStart = fluid.indexOf('@media (max-width: 1000px)');
  const compactEnd = fluid.indexOf('@media (max-width: 800px)', compactStart);
  assert.ok(summaryStart >= 0 && compactStart > summaryStart && compactEnd > compactStart);
  const summary = fluid.slice(summaryStart, compactStart);
  const compact = fluid.slice(compactStart, compactEnd);
  assert.match(summary, /\.overview-page \.value-strip\s*\{[^}]*display:\s*grid/s);
  assert.match(summary, /\.overview-page \.value-strip > svg\s*\{[^}]*display:\s*none/s);
  assert.match(compact, /\.settings-page\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(compact, /\.source-row\s*\{[^}]*grid-template-columns:\s*43px minmax\(0,\s*1fr\) auto/s);
  assert.match(compact, /\.source-row > button\s*\{[^}]*grid-column:\s*2 \/ -1/s);
  assert.match(fluid, /\.forecast-tip\s*\{[^}]*width:\s*min\(190px[^}]*white-space:\s*normal/s);
  // Scaling is CSS zoom driven by the custom properties above and nothing else:
  // no transform scaling (blurry, no reflow) and no zoom with a literal factor.
  assert.doesNotMatch(rendererStyles, /transform:\s*scale\(/);
  for (const match of rendererStyles.matchAll(/\bzoom\s*:\s*([^;]+);/g)) {
    assert.match(match[1], /^var\(--ui-(?:header-)?scale\)$/, `zoom must come from the scale properties, got ${match[1]}`);
  }
});

test('renderer contracts keep desktop failures honest and estimates visibly approximate', () => {
  const app = readText('src/App.tsx');
  const quotaCard = readText('src/components/QuotaCard.tsx');
  const styles = readText('src/styles.css');
  const accessibility = readText('src/accessibility.css');

  assert.match(app, /window\.location\.protocol\s*!==\s*'file:'/);
  assert.match(app, /isBrowserPreview\s*\?\s*demoSnapshot\s*:\s*null/);
  assert.match(app, /secure desktop bridge/i);
  assert.match(app, /if\s*\(!window\.aiUsage\)\s*return;/);
  assert.match(quotaCard, /displayedRemaining\(entry\)/);
  assert.match(quotaCard, /const estimated = Boolean\(f\.currentIsEstimated && f\.estimatedCurrentRemaining != null\)/);
  assert.match(quotaCard, /approximately.*of the allowance left/);
  assert.match(quotaCard, /\{estimated\s*\?\s*'~'\s*:\s*''\}/);
  assert.match(quotaCard, /f\.safePace\s*>\s*0\s*\?\s*f\.recentPace\s*\/\s*f\.safePace/);
  assert.match(styles, /\.settings-content[^}]*min-width\s*:\s*0/s);
  assert.match(styles, /\.settings-page\s*\{\s*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.app-header nav[^}]*flex\s*:\s*0 0 auto/s);
  assert.match(styles, /\.app-header \.refresh-button[^}]*flex\s*:\s*0 0 auto/s);
  assert.match(accessibility, /input:focus-visible\s*\+\s*i/);
});
