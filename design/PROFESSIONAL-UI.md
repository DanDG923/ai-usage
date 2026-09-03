# Professional UI direction

Reference: `professional-overview-concept.png`

## Product grammar

Every destination follows the same order: status, trajectory, action, evidence.
Overview answers whether an allowance is likely to run out before reset. Activity
shows the observations behind that answer. Costs explains API-equivalent value.
Settings contains infrequently changed preferences and progressively discloses
technical controls.

## Shell

- 128 px desktop navigation rail, collapsing to 72 px below 900 px.
- 56 px integrated command/title bar with freshness and refresh.
- Destinations: Overview, Activity, Costs, Settings.
- 24 px page gutter, 1,520 px maximum content width.
- Layout reflows with the viewport; content is not scaled with CSS zoom.

## Tokens

- Segoe UI Variable with tabular numerals for changing values.
- 4 px spacing foundation: 4, 8, 12, 16, 24, 32, 40.
- 6 px content radius; no default card shadow.
- Neutral canvas and two surface levels.
- Codex blue, Claude green, and Fable coral are stable data-series colours.
- Green, amber, and red semantic colours are reserved for status.
- Expected usage uses a soft provider-colour gradient. Additional heavy usage
  continues in a deeper gradient from the same provider family.

## Core components

- App rail and command bar
- Status narrative
- Provider summary
- Scenario allowance bar
- Small-multiple runway chart
- Insight list
- Evidence table
- Setting row and disclosure section

## Accessibility

- Status always includes text, never colour alone.
- Scenario bars expose complete expected/heavy values through accessible text.
- Forecast line styles distinguish observed, expected, and heavy scenarios.
- Tabs support arrow keys and numeric shortcuts.
- Focus remains visible, motion honours reduced-motion, and layouts remain usable
  at the 720 px application minimum width.
