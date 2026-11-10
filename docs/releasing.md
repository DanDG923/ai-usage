# Releasing

This page is for the maintainer publishing a new version of AI Usage. It covers preparing the version, tagging, what the **Windows release** workflow does and refuses, and the limits of the release-access controls. The checks a change must pass first are in [Development](development.md#verification).

## Publish future updates

### 1. Prepare the version

Run `node tools/bump-version.cjs <version>` with a stable `x.y.z` version. It does not tag or publish. It:

- sets `version` in `package.json` and both root versions in `package-lock.json`;
- replaces every occurrence of the previous version in `README.md`, which updates the current installer names;
- adds a `## <version>` heading with a "Release notes pending review." placeholder at the top of `CHANGELOG.md`, unless a heading for that version is already there (notes written ahead of the bump keep their heading, dated or not); earlier changelog headings are left intact; and
- runs the same check as `npm run version:check`, then prints the tag command to use.

`npm run version:check` (`node tools/bump-version.cjs --check`) verifies release metadata: the `package.json` and lockfile versions agree, the README names the Setup and Portable installers for that version, and the latest `CHANGELOG.md` heading is that version. The release contract test reads the version from `package.json`, so it needs no edit.

What remains manual:

- Write or review the release notes under the new `CHANGELOG.md` heading, replacing the placeholder; `latest.yml` and the GitHub release take their notes from that entry.
- Keep the GitHub repository public and retain the matching `updateFeed` and `build.publish` settings (with `"private": false`) in `package.json`; the separate `updateFeed` survives packaging so the installed app can verify its destination.

### 2. Check, merge and tag

Complete the [verification checks](development.md#verification), including those [CI does not run](development.md#what-ci-runs), review the changes, and merge them. Create and push the matching version tag, for example `v1.2.3` for version `1.2.3`.

### 3. The release workflow

The **Windows release** GitHub Actions workflow runs as two jobs:

- **Build.** The build job installs the dependencies, runs the tests, builds the Windows x64 packages, checks the manifest and packaged contents, and passes the release files to the second job as a workflow artifact.
- **Publish.** The publish job checks those files against `SHA256SUMS.txt` and creates a draft release. It uploads the Setup installer, portable executable, installer block map, `latest.yml`, and `SHA256SUMS.txt`, verifies each remote asset's size and SHA-256 digest, then publishes the release as latest.

The normal pull-request CI job is unchanged.

## What the workflow refuses

The release workflow can also be started manually with an existing version tag. It refuses:

- a mismatched version;
- a private or different destination;
- a tag whose commit is not already on `main`;
- a tag that moved between the two jobs;
- an existing release for that tag; or
- a version older than an existing stable release.

The tag checks run twice: in the build job before anything is installed, and again in the publish job.

If an upload fails, any created release stays a draft for inspection and is not offered to the app. Review and remove that incomplete draft before retrying; the workflow never overwrites existing release assets.

## Tokens and permissions

Packaging uses `--publish never`, and the build job's short-lived GitHub token can only read the repository. Dependencies, tests and the packager all run in that job, so nothing they execute can create, change or delete a release or a tag.

Permission to write releases belongs to the publish job alone. That job starts on a fresh runner, checks out only `package.json`, installs nothing and runs no project code: it repeats the tag checks, verifies the files it was handed, and passes them to `gh release`. No personal token needs to be saved as a repository secret.

This separation limits what build-time code can reach; it does not vouch for what the build produces. The publish job uploads the files the build job made, and `SHA256SUMS.txt` was written by that same build, so checking against it catches a file that changed or went missing between the jobs, not a build that was compromised while it ran. `latest.yml` includes notes generated from the current changelog entry, and the release audit checks its version, installer filename, byte size, and SHA-512 against the installer on disk before publication.

## Release access

Release access remains a repository-administration decision: anyone with write access can change a tag-triggered workflow. SHA-pinned actions and least-privilege job tokens do not replace protected refs/environments or installer signing.

Restrict writer access and configure signing when the repository plan and a certificate support it; these changes do not silently modify collaborators or claim that unsigned installers are signed.

How unsigned in-app updates are trusted is described under [accepted risks](privacy-and-security.md#security-model-and-accepted-risks).
