# AI Usage

AI Usage is a local-first Windows dashboard for answering two practical questions:

- Will the remaining Codex, Claude, and Fable allowance last until each reset?
- What would the tracked token activity have cost at the equivalent API token prices?

It imports local usage evidence, learns your real burn pattern, evaluates every active allowance window, and keeps its database on this computer.

## Install

Use `AI-Usage-Setup-1.0.23-x64.exe` for a normal Windows installation. Running it over an existing installation upgrades in place and preserves the local database, settings, observations, and backups. Uninstalling first is neither required nor recommended. Install this version once to enable future updates through the app.

Use `AI-Usage-Portable-1.0.23-x64.exe` for a single executable that does not install the app. Windows SmartScreen may show an unknown-publisher warning because this personal build is not backed by a commercial code-signing certificate; verify the supplied SHA-256 hash before running it.

## Personal private updates

Source code and update downloads remain in the private [DanDG923/ai-usage repository](https://github.com/DanDG923/ai-usage). Updates work in the installed Windows app; portable copies continue to be replaced manually.

The app reuses the existing [GitHub CLI](https://cli.github.com/) sign-in on this computer. If GitHub CLI is missing, install it and run `gh auth login --hostname github.com` once. Sign in with an account that can read this private repository, then open **Settings → Appearance & updates** and check for updates. `gh auth status --hostname github.com` can confirm the CLI sign-in without displaying its token. A fine-grained personal access token, if you use one for the CLI, needs access to this repository with **Contents: Read-only**; an existing CLI sign-in may have broader permissions, but the app performs only read requests for releases and downloads.

Automatic update checks are enabled by default, start about 45 seconds after launch, and repeat every six hours while the app is running. The setting can be disabled, and a manual check is always available. When a release is available, review its notes and choose **Download update**. Download progress is shown; private downloads use the complete installer and verify its SHA-512 checksum against the release manifest.

Choose **Restart and update** when ready. AI Usage finishes storage activity, makes a safety backup, and shuts down before installing and reopening. Shutdown waits at most fifteen seconds for storage work; a stalled task is abandoned rather than blocking Quit or a Windows sign-out. If the backup fails, installation is blocked so you can resolve the error and retry. Ordinary app exits do not install a downloaded update. The installer preserves local settings, the database, and existing backups.

GitHub CLI manages the account credential. AI Usage reads it into main-process memory only when needed; it does not copy it to the database, settings, renderer, logs, source code, or packaged update feed. A `GH_TOKEN` or `GITHUB_TOKEN` environment variable is ignored for update checks: the installed app removes both from its own environment before contacting the feed, so only the CLI sign-in can authenticate. Usage history and backups are never uploaded as part of an update check or download. If access expires or is revoked, sign in again with GitHub CLI and retry the check.

## First run

1. Open AI Usage and choose **Refresh**. Local Codex and Claude token records are imported automatically.
2. In **Settings → Sources**, choose a background interval. The app refreshes while its tray process is running; **Only when I refresh** disables scheduled, reopen, and wake-triggered scans after the initial launch scan.
3. Set your normal active hours and days. They shape when future use is expected, while the burn rate itself comes from observed history.
4. Review **API pricing**. Detected models without prices are highlighted and keep the total visibly marked as a lower bound until all of their token categories have prices.

The Claude status-line helper is optional. The automatic Claude usage reader is tried first on every refresh. Enable the helper only as a fallback for overall Claude allowance readings when the provider interface does not return them; it stores only capture time, model identity, and rate-limit fields, and disabling it restores the status line that was present before AI Usage changed the setting.

## Fully automatic Fable tracking

Fable no longer needs a manual entry to start moving. Every Claude refresh performs two independent jobs:

| Evidence | Scope | Dashboard treatment |
| --- | --- | --- |
| Claude's official model-scoped usage reading | Account allowance, when the provider returns a Fable window | Exact provider percentage and reset |
| Local Claude transcripts | Actual Fable token activity recorded on this computer | Imported automatically on every refresh |
| Calibrated local derivation | Allowance estimate when exact model-scoped data is absent and shared-pool evidence is sufficient | Clearly labelled local estimate |
| Manual observation | Optional fallback | Re-anchors an estimate; never required as a trigger |

The official model-scoped reader uses Anthropic's experimental Claude Agent SDK usage method. It sends no prompt, exposes no tools, loads no user settings or plug-ins, persists no session, bounds initialization, usage, and cleanup waits, aborts and releases the control query, validates the complete response before writing, and retains only the allowance fields the tracker needs. AI Usage does not read or store Claude OAuth tokens and does not call a private web endpoint.

That provider method can legitimately return no plan windows. In that case the app records the successful scan, continues importing actual local Fable token activity, and shows the exact allowance as unavailable rather than inventing `0%`. It automatically switches to the exact figure on a later refresh if Claude begins returning a Fable `model_scoped` window.

Fable plan rules are not universal. Claude Max and qualifying premium Team or Enterprise seats include Fable under a dedicated limit of up to half the weekly allowance, while Claude Pro and standard Team or Enterprise seats use pay-as-you-go credits. The fallback half-pool derivation therefore requires affirmative Max-plan evidence. An unknown plan is not treated as Max, and old locally derived rows created from that assumption are discarded during the upgrade. Exact provider model-scoped readings remain authoritative on any plan.

Local transcript activity is deliberately described as **this device**. It cannot see Fable work done on another computer unless an account-level provider allowance is available. **Add a quota observation** remains available for a provider percentage you want to record, but it is now an optional fallback, not an automation prerequisite.

## Run-out forecasting

Codex, overall Claude, and Fable each have an independent learner. Repeated polling snapshots are compacted so they cannot manufacture confidence. The model combines:

- allowance used across the current reset window;
- recent working pace and hourly shape without projecting one burst across every future hour;
- matching hours and weekdays from observed history;
- your configured active-day schedule; and
- the busy end of learned daily use for the **Heavier** scenario.

Provider percentage rebounds within one reset window are handled with a monotonic high-water mark, so rounding jitter cannot spend the same allowance twice. Sparse intervals are allocated by local day, reset boundaries are not mixed, and off-schedule use remains part of the measured burn. An isolated late-night step is duty-cycled across the off-schedule hours observed over whole days; it is not treated as continuous usage throughout every remaining night. This keeps the safe active-hour pace meaningful after an intentionally heavy session.

When a successful official allowance reading shows a new window—or a clear allowance replenishment before its reset timestamp updates—the forecast starts a fresh cycle. External announcements and banked-credit availability are not treated as allowance state: the dashboard reports a banked personal reset credit separately, never assumes it was spent, and never consumes it automatically.

The header verdict is built in the backend from every active primary, secondary, and model-specific window. A risky secondary window overrides a safe headline window. **All allowances on track** appears only when every expected source has sufficiently current evidence and every active window is safe; missing, stale, failed, or expired-only evidence produces an unknown verdict rather than a false all-clear. The verdict chip and the tray tooltip both carry the three headline percentages, and the tray icon carries a colour dot for the current state.

Each card also answers **Runs out**: the moment the expected projection first reaches zero, or the heavier projection's moment when only that one does. The same time is included in pace notifications.

**Budget mode** (Settings → Forecast → *Keep in reserve*) sets a share of each allowance you want untouched at reset. The safe pace only spends what sits above the reserve, and a projection that would eat into it is shown as a watch state; the forecast itself still reports what will actually happen.

## Notifications

Desktop notifications come from the tray process after a collection, so they are only as current as the collection interval. Four kinds can be enabled independently under **Alerts**: pace risk (one per episode, with the earliest run-out time), a window reset, a collector falling back to cached readings, and a daily digest at a chosen hour. **Snooze** pauses all of them for one, six, or twenty-four hours from the settings screen or the tray menu.

## Token API-equivalent costs

The **Costs** search filters model and project summaries and searches every recorded session in the selected period. Session results are paginated, and the filter is retained when switching sections. The default session order is highest API-equivalent value first.

The Details screen reconstructs token API-equivalent value from local input, output, cache-write, and cache-read records. Reasoning tokens are retained as an informational subset of output and are never billed twice. Claude five-minute and one-hour cache writes are stored and priced separately. Every selected historical period is recalculated with the current local price-catalogue row for each model; earlier tariff versions are not reconstructed, so editing a row intentionally reprices the displayed history.

OpenAI GPT-6 Astra and GPT-5.6 Sol, Terra, and Luna requests over the published 272,000-input-token threshold use the long-context multipliers, including cached prompt input when determining whether the threshold is crossed. Astra is included in the built-in catalogue at standard API rates of $10 input, $1 cached input, $12.50 cache writes, and $50 output per million tokens, verified against [OpenAI's model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra) on 4 September 2026. Existing Astra token records are repriced automatically when the new catalogue loads, and saved custom prices are preserved. Unknown or future model names are not assigned a guessed price: their tokens remain visible, price coverage drops, and totals are labelled **At least** until you add the missing row.

These values are token-only comparisons, not provider invoices. They do not claim to include untracked tool charges, web-search charges, storage, taxes, subscription fees, or usage performed on another device that did not reach the local ledger. USD is the ledger currency; GBP and EUR use the manually saved display conversion rate and are not updated from a live foreign-exchange feed.

The Details screen also groups the ledger **by project**, using the working directory each Codex or Claude session ran in, and shows **reset cycles**: the peak percentage each past allowance window reached and what that window's tokens are worth today. **Export CSV…** writes the ledger for the last 30, 90, or 365 days with the per-record API-equivalent, and **Copy summary** puts a plain-text version of every allowance on the clipboard.

Details also shows the **cache hit rate** (the share of prompt tokens read from cache), **recent totals** (today, the last seven days against the seven before, month to date, and a straight-line projection for the month), and **when the work happens**, an hour-by-weekday heatmap of API-equivalent cost. With monthly subscription fees entered under **API pricing**, the Overview adds a **subscription value** figure: how many times over the period's API-equivalent value covers the fees for the same number of days. It compares; it never charges.

Keyboard shortcuts: **1**, **2**, and **3** switch sections and **R** refreshes.

## Source health and privacy

Claude allowance readings must include confirmation of a successful provider fetch. If Claude returns cached figures after a failed connection, AI Usage retains the previous fresh reading and reports the failure. Temporary fetch failures and unexpectedly empty subscription responses receive one retry after a short delay; authentication failures and throttling wait for the next normal refresh. Diagnostics retain only safe error categories and attempt timings, never raw provider debug output.

Each source shows three different timestamps where relevant:

- **Evidence** — the newest quota or token evidence;
- **Scan** — the latest collection attempt; and
- **Last good** — the latest scan that the source explicitly reported as successful.

This keeps a failed refresh from pretending old evidence is current, without deleting the last valid observation. Provider omissions and unsupported experimental responses fail closed: missing percentages remain unknown, while an explicit `0%` is retained as valid data.

Claude prompts and responses are never copied into the dashboard. The ledger retains token counts, timestamps, model names, session/request identifiers, the session's working directory path (for the project breakdown), and limited source metadata needed for deduplication and provenance. Dashboard data is not uploaded by AI Usage.

Collection runs in a separate utility process with its own connection to the same database, so a slow transcript scan or a stalled provider call never freezes the window, the tray, or the settings screen. Transcripts and session logs are read incrementally from a byte cursor rather than re-parsed in full on every refresh. Invalid historical Codex quota windows are counted as rejected while valid token records and other windows continue importing. Polling rows older than sixty days are compacted to the chronological first, last, and highest reading of each window per day; manual observations are retained. **Diagnostics** at the bottom of Settings shows what each collector last saw, including latency and the reason for any fallback.

Update checks fetch private GitHub release metadata and a version manifest. Installer downloads happen only after **Download update** is selected. Update requests contain the GitHub authorization needed for this private repository; local usage data is not sent.

## Data and backups

The database is stored under the standard Windows app-data directory for AI Usage. Backups are written to `Documents\AI Usage\Backups` as both a SQLite snapshot and a readable `.aiusage.json` export. Daily backup creation is enabled by default, and **Back up now** is available at any time.

Backups, restores, and CSV exports run in a dedicated background worker. Storage changes are queued safely, and quitting waits for active storage work to complete.

**Restore from backup…** merges an export into the local database. Existing token records, observations, daily totals, and prices are kept, so a restore neither double-counts nor rolls back newer records. Settings are replaced by the export's settings. A fresh safety backup is written before the merge.

Closing the window keeps the tray app running. Use **Quit** from the tray menu to exit fully.

## Developer verification

Requires Node.js and npm:

```powershell
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build:web
npm audit
npm run build
```

For a repeatable cost-analytics benchmark, run `node tools/benchmark-analytics.cjs` (optionally followed by a record count). It uses 30,000 synthetic records in an in-memory database by default, reports the median of seven measured runs after two warmups, and prints a checksum of the complete result. Compare the checksum as well as the timing when changing analytics. This measures backend cost aggregation, not collection or end-to-end UI latency, and never reads the installed app's data.

Linting uses oxlint (typescript-eslint does not yet support the TypeScript 7 compiler this project builds with) and Prettier formats the renderer source. The same steps run in GitHub Actions on every push and pull request. `npm run build` runs the tests and web build, creates both Windows artifacts without publishing, audits the packaged ASAR for source maps, private local data, and the SDK's optional Claude binary, verifies the private update feed and installer manifest, then writes `release\SHA256SUMS.txt`. The checksums cover the installer, portable executable, installer block map, and `latest.yml`. The source uses React, Vite, Electron, Node's built-in SQLite support, the official Claude Agent SDK, and local JSON-line collectors. Packaged builds use the already installed external Claude binary instead.

## Publish future private updates

1. Update `package.json`, both root versions in `package-lock.json`, the current installer names in this README, the version contract test, and `CHANGELOG.md`. Keep the GitHub repository private and retain the matching `updateFeed` and `build.publish` settings in `package.json`; the separate `updateFeed` survives packaging so the installed app can verify its destination.
2. Complete the checks above, review the changes, and merge them. Create and push the matching version tag, for example `v1.0.24` for version `1.0.24`.
3. The **Private Windows release** GitHub Actions workflow builds Windows x64 packages, checks the manifest and packaged contents, and creates a draft release. It uploads the Setup installer, portable executable, installer block map, `latest.yml`, and `SHA256SUMS.txt`, verifies each remote asset's size and SHA-256 digest, then publishes the release as latest. The normal pull-request CI job is unchanged.

The release workflow can also be started manually with an existing version tag. It refuses a mismatched version, a public or different destination, a tag whose commit is not already on `main`, an existing release for that tag, or a version older than an existing stable release. If an upload fails, any created release stays a draft for inspection and is not offered to the app. Review and remove that incomplete draft before retrying; the workflow never overwrites existing release assets.

Packaging uses `--publish never` and has no publishing credential in its environment. The workflow supplies its short-lived GitHub token only to the release-upload step; no personal token needs to be saved as a repository secret. `latest.yml` includes notes generated from the current changelog entry, and the release audit checks its version, installer filename, byte size, and SHA-512 against the installer on disk before publication.

## Set up another Windows computer

Run the Setup installer and leave **Open AI Usage and set up usage tracking** checked. The first-run guide detects Microsoft Store and native Claude Code installations. If missing, **Install Claude Code** runs Anthropic's official native installer for the current Windows user; no Node.js or npm installation is needed. Internet access and Windows 10/11 are required.

Choose **Sign in to Claude** and complete the account flow in your browser. AI Usage never copies account credentials into its database or installer. Claude Desktop sign-in can be separate from Claude Code sign-in. Then choose **Start collecting** to optionally enable the fallback helper and refresh. Restart Claude Code for the helper to take effect. The provider may omit subscription windows even after a successful sign-in; missing limits are not reported as zero. Local activity only appears after Claude Code has written local usage records.

**Set up later** leaves Codex collection available. Reopen the guide from **Settings → Sources → Set up Claude**. Failed or cancelled installation/sign-in can be retried. A silent installation defers account setup until the app is opened interactively. Codex must separately be installed and signed into on that computer.
