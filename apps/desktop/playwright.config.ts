/**
 * Playwright configuration for eigenheim e2e smoke tests.
 *
 * Test strategy (from eigenheim-plan/14-testing-strategy.md):
 *   - macOS + Linux runners in CI: Electron-mode smoke over the core loop.
 *   - Windows nightly: dropped (solo maintainer, per council decision 2026-06-13).
 *
 * The smoke suite spins up the Python engine against a fixture DB, then drives
 * the Electron renderer (or, on headless CI, the compiled dist served as a web app).
 *
 * CI: see .github/workflows/ci.yml — the e2e job passes --project=chromium
 * because Electron's Chromium IS chromium under the hood; full Electron launch
 * is done via the custom fixture in e2e/fixtures.ts.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,          // engine process is shared; serial is safer
  forbidOnly: !!process.env.CI,  // fail fast on .only left in code
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  workers: 1,

  use: {
    // Base URL for non-Electron tests (REST smoke against the running engine).
    baseURL: "http://127.0.0.1:8765",
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "engine-api",
      // API-level smoke: no browser, just REST calls to the engine.
      // Works on any OS/CI without a display server.
      testMatch: "**/*.api.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:8765" },
    },
    {
      name: "electron",
      // Full Electron UI smoke. Requires a display (macOS native, or Xvfb on Linux).
      testMatch: "**/*.electron.spec.ts",
      use: {
        // Electron uses its own launch mechanism in e2e/fixtures.ts.
        // We keep the `use` block minimal here and override inside fixtures.
      },
    },
  ],

  // Global setup: start the engine sidecar against the fixture DB.
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
});
