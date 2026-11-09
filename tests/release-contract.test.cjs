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
  assert.deepEqual(pkg.build.publish, { provider: 'github', owner: 'DanDG923', repo: 'ai-usage', private: false });
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

test('public releases build without write access and publish complete verified assets', () => {
  const yaml = require('js-yaml');
  const workflow = yaml.load(readText('.github/workflows/release.yml'));
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['build', 'publish']);
  const buildJob = workflow.jobs.build;
  const publishJob = workflow.jobs.publish;

  // Dependency installation, tests and packaging run in a job that cannot
  // write to the repository and gives no step a token.
  assert.deepEqual(buildJob.permissions, { contents: 'read' });
  assert.equal(buildJob['runs-on'], 'windows-latest');
  assert.equal(buildJob.env.GH_TOKEN, undefined);
  assert.equal(buildJob.env.GITHUB_TOKEN, undefined);
  for (const step of buildJob.steps) {
    const text = JSON.stringify(step);
    assert.doesNotMatch(text, /github\.token|secrets\./, `build step ${step.name || step.run || step.uses} receives no token`);
  }
  const checkout = buildJob.steps.find((step) => (step.uses || '').startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  const buildRuns = buildJob.steps.map((step) => step.run).filter(Boolean);
  const validate = buildJob.steps.find((step) => step.name === 'Validate version and destination');
  const build = buildJob.steps.find((step) => step.run === 'npm run build');
  assert.ok(buildRuns.includes('npm ci --ignore-scripts'));
  assert.ok(buildJob.steps.indexOf(validate) < buildJob.steps.findIndex((step) => step.run === 'npm ci --ignore-scripts'),
    'version outputs are recorded before any dependency code runs');
  assert.match(validate.run, /-cne "v\$\(\$package\.version\)"/);
  assert.match(validate.run, /publish\.private -ne \$false/);
  assert.match(validate.run, /git rev-parse 'HEAD\^\{commit\}'/);
  assert.equal(build.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  const upload = buildJob.steps.find((step) => (step.uses || '').startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.name, 'windows-release');
  assert.equal(upload.with['if-no-files-found'], 'error');
  for (const artifact of ['AI-Usage-Setup-', '.exe.blockmap', 'AI-Usage-Portable-', 'latest.yml', 'SHA256SUMS.txt', 'release-notes.md']) {
    assert.ok(upload.with.path.includes(artifact), `build uploads ${artifact}`);
  }
  assert.ok(buildJob.steps.indexOf(build) < buildJob.steps.indexOf(upload));
  for (const output of ['version', 'commit', 'checksums_sha256', 'notes_sha256']) assert.ok(buildJob.outputs[output], `build outputs ${output}`);

  // Publishing holds the only write permission. It checks out nothing,
  // installs nothing and runs no project or dependency code.
  assert.equal(publishJob.needs, 'build');
  assert.deepEqual(publishJob.permissions, { contents: 'write' });
  const publishUses = publishJob.steps.filter((step) => step.uses).map((step) => step.uses.split('@')[0]);
  assert.deepEqual(publishUses, ['actions/download-artifact']);
  for (const step of publishJob.steps.filter((item) => item.run)) {
    assert.equal(step.shell, 'pwsh');
    assert.doesNotMatch(step.run, /\b(?:npm|npx|node|git|electron-builder)\b/, `${step.name} runs no project code`);
  }
  const destination = publishJob.steps.find((step) => step.name === 'Validate destination and existing releases');
  const download = publishJob.steps.find((step) => (step.uses || '').startsWith('actions/download-artifact@'));
  const verify = publishJob.steps.find((step) => step.name === 'Verify downloaded artifacts');
  const publish = publishJob.steps.find((step) => step.name === 'Publish audited release');
  assert.equal(download.with.name, upload.with.name);
  const order = [destination, download, verify, publish].map((step) => publishJob.steps.indexOf(step));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'validation and verification precede publication');
  assert.ok(order.every((index) => index >= 0));
  assert.equal(publishJob.env.GH_TOKEN, undefined);
  assert.equal(verify.env, undefined, 'artifact verification needs no token');
  assert.equal(destination.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(publish.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(publishJob.env.RELEASE_VERSION, '${{ needs.build.outputs.version }}');
  assert.equal(publishJob.env.RELEASE_COMMIT, '${{ needs.build.outputs.commit }}');

  // Every safeguard of the single-job workflow is still present.
  assert.match(destination.run, /-cne "v\$env:RELEASE_VERSION"/);
  assert.match(destination.run, /repository\.private -ne \$false/);
  assert.match(destination.run, /commits\/tags\/\$env:RELEASE_TAG/);
  assert.match(destination.run, /compare\/main\.\.\.\$env:RELEASE_COMMIT/);
  assert.match(destination.run, /-notin @\('identical', 'behind'\)/);
  assert.match(destination.run, /A release for this tag already exists/);
  assert.match(destination.run, /\[version\]\$Matches\[1\] -ge \[version\]\$env:RELEASE_VERSION/);
  assert.match(verify.run, /SHA256SUMS\.txt/);
  assert.match(verify.run, /-cne \$env:CHECKSUMS_SHA256/);
  assert.match(verify.run, /-cne \$env:NOTES_SHA256/);
  assert.match(verify.run, /does not match SHA256SUMS\.txt/);
  assert.match(publish.run, /--draft/);
  assert.match(publish.run, /--verify-tag/);
  assert.doesNotMatch(publish.run, /releases\/tags\//);
  assert.match(publish.run, /tag_name -ceq \$env:RELEASE_TAG -and \$_\.draft/);
  for (const artifact of ['latest.yml', 'SHA256SUMS.txt', '.exe.blockmap', 'AI-Usage-Portable-', 'AI-Usage-Setup-']) {
    assert.ok(publish.run.includes(artifact), `release uploads ${artifact}`);
    assert.ok(verify.run.includes(artifact), `publish verifies ${artifact}`);
  }
  assert.match(publish.run, /Get-FileHash[\s\S]*SHA256/);
  assert.match(publish.run, /\.size -ne \$local\.Length/);
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
  for (const step of [...pack.steps, ...buildJob.steps, ...publishJob.steps].filter((item) => item.uses)) {
    assert.match(step.uses, /@[a-f0-9]{40}$/);
  }
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

test('the Node.js version used by CI is written once, in .nvmrc', () => {
  const yaml = require('js-yaml');
  assert.match(readText('.nvmrc'), /^\d+\.\d+\.\d+\n$/);
  const setups = [
    ...yaml.load(readText('.github/workflows/ci.yml')).jobs.verify.steps,
    ...yaml.load(readText('.github/workflows/release.yml')).jobs.build.steps,
  ].filter((step) => (step.uses || '').startsWith('actions/setup-node@'));
  assert.equal(setups.length, 2);
  for (const step of setups) {
    assert.equal(step.with['node-version-file'], '.nvmrc');
    assert.equal(step.with['node-version'], undefined);
  }
});
