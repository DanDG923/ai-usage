# Professional UI direction

Reference: `professional-overview-concept.png` (layout); the graphite colour
system and the per-provider runway below supersede its colours and combined chart.

## Product grammar

Every destination follows the same order: status, trajectory, action, evidence.
Overview answers whether an allowance is likely to run out before reset and what
daily pace keeps it safe. A provider page holds everything about one allowance:
its runway, a daily-budget planner, past windows, token capacity and evidence.
Activity shows the observations behind the forecasts. Costs explains
API-equivalent value. Settings contains infrequently changed preferences and
progressively discloses technical controls. The tray flyout answers the same
question as the Overview at a glance.

Say each thing once. The status line states the overall verdict and its daily
guidance; each card states its own provider; the list beneath holds only what
neither of those already says.

## Shell

- 128 px desktop navigation rail, collapsing to 72 px below 980 px.
- 56 px integrated command bar: the section title (or a breadcrumb on a provider
  page), source health in words, relative freshness, and refresh. Pages do not
  repeat the command-bar title as a visible heading.
- Destinations: Overview (with provider pages), Activity, Costs, Settings.
- 24 px page gutter, 1,520 px maximum content width.
- Layout reflows with the viewport; content is not scaled with CSS zoom.

## Colour

A colour means a provider or a status, never both. Everything else is monochrome.

- Neutrals are graphite, not blue-slate, so provider hues read true.
- Chrome (primary buttons, toggles, selected states, focus rings, magnitude
  ramps such as the heatmap) uses `--accent`: ivory in dark, ink in light. No
  control can be mistaken for Codex data.
- Providers: Codex blue, Claude violet, Fable magenta, as swatches, chart lines
  and fills only. Text never wears a provider colour.
- Status: green on track, amber watch/at risk, red critical. Status always
  carries an icon and a word.
- Both themes are validated sets, not a flip. The provider trio passes the
  dataviz checks with all pairs in play (normal-vision ΔE ≥ 15, colour-blind
  ΔE ≥ 8, ≥ 3:1 against the card surface) and sits ≥ 17 ΔE from every status
  colour. Before this change Fable coral was ΔE 3.6 from "at risk" red and
  Claude green ΔE 3.8 from "on track" green.

| Token | Dark | Light |
| --- | --- | --- |
| `--bg` / `--surface` | `#0f1012` / `#17181b` | `#f5f5f2` / `#ffffff` |
| `--text` / `--text-muted` | `#f3f2ee` / `#9d9c96` | `#18181a` / `#5c5c57` |
| `--accent` | `#f3f2ee` | `#1b1c1f` |
| `--codex` / `--claude` / `--fable` | `#0871c1` / `#9584e5` / `#ad3d9a` | `#0065b4` / `#9584e5` / `#8d1e72` |
| `--ok` / `--warn` / `--bad` | `#5cc98f` / `#eab04c` / `#f07a6a` | `#17804f` / `#9a6200` / `#c13d2b` |

## Tokens

- Segoe UI Variable with tabular numerals for changing values.
- 4 px spacing foundation: 4, 8, 12, 16, 24, 32, 40.
- 6 px content radius; no default card shadow.
- Chart axes use round steps (1, 2, 2.5 or 5 × 10ⁿ) that cover the peak.

## Core components

- App rail and command bar (breadcrumb, source health, relative freshness)
- Status line: icon, verdict, daily guidance, and a "Plan … usage" action
- Provider card: state pill, balance and reset, compact runway, expected and
  heavier outcomes, daily-budget strip, session and model windows, details link
- Runway chart: one provider on its own clock from window start to reset —
  observed line, dashed expected path, shaded heavier-week range, hours outside
  the active schedule shaded, run-out marker, optional reserve line; the
  full-size version adds hover and a data table
- Daily-budget strip: the per-active-day budget with expected and heavier paces
  marked against it; every figure comes from the same endpoints as the chart,
  so a pace fits exactly when its path keeps the reserve
- Planner: reserve slider that re-plans live and can save the reserve
- State pill: icon + word on a light tint
- Evidence table, setting row, section navigation and disclosure section

## Accessibility

- Status always includes text, never colour alone.
- Charts expose a complete sentence as their accessible name; full-size charts
  add a data table. Budget strips describe budget and both paces in words.
- Forecast line styles distinguish observed (solid), expected (dashed) and the
  heavier range (dotted edge and band).
- Tabs support arrow keys and numeric shortcuts; Escape leaves a provider page.
- Focus remains visible, motion honours reduced-motion, forced-colours mode keeps
  borders and chart colours, and layouts remain usable at the 720 px application
  minimum width.
