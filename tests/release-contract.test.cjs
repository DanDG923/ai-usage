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

  assert.equal(pkg.version, '1.0.27');
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
  assert.deepEqual(pkg.build.publish, { provider: 'github', owner: 'DanDG923', repo: 'ai-usage', private: true });
  assert.deepEqual(pkg.updateFeed, pkg.build.publish);
  assert.match(pkg.scripts.build, /--win portable nsis --x64 --publish never/);
  assert.match(pkg.scripts.pack, /--publish never/);
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
  assert.match(readme, /AI-Usage-Setup-1.0.27-x64\.exe/);
  assert.match(readme, /actual local Fable token activity/i);
  assert.match(readme, /experimental/i);
  assert.match(changelog, /^# Changelog\s+## 1.0.27/m);
});

test('private releases build without credentials and publish complete verified assets', () => {
  const yaml = require('js-yaml');
  const workflow = yaml.load(readText('.github/workflows/release.yml'));
  const steps = workflow.jobs.release.steps;
  const build = steps.find((step) => step.run === 'npm run build');
  const publish = steps.find((step) => step.name === 'Publish audited private release');
  const validate = steps.find((step) => step.name === 'Validate version and destination');
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
  assert.equal(workflow.jobs.release['runs-on'], 'windows-latest');
  assert.equal(build.env.GH_TOKEN, undefined);
  assert.equal(validate.env.GH_TOKEN, '${{ github.token }}');
  assert.match(validate.run, /compare\/main\.\.\.\$head/);
  assert.match(validate.run, /-notin @\('identical', 'behind'\)/);
  assert.equal(build.env.GITHUB_TOKEN, undefined);
  assert.equal(publish.env.GH_TOKEN, '${{ github.token }}');
  assert.match(publish.run, /repository\.private -ne \$true/);
  assert.match(publish.run, /--draft/);
  assert.match(publish.run, /--verify-tag/);
  assert.doesNotMatch(publish.run, /releases\/tags\//);
  assert.match(publish.run, /tag_name -ceq \$env:RELEASE_TAG -and \$_\.draft/);
  for (const artifact of ['latest.yml', 'SHA256SUMS.txt', '.exe.blockmap', 'AI-Usage-Portable-', 'AI-Usage-Setup-']) {
    assert.ok(publish.run.includes(artifact), `release uploads ${artifact}`);
  }
  assert.match(publish.run, /Get-FileHash[\s\S]*SHA256/);
  assert.match(publish.run, /\.digest -cne "sha256:\$sha256"/);
  assert.match(publish.run, /--draft=false --latest/);
  assert.match(readText('.github/workflows/ci.yml'), /jobs:\s+verify:/);
});

test('the desktop window integrates native controls into the app header', () => {
  const main = readText('electron/main.cjs');
  const app = readText('src/App.tsx');
  const styles = readText('src/styles.css');

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
});

test('the renderer reflows to the window without scaling the interface', () => {
  const entry = readText('src/main.tsx');
  const professional = readText('src/professional.css');
  const app = readText('src/App.tsx');

  assert.match(entry, /import ['"]\.\/pricing\.css['"];\s*import ['"]\.\/professional\.css['"];/);
  assert.doesNotMatch(entry, /fluid\.css/);
  assert.doesNotMatch(app, /watchViewportScale/);
  assert.doesNotMatch(professional, /--ui-(?:header-)?scale/);
  assert.doesNotMatch(professional, /transform:\s*scale\(/);

  assert.match(professional, /--content-max:\s*1520px/);
  assert.match(professional, /--page-gutter:\s*clamp\(/);
  assert.match(professional, /\.app-shell\s*\{[^}]*padding-left:\s*var\(--rail-width\)/s);
  assert.match(professional, /\.page\s*\{[^}]*width:\s*min\(var\(--content-max\)/s);
  assert.match(professional, /\.overview-workspace\s*\{[^}]*grid-template-columns:/s);

  const medium = professional.slice(
    professional.indexOf('@media (max-width: 1260px)'),
    professional.indexOf('@media (max-width: 980px)'),
  );
  const compact = professional.slice(
    professional.indexOf('@media (max-width: 980px)'),
    professional.indexOf('@media (max-width: 760px)'),
  );
  const narrow = professional.slice(
    professional.indexOf('@media (max-width: 760px)'),
    professional.indexOf('@media (prefers-reduced-motion: reduce)'),
  );
  assert.match(medium, /\.overview-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(compact, /--rail-width:\s*72px/);
  assert.match(compact, /\.provider-summary-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(narrow, /--rail-width:\s*64px/);
  assert.match(narrow, /\.overview-insights\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(narrow, /\.cost-summary dl\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(narrow, /\.table-search\s*\{[^}]*width:\s*100%/s);
  assert.match(professional, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(professional, /@media\s*\(forced-colors:\s*active\)/);
});

test('renderer contracts keep desktop failures honest and estimates visibly approximate', () => {
  const app = readText('src/App.tsx');
  const providerView = readText('src/provider-view.ts');
  const providerSummary = readText('src/components/ProviderSummary.tsx');
  const styles = readText('src/styles.css');
  const accessibility = readText('src/accessibility.css');

  assert.match(app, /window\.location\.protocol\s*!==\s*'file:'/);
  assert.match(app, /isBrowserPreview\s*\?\s*demoSnapshot\s*:\s*null/);
  assert.match(app, /secure desktop bridge/i);
  assert.match(app, /if\s*\(!window\.aiUsage\)\s*return;/);
  assert.match(providerView, /displayedRemaining\(current\)/);
  assert.match(providerView, /estimated: current \? isEstimated\(current\) : false/);
  assert.match(providerSummary, /\{view\.estimated\s*\?\s*'~'\s*:\s*''\}/);
  assert.match(providerSummary, /view\.estimated \? 'Estimated balance' : 'Current balance'/);
  assert.match(styles, /\.settings-content[^}]*min-width\s*:\s*0/s);
  assert.match(styles, /\.settings-page\s*\{\s*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.app-header nav[^}]*flex\s*:\s*0 0 auto/s);
  assert.match(styles, /\.app-header \.refresh-button[^}]*flex\s*:\s*0 0 auto/s);
  assert.match(accessibility, /input:focus-visible\s*\+\s*i/);
});
