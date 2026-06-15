# Changelog

Notable changes to eigenheim. Pre-release `0.x`. Releases are **batched**: fixes accumulate
under **Unreleased** and ship as a version when a batch is ready, or immediately for a critical
fix. The git tag is the release trigger (in-app auto-update reads the published release).

## Unreleased

_Nothing yet._

## v0.1.6 — 2026-06-15

- Engine startup is resilient and diagnosable: a failure in a best-effort step (backup,
  migrations, catalog refresh, audit, scheduler) is logged and the engine still serves
  instead of silently dying behind a sidecar timeout; only the schema-critical path is
  fatal. The Electron host now captures the engine's output to `engine.log` (session
  token redacted) and surfaces the real failure via "Copy diagnostics"; the startup wait
  is more patient (30s + 20 renderer retries) for a cold packaged launch.
- Fixed Key Result creation returning 500: the create route returned the raw row but
  its response model requires the computed fields (status/progress/…); it now returns
  the same computed shape as the list/detail routes.
- Removed the standalone `⌘K` chip from every page (Tasks/Goals/Prioritization/
  Hypotheses/Decisions); the `⌘K` shortcut and the rail Chat `⌘K` label remain.
- Graph: the "Directory path" field now has a native **Browse…** folder picker
  (Electron open-directory dialog); the text input still works in plain dev.
- Chat provider badge is honest about local models: it pings Ollama and shows
  `Local · not connected` when the endpoint is unreachable instead of always claiming
  `Local · <model>`.
- Chat is now the first item in the left rail (above Reports).
- Onboarding now really connects PostHog. The connect step was a façade: its Host /
  Project ID fields were unbound, "Test connection" only flipped a local flag, and the
  sync screen was a fake event counter — so a source "connected" in onboarding was never
  saved or synced (Settings showed nothing, Reports stayed empty). It now binds all
  fields, tests against the engine (`/datasources/posthog/test`), saves the source to the
  OS keychain on continue (same path as Settings), and the sync step runs a real
  `/datasources/posthog/sync` then refreshes reports + catalog. Sync failures show an
  error with Retry / Continue instead of fake progress.
- Reports: **add a metric** to an existing report — an "Add metric" button on the report
  page opens the logic picker and appends the chosen formulas (`PATCH /reports/{id}`).
  `report_detail` now returns `logic_ids` so the picker never double-adds.
- The `⌘K` affordance moved from the report header to the left-rail **Chat** item (with a
  tooltip); the report top bar is no longer cluttered by it.
- Security: fixed a chat egress gap — "Set as default" on the cloud (OpenRouter) provider
  card now shows the data-egress disclosure before activating, and the send path refuses a
  cloud call until the per-session egress confirmation is given. The chat model logic is
  factored into a shared engine (`useChatEngine`) so the overlay and the upcoming chat page
  share one egress/trace path.
- The left-rail **Chat** now opens a full chat **page** (the `⌘K` overlay stays for quick
  ask). The page is a three-column layout: a conversation history sidebar (New chat +
  Today/Yesterday/Earlier), the thread with verified/inferred metric chips + trace links and
  the always-on boundary footer, and a composer with prompt suggestions. Conversations are
  **persisted locally** (engine SQLite — transcripts never leave the machine, never in any
  export). Page and overlay share one chat engine + one egress/trace path. The right data
  panel is hidden on the chat page. (Mic, file-attach, and the context-window meter from the
  generic mock are intentionally omitted — eigenheim's chat is a reader over the data layer.)

## v0.1.5 — 2026-06-15

- First-run onboarding now auto-shows once: on a fresh launch with no data source
  configured and onboarding not yet seen, the welcome → connect → sync → coach → MCP-key
  flow opens. Every step is skippable; after finish or skip it is marked seen
  (`localStorage`) and never auto-shows again. Settings → About gains a "Run setup again"
  entry to reopen it on demand.
- Reports can be renamed, duplicated, and deleted from a card menu (`PATCH` / `POST
  …/duplicate` / `DELETE` on the engine, with cascade to snapshots; deleting a seeded
  default does not reappear on the next launch). The menu portals to the body and clamps
  to the viewport so it is never clipped at a screen edge.
- Fixed a CORS regression: the engine allowed only `GET/POST/DELETE`, so every `PATCH`
  preflight was rejected (400) and silently broke report rename plus the objective / key
  result / decision / RICE / hypothesis-status updates. The sidecar now allows all methods
  (the origin allowlist is the real boundary); added a preflight regression test.

## v0.1.4 — 2026-06-15

English-first, all the way down. The English-first UI decision had only reached the
renderer nav; the **engine** still emitted Russian strings that surfaced in the
production UI (report names, the event/metric catalog, sync labels, DSL-validation
errors, Jira/Linear connect errors, data-source/health messages). Now the whole
user-facing surface is English.

- Engine catalog + reports API in English: default reports `Activation` / `Growth`,
  period labels `30d` / `7d`, the seeded event + metric/logic descriptions, and the
  sample sync labels (`event catalog` / `every 6h`, …).
- An **unbuilt** report is now `collecting`, never `mock` — the engine no longer emits
  the demo-only `mock` status anywhere. The report card shows `not built yet` instead
  of a Russian "built" line when there is no snapshot.
- DSL formula-validation errors, Jira/Linear connect errors, PostHog adapter errors,
  the data-quality/health message, and the weekly-table column label (`Week N`) are
  English.
- Regenerated the typed API client from the English OpenAPI schema (no stale Russian
  `@default` annotations). Russian code comments are intentionally kept.

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
