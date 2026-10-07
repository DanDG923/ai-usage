'use strict';
require('./setup.cjs');

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

  assert.equal(require('../tools/bump-version.cjs').checkVersion(root, pkg.version), pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(pkg.dependencies['@anthropic-ai/claude-agent-sdk'], /^\d+\.\d+\.\d+$/);
  assert.equal(lock.packages[''].dependencies['@anthropic-ai/claude-agent-sdk'], pkg.dependencies['@anthropic-ai/claude-agent-sdk']);
  // Vite bundles the renderer, so its packages must never be packed as loose
  // files; the only runtime dependencies are the SDK and the updater.
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@anthropic-ai/claude-agent-sdk', 'electron-updater']);
  for (const name of ['react', 'react-dom', 'lucide-react']) assert.ok(pkg.devDependencies[name], `${name} is a devDependency`);
  // The release tooling and these tests load js-yaml and @electron/asar
  // directly, so they must be declared rather than borrowed from
  // electron-builder's transitive tree. The pin is checked for its form, not
  // a particular version, so a dependency bump needs no edit here.
  for (const name of ['js-yaml', '@electron/asar']) {
    const version = pkg.devDependencies[name];
    assert.match(version ?? '', /^\d+\.\d+\.\d+$/, `${name} is an exactly pinned devDependency`);
    assert.equal(lock.packages[''].devDependencies[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  assert.equal(pkg.allowScripts, undefined);
  assert.equal(pkg.scripts.lint, 'oxlint --deny-warnings');
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
  assert.match(readme, /actual local Fable token activity/i);
  assert.match(readme, /experimental/i);
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
  const ci = yaml.load(readText('.github/workflows/ci.yml'));
  assert.ok(ci.jobs.verify, 'CI keeps the verify job');
  // Packaging is exercised on every push so a broken ASAR or update feed is
  // caught before a tag ever reaches the release workflow. The nsis target is
  // the only Windows target for which electron-builder writes app-update.yml.
  const pack = ci.jobs.verify;
  assert.equal(pack['runs-on'], 'windows-latest');
  assert.equal(ci.jobs.package, undefined);
  assert.equal(ci.permissions.contents, 'read');
  assert.ok(ci.concurrency['cancel-in-progress']);
  for (const step of [...pack.steps, ...steps].filter((item) => item.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/);
  const packRuns = pack.steps.map((step) => step.run).filter(Boolean);
  assert.ok(packRuns.includes('npm ci --ignore-scripts'));
  assert.ok(packRuns.includes('node node_modules/electron/install.js'));
  assert.ok(packRuns.includes('npm run build:web'));
  assert.ok(packRuns.indexOf('npm run release:notes') < packRuns.findIndex((run) => run.includes('electron-builder')));
  const builder = pack.steps.find((step) => /electron-builder --config tools\/electron-builder.cjs --win nsis --x64 --publish never/.test(step.run || ''));
  assert.equal(builder.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.equal(builder.env.GH_TOKEN, undefined);
  assert.equal(builder.env.GITHUB_TOKEN, undefined);
  assert.ok(packRuns.includes('node tools/audit-release.cjs --unpacked'));
  assert.match(readText('tools/audit-release.cjs'), /--unpacked/);
});
