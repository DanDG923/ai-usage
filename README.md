# AI Usage

AI Usage is a local-first Windows dashboard for answering two practical questions:

- Will the remaining Codex, Claude, and Fable allowance last until each reset?
- What would the tracked token activity have cost at the equivalent API token prices?

It imports local usage evidence, learns your real burn pattern, evaluates every active allowance window, and keeps its database on this computer.

## Install

Use `AI-Usage-Setup-1.0.43-x64.exe` for a normal Windows installation. Running it over an existing installation upgrades in place and preserves the local database, settings, observations, and backups. Uninstalling first is neither required nor recommended. Install this version once to enable future updates through the app.

Use `AI-Usage-Portable-1.0.43-x64.exe` for a single executable that does not install the app. Windows SmartScreen may show an unknown-publisher warning because this personal build is not backed by a commercial code-signing certificate; verify the supplied SHA-256 hash before running it.

## Personal private updates

Source code and update downloads remain in the private [DanDG923/ai-usage repository](https://github.com/DanDG923/ai-usage). Updates work in the installed Windows app; portable copies continue to be replaced manually.

The app reuses the existing [GitHub CLI](https://cli.github.com/) sign-in on this computer. If GitHub CLI is missing, install it and run `gh auth login --hostname github.com` once. Sign in with an account that can read this private repository, then open **Settings → Appearance & updates** and check for updates. `gh auth status --hostname github.com` can confirm the CLI sign-in without displaying its token. A fine-grained personal access token, if you use one for the CLI, needs access to this repository with **Contents: Read-only**; an existing CLI sign-in may have broader permissions, but the app performs only read requests for releases and downloads.

Automatic update checks are enabled by default, start about 45 seconds after launch, and repeat every six hours while the app is running. The setting can be disabled, and a manual check is always available. When a release is available, review its notes and choose **Download update**. Download progress is shown; private downloads use the complete installer and verify its SHA-512 checksum against the release manifest.

Choose **Restart and update** when ready. AI Usage finishes storage activity, makes a safety backup, and shuts down before installing and reopening. The whole preparation is limited to fifteen seconds. If the backup does not finish in time, nothing is installed and AI Usage reopens so you can retry; if only the final close stalls after the backup, the update proceeds. Quit from the tray waits the same fifteen seconds for storage work before exiting. If the backup fails, installation is blocked so you can resolve the error and retry. Ordinary app exits do not install a downloaded update. The installer preserves local settings, the database, and existing backups.

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
| Projected local estimate | Allowance estimate when exact model-scoped data is absent and shared-pool evidence is sufficient; computed when the dashboard is built, never stored | Clearly labelled local estimate |
| Manual observation | Optional fallback | Re-anchors an estimate; never required as a trigger |

The official model-scoped reader uses Anthropic's experimental Claude Agent SDK usage method. It sends no prompt, exposes no tools, loads no user settings or plug-ins, persists no session, bounds initialization, usage, and cleanup waits, aborts and releases the control query, validates the complete response before writing, and retains only the allowance fields the tracker needs. AI Usage does not read or store Claude OAuth tokens and does not call a private web endpoint.

That provider method can legitimately return no plan windows. In that case the app records the successful scan, continues importing actual local Fable token activity, and shows the exact allowance as unavailable rather than inventing `0%`. It automatically switches to the exact figure on a later refresh if Claude begins returning a Fable `model_scoped` window.

Fable plan rules are not universal. Claude Max and qualifying premium Team or Enterprise seats include Fable under a dedicated limit of up to half the weekly allowance, while Claude Pro and standard Team or Enterprise seats use pay-as-you-go credits. The fallback half-pool derivation therefore requires affirmative Max-plan evidence. An unknown plan is not treated as Max, and old locally derived rows created from that assumption are discarded during the upgrade. Exact provider model-scoped readings remain authoritative on any plan.

The local estimate is a projection, not a reading. It is recomputed from official readings and local activity each time the dashboard snapshot is built, cached until Claude evidence, the allowance-change setting or the clock moves it, and never written to the allowance history. So it cannot outlive the settings it was computed under, an official reading is never displaced by it, and cycle history for Fable is built from provider-backed and manual readings only; while only the projection exists, the current cycle row for Fable stays empty. The Max-plan check reads the most recent official reading in the window that names a plan, so a status-line reading, which never carries one, cannot switch the estimate off. Estimates stored by earlier versions are removed once on upgrade.

Local transcript activity is deliberately described as **this device**. It cannot see Fable work done on another computer unless an account-level provider allowance is available. **Add a quota observation** remains available for a provider percentage you want to record, but it is now an optional fallback, not an automation prerequisite.

## Run-out forecasting

Use **Settings → Forecast → Ignored forecast days** to exclude a date when your usage was unusual, such as a one-off intensive task or a day away. Choose today or a past date and select **Ignore day**; **Include again** restores it to learning. Dates follow the local timezone shown beside the control and apply across Codex, Claude, and Fable. The list is saved in the local settings and included in backups.

Ignoring a date changes the historical patterns used for forecasting. Recorded usage and costs, observed allowance, and your future active-day schedule stay intact. Because quota readings are cumulative, learning also leaves out intervals crossing an ignored day instead of attributing that usage to a neighbouring day. Less usable history can reduce forecast confidence or require the configured fallback pace.

Use **Settings → Forecast → Allowance changes** when a subscription's main weekly allowance changes size, for example when a promotional 50% boost ends or a plan is upgraded. A provider percentage is a share of the allowance in force when it was read, so the first reading after such a change steps by the ratio of the two allowances without any usage, and every earlier reading is a share of a different whole. Record the subscription, the instant of the change (after the last reading on the old allowance and before the first on the new one), and the earlier allowance as a percentage of the allowance that replaced it, such as 150 when a 50% boost has ended. Learning then multiplies readings taken before that instant by the ratio, so the step is not learned as a burst, earlier weeks keep their true pace in today's terms, and token capacity calibrated on the old allowance is scaled to the new one, including across a plan upgrade that would otherwise restart its calibration. Entries affect the main weekly allowance only. A Claude change also applies to Fable 5 because it shares that pool; five-hour, other model-specific, and OAuth-app limits are unaffected. Recorded usage, costs, cycle history, and the provider's own percentages on the cards are never rewritten; the projected Fable estimate follows a saved or removed entry on the very next snapshot, because it is computed from the readings rather than stored. Each entry compares neighbouring allowances rather than today's, so several changes compound correctly and an entry stays valid when the allowance changes again; removing one restores the previous learning. The list is saved in the local settings and included in backups.

Codex, overall Claude, and Fable each have an independent learner. Repeated polling snapshots are compacted so they cannot manufacture confidence. The model combines:

- allowance used across the current reset window;
- recent working pace and hourly shape without projecting one burst across every future hour;
- matching hours and weekdays from observed history;
- your configured active-day schedule; and
- the busy end of learned daily use for the **Heavier** scenario, phased in across seven historical days separately for scheduled and off-schedule use. Until that history accumulates, the scenario stays closer to its baseline of 22% above expected consumption; the latest observed day does not count as a completed historical day. The busiest learned day is repeated in full for the first day ahead; beyond that, the margin above the expected path grows with the square root of elapsed days, because a heavier week is not seven consecutive peak days. A heavier case that would leave less than the hard-limit margin at reset puts the window on watch.

Provider percentage rebounds within one reset window are handled with a monotonic high-water mark, so rounding jitter cannot spend the same allowance twice. Sparse intervals are allocated by local day, reset boundaries are not mixed, and off-schedule use remains part of the measured burn. An isolated late-night step is duty-cycled across the off-schedule hours observed over whole days; it is not treated as continuous usage throughout every remaining night. This keeps the safe active-hour pace meaningful after an intentionally heavy session.

When a successful official allowance reading shows a new window—or a clear allowance replenishment before its reset timestamp updates—the forecast starts a fresh cycle. External announcements and banked-credit availability are not treated as allowance state: the dashboard reports a banked personal reset credit separately, never assumes it was spent, and never consumes it automatically.

If a clearly early replenishment follows an unusually heavy day, the expected forecast gives that completed local day **25% of its usual influence**. The detector needs closely spaced provider readings showing a drop of at least 20 percentage points to 2% used or less, well before the prior scheduled reset. It also needs reliable daily coverage and at least three earlier comparison days; the preceding day's use must be at least three times typical and at least 10 percentage points higher. An ordinary reset, sparse history, or a heavy day alone does not trigger this adjustment.

This reduces the influence of that day's usage and observation time together; it does not pretend fewer tokens or allowance were consumed. Recorded usage, the provider balance, and the heavier-use scenario retain the real activity. A note on the provider card explains when the adjustment applies. Explicitly ignored dates still take precedence. The app recognises the observed replenishment pattern but does not infer whether a credit was redeemed or why the provider reset the allowance.

The header verdict is built in the backend from every active primary, secondary, and model-specific window. A risky secondary window overrides a safe headline window. **All allowances on track** appears only when every expected source has sufficiently current evidence and every active window is safe; missing, stale, failed, or expired-only evidence produces an unknown verdict rather than a false all-clear. The verdict chip and the tray tooltip both carry the three headline percentages, and the tray icon carries a colour dot for the current state.

Expired allowance readings are labelled as historical evidence while the app waits for a current reading. The **Current cycles** table pairs each cycle with its own allowance-window forecast; a shorter, more restrictive window can still drive the headline verdict without being shown as the weekly cycle's forecast.

Each card also answers **Runs out**: the moment the expected projection first reaches zero, or the heavier projection's moment when only that one does. The same time is included in pace notifications.

**Budget mode** (Settings → Forecast → *Keep in reserve*) sets a share of each allowance you want untouched at reset. The safe pace only spends what sits above the reserve, and a projection that would eat into it is shown as a watch state; the forecast itself still reports what will actually happen.

### Estimated weekly token capacity

Overview shows **Weekly token capacity** alongside the allowance forecasts. Each supported weekly window has its own estimated full-week token capacity, estimate range, confidence label, and tokens remaining at the displayed provider-reading timestamp. These figures describe the recorded model and token mix; they are not a provider-declared token entitlement. Overall and model-specific windows can share allowance and must not be added together. Providers without any allowance reading are omitted from the panel, and a weekly pool with no token scope (such as OAuth apps) is hidden when a supported weekly window exists.

The estimate matches recorded tokens to positive changes between provider-reported percentages within the same reset cycle. It needs at least three usable intervals, each covering at least five percentage points, and learns from up to 45 days of history. Plateaus are accumulated until the percentage moves enough; resets, corrections, future records, unknown bucket membership, and intervals crossing ignored dates are excluded. Readings taken before a recorded allowance change are rescaled to the current allowance before matching, and the window's details say so. Token categories are counted once: cached input is already part of Codex input, reasoning is already part of output, and cache-write durations are subdivisions of the cache-write total. API prices and imported desktop conversation estimates do not determine capacity.

Expand a window's details to see the recorded model mix, input/cache/output split, calibration evidence, and limitations. The range reflects variation in the usable observations with an uncertainty margin, not a guaranteed bound or statistical confidence interval. Confidence describes consistency in the available local evidence and stays conservative because web, cloud, desktop, and other-device activity may be missing. Missing activity can make apparent capacity too low; a changed model or token mix can change it substantially. An expired window or provider reading older than 24 hours cannot supply a current tokens-remaining estimate. Ignored days affect learning only and still consume actual allowance.

## Notifications

Desktop notifications come from the tray process after a collection, so they are only as current as the collection interval. Four kinds can be enabled independently under **Alerts**: pace risk (one per episode, with the earliest run-out time), a window reset, a collector falling back to cached readings, and a daily digest at a chosen hour. **Snooze** pauses all of them for one, six, or twenty-four hours from the settings screen or the tray menu.

## Token API-equivalent costs

The **Costs** search filters model and project summaries and searches every recorded session in the selected period. Session results are paginated, and the filter is retained when switching sections. The default session order is highest API-equivalent value first.

The Details screen reconstructs token API-equivalent value from local input, output, cache-write, and cache-read records. Reasoning tokens are retained as an informational subset of output and are never billed twice. Claude five-minute and one-hour cache writes are stored and priced separately. Every selected historical period is recalculated with the current local price-catalogue row for each model; earlier tariff versions are not reconstructed, so editing a row intentionally reprices the displayed history.

Historical costs, tasks, sessions, and CSV exports include records through the current moment. Records dated in the future remain stored and enter those totals when their timestamp is reached.

Costs include every model present in the imported Codex and Claude Code token records. Opus 5, Opus 4.8, Sonnet 5, and Haiku 4.5 already have built-in prices alongside Astra, Sol, Terra, Luna, and Fable. Regular Claude desktop and web chats can consume the same account allowance but do not appear in the token ledger. A missing model row can therefore mean missing activity records rather than missing pricing. **Price coverage measures only recorded tokens**: 100% does not establish complete account activity coverage.

### Claude desktop and web chat estimates

In Claude, request **Settings → Privacy → Export data**, download the export, and extract its ZIP. In AI Usage, open **Costs → Claude desktop & web chat estimates → Import Claude export…**, then select `conversations.json` (up to 64 MB / 200,000 messages). Up to 128 distinct model labels can be stored across chat imports and restored estimates, keeping previews and dashboard tables bounded. Review the detected models and missing-data counts before saving. This is a manual import; repeat it with a newer export to add subsequent replies. Desktop and web chats cannot be distinguished by this importer.

Only the model attached to an individual reply is used. A conversation-level model is not applied to older replies because models can change mid-chat. Missing models stay unknown and unpriced by default. You may explicitly select a catalogue model as a pricing assumption for all missing-model replies in that import; those rows are labelled **User assumption** separately from **From export** rows. Named models with no catalogue price appear in **Settings → Pricing and data management → API pricing**, where you can supply prices; their chat estimates are then recalculated separately from recorded usage totals.

The estimate divides visible prompt/reply Unicode character counts by four, rounding each up, and prices them at the current input/output rates. It counts only the immediate human prompt (the explicit human parent for branched replies), not repeated context from earlier turns. Text blocks take precedence over the duplicate convenience `text` field. System prompts, caching, attachments, images, tool content and hidden reasoning are excluded. This is a rough **visible-text value**, not actual subscription consumption or a reconstructed API bill; accuracy varies by language and content. Missing prompts and omitted content are flagged. All estimates remain outside recorded costs, token-ledger CSVs, quota calibration, and forecasts.

Parsing runs locally in the storage worker. AI Usage persists only opaque hashed reply keys, dates, model evidence/assumptions, estimated counts and limitation flags, never conversation titles or text. Identical replies are deduplicated across imports; existing estimates and assumptions are kept unchanged. To replace an assumption, use **Remove imported estimates…** (which creates a safety backup) and reimport. Both SQLite and `.aiusage.json` backups include estimates; restore merges them without replacing existing rows. Import previews expire after 30 minutes and save the reviewed counts even if the source file changes meanwhile.

OpenAI GPT-6 Astra and GPT-5.6 Sol, Terra, and Luna requests over the published 272,000-input-token threshold use the long-context multipliers, including cached prompt input when determining whether the threshold is crossed. Astra is included in the built-in catalogue at standard API rates of $10 input, $1 cached input, $12.50 cache writes, and $50 output per million tokens, verified against [OpenAI's model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra) on 4 September 2026. Existing Astra token records are repriced automatically when the new catalogue loads, and saved custom prices are preserved. Unknown or future model names are not assigned a guessed price: their tokens remain visible, price coverage drops, and totals are labelled **At least** until you add the missing row.

These values are token-only comparisons, not provider invoices. They do not claim to include untracked tool charges, web-search charges, storage, taxes, subscription fees, or usage performed on another device that did not reach the local ledger. USD is the ledger currency; GBP and EUR use the manually saved display conversion rate and are not updated from a live foreign-exchange feed.

The Costs screen now includes **Tasks & sub-agents**. Expand a row to see the main-agent and sub-agent API-equivalent totals, recorded agent count, each agent/model's uncached input, cache reads, cache writes, output (including reasoning), usage-record count, and first-to-last activity span. Search includes task/session IDs, agent IDs, names, roles, models, and projects. A model switch adds a row without counting the same agent twice. Totals use the existing per-event pricing and currency settings; unknown prices remain unpriced or lower bounds.

Codex records are grouped by the recorded root turn ID (or a main thread's turn ID) when available. Parent/root session metadata links child and nested agent usage. Claude transcripts use their agent ID or the `session/subagents/agent-ID.jsonl` layout, with legacy `agent-ID.jsonl` support. When task attribution is absent, the UI explicitly shows a **session breakdown**; it does not infer task boundaries or read prompts to invent names. Unlinked child usage remains separate from identified turns. Legacy records without usable agent metadata stay **unattributed**. For older Codex logs without a root session ID, ancestry can only be followed through parent links present in the selected period. Agent counts include only agents with recorded usage, not every agent spawned. Activity span includes idle time and is not execution duration; a single record has no measurable span.

On the next normal collection, each eligible local log is re-read once to backfill structural attribution, using the existing event keys to update rather than duplicate usage. Subsequent scans resume incrementally. Logs no longer available locally retain their existing costs and may remain unattributed. No prompts or response content are added to the ledger. The browser preview includes clearly labelled sample task breakdowns.

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

Malformed non-object transcript records are skipped without blocking later valid records; storage failures still roll back the file for a complete retry. Codex cumulative token totals distinguish new usage from repeated quota notifications. When eligible logs are first rechecked by the corrected importer, existing duplicates are removed only where the source records and stored token details prove the duplication, with a safety backup before correction. Unavailable logs and conflicting records are left intact.

The one-time correction also checks previously imported Codex logs outside the usual recent scan, if those files are still available. Restoring an older export that adds Codex records schedules another check on the next scan.

Analytics caches track changes to usage, pricing, and the relevant allowance bucket separately. A source-status or import-cursor update therefore retains previously calculated costs and cycle history. Cycle history merges small reset-timestamp variations before applying its display limit. One shared rule decides which allowance window a provider headlines, which are listed beneath it, and which are history: the summary cards, tray tooltip, digests, dashboard verdict, recent-cycles table and token-capacity panel all consume it, so they always name the same window.

Update checks fetch private GitHub release metadata and a version manifest. Installer downloads happen only after **Download update** is selected. Update requests contain the GitHub authorization needed for this private repository; local usage data is not sent.

Each update stage and any failure message is appended to `update.log` in the app's data folder (`%APPDATA%\ai-usage`), so a failed installation can be diagnosed after the app has restarted. The log holds only stage names, versions and the same wording shown in Settings; no request details or credentials. Before the installer runs, its checksum is verified again against the release manifest, and a launch the system refuses, for example while antivirus software is still scanning the download, is retried a few times before the update is reported as failed.

## Security model and accepted risks

The window runs sandboxed with context isolation, no Node integration, a content security policy that allows no network origin, and navigation, pop-ups, redirects and embedded web views denied. Web permission requests (notifications, media, geolocation and the rest) are refused outright; desktop notifications come from the main process. Every bridge call is accepted only from the dashboard's own main frame.

Provider executables are located only through absolute PATH entries, the native Claude Code install location, and the official Claude Code and Codex caches. The directory the app was launched from is never searched, and each provider process starts in its own directory with a PATH from which relative and launch-directory entries have been removed. The same rule applies to the GitHub CLI used for private updates. Setting `CODEX_BINARY` selects an explicit Codex executable; an invalid value disables Codex rather than choosing something else.

CSV exports neutralise spreadsheet formula prefixes. Quota readings are accepted only with a reset at most 31 days ahead and an observation time no more than five minutes in the future; rows written by older versions are re-checked when read.

Some risks are accepted by design and worth knowing:

- **Claude Code installation** runs Anthropic's installer script, fetched from `claude.ai` at the moment you choose to install. Trust rests on TLS to that host; the script is not pinned or hashed locally.
- **In-app updates** are not code-signed. Trust rests on GitHub TLS, access control on the private repository, and the SHA-512 in the release manifest. Downloading and installing each require a click, so a compromised release cannot install itself.
- **Backups** in `Documents\AI Usage\Backups` contain settings, session identifiers and the working directory of every session. They hold no credentials, but a synced Documents folder will copy them.

## Data and backups

The database is stored under the standard Windows app-data directory for AI Usage. Backups are written to `Documents\AI Usage\Backups` as both a SQLite snapshot and a readable `.aiusage.json` export. Daily backup creation is enabled by default, and **Back up now** is available at any time.

Backups, restores, and CSV exports run in a dedicated background worker. Storage changes are queued safely, and quitting waits for active storage work to complete.

**Restore from backup…** merges an export into the local database. Existing token records, observations, daily totals, and edited prices are kept. On a fresh database, saved prices replace the built-in defaults so recovery restores the original cost calculations. Settings are replaced by the export's settings. A fresh safety backup is written before the merge, and a storage failure aborts the restore immediately.

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
2. Complete the checks above, review the changes, and merge them. Create and push the matching version tag, for example `v1.0.43` for version `1.0.43`.
3. The **Private Windows release** GitHub Actions workflow builds Windows x64 packages, checks the manifest and packaged contents, and creates a draft release. It uploads the Setup installer, portable executable, installer block map, `latest.yml`, and `SHA256SUMS.txt`, verifies each remote asset's size and SHA-256 digest, then publishes the release as latest. The normal pull-request CI job is unchanged.

The release workflow can also be started manually with an existing version tag. It refuses a mismatched version, a public or different destination, a tag whose commit is not already on `main`, an existing release for that tag, or a version older than an existing stable release. If an upload fails, any created release stays a draft for inspection and is not offered to the app. Review and remove that incomplete draft before retrying; the workflow never overwrites existing release assets.

Packaging uses `--publish never` and has no publishing credential in its environment. The workflow supplies its short-lived GitHub token only to the validation and release-upload steps, never to packaging; no personal token needs to be saved as a repository secret. `latest.yml` includes notes generated from the current changelog entry, and the release audit checks its version, installer filename, byte size, and SHA-512 against the installer on disk before publication.

## Set up another Windows computer

Run the Setup installer and leave **Open AI Usage and set up usage tracking** checked. The first-run guide detects Microsoft Store and native Claude Code installations. If missing, **Install Claude Code** runs Anthropic's official native installer for the current Windows user; no Node.js or npm installation is needed. Internet access and Windows 10/11 are required.

Choose **Sign in to Claude** and complete the account flow in your browser. AI Usage never copies account credentials into its database or installer. Claude Desktop sign-in can be separate from Claude Code sign-in. Then choose **Start collecting** to optionally enable the fallback helper and refresh. Restart Claude Code for the helper to take effect. The provider may omit subscription windows even after a successful sign-in; missing limits are not reported as zero. Local activity only appears after Claude Code has written local usage records.

**Set up later** leaves Codex collection available. Reopen the guide from **Settings → Sources → Set up Claude**. Failed or cancelled installation/sign-in can be retried. A silent installation defers account setup until the app is opened interactively. Codex must separately be installed and signed into on that computer.
