# Run-out forecasting

This page is for anyone who wants to know how AI Usage decides whether an allowance will last until its reset. It covers the forecast model, ignored days, allowance changes, the verdict, the daily budget and budget mode, the weekly token-capacity estimate, and how Fable is tracked and limited by the shared Claude weekly allowance.

## How the forecast learns

Codex, overall Claude, and Fable each have an independent learner. Repeated polling snapshots are compacted so they cannot manufacture confidence. The model combines:

- allowance used across the current reset window;
- recent working pace and hourly shape without projecting one burst across every future hour;
- matching hours and weekdays from observed history;
- your configured active-day schedule; and
- the busy end of learned daily use for the **Heavier** scenario (see below).

### The heavier scenario

The **Heavier** scenario uses the busy end of learned daily use, phased in across seven historical days separately for scheduled and off-schedule use. Until that history accumulates, the scenario stays closer to its baseline of 22% above expected consumption; the latest observed day does not count as a completed historical day.

The busiest learned day is repeated in full for the first day ahead; beyond that, the margin above the expected path grows with the square root of elapsed days, because a heavier week is not seven consecutive peak days. A heavier case that would leave less than the hard-limit margin at reset puts the window on watch.

### Readings and intervals

Provider percentage rebounds within one reset window are handled with a monotonic high-water mark, so rounding jitter cannot spend the same allowance twice. Sparse intervals are allocated by local day, reset boundaries are not mixed, and off-schedule use remains part of the measured burn.

An isolated late-night step is duty-cycled across the off-schedule hours observed over whole days; it is not treated as continuous usage throughout every remaining night. This keeps the safe active-hour pace meaningful after an intentionally heavy session.

## Ignored forecast days

Use **Settings → Forecast → Ignored forecast days** to exclude a date when your usage was unusual, such as a one-off intensive task or a day away. Choose today or a past date and select **Ignore day**; **Include again** restores it to learning. Dates follow the local timezone shown beside the control and apply across Codex, Claude, and Fable. The list is saved in the local settings and included in backups.

Ignoring a date changes the historical patterns used for forecasting. Recorded usage and costs, observed allowance, and your future active-day schedule stay intact. Because quota readings are cumulative, learning also leaves out intervals crossing an ignored day instead of attributing that usage to a neighbouring day. Less usable history can reduce forecast confidence or require the configured fallback pace.

## Allowance changes

Use **Settings → Forecast → Allowance changes** when a subscription's main weekly allowance changes size, for example when a promotional 50% boost ends or a plan is upgraded.

A provider percentage is a share of the allowance in force when it was read, so the first reading after such a change steps by the ratio of the two allowances without any usage, and every earlier reading is a share of a different whole.

Record:

- the subscription;
- the instant of the change (after the last reading on the old allowance and before the first on the new one); and
- the earlier allowance as a percentage of the allowance that replaced it, such as 150 when a 50% boost has ended.

Learning then multiplies readings taken before that instant by the ratio, so the step is not learned as a burst, earlier weeks keep their true pace in today's terms, and token capacity calibrated on the old allowance is scaled to the new one, including across a plan upgrade that would otherwise restart its calibration.

What an entry affects:

- Entries affect the main weekly allowance only. A Claude change also applies to Fable because it shares that pool; five-hour, other model-specific, and OAuth-app limits are unaffected.
- Recorded usage, costs, cycle history, and the provider's own percentages on the cards are never rewritten; the projected Fable estimate follows a saved or removed entry on the very next snapshot, because it is computed from the readings rather than stored.
- Each entry compares neighbouring allowances rather than today's, so several changes compound correctly and an entry stays valid when the allowance changes again; removing one restores the previous learning.

The list is saved in the local settings and included in backups.

## Resets and early replenishment

When a successful official allowance reading shows a new window—or a clear allowance replenishment before its reset timestamp updates—the forecast starts a fresh cycle. External announcements and banked-credit availability are not treated as allowance state: the dashboard reports a banked personal reset credit separately, never assumes it was spent, and never consumes it automatically.

If a clearly early replenishment follows an unusually heavy day, the expected forecast gives that completed local day **25% of its usual influence**. The detector needs:

- closely spaced provider readings showing a drop of at least 20 percentage points to 2% used or less, well before the prior scheduled reset;
- reliable daily coverage and at least three earlier comparison days; and
- the preceding day's use to be at least three times typical and at least 10 percentage points higher.

An ordinary reset, sparse history, or a heavy day alone does not trigger this adjustment.

This reduces the influence of that day's usage and observation time together; it does not pretend fewer tokens or allowance were consumed. Recorded usage, the provider balance, and the heavier-use scenario retain the real activity. A note on the provider card explains when the adjustment applies. Explicitly ignored dates still take precedence. The app recognises the observed replenishment pattern but does not infer whether a credit was redeemed or why the provider reset the allowance.

## The verdict

The header verdict is built in the backend from every active primary, secondary, and model-specific window. A risky secondary window overrides a safe headline window.

**All allowances on track** appears only when every expected source has sufficiently current evidence and every active window is safe; missing, stale, failed, or expired-only evidence produces an unknown verdict rather than a false all-clear. The verdict chip and the tray tooltip both carry the three headline percentages, and the tray icon carries a colour dot for the current state.

Expired allowance readings are labelled as historical evidence while the app waits for a current reading. The **Past weeks** table on each provider page pairs the window in progress with its own allowance-window forecast; a shorter, more restrictive window can still drive the headline verdict without being shown as the weekly cycle's forecast.

Each card states the expected and heavier-week outcomes at reset in words: the balance left, or **Runs out** with the moment that projection first reaches zero. The same time is included in pace notifications.

## Daily budget and budget mode

A **daily budget** beneath each card turns the forecast into a pace: the share of the allowance that fits in each remaining active day while keeping the reserve, with the expected and heavier paces marked against it. Every figure comes from the same endpoints the runway draws, so a pace fits exactly when its projection keeps the reserve. Use outside active hours still draws on the allowance and is included in each pace.

When something needs attention, the status line at the top states it once, with its daily budget and a **Plan … usage** button that opens the provider page; the list beneath the cards holds only what the status line and cards do not already say.

**Budget mode** (Settings → Forecast → *Keep in reserve*) sets a share of each allowance you want untouched at reset. The safe pace only spends what sits above the reserve, and a projection that would eat into it is shown as a watch state; the forecast itself still reports what will actually happen. On a provider page, the **Daily budget** planner's *Keep in reserve* slider re-plans the budget, the chart's reserve line and the verdict as you drag, without saving; **Use N% for all forecasts** saves it as the reserve.

## Estimated weekly token capacity

Each provider page shows its **Weekly token capacity** beneath its runway. Each supported weekly window has its own estimated full-week token capacity, estimate range, confidence label, and tokens remaining at the displayed provider-reading timestamp. These figures describe the recorded model and token mix; they are not a provider-declared token entitlement. Overall and model-specific windows can share allowance and must not be added together. Providers without any allowance reading are omitted from the panel, and a weekly pool with no token scope (such as OAuth apps) is hidden when a supported weekly window exists.

### How it is estimated

The estimate matches recorded tokens to positive changes between provider-reported percentages within the same reset cycle. It needs at least three usable intervals, each covering at least five percentage points, and learns from up to 45 days of history.

- Plateaus are accumulated until the percentage moves enough; resets, corrections, future records, unknown bucket membership, and intervals crossing ignored dates are excluded.
- Readings taken before a recorded [allowance change](#allowance-changes) are rescaled to the current allowance before matching, and the window's details say so.
- Token categories are counted once: cached input is already part of Codex input, reasoning is already part of output, and cache-write durations are subdivisions of the cache-write total.
- API prices and imported desktop conversation estimates do not determine capacity.

### Reading the details

Expand a window's details to see the recorded model mix, input/cache/output split, calibration evidence, and limitations. The range reflects variation in the usable observations with an uncertainty margin, not a guaranteed bound or statistical confidence interval.

Confidence describes consistency in the available local evidence and stays conservative because web, cloud, desktop, and other-device activity may be missing. Missing activity can make apparent capacity too low; a changed model or token mix can change it substantially. An expired window or provider reading older than 24 hours cannot supply a current tokens-remaining estimate. Ignored days affect learning only and still consume actual allowance.

## Automatic Fable activity tracking

Fable no longer needs a manual entry to start moving. Two independent jobs keep it current: every Claude collection imports local activity, and a **Refresh** you choose also reads the official allowance (automatic collections do not, to keep automated access to your Claude subscription out of the app):

| Evidence | Scope | Dashboard treatment |
| --- | --- | --- |
| Claude's official model-scoped usage reading | Account allowance, when the provider returns a Fable window | Exact provider percentage and reset, read when you choose **Refresh** and kept until the next one |
| Local Claude transcripts | Actual Fable token activity recorded on this computer | Imported automatically on every collection |
| Projected local estimate | Allowance estimate when exact model-scoped data is absent and shared-pool evidence is sufficient; computed when the dashboard is built, never stored | Clearly labelled local estimate |
| Manual observation | Optional fallback | Re-anchors an estimate; never required as a trigger |

### The official reader

The official model-scoped reader uses Anthropic's experimental Claude Agent SDK usage method. It sends no prompt, exposes no tools, loads no user settings or plug-ins, persists no session, bounds initialization, usage, and cleanup waits, aborts and releases the control query, validates the complete response before writing, and retains only the allowance fields the tracker needs. AI Usage does not read or store Claude OAuth tokens and does not call a private web endpoint.

That provider method can legitimately return no plan windows. In that case the app records the successful scan, continues importing actual local Fable token activity, and shows the exact allowance as unavailable rather than inventing `0%`. It automatically switches to the exact figure on a later refresh if Claude begins returning a Fable `model_scoped` window.

### Plan rules

Fable plan rules are not universal. Claude Max and qualifying premium Team or Enterprise seats include Fable 5 and Fable 5.1 under one Fable limit of up to half the weekly allowance, while Claude Pro and standard Team or Enterprise seats use usage credits at API rates.

The fallback half-pool derivation therefore requires affirmative Max-plan evidence. An unknown plan is not treated as Max, and old locally derived rows created from that assumption are discarded during the upgrade. Exact provider model-scoped readings remain authoritative on any plan.

### The local estimate

The local estimate is a projection, not a reading. It is recomputed from official readings and local activity each time the dashboard snapshot is built, cached until Claude evidence, the allowance-change setting or the clock moves it, and never written to the allowance history.

So it cannot outlive the settings it was computed under, an official reading is never displaced by it, and cycle history for Fable is built from provider-backed and manual readings only; while only the projection exists, the current cycle row for Fable stays empty.

The Max-plan check reads the most recent official reading in the window that names a plan, so a status-line reading, which never carries one, cannot switch the estimate off. Estimates stored by earlier versions are removed once on upgrade.

### Fable 5 and Fable 5.1

Fable 5 and Fable 5.1 draw on the same Fable limit, which Claude reports as a single "Fable" window, so the allowance is called Fable. The Fable page splits this device's Fable activity between the two versions by requests, tokens and API-equivalent cost; it does not split the percentage, because the provider reports one.

### This device only

Local transcript activity is deliberately described as **this device**. It cannot see Fable work done on another computer unless an account-level provider allowance is available. **Add a quota observation** remains available for a provider percentage you want to record, but it is now an optional fallback, not an automation prerequisite.

## Fable shares the Claude weekly limit

Anthropic describes the Fable limit as a share of your weekly limit, not an allowance beside it: Fable models can use "up to 50% of your weekly usage limits", they "draw from your plan's regular weekly usage limits", and every other model draws from the same limits. So what any Claude model uses shrinks what Fable can still use. With Opus at 70% of the week and Fable unused, 30 points of the week remain, which is 60% of the Fable limit.

The dashboard applies that rule whenever it builds a snapshot:

```
usable Fable = min(Fable limit remaining, Claude weekly remaining / 0.5)
```

- The Fable card, runway, daily budget, verdict, tray tooltip, digest and flyout show **usable** Fable. When the Claude weekly limit is the tighter one the figure is labelled "usable" and the provider's own Fable percentage is shown beside it; it is never rewritten.
- The runway hatches the part of the Fable limit the week can no longer cover, and the expected and heavier-week paths, the run-out time and the state follow whichever limit runs out first. Because every Fable point also spends half a point of the week, the Claude weekly projection is never allowed to fall more slowly than Fable's own.
- When the Claude weekly limit is what puts Fable at risk, the verdict, notifications and attention list name Claude once, "Fable included", rather than raising two alarms for one event. A Fable risk from its own limit or its own pace is still reported on Fable.
- The Fable page's **Claude weekly limit** panel shows the Fable limit, Claude weekly and usable Fable now and at the reset, which one binds, and what happens at the limit given the extra-usage setting from your last Refresh: at the Fable limit other models keep working, but at the weekly limit every Claude model stops and switching model does not help.
- It uses only the readings already stored; nothing new reads Claude plan usage. If the two readings were taken more than 15 minutes apart, or either is projected from an older reading, the usable figure is marked estimated. If a Fable reading is more than twice the weekly use taken at the same time, the half-share rule does not match the account and the cap is not applied.
