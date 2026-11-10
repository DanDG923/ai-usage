# Using the dashboard

This page is for anyone using AI Usage day to day. It explains how to read the Overview and the provider pages, what is in Settings, the notifications, the tray flyout, keyboard shortcuts, memory use, and the optional Claude Code mod that shows the same figures inside Claude Code.

## Reading the dashboard

### Colour

Colour means a provider (Codex blue, Claude violet, Fable magenta) or a status (green on track, amber watch or at risk, red critical), never both, and every status also carries an icon and a word. Buttons, links and focus rings are monochrome, so no control looks like Codex data. Both the dark and light themes use colour sets checked for colour-blind separation and contrast.

### The Overview

The status line at the top of the Overview gives the overall verdict. How it is built is described in [The verdict](forecasting.md#the-verdict).

Each provider card draws its own **runway** from the window's start to its own reset:

- the solid line is the observed balance;
- the dashed line the expected path;
- the shaded band the range a heavier week could take; and
- the grey bands the hours outside your active schedule, which is why projections flatten overnight.

Each card also states the outcome at reset in words and shows a [daily budget](forecasting.md#daily-budget-and-budget-mode).

Resets you can claim sit on their provider's card: Codex's banked reset credits as Codex reports them, and Claude's free resets, which Claude offers only in its own Usage settings and no API reports. Record those under **Settings → Subscriptions → Claude free resets**, with the expiry date Claude shows; the card hides them after that date. Neither is counted as allowance or assumed spent.

The command bar says whether every source is current and how long ago the sources last collected successfully.

### Provider pages

A card's details link opens the **provider page**: a full-size runway with hover and a data table, the daily-budget planner, past weeks, [token capacity](forecasting.md#estimated-weekly-token-capacity) and the evidence behind the reading.

## Settings

**Settings** is one page with a section list beside it: Subscriptions (including monthly fees), Sources, Forecast, Alerts, API pricing, Data & backups, Appearance & updates, and an Advanced group for manual observations and diagnostics.

The list follows your scroll, shows how many sources are connected or need attention and how many recorded models are unpriced, and **Search settings** filters the page to matching sections and opens any collapsed group that holds a match. **Keep in reserve** previews each provider's resulting daily budget as you type.

## Notifications

Desktop notifications come from the tray process after a collection, so they are only as current as the collection interval. Automatic collections do not read Claude plan usage, so Claude's figures are as current as your last **Refresh** or the status-line helper.

Four kinds can be enabled independently under **Alerts**:

- pace risk (one per episode, with the earliest run-out time);
- a window reset;
- a collector falling back to cached readings (a Claude reading that has simply aged since your last **Refresh** is not a fallback and raises no alert; a **Refresh** that fails to read plan usage is); and
- a daily digest at a chosen hour.

**Snooze** pauses all of them for one, six, or twenty-four hours from the settings screen or the tray menu.

## The tray

Closing the window keeps the tray app running. Use **Quit** from the tray menu to exit fully.

**Left-click the tray icon** for a flyout with the overall verdict, each allowance's balance and what is expected to remain at reset, refresh, **Snooze 1 h** (or **Resume alerts**) and **Open dashboard**. Selecting an allowance opens its provider page; the settings button opens Settings. The flyout opens beside the icon wherever the taskbar sits and closes when it loses focus or on **Escape**. Right-click still opens the tray menu, and double-click opens the dashboard.

## Keyboard shortcuts

**1** to **4** switch sections, **R** refreshes, and **Escape** leaves a provider page.

## Memory use

After 30 seconds closed to the tray, the dashboard releases its window and detailed analytics caches. Reopening restores the selected page, analysis period, search and window bounds, with a brief reload.

- Settings, open dialogs, import previews and in-progress work keep the window loaded to protect unfinished edits.
- Minimising keeps the dashboard loaded.
- Starting with Windows in tray mode waits to create the dashboard until you open it.
- The tray flyout is created on its first click, reads only the lightweight tray summary, and releases its renderer 60 seconds after it closes.
- Collection and alerts continue on their configured schedule; idle collectors close their database connection and release their process after 30 seconds, then restart on demand.
- The storage worker for backups, restores and exports does the same once no desktop-import preview is open, and a collection starts it only when a scheduled backup is due.

**Lower memory use** in **Settings → Appearance & updates** (on by default) draws the dashboard with the processor instead of the graphics card. Chromium's GPU process otherwise keeps roughly 200 MB of private memory after the dashboard has been drawn once, even while the window is released to the tray; software rendering keeps it near 30 MB. Scrolling is marginally less smooth.

The choice is read before the app starts, so changing it shows a **Restart AI Usage** button. Setting `AI_USAGE_DISABLE_GPU=1` in the environment forces software rendering regardless of the setting; Settings then says so instead of offering a restart.

## Inside Claude Code

AI Usage can show your allowances inside Claude Code itself, in the terminal and in the Code tab of the Claude desktop app, through a Claude Code *mod* (a plugin that draws in Claude Code's interface).

Install it from **Settings → Sources → Claude Code mod**; it needs Claude Code 2.1.287 or later. The app copies the mod into its own folder and runs your own `claude plugin marketplace add` and `claude plugin install`, so it appears in Claude Code's `/plugin` list like any plugin and can be turned off there. **Remove mod** runs the matching uninstall. App updates refresh the mod in place; Claude Code picks the new version up at its next session.

- **`/ai-usage`** opens a pane beside the conversation with the tray flyout's figures: the verdict, each subscription's balance with a fuel tape (solid is expected to be left at the reset, shaded is likely used before it), the forecast at reset and shorter windows such as the five-hour session. `s` collects now, `o` opens the dashboard and `c` turns the caution line on or off. `/ai-usage text` prints the same as text, as it does wherever Claude Code draws nothing (the VS Code extension and `claude -p`); only that text enters the conversation.
- **The caution line** appears above the prompt only while an allowance is on watch, at risk or critical and alerts are not snoozed. It says nothing while everything is on track or while AI Usage is not running.
- **Plan limits from Claude Code.** After each response, Claude Code already holds the plan limits that response reported (the figures its status line shows). The mod leaves them for the app, dated by the request that fetched them, and while automatic collection is on the app imports the first within seconds and those that follow at most every two minutes. Claude then stays current between Refreshes without the app ever reading plan usage itself. An unchanged reading is left at most every ten minutes, and none are left once the app has not run for a week.

### What the mod can reach

The mod calls no model, makes no network request and adds nothing to what Claude reads, so it uses no API and none of your allowance. It reads `glance.json` and writes small reading and request files in the app's `claude-code` folder (under `%APPDATA%\ai-usage`), and nothing else.

**Sync now** in the mod is a local collection: like every automatic one it never reads plan usage, which still happens only when you press **Refresh** in the app. A request is acted on only while it is fresh, so one left while the app was closed does nothing at the next launch.

Mods are early in Claude Code, and their interface may change between Claude Code releases; the mod was built and tested against 2.1.287. How to test the mod during development is in [Development](development.md#the-claude-code-mod).
