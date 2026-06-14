# Changelog

Notable changes to eigenheim. Pre-release `0.x`. Releases are **batched**: fixes accumulate
under **Unreleased** and ship as a version when a batch is ready, or immediately for a critical
fix. The git tag is the release trigger (in-app auto-update reads the published release).

## Unreleased

_Nothing yet._

## v0.1.3 — 2026-06-15

- Harden `report_detail` + metric computation against a tile referencing a deleted/missing
  logic id. Every compute path already skips it (no 500); added regression tests, a
  defense-in-depth guard in `compute_value` (clear error vs a cryptic `NoneType` crash), and
  a test asserting the seeded default reports reference no missing logic.
- Tooltips render in a portal on `document.body` (never clipped by an ancestor's
  `overflow:hidden`, always above modals/drawers) and are clamped to the viewport: they
  shift horizontally to stay on-screen and flip below the trigger when there's no room above,
  with long labels wrapping instead of overflowing. Fixes the clipped "Run sync" / "Pause"
  tooltips near panel edges.
- Shell layout: the left-rail collapse arrow moved into the header (right of the logo); the
  right-panel collapse arrow moved to the left of the data tabs; the Events/Logic/Syncs tabs
  are now icon-only (label in a tooltip + aria-label). Restored the **Chat** entry in the
  left rail (opens the AI chat). Fixed the logomark SVG (it was double-scaled, rendering
  shrunken/offset) so it fills its box at any size.
- Unlocked **Tasks** and **Graph** in the rail so they are reachable (they open their pages
  with a connect/build flow instead of a dead lock).
- Made the unlocked + panel surfaces real, no dead no-op controls: **Tasks** has a real
  Jira/Linear connect flow (`POST /trackers` + key in the OS keychain) with a clean
  no-tracker empty state and a wired reconnect; **Graph** shows a build flow + a clear
  "needs the graphify CLI" message instead of a blank/crash; the **Syncs** "Run" action
  triggers the real PostHog sync (and prompts to connect a source if none), "Pause" is
  honestly non-interactive (no schedule endpoint); the Events "create" affordance is an
  honest "from sync only" hint; the MCP/agent setup now shows the correct working stdio
  config (`eigenheim mcp serve` + `EIGENHEIM_MCP_KEY`) instead of a non-existent HTTP `/mcp`.
- Create reports: the "Create report" buttons now open a real drawer (name + period + a
  multi-select of Logic formulas) that calls `POST /reports` and opens the new report. The
  Logic-library "Use" button now opens the Logic editor prefilled from the template. Removed
  a report-card menu that had no backend.

## v0.1.2 — 2026-06-15

Production mode: the shipped app no longer contains dev tools or mock data.

- Removed the bottom **DemoBar** dev state switcher.
- The engine no longer seeds the 60k-event sample: a **fresh install starts empty** and shows
  data only from a connected source (PostHog). The deterministic sample now lives only in the
  test fixtures.
- Removed the frontend mock-data fallbacks (reports / events / logic / syncs) so a real user
  never sees ghost data; the sync drawer resolves from live data.
- Real engine state drives the UI: boot/failed screens reflect the actual sidecar health,
  `dataSourceConnected` defaults to false, and the EngineFailure "Restart" relaunches the app
  for a clean engine respawn.
- a11y: boot screen is a status region; the engine-failure card is an alert.

## v0.1.1 — 2026-06-14

- **In-app auto-update.** Windows/Linux update via electron-updater; macOS notifies and opens
  the new dmg (unsigned). Update feed (`latest*.yml`) is published with each release.
- App icon set to the eigenheim brand logo.
- macOS app is ad-hoc signed so it is not reported as "damaged" on Apple Silicon.
- Engine binds the first free port instead of a fixed 8765; the startup health probe
  authenticates.

## v0.1.0 — 2026-06-14

- First public release. Unsigned builds for macOS, Windows, and Linux; build-from-source
  documented in BUILD.md.
