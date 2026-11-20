# Accessible data visualizations (#206)

Target: WCAG 2.1 Level AA. Code:
`frontend/src/app/shared/components/accessible-chart/`.

## Pattern

Every chart is an `<app-accessible-chart>`, which renders from one `data`
input:

- **Equivalent data table.** A "Show data table" button (`aria-expanded`,
  `aria-controls`) reveals a table built from the same `data` array as the
  bars, so the text alternative cannot drift from the picture (WCAG 1.1.1,
  1.3.1).
- **Summary.** The figure is described by a text summary: count, highest,
  lowest and total.
- **Keyboard.** The bars are one roving-tabindex composite (WAI-ARIA APG,
  "Developing a Keyboard Interface"): one Tab stop. Key bindings follow the APG
  Toolbar pattern — Arrow keys move to the previous/next point, Home and End to
  the first/last, Tab leaves the chart (WCAG 2.1.1, 2.1.2). Focus is visible
  (2.4.7).
- **Announcements.** Each bar's accessible name gives its value (with units
  spelled out, e.g. "tonnes of CO₂ equivalent"), its position ("2 of 5"), the
  change from the previous point ("up 50% from Mangrove"), and whether it is
  the highest or lowest — a trend, not coordinates. The name is read when the
  bar receives focus, so no separate live region repeats it.
- **Contrast.** Bars are `#2563eb` on white (5.17:1, WCAG 1.4.11 needs 3:1);
  text meets 4.5:1 (1.4.3).

Charts are added with the component, never by drawing directly, so there is a
single implementation to keep accessible.

## Automated checks (CI)

`axe-core` runs over the rendered chart component and the whole dashboard with
the `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa` rule tags
(`frontend/src/app/shared/testing/axe.ts`). The specs
`accessible-chart.component.spec.ts` and `dashboard.a11y.spec.ts` run in the
existing CI step `npm run test -- --watch=false --browsers=ChromeHeadless`, so
a violation fails the build. They check both the table-hidden and
table-shown states.

The first dashboard run found contrast failures in existing elements (status
badges 2.27:1, section links 3.27:1, empty-state text 4.31:1); their colours
were changed to meet 4.5:1.

## Manual screen-reader walkthrough

Automated tools catch only part of WCAG. Run this walkthrough on the dashboard
with at least one of **NVDA + Firefox or Chrome (Windows)** or **VoiceOver +
Safari (macOS)** before each release that changes a chart, and record the
result below.

| # | Step | Expected announcement / behaviour |
| --- | --- | --- |
| 1 | Open the dashboard and move by headings (NVDA `H`, VoiceOver `VO+Cmd+H`) | Headings "Dashboard", "Overview", "My Portfolio", "Recent Bonds", "Recent Projects" in order |
| 2 | Move to the chart with Tab | "Estimated carbon sequestration by project" figure, followed by its summary; focus lands on the first bar |
| 3 | Listen to the first bar | "<project>: <value> tonnes of CO₂ equivalent. 1 of N." |
| 4 | Press Right Arrow | Next bar with "up/down X% from <previous project>" and, where true, "highest/lowest in series" |
| 5 | Press End, then Home | Focus jumps to the last, then the first bar |
| 6 | Press Tab | Focus leaves the chart for "Show data table" — no trap |
| 7 | Activate "Show data table" | Button reports expanded; the table caption, headers "Project" / "Value (tCO₂e)" and each row are read with header context |
| 8 | Compare table values with the bar announcements | Identical values for every project |
| 9 | Zoom to 200% and repeat steps 2–7 | Everything reachable and readable without horizontal scrolling of the page |

### Results log

| Date | Screen reader + browser | Tester | Result | Notes |
| --- | --- | --- | --- | --- |
| — | — | — | Not yet run | Must be completed by a person with the screen reader; it cannot be performed by automated tooling. |
