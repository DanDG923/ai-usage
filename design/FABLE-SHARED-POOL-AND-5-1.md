# Fable 5.1 and the shared weekly pool

Branch `feature/fable-5-1`, from `main` at 1.0.51.

## What Anthropic says

These are the rules the dashboard has to model. They were checked on 2026-09-26.

- **The Fable limit sits inside the weekly pool.** On Max, premium Team seats and premium seat-based Enterprise seats, "you can use up to 50% of your weekly usage limits on Fable models at no extra cost". Fable models "draw from your plan's regular weekly usage limits and use them faster than other Claude models". Also: "your use of other models draws from the same usage limits and you can never use more than your weekly limit." ([Help Center: Claude Fable models on your plan](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan))
- **Fable 5 and 5.1 are one allowance.**
  - The Help Center says "Fable 5 and Fable 5.1 work the same way on your plan".
  - claude.com/pricing has one "Fable" row: "50% of weekly limits" on both Max 5x and Max 20x.
  - Claude Code renamed its limit message from "Fable 5 limit reached" to "Fable limit reached" in v2.1.257.
  - The Agent SDK usage method returns a single `model_scoped` window with the display name "Fable". Every official reading in the local database (87 rows) comes from that window.
- **After the Fable limit.**
  - Max and premium seats: use usage credits at standard API rates (opt-in), or switch model.
  - Pro and standard seats: Fable runs on usage credits from the first request. There is no promotional credit for 5.1.
- **API prices (per MTok).** Fable 5.1 costs the same as Fable 5 except for cache reads, which are $0.25 instead of $1.00. The full rates are $10 input, $12.50 5-minute cache write, $20 1-hour cache write, $0.25 cache read and $50 output. Opus 5.5 is $4 / $5 / $8 / $0.20 / $20.
- **What is not published.**
  - How much faster Fable uses the pool.
  - Whether 5.1's cheaper cache reads also use less of the plan limit.

## The rule the dashboard misses

Fable's limit is a ceiling, not a separate pool. Any model's use shrinks the weekly pool, and the Fable limit can never lend back what the pool no longer has. With share `s = 0.5`, all figures are percentages remaining:

```
usable Fable = min(Fable limit remaining, Claude weekly remaining / s)
```

Example: Opus 5.5 has used 70% of the weekly limit and Fable has used none. The Fable limit shows 100% left, but only 30 points of the week remain, which is 60% of the Fable limit. Usable Fable is therefore 60%, not 100%.

## 1. Shared-pool ceiling (`electron/fable-shared-pool.cjs`)

A pure function, `applySharedPool(fableQuota, claudeQuota, options)`. It is applied in `store.getTraySnapshot` after both quotas are built, so everything that reads the snapshot sees the same result: cards, verdict, notifications, tray, flyout and the daily planner. It never writes a row, and never reads plan usage (see the refresh rule in `electron/refresh-policy.cjs`).

**Which window counts as the pool.** The first active Claude window that meets all three conditions:
- `isMainWindow` is true;
- `windowMinutes === 10080`;
- it has not expired.

It is the `seven_day` overall window. The five-hour session is left out. It is also shared across all models, but it is a short-term limit that the Claude card already shows.

**Which windows it applies to.** Every active Fable window with `windowMinutes === 10080` whose bucket is `fable_seven_day` or `fable:*`. It covers official, manual and projected readings alike: whenever a Fable weekly window exists, Anthropic's rule places it inside the pool. The function does nothing when:
- there is no live pool window, or its forecast is unknown or expired;
- the Fable window has expired or its forecast is unknown.

In both cases the Fable forecast stays Fable-only, and `sharedPool` is `{ status: 'unavailable', reason }`, so the page can say why.

**Figures now.** Each side uses the dashboard's displayed rule: `estimatedCurrentRemaining` when `currentIsEstimated`, otherwise `remainingPercent`. For each window:
- `capRemaining` and `poolRemaining`;
- `poolAsFable = poolRemaining / s`, clamped to [0, 200];
- `usableRemaining = min(capRemaining, poolAsFable)`;
- `binding = poolAsFable < capRemaining ? 'pool' : 'cap'`.

**Combined forecast.** The Fable forecast's expected and heavy series are replaced by a pointwise combination: `min(Fable series(t), pool series(t) / s)`.
- The pool value is linearly interpolated from the pool's own series, which starts at the same `now` and steps on the same local-hour boundaries.
- After the pool's reset, the pool no longer constrains Fable: the pool refills and its ceiling rises above 100.
- `projected` values are combined the same way, so `exhaustionTime` places the run-out inside the hour.

From the combined series:
- `expectedRemaining` and `heavyRemaining` are the last points;
- `exhaustsAt` and `heavyExhaustsAt` come from `exhaustionTime`;
- `bindingAtReset` is `'pool'` when the pool caps Fable anywhere on the expected path (see "Changes from the design review");
- `state` comes from `forecastState` (now exported from `forecast.cjs`), using the settings' thresholds and reserve.

**Pace fields.** When the pool binds at reset:
- `safePace`, `recentPace` and `workingPace` become the pool's figures divided by `s`;
- `paceRatio = max(Fable paceRatio, pool paceRatio)`.

In words: the Fable balance shrinks at the pool's pace, and a faster Fable pace still counts. Otherwise Fable's own pace fields are kept. The original Fable-only figures remain under `sharedPool.cap`.

**Token capacity.** When the pool binds now:
- `remainingTokens` and `remainingRange` are scaled by `usableRemaining / capRemaining`;
- one warning is added, saying that the shared weekly pool limits the figure.

**Shape added to the Fable window** (optional field `sharedPool` on `QuotaWindow`):

```ts
type SharedPool =
  | { status: 'unavailable'; reason: 'no-weekly-pool' | 'pool-expired' | 'pool-unknown' | 'share-inconsistent' }
  | {
      status: 'applied';
      share: number;                         // 0.5
      capRemaining: number;                  // Fable limit, displayed rule
      poolRemaining: number;                 // Claude weekly, displayed rule
      poolAsFable: number;                   // poolRemaining / share, 0-200
      usableRemaining: number;               // 0-100
      binding: 'cap' | 'pool';
      bindingAtReset: 'cap' | 'pool' | null; // 'pool' if Claude weekly caps Fable anywhere on the expected path
      estimated: boolean;                    // either figure estimated, or readings >15 min apart
      paceSource: 'cap' | 'pool';
      cap: { ...Fable's own forecast figures and series, everything the cap may replace };
      tokenFactor: number;                   // how remaining tokens were scaled, 1 when not
      pool: { bucketName; observedAt; resetsAt; provenance; state; expectedRemaining; heavyRemaining; exhaustsAt };
      ceiling: { observed: Point[]; expected: Point[] };  // pool / share, for the runway line
    };
```

**Renderer.**
- `lib.displayedRemaining` returns `usableRemaining` when `sharedPool.status === 'applied'`. `isEstimated` follows `sharedPool.estimated`. The card's "Left now", the planner budget, the runway's now dot and the tape all therefore agree with the combined forecast.
- The electron copy in `notifications.cjs` follows the same rule.
- The Fable card gets a pool row.
  - When the pool binds: "Limited by the shared weekly pool", with "Fable limit 100% left · Claude weekly 30% left".
  - Otherwise the row states how much of the Fable limit is within the pool.
- The runway chart draws `ceiling` as a dashed Claude-violet line labelled "Shared weekly pool". The plot's clip hides it while it sits above 100.
- The Fable detail page gets a "Shared weekly pool" section. It shows:
  - the Fable limit, the Claude weekly figure and usable Fable, now and at reset;
  - which side binds;
  - the Anthropic rule in one sentence;
  - what happens at the Fable limit, using `extraUsage.isEnabled` from the last Refresh, labelled as such.
- When the pool binds, the Overview attention wording says the shared pool is the cause.

## 2. Pricing

- Add two `PRICE_ROWS` entries:
  - `['claude-fable-5-1', 10, 12.5, 20, 0.25, 50]`, effective 2026-09-01;
  - `['claude-opus-5-5', 4, 5, 8, 0.2, 20]`, effective 2026-09-22.
- The seed inserts missing rows on every start, and the price revision reprices history.
- Restrict `VERSION_SUFFIX` to date suffixes. The next point release then shows as unpriced instead of silently taking its predecessor's price. Only `claude-fable-5-1` and `claude-opus-5-5` relied on the looser pattern.

## 3. Allowance pressure v2 (`fable-projection.cjs`)

- `ALLOWANCE_PRESSURE_V2` adds `claude-fable-5-1` (cache read 0.25) and `claude-opus-5-5`, and the profile label becomes `allowance-pressure-v2`.
- The weights stay API-proportional, as V1 was. That is the model's documented basis, and Anthropic says cached tokens count less against limits. The weights remain a heuristic, used only when no provider Fable reading exists.
- The family-prefix fallback stays for attribution, unlike pricing.

## 4. Provider conflict robustness (`fable-tracker.cjs`)

Today, two Fable `model_scoped` entries with different figures make the whole payload invalid, and the overall windows are then lost too. Instead, the overall windows are kept, and Fable is reported `unavailable` with reason `fable-window-conflict`.

## 5. Labels

- "Fable 5" becomes "Fable" everywhere (source name, verdict label, cards, settings, tray), and "Fable 5 weekly" becomes "Fable weekly".
- A one-time migration renames `sources.name` and the stored `bucket_name`. Old names arriving from restored backups are normalised when read.
- Source-status metadata replaces `modelId: 'claude-fable-5'` with the models actually seen.

## 6. Fable 5 vs 5.1

- Local Fable activity is grouped by model, so the "This device" note and the detail page show requests, tokens and API-equivalent cost per version.
- No percentage split is shown: there is only one provider window.
- Costs by model already lists both, and is correct once the price rows exist.

## Out of scope

- Opus 5.5 fast mode. It needs a speed field on stored events.
- The status line's `spend_limit`.
- The US-only inference multiplier.
- Status-line Fable keys, which do not exist.

## Changes from the design review

Three reviewers took the design apart before implementation: one on the maths and forecast semantics, one on every consumer of a Fable figure, one on wording and honesty. These are the changes that landed.

**Maths and forecasts**
- **Reset jitter.** Claude reports the same weekly reset up to a second apart between readings; in the real database the `seven_day` reset moves between 07:59:59.5 and 08:00:00.4 while Fable's stays at 08:00:00.000. Resets within 60 s count as one reset, so the pool never appears to refill at Fable's own reset.
- **`bindingAtReset` reads the whole path.** It is `'pool'` if the Claude weekly limit caps Fable anywhere on the expected path before the reset, not only at the last point. A run-out on the way is critical even if an early pool reset refills it later.
- **Coupling.** Along each combined series the pool may not fall more slowly than Fable's own projected use: every Fable point spends half a point of the week.
- **When the pool binds:**
  - state is the worse of the combined state and the pool's state;
  - the reserve is the pool's, in Fable points;
  - pace fields come from whichever pace ratio is higher, recorded as `paceSource`;
  - confidence is the lower of the two.
- **Observed history is combined too**, holding each side's latest reading. Fable's own readings stay under `sharedPool.cap.observed`.
- **`estimated`** is true when either side is estimated or the two readings are more than 15 minutes apart.
- **Consistency check.** A Fable reading above twice the weekly use taken at the same moment (plus 2 points of rounding) means the half-share rule does not describe the account. The window is then `unavailable` with reason `share-inconsistent`, and no cap is applied.
- **Buckets.** Only `fable_seven_day` and `fable:seven_day_fable` are capped, the same two buckets `quota-selection` and `allowance-changes` recognise.
- **Rounding.** `poolAsFable` is built from the rounded Claude figure, so 30% of Claude always reads as 60% of Fable.

**One event, one alert**
- A Fable window whose worse state comes from the pool folds into the Claude weekly verdict entry: "Claude will reach its limit before reset, Fable included".
- Notifications, the attention list and the flyout follow the same fold. The fold uses `poolDrivenBucket` and `foldsInto` in `dashboard-decision.mjs`, shared with the renderer.

**Wording and display**
- "Usable now" and "usable" appear only when the Claude weekly limit is the tighter one; otherwise the figure is the provider's and reads "left".
- The UI never says "pool". It uses "Claude weekly", "Fable limit" and "usable Fable".
- The ceiling is not drawn as a violet Claude series, because its values are twice Claude's percentage. It is neutral chart furniture: a thin line with the unusable area above it hatched, labelled "Claude weekly cap".
- The Fable page's "Related allowance" panel became **Claude weekly limit**:
  - a now / at-reset table and which limit binds;
  - Anthropic's 2-for-1 rule;
  - what happens at the binding limit, using the extra-usage setting and time of the last Refresh;
  - the Claude row;
  - this device's Fable 5.1 and Fable 5 activity.
- The card row, planner and budget strip say when Claude weekly sets Fable's budget.

**Consumers**
- `snapshot-time.ts` releases a cap whose Claude window has reset.
- The flyout payload drops the ceiling series.
- A stale Claude reading that binds Fable marks Fable stale as well.
- The demo keeps Claude's heavier week at least as heavy as Fable's share of it, and `?demo=shared-pool` shows the capped case in both the dashboard and the flyout previews.

## Post-implementation review

A four-lens review of the finished branch put each finding to a skeptic. Seventeen findings were confirmed and fixed; each fix has a test.

- **Heavier week.**
  - `heavyBindsAtReset` records when Claude weekly caps only Fable's heavier path. The verdict fold (`poolDrivenBucket`) reads it, so that case is still one alert on Claude.
  - A heavier-path run-out on the way is at least a risk, even when an early Claude reset refills the week.
- **`cappedAtReset`.** Names the limit that sets the figure at Fable's own reset. The cycle row says "capped by Claude weekly" only then. The Claude row in the panel shows its own reset when that reset differs.
- **Token capacity.** When Claude weekly binds, remaining tokens are that reading's share of the estimated week, dated to the reading. The original estimate is kept in `sharedPool.cap.tokenCapacity` and restored as-is when the cap is released, including when it had reached zero.
- **Share check.**
  - A Fable reading is checked only against a Claude reading from the same moment or later.
  - A projected Fable figure is never checked, because it is built on the half share.
- **Rounding.** The forecast ceiling carries the same rounding offset as the figure now, so the path starts at the card's usable figure. Readings are still drawn as read, and projected overshoot is not clamped, so run-out times stay exact.
- **One reserve.** `forecastReserve` (src/budget.ts) gives the planner, the runway reserve line and the Settings preview the backend's rule: a reserve of the week is twice that of Fable while the week sets Fable's budget.
- **Staleness.** `stalePoolWindow` puts a capped Fable in the verdict's "needs current data" list, and keeps it out of "on track", when its Claude weekly reading needs a Refresh.
- **Extra usage.**
  - The dashboard snapshot carries `claudeExtraUsage`: the setting from the newest plan-usage read of either Claude source.
  - The Fable page and the card's "limit reached" line both read it. The card says Fable continues on extra usage when it was on.
- **One activity total.** The "This device" note uses the same per-version totals as the table.
- **Rename.** A Fable risk episode saved before the rename keeps its signature, so it is not announced again.

## Third review (Astra)

Astra reproduced three issues. Each is fixed, and each has a test.

- **Rounding survived an empty week.** The rounding adjustment was added after the Claude projection had been clipped at zero, so Fable kept a fraction of a point after the week ran out: no run-out, and a budget that "fit".
  - The Claude projection is now read unclipped.
  - The rounding is a scale, not a shift. The card still shows usable Fable as twice the whole Claude percentage, an empty week stays empty, and Fable runs out at the same instant as Claude.
- **Run-outs between crossing lines.** The combined path now includes the instants where Fable's own path, the Claude cap and the coupling bound cross. A run-out is therefore always interpolated along a single limit.
- **Staleness ignored the heavier week.** `dependsOnClaudeWeekly` (dashboard-decision.mjs) counts the heavier-week dependency, and both the verdict and the card use it through `stalePoolWindow`.
- **Crossing points took clipped values (found after the third review).** The crossing instants were placed on the unclipped lines, but their values were read from Fable's clipped series. Inside the hour Fable's own projection passes zero, that overstated the balance and pushed Fable's run-out later than its own limit allows (13:36 instead of 13:30). Every combined point is now the lower of the unclipped lines, clipped only at the end, so the combined path never sits above either limit.
  - A regression test covers Astra's case.
  - A sweep of 576 straight, curved and knee-shaped paths checks that every combined point stays at or below both limits, and that the combined run-out is never later than either limit's own. The sweep catches the old bug independently.
