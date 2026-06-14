# Changelog

Notable changes to eigenheim. Pre-release `0.x`. Releases are **batched**: fixes accumulate
under **Unreleased** and ship as a version when a batch is ready, or immediately for a critical
fix. The git tag is the release trigger (in-app auto-update reads the published release).

## Unreleased

_Nothing yet._

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
