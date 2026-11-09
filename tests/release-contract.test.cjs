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

test('public releases build without credentials and publish complete verified assets', () => {
  const yaml = require('js-yaml');
  const workflow = yaml.load(readText('.github/workflows/release.yml'));
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
  assert.equal(workflow.env.RELEASE_TAG, '${{ inputs.tag || github.ref_name }}');

  // Two jobs: one builds with a read-only token, the other holds the only
  // write permission and runs nothing from the project.
  assert.deepEqual(Object.keys(workflow.jobs), ['build', 'publish']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const { build: buildJob, publish: publishJob } = workflow.jobs;
  assert.deepEqual(buildJob.permissions, { contents: 'read' });
  assert.deepEqual(publishJob.permissions, { contents: 'write' });
  assert.equal(buildJob.needs, undefined);
  assert.equal(publishJob.needs, 'build');
  assert.equal(buildJob['runs-on'], 'windows-latest');
  assert.equal(publishJob['runs-on'], 'windows-latest');
  const steps = [...buildJob.steps, ...publishJob.steps];
  const named = (job, name) => job.steps.find((step) => step.name === name);
  const usesAction = (step, action) => (step.uses || '').startsWith(`${action}@`);
  const credential = /github\.token|secrets\./;

  // Build job: the tag is validated before anything is installed, and no
  // later step is given a token, not even this job's read-only one.
  const buildRuns = buildJob.steps.map((step) => step.run).filter(Boolean);
  const validate = named(buildJob, 'Validate version and destination');
  assert.ok(buildJob.steps.indexOf(validate) < buildJob.steps.findIndex((step) => step.run === 'npm ci --ignore-scripts'));
  assert.equal(validate.env.GH_TOKEN, '${{ github.token }}');
  assert.match(validate.run, /RELEASE_TAG -cne "v\$\(\$package\.version\)"/);
  assert.match(validate.run, /publish\.private -ne \$false/);
  assert.match(validate.run, /compare\/main\.\.\.\$head/);
  assert.match(validate.run, /-notin @\('identical', 'behind'\)/);
  for (const step of buildJob.steps.filter((item) => item !== validate)) {
    assert.doesNotMatch(JSON.stringify(step), credential, 'only validation receives a token in the build job');
  }
  const build = buildJob.steps.find((step) => step.run === 'npm run build');
  assert.equal(build.env.GH_TOKEN, undefined);
  assert.equal(build.env.GITHUB_TOKEN, undefined);
  assert.equal(buildJob.steps[0].with['persist-credentials'], false);
  assert.ok(buildRuns.includes('node node_modules/electron/install.js'));
  assert.ok(buildRuns.includes('npm run test:electron'));
  const upload = buildJob.steps.at(-1);
  assert.ok(usesAction(upload, 'actions/upload-artifact'));
  assert.equal(buildJob.steps.indexOf(build), buildJob.steps.length - 2, 'the audited build output is uploaded as it stands');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.deepEqual(upload.with.path.trim().split(/\r?\n/), [
    'release/AI-Usage-Setup-*-x64.exe',
    'release/AI-Usage-Setup-*-x64.exe.blockmap',
    'release/AI-Usage-Portable-*-x64.exe',
    'release/latest.yml',
    'release/SHA256SUMS.txt',
    'release/release-notes.md',
  ]);

  // Publish job: package.json and the artifact are the only inputs. It has
  // no Node setup, installs nothing and runs nothing from the checkout.
  assert.deepEqual(publishJob.steps.map((step) => step.name || step.uses.split('@')[0]), [
    'actions/checkout',
    'Validate version and destination',
    'actions/download-artifact',
    'Publish audited release',
  ]);
  const [checkout, publishValidate, download, publish] = publishJob.steps;
  assert.equal(checkout.with.ref, buildJob.steps[0].with.ref);
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with['sparse-checkout'], '/package.json');
  assert.equal(checkout.with['sparse-checkout-cone-mode'], false);
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with.path, 'release');
  assert.equal(download.with['github-token'], undefined);
  for (const step of publishJob.steps) {
    assert.doesNotMatch(step.run || '', /\b(?:npm|npx|node|electron-builder)\b/, 'the publish job runs no project code');
  }
  // The checks that guard the write permission are the ones the build ran.
  assert.deepEqual(publishValidate, validate);
  assert.equal(buildJob.outputs.commit, '${{ steps.validate.outputs.commit }}');
  assert.match(validate.run, /"commit=\$head" >> \$env:GITHUB_OUTPUT/);
  assert.equal(publish.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(publish.env.BUILT_COMMIT, '${{ needs.build.outputs.commit }}');
  assert.equal(publish.env.VALIDATED_COMMIT, '${{ steps.validate.outputs.commit }}');
  assert.match(publish.run, /\$env:BUILT_COMMIT -cne \$env:VALIDATED_COMMIT/);
  assert.match(publish.run, /repository\.private -ne \$false/);
  assert.match(publish.run, /A release for this tag already exists/);
  assert.match(publish.run, /refusing to move the update feed backwards/);
  // `--draft=false` appears later in the script, so match the create command.
  assert.match(publish.run, /gh release create [^\n]* --verify-tag --draft /);
  assert.doesNotMatch(publish.run, /releases\/tags\//);
  assert.match(publish.run, /tag_name -ceq \$env:RELEASE_TAG -and \$_\.draft/);
  for (const artifact of ['latest.yml', 'SHA256SUMS.txt', '.exe.blockmap', 'AI-Usage-Portable-', 'AI-Usage-Setup-']) {
    assert.ok(publish.run.includes(artifact), `release uploads ${artifact}`);
  }
  // Nothing is uploaded until the downloaded files are exactly the expected
  // set and match the checksums the release audit wrote.
  const createsDraft = publish.run.indexOf('gh release create');
  const exactFiles = publish.run.indexOf('$_.PSIsContainer -or $_.Name -cnotin $expectedFiles');
  const checksums = publish.run.indexOf('$_ -ceq "$actual *$name"');
  assert.ok(exactFiles > 0 && exactFiles < createsDraft, 'unexpected files stop the release before upload');
  assert.ok(checksums > 0 && checksums < createsDraft, 'SHA256SUMS.txt is verified before upload');
  assert.match(publish.run, /\$checksumLines\.Count -ne \$checksummed\.Count/);
  assert.match(readText('tools/audit-release.cjs'), /toUpperCase\(\)\} \*\$\{name\}/, 'the audit writes the line format the publish job compares');
  assert.match(publish.run, /Get-FileHash[\s\S]*SHA256/);
  assert.match(publish.run, /\.digest -cne "sha256:\$sha256"/);
  assert.match(publish.run, /\.size -ne \$local\.Length/);
  assert.ok(publish.run.indexOf('.digest -cne "sha256:$sha256"') < publish.run.indexOf('--draft=false --latest'), 'remote assets are verified before the draft is published');
  assert.match(publish.run, /--draft=false --latest/);

  // CI and the release build read one Node version from one place.
  assert.match(readText('.nvmrc'), /^\d+\.\d+\.\d+\r?\n$/);
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
  const nodeSetups = [...pack.steps, ...steps].filter((step) => usesAction(step, 'actions/setup-node'));
  assert.equal(nodeSetups.length, 2, 'CI and the release build set up Node; the publish job does not');
  for (const step of nodeSetups) {
    assert.equal(step.with['node-version-file'], '.nvmrc');
    assert.equal(step.with['node-version'], undefined);
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

  // A second job runs the checks and the Node test suite on Linux, so code
  // that assumes Windows paths by accident is caught. It only checks: it never
  // installs the Electron binary, packages, or widens the workflow's permissions.
  assert.deepEqual(Object.keys(ci.jobs), ['verify', 'verify-linux']);
  const linux = ci.jobs['verify-linux'];
  assert.equal(linux['runs-on'], 'ubuntu-latest');
  assert.equal(linux.permissions, undefined, 'the Linux job keeps the workflow-wide read-only permissions');
  for (const step of linux.steps.filter((item) => item.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/);
  const linuxActions = linux.steps.filter((item) => item.uses).map((item) => item.uses);
  assert.deepEqual(linuxActions, pack.steps.filter((item) => item.uses).map((item) => item.uses), 'both jobs pin the same actions');
  const linuxNode = linux.steps.find((step) => usesAction(step, 'actions/setup-node'));
  assert.equal(linuxNode.with['node-version-file'], '.nvmrc');
  assert.equal(linuxNode.with['node-version'], undefined);
  assert.deepEqual(linux.steps.map((step) => step.run).filter(Boolean),
    ['npm ci --ignore-scripts', 'npm run lint', 'npm run format:check', 'npm run typecheck', 'npm test']);
  for (const run of ['npm run lint', 'npm run format:check', 'npm run typecheck', 'npm test']) assert.ok(packRuns.includes(run), `the Windows job still runs ${run}`);
});
