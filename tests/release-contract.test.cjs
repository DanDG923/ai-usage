'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const readText = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const readCssBlock = (source, header) => {
  const headerIndex = source.indexOf(header);
  assert.notEqual(headerIndex, -1, `missing CSS block: ${header}`);
  const openingBrace = source.indexOf('{', headerIndex);
  assert.notEqual(openingBrace, -1, `missing opening brace for CSS block: ${header}`);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  assert.fail(`missing closing brace for CSS block: ${header}`);
};

test('release metadata, dependency pin, package exclusions, and docs agree', () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const readme = readText('README.md');
  const changelog = readText('CHANGELOG.md');

  assert.equal(pkg.version, '1.0.11');
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
  assert.match(readme, /AI-Usage-Setup-1\.0\.11-x64\.exe/);
  assert.match(readme, /actual local Fable token activity/i);
  assert.match(readme, /experimental/i);
  assert.match(changelog, /^# Changelog\s+## 1\.0\.11/m);
});

test('the desktop window integrates native controls into the app header', () => {
  const main = readText('electron/main.cjs');
  const app = readText('src/App.tsx');
  const styles = readText('src/styles.css');
  const overviewStyles = readText('src/overview.css');

  // Window chrome follows the theme: both palettes are declared once and the
  // overlay is re-applied whenever the effective theme changes.
  assert.match(main, /dark:\s*\{\s*background:\s*'#07101e',\s*symbol:\s*'#cbd6e8'\s*\}/);
  assert.match(main, /light:\s*\{\s*background:\s*'#f4f6fb',\s*symbol:\s*'#2b3548'\s*\}/);
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
  assert.match(overviewStyles, /@media\s*\(max-width:\s*1250px\)\s*\{\s*\.verdict-chip\s*\{[^}]*flex:\s*1 0 100%/s);
});

test('the renderer fluidly scales focal content without globally zooming the UI', () => {
  const entry = readText('src/main.tsx');
  const fluid = readText('src/fluid.css');
  const veryWide = readCssBlock(fluid, '@media (min-width: 1920px)');
  const rendererStyles = [
    'src/styles.css',
    'src/overview.css',
    'src/accessibility.css',
    'src/pricing.css',
    'src/fluid.css',
  ].map(readText).join('\n');

  assert.match(entry, /import ['"]\.\/pricing\.css['"];\s*import ['"]\.\/fluid\.css['"];/);
  assert.match(fluid, /--content-max:\s*1800px/);
  assert.match(fluid, /--page-gutter:\s*clamp\(/);
  assert.match(fluid, /\.page,\s*\.app-footer\s*\{[^}]*var\(--content-max\)[^}]*var\(--page-gutter\)/s);
  assert.match(fluid, /\.panel\s*\{[^}]*var\(--panel-padding\)/s);
  assert.match(fluid, /\.page-lead h1\s*\{[^}]*font-size:\s*clamp\(/s);
  assert.match(fluid, /--gauge-size:\s*clamp\(/);
  assert.match(fluid, /\.qc-hero\s*\{[^}]*grid-template-columns:\s*var\(--gauge-size\)/s);
  assert.match(fluid, /\.gauge,\s*\.gauge svg\s*\{[^}]*width:\s*var\(--gauge-size\)[^}]*height:\s*var\(--gauge-size\)/s);
  assert.match(fluid, /\.qc-grid\s*\{[^}]*minmax\(min\(100%,\s*440px\),\s*1fr\)/s);
  assert.match(veryWide, /--content-max:\s*clamp\(1800px,\s*calc\(100vw - 120px\),\s*2280px\)/s);
  assert.match(veryWide, /\.forecast-wrap\s*\{[^}]*max-width:\s*clamp\(820px,\s*calc\(34\.375vw \+ 160px\),\s*1040px\)/s);
  assert.match(veryWide, /\.cost-chart\s*\{[^}]*max-width:\s*1440px/s);
  assert.match(veryWide, /\.daily-usage-chart\s*\{[^}]*max-width:\s*1920px/s);
  assert.match(fluid, /\.cost-chart,\s*\.daily-usage-chart\s*\{[^}]*height:\s*auto/s);
  assert.match(fluid, /\.settings-nav\s*\{[^}]*top:\s*var\(--sticky-header-offset\)/s);
  assert.match(fluid, /\.settings-section\s*\{[^}]*scroll-margin-top:\s*var\(--sticky-header-offset\)/s);
  assert.match(fluid, /@media\s*\(min-width:\s*1251px\)[^{]*\{\s*\.app-header\s*\{[^}]*titlebar-area-x[^}]*titlebar-area-width/s);
  assert.match(fluid, /@media\s*\(max-width:\s*1250px\)[^{]*\{[^}]*titlebar-area-height/s);
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
  assert.doesNotMatch(rendererStyles, /\bzoom\s*:|transform:\s*scale\(/);
});

test('renderer contracts keep desktop failures honest and estimates visibly approximate', () => {
  const app = readText('src/App.tsx');
  const quotaCard = readText('src/components/QuotaCard.tsx');
  const gauge = readText('src/components/Gauge.tsx');
  const styles = readText('src/styles.css');
  const accessibility = readText('src/accessibility.css');

  assert.match(app, /window\.location\.protocol\s*!==\s*'file:'/);
  assert.match(app, /isBrowserPreview\s*\?\s*demoSnapshot\s*:\s*null/);
  assert.match(app, /secure desktop bridge/i);
  assert.match(app, /if\s*\(!window\.aiUsage\)\s*return;/);
  assert.match(quotaCard, /displayedRemaining\(entry\)/);
  assert.match(quotaCard, /estimated=\{Boolean\(f\.currentIsEstimated/);
  assert.match(gauge, /approximately.*allowance left/);
  assert.match(gauge, /\{estimated\s*\?\s*'~'\s*:\s*''\}/);
  assert.match(gauge, /safePace\s*>\s*0\s*\?\s*recentPace\s*\/\s*safePace\s*:\s*recentPace\s*>\s*0\s*\?\s*span\s*:\s*0/);
  assert.match(styles, /\.settings-content[^}]*min-width\s*:\s*0/s);
  assert.match(styles, /\.settings-page\s*\{\s*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.app-header nav[^}]*flex\s*:\s*0 0 auto/s);
  assert.match(styles, /\.app-header \.refresh-button[^}]*flex\s*:\s*0 0 auto/s);
  assert.match(accessibility, /input:focus-visible\s*\+\s*i/);
});
