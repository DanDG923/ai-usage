# Changelog

## 1.0.45 — 14 September 2026

- Correct short-window forecasts at local hour boundaries, manual Fable calibration, allowance-change learning and idle reset confidence. Keep every displayed Fable window supplied with a forecast when provider and manual readings coexist.
- Reduce repeated dashboard work with bounded forecast and daily-analytics caches while preserving recorded usage, cost totals and reporting boundaries.
- Preserve recovery backups when a damaged database is recreated. Write compressed exports with bounded memory, clean up failed partial files, back off failed attempts, and place new backups outside Documents/OneDrive. Existing backups remain available.
- Preserve restored or edited records during Codex import, back up verified accounting repairs, and continue importing healthy transcripts after another file fails to read. Avoid copied Claude fork usage and stale rotated status-line evidence.
- Keep critical allowances visible, remember per-currency conversion rates, retain expanded tables during refresh, and prevent background updates from undoing a period selection. Improve reset countdowns, chart alternatives, focus, contrast and error messages.
- Fix hidden refresh, notification, shutdown and installer-authentication edge cases. Update Electron and the Claude SDK, tighten CI and package audits, and add independent regression coverage.
- Preserve local history, settings, observations and existing backups during an update.

## 1.0.44 — 14 September 2026

- Align the minimise, maximise and close buttons vertically with the refresh button by matching the native window-controls height to the dashboard header.

## 1.0.43 — 14 September 2026

- Compute the local Fable 5 estimate when the dashboard is built instead of storing it as a reading. A stored estimate could outlive the settings and evidence it was computed from: estimates recorded after an allowance boost ended but before the change was entered kept feeding the Fable forecast, and a status-line reading newer than the SDK reading could switch the estimate off. The projected estimate follows a saved or removed allowance change on the next snapshot, is never displaced by or mistaken for an official reading, reads the Max-plan check from the most recent official reading that names a plan, and is removed from the allowance history once on upgrade. Fable cycle history now comes from provider-backed and manual readings only.
- Use one shared rule for which allowance window each provider headlines. The summary cards, tray tooltip, digests, dashboard verdict, recent-cycles table and token-capacity panel previously carried their own copies and could name different windows; an unrecognised Claude window is now listed beneath the weekly allowance rather than competing to headline it.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.42 — 14 September 2026

- Recompute the locally derived Fable 5 estimate as soon as an allowance change is saved or removed. A derived estimate that had already absorbed the allowance jump previously stayed on the Fable card until the next Claude refresh, indefinitely with refreshes set to only when you refresh. When no estimate can be produced under the new entries, the outdated one is discarded rather than left on the card. An official Fable reading is never displaced or removed by the recomputation.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.41 — 14 September 2026

- Record an allowance change in Settings → Forecast when a subscription's main weekly allowance changes size, such as the end of a promotional 50% boost, giving the earlier allowance as a percentage of the one that replaced it. Readings taken before the change are rescaled for learning, so the jump in the provider's percentage is not learned as a burst of usage, earlier weeks keep their true pace in today's terms, and estimated weekly token capacity calibrated on the old allowance is scaled to the new one. Entries affect the main weekly allowance and Claude’s shared Fable 5 pool; five-hour and other independent limits are unaffected. Recorded usage, costs, cycle history, and the readings shown on the cards are unchanged, and the list is saved with settings and backups.
- Apply allowance changes only once their recorded time arrives, preserve calibration when successive changes cancel out, and accept fractional allowance ratios in Settings.
- Keep Claude’s main allowance selected ahead of model-specific windows in cards, tray summaries, and digests, and label Claude Pro correctly.
- Return saved manual readings promptly even when Claude is slow or unavailable. Manual Codex readings no longer trigger a Claude refresh.
- Reject inconsistent token counts and cache-duration splits before they can distort costs, including during backup restore, while retaining support for older exports.
- Show failed settings saves beside the affected fields and restore numeric fields to their saved values so an unsaved edit cannot appear successful.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.40 — 12 September 2026

- Correct the Claude source status after an allowance reset time is revised. Only the latest usable reading for each window can keep it active; an older reading no longer overrides a newer expired reset.
- Keep other active allowance windows and valid history available when a stored reading is malformed.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.39 — 12 September 2026

- Refresh the dashboard faster as history grows. Forecasts parse each allowance reading once instead of three times, the cost ledger shares one local-time conversion per quarter hour, and the Claude refresh checks for an existing reading with an indexed lookup instead of forecasting every window. A cold dashboard snapshot dropped from 221 ms to 160 ms on a live database, and a 120,000-record ledger aggregates in less than half the time. Figures, forecasts and totals are unchanged.
- Let the runway chart fill its panel from the first observations. On a fresh install it stayed at its minimum height until the tab was reopened.
- Stop status messages re-rendering the whole page, and stop the Settings page rebuilding date formatters for every price row and every keystroke in the ignored-days field.
- Stop the setup guide running the Claude command-line check on every window open once the guide has been dismissed.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.38 — 12 September 2026

- Stop the heavier-usage forecast from repeating the busiest learned day for every remaining day. A fresh weekly allowance after an early reset no longer starts the week flagged at risk with a heavier case that reaches zero; the busiest day still counts in full for the first day ahead, and the margin above the expected path then grows with the square root of elapsed days.
- Put an allowance on watch when its heavier case would end below the hard-limit margin, so a near miss under heavier use still needs attention without being called a run-out.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.37 — 9 September 2026

- Choose which subscriptions appear in Settings. Hiding Codex or Claude removes it from the dashboard, activity evidence, cycle history, token capacity, tray tooltip, summaries, and alerts, while its saved usage, costs, and background collection continue unchanged.
- Keep GPT-5.3-Codex-Spark tokens out of the main Codex capacity estimate, and prefer live Codex readings over overlapping transcript snapshots when learning capacity so lagging snapshots no longer discard calibration.
- End a reset cycle where its replacement begins when an allowance resets early, label that cycle in history, and fold an idle allowance's rolling reset readings into the window they belong to.
- Reject restored readings whose stored quota metadata is not a readable object, ignore an unusable banked reset-credit count, and keep the main Codex weekly balance selected for manual and older readings that carry no limit identity.
- Resolve task ancestry once per refresh so deep or repeated session chains stay responsive, and let a single shown subscription use the full card width.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.36 — 8 September 2026

- Keep the main Codex account allowance separate from GPT-5.3-Codex-Spark limits. Preserve model names in stored readings, diagnostics, and allowance alerts.
- Put separate model allowances in expandable details, automatically opening them when a model window needs attention. Unused Spark windows say no usage is reported instead of displaying a misleading second Codex forecast.
- Keep the main Codex balance selected in the dashboard and tray regardless of the order in which model-specific limits arrive. Existing usage, allowance history, prices, and settings remain intact.

## 1.0.35 — 8 September 2026

- Stop a restore immediately on a storage failure so later records cannot escape a rolled-back transaction. Keep malformed-record skipping for readable exports.
- Recover custom model prices into a fresh database while preserving prices already edited or restored locally.
- Recheck older Codex import cursors and repair source-verified same-millisecond token collisions after a safety backup. Preserve conflicting records and retry unreadable logs.
- Show incomplete Claude transcript scans as degraded, retain the last good scan time, and report file-read failures in Diagnostics and refresh messages.
- Detect resets within each allowance window, keep weekly balances consistent across the dashboard and tray, and retain alerts for shorter windows.
- Only describe a provider as on track when every active allowance window has a safe forecast and current evidence.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.34 — 8 September 2026

- Headline each provider's weekly allowance so the balance on a card matches the provider's own usage summary, and list shorter session windows beneath it with their own state, balance, and reset. A five-hour session running warm no longer replaces the weekly figure on the card or the runway chart; it keeps its own line under what needs attention.
- Report an expected run-out time to the minute instead of rounding it up to the end of the hour, and show a reset countdown of less than a day as hours and minutes.
- Keep both Codex token counts when two are recorded in the same millisecond. The second previously replaced the first, losing its tokens from recorded usage and costs.
- Start with a new database when the local one cannot be read, keeping the unreadable file under a dated name, rather than failing to launch. Restore the most recent export from Settings to bring the history back.
- Keep the dashboard usable when storage maintenance stalls, when the renderer hits an error, and while the database is briefly unavailable during an update.
- Give Claude and Codex the environment AI Usage was started with, honour `CODEX_HOME` and `CLAUDE_CONFIG_DIR`, report local logs Windows refused to read instead of counting them as scanned, and register launch-at-login against the portable executable that was actually run.
- Match the window title bar to the dashboard palette, and use one date and number format throughout.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.33 — 8 September 2026

- Add estimated weekly token capacity and remaining tokens for supported Codex, Claude, and Fable allowance windows, with evidence, model and token mix, uncertainty ranges, and conservative confidence labels.
- Reduce an unusually heavy day's influence on the expected forecast when well-supported readings show an early allowance replenishment. Keep recorded usage and the heavier scenario intact, and temper early off-schedule bursts while a new window is still learning.
- Preserve official allowance readings when generated estimates share their timestamp, and keep observation values and provenance together when replacing readings.
- Improve forecast chart labels and responsive layout, and preserve local history, settings, observations, and backups during an in-place update.

## 1.0.32 — 7 September 2026

- Add ignored forecast days in Settings so unusual days can be excluded from learned usage patterns. Dates are reversible, use your local timezone, and persist in settings and backups without removing recorded usage or costs.
- Prevent repeated Codex quota notifications from duplicating token usage. Recheck available legacy logs once and repair source-verified duplicate records only after a safety backup; preserve unavailable or conflicting records.
- Skip malformed transcript records without stalling imports, and record each diagnostic operation's actual duration.
- Show expired allowance readings clearly, match current-cycle forecasts to the correct allowance window, and retain complete cycle history across reset-time jitter.
- Exclude future-dated usage from historical costs and exports, prevent overlapping schedule saves, and avoid rebuilding analytics for unrelated status or cursor writes while retaining correct invalidation for usage, pricing, and time boundaries.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.31 — 7 September 2026

- Temper the heavier-usage forecast while history is sparse. A few busy days no longer receive full weight as the pace for every remaining day; the learned busy-day pace gains influence across seven historical days, separately for scheduled and off-schedule use.
- Keep the expected forecast unchanged and retain a heavier-use margin while learning. Repeated busy days still produce exhaustion warnings when the history supports them.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.30 — 7 September 2026

This is an in-place forecast correction. Running the 1.0.30 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, imported cost history, and backups.

- Fixed a double count in the run-out forecast just after an allowance reset. The previous window's pace that carries into a fresh window now covers only usage during your scheduled active hours, because off-schedule use is projected separately; late-night use was previously spent twice, overstating Codex and Fable 5 weekly expectations by roughly the prior week's off-schedule share.
- The current window's own pace, the heavier scenario, collection, and storage are unchanged.

## 1.0.29 — 6 September 2026

- Added expandable task and session breakdowns under Costs, with main-agent and sub-agent API-equivalent costs, token categories, models, usage-record counts, and activity spans.
- Added task and agent search with pagination. Missing task identifiers are shown as session breakdowns; unlinked or unattributed usage remains explicit.
- Preserved Codex task/parent-thread and Claude sub-agent metadata during collection. Existing logs are rescanned once to backfill attribution without duplicating usage records.
- Kept pricing coverage and unpriced models visible. Reasoning stays included in output tokens, and activity spans include idle time.

## 1.0.28 — 6 September 2026

- Import Claude desktop and web chat exports from the Costs page, with a preview before saving and duplicate detection on repeat imports. Conversation text and titles are never retained by AI Usage.
- Show visible prompt-and-reply text estimates separately from recorded token costs and quota forecasts. Missing models stay unpriced unless you explicitly choose a pricing assumption, and desktop-only models can receive prices in Settings.
- Include imported estimates in backups and restores, with a safety backup before removing them. Reject excessive model labels and skip malformed backup records without losing valid data.
- These are rough text-value estimates, not measured subscription costs: caching, repeated context, attachments, tools, and hidden reasoning are excluded. Automatic desktop chat tracking is not included.

## 1.0.27 — 6 September 2026

- Record every update stage and failure in `update.log` in the app's data folder, with stable error codes and the wording shown in Settings, so a failed installation can be diagnosed after the app restarts.
- Launch the installer from the app before quitting, re-verifying its checksum against the release manifest and retrying a launch the system refuses, for example during an antivirus scan of the download, before reporting failure and reopening the current version.
- Keep electron-updater's launch for installs that need elevation or where no downloaded file path was reported.

## 1.0.26 — 6 September 2026

- Accept bridge calls only from the dashboard's own main frame for every action, not just Claude setup.
- Deny pop-ups, navigation, redirects, embedded web views, and all web permission requests such as notifications or microphone access in the renderer.
- Validate settings keys as own entries only, so inherited object names cannot pass validation from the settings screen, an export, or a stored row.
- Bound and shape price catalogue text: plain-text model names, calendar effective dates, http(s) source links, and capped rates, while keeping restored rows whose link is unusable.
- Reduce Codex exit diagnostics to one short line before they appear in source status or a desktop notification.
- Exclude the launch directory when locating the GitHub CLI for private updates, matching the provider executable rule.
- Document the security model and accepted risks in the README, and stop tracking packaging outputs and local investigation notes.

## 1.0.25 — 6 September 2026

- Export potentially executable spreadsheet formulas as literal CSV text while preserving ordinary labels and numeric values.
- Resolve Claude and Codex through validated absolute executable paths, preventing programs planted in the launch directory from being selected.
- Reject far-future quota observations and bound forecasting work, including when older versions already stored invalid dates.
- Preserve valid dormant quota history when newer malformed observations exist, with regression coverage for database reopening and supported reset windows.

## 1.0.24 — 5 September 2026

- Bound the whole update preparation to fifteen seconds. If the safety backup does not finish in time, nothing is installed and AI Usage reopens so the update can be retried; if only the final storage close stalls after the backup, the update proceeds.
- Wait at most fifteen seconds for storage work when quitting from the tray, so a stalled restore or collector can no longer keep the app running.
- Keep the scheduled update check in place across settings changes instead of restarting its delay on every edit; disabling automatic checks clears the schedule.
- Ignore `GH_TOKEN` and `GITHUB_TOKEN` environment variables for update checks so only the GitHub CLI sign-in can authenticate against the private feed.
- Report each update failure once, and answer dashboard reads with the last published view while storage is closing for an update.
- Refuse to publish a release whose tag does not point at a commit already on `main`.

## 1.0.23 — 5 September 2026

- Add personal updates from the private `DanDG923/ai-usage` GitHub repository using the existing GitHub CLI sign-in on this computer.
- Check for releases automatically or on demand, download with progress, and offer a restart to install the verified update.
- Preserve local data during updates, with a safety backup and an orderly shutdown before installation.
- Keep GitHub credentials in the main process only; do not save them in app settings, send them to the renderer, or package them with releases.
- Publish complete private update releases with `latest.yml`, installer block maps, and SHA-256 checksums; audit the manifest against the actual installer before upload.

## 1.0.22 — 5 September 2026

- Retry valid usage records after database failures instead of advancing the import cursor past unwritten records.
- Fix Escape cancelling numeric settings, repeated keyboard navigation between sections, and manual-entry retention after a failed save.
- Cache reset-cycle calculations while keeping writes, pricing changes, reset boundaries, and clock changes correct.
- Search all recorded sessions in the selected period with pagination, retain cost filters between sections, and distinguish missing data from empty search results.
- Show actionable waiting states when allowance readings are missing and let forecast times wrap in provider summaries.
- Keep older observations inside the runway plot and separate nearby provider labels without moving their data points.
- Run backups, restores, and CSV exports in a background worker with serialized operations and graceful shutdown.

## 1.0.21 — 5 September 2026

- Verify that Claude fetched allowance data successfully before recording it as fresh. Cached SDK responses after a connection failure no longer advance the evidence timestamp.
- Retry temporary fetch failures and unexpectedly empty subscription responses once, after a short delay and full query cleanup. Authentication failures and throttling wait for the next normal refresh.
- Record safe error categories and up to two attempt summaries in source diagnostics. Raw Claude debug output is discarded.
- Preserve the last good Claude and Fable readings when freshness cannot be verified, including after an incompatible provider diagnostic change.
- Add regression coverage for cached failures, recovery, empty results, cancellation, throttling, split diagnostic output, and unchanged database evidence on failure.

## 1.0.20 — 5 September 2026

- Correct five-minute cache-write token counts when older records without duration details are mixed with newer records.
- Honour an unchecked fallback-helper option during Claude setup and restore the previous status line when disabling it.
- Keep navigation and refresh shortcuts inside the setup dialog; normal shortcuts resume after closing it.
- Reuse the verified sign-in result instead of launching a second status check during login and setup completion.
- Cache cost analytics independently of forecasts, invalidating on database writes, currency or period changes, clock rollback, and rolling-window expiry. Transactional reads bypass the cache.
- Give usage records without session IDs distinct identifiers to prevent duplicate table rows.
- Add ten regression tests. The 30,000-record benchmark returns identical results for cached and full reads; cached reads measured 0.071 ms versus 293.69 ms for full aggregation. Initial scans still require full aggregation.

## 1.0.19

- Adds cost by model with input, cache-read, five-minute and one-hour cache-write, and output values beside token counts.
- Shows each model's share of priced cost, respecting the selected period, currency, custom prices, and per-request context rates.
- Keeps missing prices visible as unpriced and reasoning included in output.


## 1.0.18

- Detect Microsoft Store Claude Code installations and newly installed native binaries before PATH refresh.
- Include a first-run Claude setup guide in the Windows installer: dependency installation, browser sign-in, optional preserved status-line helper, and initial refresh.
- Keep setup retryable and available from Settings, with cancellation and bounded operations.

## 1.0.17 — 4 September 2026

Adds GPT-6 Astra pricing and fixes historical import and cleanup errors. Install over the existing version to preserve the local database, settings, and backups.

- Adds `gpt-6-astra` to the built-in and preview price catalogues at standard API rates: $10 input, $1 cached input, $12.50 cache writes, and $50 output per million tokens. Requests above 272,000 input tokens apply the documented 2x input/cache and 1.5x output multipliers. Existing records are repriced automatically; saved custom prices are preserved.
- Aggregates cost records without retaining a separate raw-ledger array and converts each timestamp to local date parts once. A 30,000-record synthetic benchmark improved from 231.53 ms to 160.22 ms median with an identical complete-result checksum. Adds a repeatable benchmark tool.
- Preserves chronological endpoints and peak usage during cleanup of observations older than sixty days, including out-of-order imports. Previously removed observations cannot be reconstructed.
- Selects the latest evidence by observation time for dormant allowance buckets and prevents historical imports from moving a source's evidence timestamp backwards.
- Rejects invalid historical Codex quota windows individually so valid token records and other windows continue importing. Coded database/runtime failures still abort the import transaction.
- Adds seven regression tests for history retention, import recovery, source timestamps, and Astra pricing, bringing the suite to 232 tests.

## 1.0.16 — 3 September 2026

This is an in-place performance and maintenance update with no visible interface change. Running the 1.0.16 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, imported cost history, and backups.

### Faster collection and snapshots

- Caches prepared SQL statements in the local store instead of re-parsing every statement on each call, and adds a source-and-time index on usage events for the queries that filter by both.
- Imports each Codex session log and Claude transcript in one transaction, so a first import no longer pays a write-ahead-log sync per message.
- Builds cycle history from one range query per provider, costing each usage event once, instead of one query and a full re-costing per reset window.
- Resolves the local time zone once per cost analysis rather than twice per usage event, and memoises the allowance-pressure model profiles.
- Partitions forecast learning samples once per projected series and remembers each weekday-and-hour rate, producing identical numbers with far fewer passes over the sample set.
- Rebuilds the tray menu only when the snooze state changes.

### Leaner renderer

- Memoises the runway, cost, and daily-usage chart geometry so hovering no longer rebuilds every series path, and builds date and number formatters once instead of once per label or table cell.
- Caches the derived provider rows per snapshot and registers the keyboard shortcuts once rather than on every render.
- Removes the six modules orphaned by the 1.0.15 redesign (the previous allowance card, Details page, per-card forecast chart, viewport scaling, and their stylesheet) and roughly 430 lines of stylesheet rules that styled only them. The shipped stylesheet shrinks from 54.8 KB to 45.0 KB.

### Verification

- Release contracts now assert the estimate-visibility rules against the live provider view and summary card.
- Computed-style comparison of all four screens before and after the stylesheet pruning showed no layout or style change.
- Full automated suite: 225 tests passed; oxlint, Prettier, strict TypeScript, and the Vite production build passed.

## 1.0.15 — 3 September 2026

This is an in-place interface and forecast-communication update. Running the 1.0.15 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, imported cost history, and backups.

### Professional application shell

- Replaces the text-tab header with a compact Windows-style side rail and command bar across Overview, Activity, Costs, and Settings.
- Removes viewport-wide CSS zoom. The interface now reflows at 1260, 980, and 760 pixel breakpoints, retaining readable type and usable controls down to the supported 720-pixel window width.
- Establishes a restrained design system with flatter surfaces, tighter spacing, consistent six-pixel radii, provider colours reserved for data, semantic colours reserved for status, reduced-motion handling, and Windows forced-colour support.
- Adds explicit tab-to-panel relationships, destination focus management, and number-key navigation for all four screens.

### Joined allowance view

- Joins Codex, Claude, and Fable 5 into one shared-calendar runway chart. Observed history is neutral, expected projections are solid, heavier-use projections are dashed, and each provider line ends at its own reset date.
- Adds direct provider endpoint labels and a hover inspection view without collapsing the three independent reset schedules into one artificial cycle.
- Rebuilds the top allowance summaries as compact rows with a neutral current-use segment, a softer provider gradient for expected usage, a deeper same-family gradient for additional heavy usage, and a visible scenario boundary.
- Keeps exact expected and heavier-case values in accessible labels so the gradients are never the only distinction.

### Clearer Activity, Costs, and Settings

- Splits the previous Details screen into Activity and Costs. Activity owns source evidence, provenance, collection freshness, the activity heatmap, daily usage, and cycle history; Costs owns the API-equivalent total, trend, cache savings, and project, model, and session evidence.
- Adds a single search control that filters all three cost evidence tables.
- Keeps common collection, forecast, alert, appearance, and update settings visible while moving pricing, storage, manual observations, and diagnostics into progressive disclosures.

### Forecast wording and notifications

- Extends the dashboard verdict with structured per-window reasons for expected exhaustion, heavier-case exhaustion, safe-pace pressure, watch state, and mixed conditions.
- Describes heavier-case-only exhaustion conditionally instead of calling it likely, keeps pace-only risk separate from run-out claims, and preserves the affected model-scoped window in supporting evidence.
- Prevents an unknown heavier projection from being treated as zero and aligns tray notifications with the same expected, heavier-case, and pace distinctions shown in the dashboard.

### Verification

- Adds focused dashboard-decision, notification, and responsive-renderer release contracts.
- Full automated suite: 225 tests passed.
- oxlint, Prettier, strict TypeScript, the Vite production build, packaged-ASAR audit, native-size visual review, and 720-pixel responsive review passed.

## 1.0.14 — 3 September 2026

This is an in-place design update. Running the 1.0.14 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, imported cost history, and backups.

### A quieter, more deliberate interface

The screens were redrawn as a design canvas first and then carried into the app. The forecast charts stay; the kit around them changes.

- **Overview**: one status line at the top of the page ("Fable 5 is likely to reach its weekly limit before reset", with the providers that are on track and the three headline percentages), in place of the header chip and the sentence inside every card.
- The three cards become **one panel of hairline-divided columns**. Each column reads top to bottom: provider and plan, the remaining figure as a large numeral, an **allowance bar** showing used, expected before reset, and spare with a marker for the heavier case, four label-left value-right rows (Resets, Expected at reset, Runs out, Recent pace), and the forecast with its legend in the title row. The arc gauge and the pace bar are gone.
- **Chrome**: a 48-pixel header with a monochrome mark, text tabs underlined in the text colour, "Updated 20:08 · refreshes every 15 min" and a plain bordered Refresh button. The section is now called **Settings**.
- **Surfaces**: a near-neutral ground with hairline borders at low alpha, 5 and 6 pixel radii, no shadows and no filled accent buttons. The accent colour is kept for interactive states only (switches, selection, focus). Light and dark palettes were both redrawn and the window chrome follows them.
- Telemetry is reduced to one faint line per column: how many days the learner has seen and its confidence, and when the reading was taken and how (official, manual, or local estimate).
- Details and Settings pick up the same tokens, radii, and header; their structure is unchanged from 1.0.13.

### Verification

- The release contract now checks the status line, the allowance-bar accessibility label, and the new window chrome colours.

## 1.0.13 — 3 September 2026

This is an in-place design, feature, and reliability update. Running the 1.0.13 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, imported cost history, and backups.

### Redesigned interface

- Replaces the glowing navy theme with a quiet, flat system: one neutral surface scale, a single accent for actions and selection, and green, amber, and red reserved for allowance state. Provider colours appear only where series need telling apart. Both palettes were redrawn and the native window chrome follows them.
- Uses the system typeface throughout with tabular figures for every number; the monospace face is now used only for paths and session identifiers. Uppercase eyebrow labels, decorative panel icons, gradient buttons, glow shadows, and the large corner radii are gone.
- Shrinks the header to a 64-pixel strip with underlined section tabs, and rewrites headings and descriptions in plain sentence case ("Costs", "By model", "Reset cycles", "Settings") in place of the previous slogans.
- Presents each allowance card with the provider name and plan as its title, a dot-and-word state instead of a filled badge, a thinner gauge and pace bar, and a lighter forecast chart with a neutral observed line.
- Turns the cost summary and the Details ribbon into bordered stat rows, replaces the cache donut with a with-cache versus without-cache bar comparison, right-aligns every numeric table column, and gives the Details page a plain title with the period control beside it.

### New in Details and the Overview

- **Subscription value**: with monthly fees for Codex and Claude entered under API pricing, the Overview shows how many times over the period's API-equivalent value covers the fees for the same number of days.
- **Cache hit rate**: the share of prompt tokens read from cache, alongside the cache discount.
- **Recent totals**: today, the last seven days with the change against the seven before, month to date, and a straight-line projection for the month.
- **When the work happens**: an hour-by-weekday heatmap of API-equivalent cost over the selected period, with the busiest slot named. The backend now supplies this grid with every snapshot.
- Keyboard shortcuts: 1, 2, and 3 switch sections and R refreshes.

### Corrections from review

- A collector process recycled after a timeout could, on its late exit, reject a request that had already been sent to its replacement; requests are now failed only by the child that owned them.
- Two Claude collections could run at once when a manual observation or helper change overlapped a scheduled refresh; each source's collector is now queued so one run completes before the next starts.
- One malformed transcript or session-log row used to stop the whole file and, because the cursor never advanced, fail again on every refresh. Rows are now rejected individually, counted in Diagnostics, and the file continues.
- When every Claude window was recorded in one scan, the tray, digest, and cycle history could headline a model-scoped bucket instead of the shared weekly. The tray and digest also now use the same worst-active-window rule as the header chip.
- Reset-cycle token totals no longer add Codex cached input a second time.
- Quitting during a refresh no longer records both sources as failed for the next launch.
- The manual-observation channel accepts only the fields the form sends; bucket, window, plan, and observation time are fixed by the app.
- The packaged renderer's content-security policy no longer allows connections to loopback ports; the development server adds that exception itself.
- "1 days 24h" style labels, weekday ticks drifting after a daylight-saving change, a header height observer left on the loading header, a hidden chart tooltip, and the section tabs' keyboard handling are fixed. A date formatter is now cached instead of built once per token record.

## 1.0.12 — 1 September 2026

This is an in-place layout update. Running the 1.0.12 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, imported cost history, and backups.

### Window-filling scale

- The dashboard now scales to the window. The design is anchored at a 1600-by-1000 window; a larger window zooms the page up so a maximised or fullscreen display is filled, and a smaller window zooms it down so the three allowance cards still fit side by side. The factor follows the smaller of the width and height ratios and is bounded between 0.7 and 1.6, so nothing overflows in either direction and text never becomes unreadable.
- Scaling is CSS zoom, not a transform: layout reflows at the scaled size, text stays crisp, and the card grid decides its column count from the scaled width. The header scales only halfway, because it shares the window with the native caption buttons, whose safe areas are measured in real pixels.
- The Overview also fills the window vertically. The card row takes the height left under the header, the cards stretch to the row, and each forecast plot absorbs the spare height of its card, redrawing at the box's aspect ratio rather than letterboxing.
- Replaces the previous second growth tier for very wide windows, which is no longer needed.

### Verification

- The release contract now checks that zoom comes only from the scale properties and never from a literal factor or a transform, that the header itself is never zoomed, and that the overview fill and plot sizing rules are present.
- Verified in the browser preview at 1280 by 720, 2000 by 1125, and 2560 by 1440 with no horizontal overflow; the overview fills each window height.

## 1.0.11 — 1 September 2026

This is an in-place feature and reliability update. Running the 1.0.11 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, imported cost history, and backups. On first launch it rescans local transcripts once to fill the new project column.

### Answers first

- Adds **Runs out** to every allowance card: the moment the expected projection first reaches zero, or the heavier projection's moment when only that one does, with the distance to reset. The forecast chart marks the same instant.
- Puts the three headline percentages into the header verdict chip and the tray tooltip, and paints a state-coloured dot onto the tray icon.
- Presents Fable 5 as a full third card with the same gauge, pace bullet, forecast chart, and run-out fact as Codex and Claude; its local-activity and staleness notes move into the card footer.
- Adds **Budget mode**: a per-allowance reserve that the safe pace will not spend and that turns the state to watch when a projection would eat into it.

### Details

- Adds **Reset cycles**: the peak percentage each past window reached, the number of readings, and what that window's tokens are worth at the current catalogue, with a small bar history per source.
- Adds a **By project** table using the working directory each Codex or Claude session ran in; sessions now show the project name and a short session id instead of a truncated UUID. Only the folder path is stored, never prompts.
- Gives the cost chart hover values, day ticks, and a stacked-by-provider mode; the daily Codex chart gains the same hover and ticks.
- Replaces the repeated "current-catalogue token API-equivalent" phrasing with a short label and an explainer available from an info control.

### Notifications, export, diagnostics

- Adds reset, fallback, and daily-digest notifications alongside the existing pace alert, each independently switchable; the pace alert now names the earliest run-out time. Alerts can be snoozed for one, six, or twenty-four hours from settings or the tray menu.
- Adds **Export CSV…** for the ledger (30, 90, or 365 days, with the per-record API-equivalent) and **Copy summary** for a plain-text allowance summary, also available from the tray.
- Adds a **Diagnostics** section listing what each collector last saw: SDK read latency and outcome, transcript and status-line counters, and the reason for any fallback.
- Adds a **Theme** setting (follow Windows, dark, light). The renderer now uses design tokens throughout, and the native title bar follows the effective theme.
- Adds opt-out update checks through electron-updater. They activate only in packaged builds once `build.publish` names a real release feed; the placeholder shipped here keeps them off.

### Reliability and performance

- Moves collection into a utility process with its own SQLite connection, so a slow transcript scan or a stalled provider call no longer blocks the window, the tray menu, or settings. In-flight requests fail cleanly if that process stops, and it is recycled after a timeout.
- Reads Codex session logs and Claude transcripts incrementally from a byte cursor; the Codex reader keeps session, model, and working-directory context in the cursor so an appended chunk parses on its own.
- Forecasts from a bounded 45-day window plus each bucket's latest row, compacts polling rows older than 60 days to the first and last reading per window per day, caches price lookups within an analytics run, and caches the dashboard snapshot for twenty seconds between writes.
- Packages only the runtime dependencies: React, ReactDOM, and lucide-react are bundled by Vite and are now devDependencies, which removes about 2,160 loose files from the application archive.

### Corrections

- Fixes a release-blocking test whose fixture date had expired.
- Gives each forecast chart its own gradient id, aligns the Fable estimator's list of official provenances with the tracker's, widens the active-hour selects to the full validated range, and renames the risk-notification setting to reflect that it is a desktop notification (old databases and exports are migrated).
- Removes about half of the old stylesheet that no component referenced, raises the smallest secondary text sizes, and adds tab, live-region, and focus semantics to the header and settings.

### Tooling

- Adds oxlint, Prettier, `npm run typecheck`, and a GitHub Actions workflow that runs lint, format check, type check, tests, and the web build.

## 1.0.10 — 31 August 2026

This is an in-place visual update. Running the 1.0.10 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, imported cost history, and backups.

### Native application header

- Integrates the native Windows minimise, maximise, and close controls into the application header using Electron's Window Controls Overlay, removing the visually separate title strip while preserving native window behaviour.
- Defines explicit draggable and interactive regions so the header can still move the window without making navigation, refresh, or other controls unclickable.
- Keeps the brand, navigation, verdict, refresh metadata, and native caption controls within responsive safe areas, including when the header wraps on a narrow window.

### Responsive dashboard scaling

- Replaces the fixed-feeling desktop canvas with bounded responsive scaling for the dashboard width, provider cards, gauges, forecast plots, icons, spacing, and important values. A 2560-pixel logical fullscreen viewport now uses a 2280-pixel dashboard instead of remaining capped at 1800 pixels.
- Preserves the established layout at 1920 pixels and below, then grows continuously to the new very-wide cap without a breakpoint jump or global browser zoom.
- Stacks provider cards before they become cramped, keeps the four-value summary in a balanced two-by-two layout until it fits on one row, and collapses settings navigation and source controls before they can overflow.
- Lets Details charts follow their SVG aspect ratios while applying readable maximum widths, and keeps forecast tooltips wrapped and contained inside their plots.

### Verification

- Adds release contracts for native title-bar configuration, draggable/non-draggable regions, caption-control safe areas, responsive focal scaling, compact settings containment, summary-grid behaviour, tooltip wrapping, very-wide chart caps, and the absence of global CSS zooming.
- Exercises Overview, Details, and Data & Settings across compact, desktop, breakpoint, and 2560-by-1440 fullscreen browser viewports with no horizontal page overflow or console errors.
- Verifies the native Electron header at regular and compact window sizes, including native caption controls and narrow-header wrapping.

## 1.0.9 — 30 August 2026

This is an in-place forecast correction. Running the 1.0.9 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Codex runway forecasting

- Fixes a false `0.00%/h` safe pace after a deliberately heavy late session. Previously, one small percentage step just after the configured active-hours boundary could assign nearly all otherwise unlocalised current-window use to off-schedule activity, then repeat that event rate through every remaining night.
- Allocates usage from before the first useful observation by elapsed active/off-schedule exposure, while projecting observed off-schedule events as a duty-cycled daily budget. The **Heavier** scenario still retains genuinely busy nights instead of erasing them.
- Uses each learned local day's actual off-schedule capacity, so inactive days and 23/25-hour daylight-saving days are not divided by an active weekday's hours. The expected series now applies inferred sustainable off-schedule evidence even before a zero-change poll arrives, keeping forecasts invariant to polling cadence and consistent with safe pace.
- Keeps the safe-pace denominator and the expected forecast on the same sustainable off-schedule model. Positive usage against a genuinely zero safe budget now reports an over-limit pace and fills the burn bar hot rather than rendering a misleading green sliver.
- Treats observed allowance state, external reset announcements, and banked personal reset credits as distinct. A changed official window—or a clear provider-reported allowance replenishment before its reset timestamp updates—re-anchors the forecast on the next successful refresh; announcements and credit availability do not alter the numbers, and the app never redeems a credit automatically.

### Verification

- Adds exact regressions for the two-observation live failure, the zero-safe-budget display contract, a clear provider-reported allowance replenishment before its reset timestamp changes, derived-estimate corrections, inactive days, and unchanged polling, alongside the existing overnight, sparse multi-day, reset-boundary, and rebound-jitter cases.
- Replays a copied live database without modifying the installed profile. At the captured 87%-remaining point, the corrected model reports about `0.88%` safe use per active hour, `24%` expected to remain, and `3%` in the heavier scenario instead of a false critical result.

## 1.0.8 — 30 August 2026

This is an in-place corrective update. Running the 1.0.8 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Automatic Fable 5 tracking

- Adds a one-call automatic Fable refresh that reads official model-scoped allowance data through Anthropic's experimental Claude Agent SDK when the provider supplies it, while independently importing actual local Fable token activity on every refresh.
- The SDK control query sends no prompt, exposes no tools, loads no user settings or plug-ins, persists no session, has bounded initialization, usage, and cleanup waits, aborts and releases its input, and returns only validated subscription/rate-limit fields. AI Usage neither reads OAuth tokens nor calls a private web endpoint.
- Treats `rate_limits: null`, an absent Fable window, malformed data, cancellation, and provider failure as unavailable or degraded evidence—never as fabricated `0%` usage. A still-valid official cached Fable observation can be shown as stale without being rewritten.
- Uses exact provider data whenever a Fable `model_scoped` window appears. Otherwise, actual this-device Fable activity continues to update and a calibrated local estimate is used only when its evidence is sufficient.
- Accounts for plan differences: the shared half-pool derivation now requires affirmative Max-plan evidence, because Pro and standard seats use credits and the status-line schema does not identify the plan. The upgrade clears the false Max label from old status-line rows and discards only reproducible derived estimates created from it. Manual observations remain an optional re-anchor rather than an automation trigger.
- Repairs the fallback estimator's same-reset high-water handling, rejects zero-delta rounded calibration pairs and incomplete model coverage, and bases allowance pressure on a fixed versioned vector rather than user-editable API prices or exchange rates. A twice-overall ceiling is applied only at the timestamp shared by both readings; later actual local Fable activity is no longer suppressed by an older overall percentage.
- Preserves all supported five-hour, weekly, OAuth-app, Opus, Sonnet, and model-scoped provider windows. Sanitized extra-usage credit metadata is retained as a separate account signal without being mislabelled as a Fable percentage.

### Runway and API-equivalent correctness

- Moves the all-clear/risk verdict into the backend and evaluates every active allowance window. Risk in a secondary or model-specific window can no longer be hidden by a safe primary window, and missing or expired-only sources cannot produce “All allowances on track.”
- Makes unknown model pricing explicit. Cost totals become a labelled lower bound, show the unpriced models and token volumes, and expose blank catalogue rows that can be completed in the settings screen.
- Applies the published GPT-5.6 Sol, Terra, and Luna long-context multipliers above 272,000 input tokens, with cached prompt input included in threshold eligibility.
- Keeps USD conversion fixed at one and validates settings, observations, token records, reset horizons, confidence values, and reasoning/output relationships before storage.
- Defines the displayed comparison as a current-catalogue token API-equivalent: current model rows intentionally reprice selected history, price provenance is visible, and GBP/EUR use a clearly labelled manual conversion rate rather than an implied live feed.
- Reprices restored legacy events with the current catalogue even when they carry an old reported charge, so a displayed total never mixes historical invoices with the current token comparison.
- Labels projected current balances as estimates in the primary gauges and every secondary allowance window instead of presenting a decayed observation as exact.

### Reliability, health, and packaging

- Separates the newest evidence, latest collection attempt, and latest successful scan, so a failed refresh neither refreshes stale evidence nor erases the last known-good state.
- Downgrades a safe-looking verdict when collector health or allowance evidence is stale, and shows stale Fable provider readings as projected estimates rather than current balances.
- Hardens the Codex JSON-line client against child-process, pipe, reader, write, timeout, and bounded-stderr failures. A missing percentage remains unknown while an explicit zero remains valid.
- Makes the fallback status-line inbox data-minimal, rejects malformed rows independently so they cannot block the SDK, and prevents Claude Desktop's GUI executable from being mistaken for Claude Code.
- Adds single-instance behavior, safely defers an early second-launch reveal until initialization, reuses/restores the existing window, ignores stale Vite URLs in packaged builds, visibly reports bootstrap/load failures, and keeps the aggregate verdict usable at 720 pixels wide.
- Installed desktop startup now reports a visible load failure with Retry instead of silently substituting demo data. Demo content is limited to browser preview.
- Pins `@anthropic-ai/claude-agent-sdk` exactly and excludes its optional bundled Windows Claude binary from release payloads; the app uses the external installed Claude executable.
- Keeps allowance freshness separate from transcript-activity freshness: a current Fable balance plus a failed local import is visibly degraded and cached activity is labelled, not silently shown as current.
- Prevents legacy backups from restoring an unverified Max-plan label, and recognizes the optional status-line helper only when its exact `-File` target is the app-owned script.
- Audits the completed ASAR for source maps, private local data, and bundled Claude binaries, then generates `SHA256SUMS.txt` for the Windows artifacts as part of the release build.

### Verification

- Adds focused SDK lifecycle/schema/privacy, automatic Fable, estimator, dashboard-decision, storage-validation, cost-completeness, lifecycle, Codex-client, and release-contract regressions.
- Runs the suite in `Europe/London` so overnight, local-day, reset-boundary, and daylight-sensitive behavior is exercised consistently.

## 1.0.7 — 30 August 2026

This is an in-place update. Running the 1.0.7 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Fable 5 allowance

The 1.0.5 derivation only moved the Fable estimate when the official overall percentage stepped forward. On a machine whose Claude sessions mostly run outside the terminal, the status line never fires, the overall figure never visibly steps, and the estimate froze at its last anchor while real usage climbed — the official Usage screen read 40% while the app still said 37%.

- Adds a second, stronger derivation: when two official Fable readings bound an interval of local token history, the rate between them — Fable percent per dollar of API-equivalent Fable value — is measured directly, with no share assumption, and projects the latest anchor forward as new usage arrives. This keeps the estimate moving between readings even when no status-line data is arriving at all.
- The direct rate takes precedence over the overall-share split whenever it exists, because it is measured against official Fable readings rather than inferred through the shared pool. The overall-share method remains the fallback when fewer than two Fable readings exist.
- Pairs must share a reset — a delta across a reset is meaningless — but a rate learned in one window carries into the next, because it is a property of pricing and caps, not of the week.
- The ceiling is unchanged: Fable can never read higher than twice the official overall percentage.
- Fixes a double-count in the overall-share tail: when a manual Fable anchor was newer than the last official overall reading, the Fable value between those two moments was included in the anchor and projected again. The tail now starts at whichever is later.
- Practical consequence: each official Fable reading you add from Claude's Usage screen both re-anchors the estimate and sharpens the measured rate. Two readings are enough to start; the estimate then tracks continuously between them.

### Verification

- Five new regression tests cover the pair calibration, its precedence over the share split, the ceiling clamp, reset boundaries, and the tail double-count fix; all 89 tests pass.
- Verified against the live database: with the official readings 37% (29 Aug) and 40% (30 Aug) recorded, the derivation reproduces the official 40% exactly and calibrates at roughly $13.80 of Fable API-equivalent value per allowance point.

## 1.0.6 — 30 August 2026

This is an in-place update. Running the 1.0.6 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Overview redesign

The Overview was recomposed so the question it exists to answer — how much is left, and will it last to the reset — is readable without scrolling and without interpreting jargon.

- Adds a verdict chip to the header ("All allowances on track", or the affected source by name when one is running warm or may hit its limit), computed from the worst forecast state across Codex, Claude, and Fable 5. It is visible from every tab.
- Replaces the full-height quota cards with compact cards that fit both providers above the fold. Each leads with the answer sentence, then an arc gauge showing remaining allowance with the low-allowance band drawn on the arc and a tick at the expected-at-reset value.
- Adds a burn-rate bar comparing recent pace against the safe pace, coloured by the same thresholds the pace alert uses.
- Makes the forecast chart readable: hovering shows the date with the expected and heavier values at that point, the axis carries weekday labels, and a legend replaces the end-of-line captions.
- Condenses the learning strip, pace row, and provenance footer into one line each; "calculated · heavier" and similar labels are replaced with plain wording.
- Presents Fable 5 as a slim strip with a meter (remaining allowance, with a tick at the expected-at-reset value) instead of a second full card. Its waiting and expired states are unchanged.

### Corrections

- The header now stays fixed while scrolling. It had been styled as sticky since 1.0.0, but an overflow rule on the page shell disabled it everywhere.
- Removes the two full-screen blurred backdrop layers, which re-rasterised on every scrolled frame and were the dashboard's largest rendering cost.
- Reduces the minimum window width from 1000px to 720px; the card grid stacks below 980px instead of forcing a horizontal scrollbar.
- Moves the forecast chart to a colour set whose adjacent series remain distinguishable under the common forms of colour-vision deficiency and meet contrast floors against the panel background, verified programmatically.
- Honours the Windows reduced-motion preference for smooth scrolling.

### Verification

- All 84 automated regression tests pass unchanged; this release alters no collector, forecast, or storage behaviour.
- Strict TypeScript and the production web build pass.
- The redesigned Overview was verified in a browser at 1400px and 760px widths: both cards render above the fold, the sticky header holds while scrolling, chart tooltips report interpolated values, and no layout overflows horizontally.

## 1.0.5 — 30 August 2026

This is an in-place update. Running the 1.0.5 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Fable 5 allowance

The Fable percentage was calibrated by dividing one official reading by the Fable tokens this computer had a record of. On a machine whose local history started partway through the week, that attributed a whole week's usage to a fraction of the week's tokens, so the rate was overstated and the estimate climbed too fast. It is now derived differently.

- Derives Fable from the official overall percentage, which Claude reports and the app already collects. Each forward step in the overall figure is split between the models that caused it by API-equivalent value, and Fable's share is doubled, because Fable's cap is half the overall weekly allowance.
- Uses only intervals bounded by two official readings, so usage from before this computer's records cannot distort the rate.
- Clamps the estimate to twice the overall percentage. A Fable figure above that is arithmetically impossible.
- Splits each step by API-equivalent value rather than raw token count. A Fable output token costs five times a Fable input token, and counting both as one token mis-weighted the split.
- Leaves the estimate at zero for a week spent entirely on other models, and moves it at twice the overall rate for a week spent entirely on Fable.
- Treats an official Fable reading as an anchor rather than a requirement. Adding one still improves the result and is the way to correct a week that began on another machine.
- Holds the estimate steady when the official overall figure has not moved, instead of projecting movement from a calibrated rate.
- Reports confidence from the number of measured steps behind the estimate.

### Developer tools

- Adds `tools/fable-probe.cjs`, which reports what Claude Code exposes to the status line, what the dashboard reads from it, how much of the current window has local records, and how many usable calibration steps exist. `watch` follows the status line and transcripts live.

### Verification

- Expands the automated suite from 83 tests to 84, replacing the five tests that encoded the previous calibration model with seven covering the new one, including the all-Opus and all-Fable extremes and the ceiling.

## 1.0.4 — 30 August 2026

This is an in-place update. Running the 1.0.4 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Background collection

- Collects on a schedule, chosen in **Data & settings → Sources**, so pace alerts and daily backups no longer depend on pressing **Refresh**. Also collects when the window is reopened and when Windows wakes.
- Honours **Only when I refresh**: with automatic collection off, reopening the window and waking the PC no longer start a scan. A launch still collects once.
- Reconciles every setting whose effect lives outside the database — launch at login and the collection schedule — from one place, so the settings screen, a restore, and startup cannot disagree.
- Sends the dashboard its new figures before the scheduled backup runs, so a failed backup can no longer freeze an open window silently. Backup failures are now reported.
- Notifies once per risk episode rather than once per collection, with an escalation to a full-allowance projection always breaking through.

### Restore from backup

- Adds **Restore from backup…**, which merges a `.aiusage.json` export into the local database. Token records, observations, daily totals and prices already held are kept as they are, so nothing is double counted or rolled back. Settings are replaced by the export's, and the notice says so.
- Reads the chosen export before writing the safety backup, and exempts it from backup retention, so restoring the oldest backup can no longer delete it.
- Skips and reports records an export cannot supply validly, one row at a time, instead of abandoning the whole restore.
- Applies the same validation to restored records as to live ones, including allowance ranges and reset times, and never writes an active-hours schedule whose start is not before its end.

### Claude status-line helper

- Adds **Disable helper**, which restores the status line preserved when the helper was enabled, or removes the one it added.
- Leaves a status line the app did not install completely alone, script included.
- Reads Claude's settings file even when another tool has written it with a UTF-8 byte-order mark, and refuses to rewrite a settings file it cannot read cleanly rather than replacing it.
- Keeps a byte-exact copy of Claude's settings before changing them, and no longer leaves a new copy of an unchanged file on every click.

### Corrections

- The cost period chosen on Details (7, 30, or 90 days) now survives a refresh, a settings change, and a price edit, and the Overview headline names the period it is showing.
- A failed Claude collection no longer erases what the app knows about the source, which had flipped **Disable helper** back to **Enable helper**.
- A background collection no longer discards a price being edited.
- Reports the version from the application manifest to the Codex app server instead of a hardcoded string.

### Verification

- Expands the automated suite from 46 tests to 83.
- Findings from an independent multi-agent review of this release were fixed and covered by regression tests.

## 1.0.3 — 29 August 2026

This is an in-place update. Running the 1.0.3 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Forecast accuracy

- Anchors each forecast to allowance used across the current provider window, divided by active hours elapsed up to the latest observation.
- Stops evidence at the reading timestamp so stale observations cannot manufacture an unused interval.
- Blends the window anchor in gradually and gives it up to 90% weight after about 30 active hours of evidence.
- Builds the heavier scenario from learned daily usage, with a conservative early-window fallback, instead of momentary burst rates.
- Splits the sustainable window budget between active and off-schedule use so the same allowance change cannot be projected twice.
- Uses unchanged boundary readings to localise later usage and distributes sparse multi-day changes across local calendar days.
- Ignores same-window percentage regressions until usage exceeds the prior high-water mark, preventing provider jitter from duplicating consumption.
- Keeps the heavier path at least 22% above the expected path.
- Separates the sustainable projected pace from the raw pace seen while actively working, and labels both clearly on the dashboard.

### Verification

- Adds regressions for short bursts during otherwise idle allowance windows and for stale-observation anchor timing.
- Makes bundled-Claude detection deterministic on computers that already have Claude on `PATH`.
- Expands the automated suite to 46 tests and fixes the test timezone to Europe/London for repeatable results.

## 1.0.2 — 29 August 2026

This is an in-place update. Running the 1.0.2 setup program upgrades an existing AI Usage installation and preserves its local database, settings, observations, and backups.

### Accuracy

- Stops counting Codex reasoning tokens twice. Reasoning remains visible as a subset of output.
- Stores and prices Claude five-minute and one-hour cache writes separately.
- Updates the built-in Claude Sonnet 5 pricing vector while preserving edited price rows.
- Re-imports local Claude transcripts once after upgrade so historical cache TTL detail is recovered.
- Uses strict, version-bounded model price matching; unknown models remain unpriced instead of receiving a guess.
- Groups cost history by the computer's local calendar day and applies the selected 7/30/90-day period to official daily usage.

### Forecasts and allowances

- Compacts repeated unchanged observations so polling frequency cannot inflate confidence.
- Projects stale observations forward to the present before forecasting the reset.
- Marks expired allowance windows as unknown while waiting for the next official reading.
- Learns mixed active/off-schedule intervals without assigning the whole change to active hours.
- Tolerates small provider reset-time drift in the learning history and chart.
- Merges manual Codex weekly observations into the official overall weekly learner when official data arrives.
- Chooses the overall Codex limit deterministically when multiple equal-length model limits exist.
- Preserves distinct Fable allowance windows if Claude supplies more than one.

### Claude collection

- Imports transcript token metadata directly even when the optional allowance status-line helper has not emitted a reading.
- Accepts Windows UTF-8 BOM-prefixed helper records.
- Preserves partial in-progress JSON lines for the next refresh and no longer rewrites the live helper inbox.
- Rejects impossible reset dates rather than storing a 1970 allowance.
- Keeps Claude marked connected across unchanged refreshes while its latest official allowance remains current.

### Reliability and accessibility

- Isolates collector failures so one unavailable provider cannot abort the other provider's refresh.
- Distinguishes complete, fallback, and failed refreshes in the in-app notice.
- Repairs invalid settings left by earlier numeric-input behavior while preserving valid custom settings.
- Adds bounded backup retention and reports failures when Windows cannot open the backup folder.
- Restores keyboard and screen-reader access to switches, active-day state, and asynchronous notices.
- Adds a production Content Security Policy and keeps Electron navigation/pop-up protections enabled.
- Pins build dependencies, adds a Git repository, and expands automated coverage from 6 original tests to 41 regression tests.

## 1.0.1 — 29 August 2026

- Added direct Claude transcript token import and Fable 5 cost tracking.
- Produced update-compatible Windows installer and portable packages.
