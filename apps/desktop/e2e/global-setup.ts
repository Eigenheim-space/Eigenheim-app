/**
 * global-setup.ts — spin up the engine sidecar against a fixture DB before
 * any Playwright test runs.
 *
 * The engine is started with EIGENHEIM_TOKEN=test-token so tests can authenticate
 * without the Electron token-file handshake (which is unit-tested separately).
 *
 * No live API keys — tests run against the seeded fixture DB only, per the
 * "никаких живых ключей в CI" principle in 14-testing-strategy.md.
 */
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

// Resolve paths via process.cwd() (Playwright sets cwd to the project root,
// which for us is apps/desktop/ since that's where playwright.config.ts lives).
const DESKTOP_DIR = process.cwd(); // apps/desktop/
const ENGINE_DIR = path.resolve(DESKTOP_DIR, "../../engine");
const ENGINE_PORT = 8765;
export const TEST_TOKEN = "eigenheim-e2e-test-token";

// uv resolution: CI runners have it on PATH; on macOS it may be in /opt/homebrew/bin.
const UV_BIN = process.env.UV_BIN
  ?? (process.platform === "win32" ? "uv.exe" : "uv");

function buildEnv() {
  const extra: Record<string, string> = {};
  if (process.platform !== "win32") {
    // Extend PATH so uv can find Python + its shims when invoked from Node.
    extra.PATH = [
      process.env.PATH ?? "",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/home/runner/.local/bin",  // CI (setup-uv installs here)
    ].filter(Boolean).join(":");
  }
  return extra;
}

function ping(): Promise<boolean> {
  return new Promise((res) => {
    const req = http.get(
      {
        host: "127.0.0.1", port: ENGINE_PORT, path: "/health", timeout: 800,
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      },
      (r) => { r.resume(); res(r.statusCode === 200); }
    );
    req.on("error", () => res(false));
    req.on("timeout", () => { req.destroy(); res(false); });
  });
}

async function waitForHealth(timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Engine did not become healthy in time.");
}

export default async function globalSetup() {
  // If the engine is already running (dev convenience), check if it uses our token.
  if (await ping()) {
    console.log("[e2e setup] Reusing already-running engine (matched token).");
    return;
  }

  console.log("[e2e setup] Starting engine sidecar …");
  const tmpDir = path.resolve(tmpdir(), "eigenheim-e2e");
  mkdirSync(tmpDir, { recursive: true });

  const engineProc: ChildProcess = spawn(
    UV_BIN,
    [
      "run", "--project", ENGINE_DIR,
      "uvicorn", "eigenheim.app:app",
      "--host", "127.0.0.1",
      "--port", String(ENGINE_PORT),
      "--log-level", "warning",
    ],
    {
      cwd: ENGINE_DIR,
      stdio: "inherit",
      env: {
        ...process.env,
        ...buildEnv(),
        EIGENHEIM_TOKEN: TEST_TOKEN,
        EIGENHEIM_DB: path.resolve(tmpDir, "eigenheim.sqlite"),
      },
      shell: false,
    }
  );

  engineProc.on("error", (e) => {
    console.error("[e2e setup] Engine spawn error:", e.message);
  });

  // Store the PID for teardown.
  const pidFile = path.resolve(tmpdir(), "eigenheim-e2e-pid.txt");
  writeFileSync(pidFile, String(engineProc.pid ?? ""));

  await waitForHealth();
  console.log("[e2e setup] Engine ready.");
}
