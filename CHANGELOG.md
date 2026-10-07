# Changelog

## 1.0.58 — 7 October 2026

- Stop the tray flyout juddering while it is open. At some display scalings, such as 150%, its contents could come out a fraction of a pixel taller than the window, so a scrollbar appeared, the text rewrapped and the window resized itself back and forth hundreds of times a second, sometimes showing a blank band or cut-off buttons at the bottom. The flyout now opens at its final height and stays still, including the first time it opens after being closed for a while, when it used to open at full height and then shrink.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.57 — 7 October 2026

- Treat a **Refresh** that Claude Code answers without your subscription sign-in as failed. Claude Code can briefly report no subscription, as an API-key session would, and AI Usage used to store that as a successful read that returned nothing: the Claude card showed **Last good** at that moment next to **Stale**, gave no reason and asked for a **Refresh** straight after one. On an account with a Claude allowance still running, AI Usage now tries once more, keeps the last reading and the last good scan, and says on the Claude and Fable cards that Claude Code did not report your subscription sign-in, until a newer reading replaces it. Other failed Refreshes now name their error on the card too.
- Say in **Settings → Sources** when the Claude Code mod's plan limits reach the app. With **Collect automatically** set to **Only when I refresh**, they wait for the next collection: when the app starts, when you press **Refresh**, or **Sync now** in the `/ai-usage` pane. The **Collect automatically** description no longer says local activity is collected automatically whatever it is set to.
- Date Claude and Fable figures correctly after a recorded allowance change. When a reading is matched with an earlier read of the same figure, both are now compared in the allowance in force now, as the forecast compares them. After an upgrade, a figure could otherwise look recently read when its evidence was days old, or days old when it had been read hours earlier, and Claude and Fable were called current or out of date on that wrong match.
- Keep Fable marked out of date after a **Refresh** that returned the Claude allowance but not Fable's, until a newer Fable reading arrives. Before, the next automatic collection showed the older Fable reading as current again.
- Check Anthropic's Claude Code installer before running it. **Install Claude Code** in the first-run guide now downloads the installer script over HTTPS, compares it with the digest recorded in this release, and runs only an exact match from a local file. If Anthropic has changed the script since this version was built, the app does not run it and shows the official PowerShell command instead.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.56 — 1 October 2026

- Bring your allowances into Claude Code with the new AI Usage mod. Install it from **Settings → Sources → Claude Code mod**; it needs Claude Code 2.1.287 or later and works in the terminal and in the desktop app's Code tab. Type `/ai-usage` to open the tray flyout's figures beside the conversation, with the verdict, a fuel tape for each subscription, the forecast at reset and shorter windows such as the five-hour session. In the pane, `s` collects now, `o` opens the dashboard and `c` turns the caution line on or off; `/ai-usage text` prints the same figures where Claude Code draws nothing.
- Show a caution line above Claude Code's prompt while an allowance is on watch, at risk or critical, unless alerts are snoozed. It stays out of the way while everything is on track or AI Usage is not running.
- Keep Claude current between Refreshes while you work in Claude Code. After each response, the mod passes on the plan limits that response reported, dated by the request that fetched them, and AI Usage imports them within seconds while automatic collection is on, then at most every two minutes. AI Usage still reads plan usage itself only when you press **Refresh**, and **Sync now** in the mod is a local collection.
- The mod uses no API and none of your allowance: it calls no model, makes no network request and adds nothing to your conversations. Remove it from the same setting, or turn it off in Claude Code's `/plugin`; app updates refresh it in place. Mods are new in Claude Code, so their behaviour may change between Claude Code releases.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.55 — 1 October 2026

- Add built-in GPT-6.1 Sol API-equivalent pricing: $2 input, $0.10 cached input, $2.50 cache writes and $10 output per million tokens, with the long-context rates above 272,000 input tokens, using official rates verified on 1 October 2026. Codex work on GPT-6.1 Sol was unpriced until now; existing records are priced when the catalogue loads, and saved custom prices are kept.
- Keep readings the allowance card already ignores out of the cycle history. A reading saved by an earlier version with an impossible reset, such as one three months ahead, could appear at the top of the history as a phantom current cycle.
- After a recorded allowance change, keep a status-line reading taken since the change on the Claude card instead of holding it back as a repeat of an earlier read of the old allowance. Claude's freshness and the Fable allowance follow the same reading.
- Label the cost and daily-token chart axes distinctly for empty or nearly empty periods: an empty cost chart counts whole pence instead of repeating £0.00 and £0.01, a few pence of cost shows steps such as £0.025, and an empty token chart counts whole tokens.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.54 — 30 September 2026

- Date every Claude status-line reading by when its Claude Code session last fetched the limits, not by when the status line was redrawn. An idle session redraws the limits it fetched hours ago every minute, so those redraws no longer replace a newer **Refresh** on the Claude card (a week read at 13% no longer turns into 1% two hours later), no longer make Claude or Fable look freshly read, and no longer count as a successful **Refresh**. When a session that is in use sees the week refilled after your last **Refresh**, the card now shows it at once instead of two hours later. The forecast and its learned pace, the remaining-token estimate and the Fable estimate follow the same dates. To tell fetches apart, the status-line helper now also keeps each session's random identifier and its total time waiting for API responses; it still stores no paths, prompts or costs. A reading whose fetch cannot be dated (from an earlier helper version, or from a session already open when the helper is enabled or updated) is still shown, but no longer marks Claude or Fable as current.
- Handle a weekly allowance that Claude refills early. A status-line redraw of the week it replaced no longer returns to the Claude card, the new week's pace counts from when the refill was fetched, and a figure the old week reached no longer makes the new week look freshly read.
- Keep Claude marked out of date after a **Refresh** that succeeds but returns no allowance at all, instead of letting the next automatic collection bring an older reading back as current.
- Stop repeated status-line redraws from counting as quiet days in the Claude forecast, where they diluted the learned night-time pace.
- Import Codex usage from threads you archive. Work written just before you archived a thread was missed, and a thread started and archived between two collections was missed entirely. Archived and unarchived logs keep their place, so nothing is counted twice.
- Name Claude's separate weekly limits, such as "Opus · weekly", instead of calling each one "weekly allowance", and label next week's reset with its day.
- Keep the Claude and Fable figures honest in more places: plans without a Fable allowance no longer wait for Fable readings, the Fable card and the planner apply the same reserve, the "above its safe pace" note follows your pace-risk setting, and an empty period no longer claims every category is priced.
- Keep **Refresh** unavailable until a refresh finishes, recover from a first load that storage refused, and keep cost figures updating after a period read fails.
- Reopen the window after **Restart** from Settings or an update recovery when the app was started at sign-in, reload a dashboard whose page crashed, and bring back a window left on a disconnected monitor.
- Export CSV by the same local calendar days as the dashboard, without holding the whole ledger in memory, and keep backups working after the Backups folder is deleted. Restoring an older `.sqlite` backup no longer resets settings that version did not have.
- Read status-line helper paths with non-ASCII characters in the profile folder correctly, and stop skipping readings after the helper rotates its inbox.
- Save whole-number settings as whole numbers, keep a free-reset expiry you are retyping, date an edited price by your local day, and list the same models in the pricing table and its Settings count.
- Keep the planner from letting a hidden window release its page while a reserve save is still pending.
- Release the storage worker when it is idle, so the app uses less memory between backups.
- Show refresh results with source names, round unusual refresh intervals to minutes, and read the last minute before a full day as "1 day 0h".
- Keep the provenance label in **Activity → Source evidence** clear of the current figure.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.53 — 29 September 2026

- Keep the local Fable estimate inside the current Claude allowance cycle. When Claude refills the weekly allowance before it updates the reset time, the estimate now starts again with the new cycle instead of ignoring its use, and use from before the refill no longer carries into it. A recorded allowance change is no longer mistaken for a refill, and a stale status-line reading no longer lowers the Fable ceiling.
- Stop a corrected Fable reading and its rebound, such as 20% → 19% → 20%, from counting as Fable use when the estimate is calibrated.
- Judge Claude's source status and the outcome of a **Refresh** on the readings the Claude card actually shows. A lower status-line reading that the card ignores no longer marks Claude as current, and a failed **Refresh** is no longer reported as successful because of it or because of a helper reading brought in by an earlier collection.
- Show a source as needing a refresh in Activity and in the header once its allowance reading is out of date, as the verdict and provider cards already did. Before, a successful collection kept it "Current" until the next one, which with manual refresh could be indefinitely.
- Keep a reserve you are still trying on a provider page. Moving the slider while a save is in progress no longer discards the newer value, the save button can no longer be pressed twice, and closing to the tray no longer drops an unsaved reserve.
- Hide a remaining-token estimate once its allowance reading is over 24 hours old without waiting for a new snapshot, while keeping the full-week estimate, and keep relative times and planning hours moving between snapshots.
- Install, detect and remove the status-line helper in the Claude configuration folder set by `CLAUDE_CONFIG_DIR`, where Claude Code reads its settings.
- Update the Claude Agent SDK that reads plan usage when you press **Refresh** to 0.3.282. The usage response it returns is unchanged.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.52 — 26 September 2026

- Treat Fable's limit the way Anthropic describes it: up to half of your Claude weekly limit, inside that limit rather than beside it. Every Claude model draws on the week, so what other models use leaves less for Fable: with Opus at 70% of the week, Fable has 60% of its limit available, not 100%. The Fable card, runway, daily budget, verdict, tray and flyout now show **usable** Fable, the lower of Fable's own remaining and what the Claude weekly limit leaves, with the provider's own Fable figure beside it. The runway hatches the part of the Fable limit the week can no longer cover, forecasts follow whichever limit runs out first, and when the Claude weekly limit is the cause the alert names Claude once, "Fable included", instead of raising two. Nothing new reads your Claude plan usage.
- Add a **Claude weekly limit** panel to the Fable page: the Fable limit, Claude weekly and usable Fable now and at the reset, which one binds, what happens at the limit given the extra-usage setting from your last Refresh, and this device's Fable activity split between Fable 5.1 and Fable 5.
- Add built-in Claude Fable 5.1 and Claude Opus 5.5 API-equivalent pricing. Both were priced as their predecessors: Fable 5.1 cache reads cost $0.25 per million tokens, not Fable 5's $1, and Opus 5.5 costs $4 input, $0.20 cache reads and $20 output per million, not Opus 5's rates. Claude Code sessions are mostly cache reads, so costs for these models were overstated by roughly three quarters (Fable 5.1) to nine tenths (Opus 5.5). Existing usage is repriced automatically and custom prices are preserved. A future point release now shows as unpriced instead of borrowing its predecessor's price.
- Weigh Fable 5.1 and Opus 5.5 by their own rates when the local Fable estimate splits Claude weekly use between models.
- Call the allowance "Fable" rather than "Fable 5": Fable 5 and 5.1 share one limit, which Claude reports as "Fable". Existing readings are renamed on upgrade.
- Keep the Claude weekly and five-hour readings from a Refresh if Claude ever reports two conflicting Fable windows; Fable is then shown as unavailable instead of the whole read being discarded.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.51 — 25 September 2026

- Keep Claude marked out of date when the status-line helper refreshes one allowance window while another active window still needs a Refresh. Source health now agrees before and after the next automatic collection.
- Restore the fallback notification when a requested Claude or Fable Refresh fails after a reading has naturally aged. Automatic collection stays quiet, repeated failures notify only once until recovery, and snoozed or disabled notifications remain suppressed, including after tray-idle memory cleanup.

## 1.0.50 — 25 September 2026

- Redesign the whole app in a new "Flight Deck" style, built around one question per allowance: will it last until its reset? A glareshield bar with numbered page keys (1 Overview, 2 Activity, 3 Costs, 4 Settings) replaces the side rail and carries source health, freshness and **Refresh**; each page has a cockpit-style title, and a footer shows the snapshot time and keyboard shortcuts.
- Land each allowance's runway on a fuel tape at its reset: the share left at reset, the share likely used before it, markers for the expected and heavier-week outcomes, a ring where a projection runs out, and a line for any reserve you keep. The daily budget becomes a fuel-flow gauge with a proper scale.
- State the overall verdict in a Master Caution strip: filled for act-now states, outlined for advisory ones. A partial all-clear, where some allowances cannot be read yet, is shown neutral and never as a green check.
- Use a night theme by default and turn the Light setting into a designed Daylight theme, with paper-white panels, ink text and status colours darkened for contrast; **System** follows Windows. Control outlines reach 3:1 contrast in both themes, and chart legends and stacked costs stay readable in Windows high-contrast mode.
- Bundle the B612 and B612 Mono typefaces, designed for cockpit displays, inside the app under the SIL Open Font License, so no web fonts are loaded.
- Rebuild Costs, Activity, Settings, the Claude setup guide and the tray flyout in the same style; the flyout shows each allowance as a mini fuel tape. The Light option is now labelled Daylight.
- Read Claude plan usage only when you press **Refresh**: on the dashboard, in the tray flyout, or with the tray menu's item, now called **Refresh**. Reading it starts your own Claude Code through the Agent SDK, and Anthropic's Consumer Terms bar automated access to a Claude subscription, so launches, scheduled collections, reopening the window, waking the PC, backup restores, manual observations, helper changes and finishing Claude setup no longer read it. Local Claude Code activity, the optional status-line helper and Codex are still collected automatically.
- Between refreshes, a Claude reading counts as current for as long as the dashboard verdict allows it (24 hours for the weekly window, one hour for the five-hour window); after that Claude asks for a Refresh. An aged reading no longer raises the fallback alert, while a failed Refresh still does. A Refresh pressed during an automatic collection now runs straight after it instead of being merged into it.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.49 — 24 September 2026

- Redesign the colour system so colour always means a provider or a status, never both. Fable's coral was nearly indistinguishable from the "at risk" red (ΔE 3.6) and Claude's green from "on track" (ΔE 3.8); providers are now Codex blue, Claude violet and Fable magenta, at least 17 ΔE from every status colour and checked for colour-blind separation in both themes. Neutrals move from blue-slate to graphite, and buttons, toggles, focus rings and selected states become monochrome so no control looks like Codex data. Every status now carries an icon and a word.
- Replace the combined runway chart with one runway per provider on its own clock, from the window's start to its own reset: observed use, the dashed expected path, a shaded heavier-week range, run-out markers and shading for hours outside the active schedule, which explains why projections flatten overnight.
- Add a daily budget to each card and to the status line: the share of the allowance that fits in each remaining active day while keeping the reserve, with the expected and heavier paces marked against it. Every figure comes from the same endpoints the chart draws, so a pace fits exactly when its projection keeps the reserve.
- Add a page for each provider, opened from its card or the status line's **Plan … usage** button: a full-size runway with hover and a data table, a heavier-week toggle, a daily-budget planner whose reserve slider re-plans live and can be saved, past weeks with the current window's forecast, weekly token capacity, the related Claude/Fable allowance, and the evidence behind the reading. Token capacity and the current-cycles table move here from the Overview.
- Add a tray flyout: left-click the tray icon for the verdict, each allowance's balance and expected remainder at reset, refresh, snooze, and a link to the dashboard or a provider page. It has its own restricted bridge, opens beside the icon on any taskbar edge, and releases its renderer 60 seconds after closing.
- State each thing once on the Overview: the status line carries the verdict and its daily guidance, each card its own provider, and the list beneath only what neither already says.
- Show source health and relative freshness ("Updated 2 min ago") in the command bar, with a breadcrumb on provider pages; **Escape** returns to the Overview.
- Reorganise Settings as one page with a section list that follows your scroll, badges for source health and unpriced models, and **Search settings**. Settings read as label-and-description beside the control, switches say On or Off, API pricing and Data & backups are no longer collapsed, and **Keep in reserve** previews each provider's daily budget as you type.
- Restore the monthly subscription fee inputs that were dropped from Settings in 1.0.45 (now under Subscriptions → Monthly fees), and show the subscription value on the Overview again, with a prompt to add fees when none are set. It compares each plan's fee only with that plan's own usage, so a plan without a fee, or hidden, never inflates another's value.
- Give chart axes round steps (£0 / £20 / £40 instead of quarters of an arbitrary maximum).
- Collapse long caveats on Costs, Activity and chat estimates into disclosures without removing any text; colour reset-cycle bars by provider with a 100% reference line; show observation times as relative times with the exact time kept; and mark every lower-bound cost figure with "≥".
- Show resets you can claim on their provider's card instead of in the list beneath: Codex's banked reset credits as reported, and Claude's free resets, which Claude offers only in its own Usage settings. Record those under Settings → Subscriptions → Claude free resets with their expiry date; the card hides them after it. Neither is counted as allowance or assumed spent.
- Fix a Claude week forecast as running out when it was on track. An idle Claude Code session keeps redrawing its status line with the limits it last fetched, so its stale reading (for example 1%) alternated with the fresh official reading (13%). Each drop looked like an early reset and each rise like new use, so one 12% rise was learned eight times over as late-night use and projected across every remaining night. A status-line reading lower than a fresh reading for the same reset now counts only if Claude's next usage read shows the drop too, or if no read arrives within two refresh intervals (at least two hours), so a genuine early replenishment still reaches the card. This applies everywhere, including the card's current balance, and an unchanged status-line reading no longer fixes when the next rise happened. Stored readings are unchanged; forecasts correct themselves on the next snapshot.

## 1.0.48 — 23 September 2026

- Add built-in GPT-6 Sol and GPT-6 Luna API-equivalent pricing for input, cache reads, cache writes, and output, using official rates verified on 22 September 2026.
- Apply published long-context rates above 272,000 input tokens, including recognised dated model variants. Existing recorded usage receives prices automatically; saved custom prices and usage history are preserved.
- Update preview catalogue and pricing documentation, with regression coverage for upgrade repricing, custom-rate preservation, and the exact long-context boundary.
- Fix Claude showing as stale after a refresh within a minute of another usage read. Claude Code now answers such a read from the snapshot it fetched in the last 60 seconds, and that answer is accepted as a fresh allowance reading; an older snapshot is still rejected.

## 1.0.47 — 22 September 2026

- Restore a `.sqlite` backup with **Restore from backup…** under Settings → Storage & export. Its records stream into the usual restore merge, so a history too large for a JSON export can be restored in the app. A JSON export now stops once it outgrows what a restore accepts, and the paired `.sqlite` backup is kept. The safety backup taken before an update skips the JSON export, so it finishes within the update's time limit.
- Count a forked Codex session once. A fork keeps its own session identity, history copied from its parent is not imported again, and a rescan no longer re-imports records that an earlier version filed under the parent.
- Store a Codex rate-limit reading from local logs only when it changes or 15 minutes have passed, keeping the database smaller while retaining the latest reading. A successful official Codex read now shows as connected, with any optional details that failed listed alongside, instead of marking current data as stale.
- Stop Claude Code rescanning a week of transcripts every time AI Usage reads Claude usage.
- Learn from quiet time in forecasts: the stretch without usage before an allowance resets now counts, and days observed without use lower the expected pace outside active hours in proportion to the hours actually observed. Reset alerts appear only when there was usage to replenish, ending alerts for idle windows and repeated replenishments.
- Show a dashboard verdict for Claude plans without a Fable 5 allowance instead of leaving it unknown.
- Treat cost periods as the last N local calendar days, so the headline total, daily chart and 7-day tile agree, and compare the weekly change across full days. The Claude setup guide starts fresh each time it opens, and **Reload dashboard** on the error screen now works.
- Build tray updates without token-capacity analysis, and stop rebuilding cost and capacity caches each time an old record ages out of the period, reducing background work. A very busy day no longer overflows the analytics calculation.
- Update React, Vite, lucide-react, oxlint, js-yaml, @electron/asar and the GitHub Actions used to build and release.
- Preserve local usage history, settings, observations, and backups during an in-place update.

## 1.0.46 — 18 September 2026

- Releases the dashboard renderer after 30 seconds closed to the tray, restoring the selected page, analysis period, search and window bounds when reopened. Settings, open dialogs, import previews and in-progress operations keep the window loaded to protect unfinished work. Starting with Windows in tray mode no longer creates a dashboard renderer.
- Closes idle collector database connections and releases their process after 30 seconds without pending requests. The next scheduled or manual collection starts a fresh process; overlapping work and late replies remain isolated.
- Releases full dashboard snapshots and detailed analytics caches when the window is unloaded while retaining the evidence needed for reset and fallback notifications. Explicit tray summary copies still include the API-equivalent cost and selected period.
- Adds deterministic lifecycle regressions and a repeatable Electron memory benchmark using a separate profile and 30,000 synthetic records. In a Windows before/after run, tray-mode private bytes fell from 363 MiB to 289 MiB (20%); summed process working sets fell from 511 MiB to 309 MiB (40%, including shared pages). These measurements are workload-specific and were taken with hardware acceleration still on.
- Stabilises two existing time-sensitive test fixtures: historical inbox freshness and same-millisecond cycle-history reads.
- Adds **Lower memory use** under Settings → Appearance & updates, on by default: the dashboard is drawn with the processor instead of the graphics card, which keeps Chromium's GPU process near 30 MiB private instead of roughly 200 MiB once a dashboard has been drawn. In the same Windows benchmark, tray-mode private bytes fell from 289 MiB to 117 MiB, open-dashboard private bytes from 422 MiB to 230 MiB, and hidden tray start from 150 MiB to 94 MiB. The choice is read before the app starts; changing it offers a Restart button. `AI_USAGE_DISABLE_GPU=1` still forces software rendering.
- Loads the private update component for the first update check instead of at launch, so portable and development builds never load it. Disables the renderer spellcheck service, which the dashboard's numeric and search fields never used.

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
