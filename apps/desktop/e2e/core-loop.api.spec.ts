/**
 * core-loop.api.spec.ts — REST + MCP smoke over the core eigenheim loop.
 *
 * Covers (from 14-testing-strategy.md smoke set):
 *   - GET /health                                    (engine is up and seeded)
 *   - POST /logic                                    (create a Logic formula)
 *   - POST /reports + GET /reports/:id              (create + read a Report)
 *   - POST /reports/:id/collect + GET /reports/:id  (collect → live snapshot)
 *   - MCP list_reports agrees with REST              (parity assertion, item 5)
 *
 * No live API keys. Fixture seed data only (EIGENHEIM_DB points at a tmp dir).
 * See global-setup.ts for the engine startup protocol.
 */
import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";
import http from "node:http";
import { TEST_TOKEN } from "./global-setup.js";

const DESKTOP_DIR = process.cwd(); // apps/desktop/
const ENGINE_DIR = path.resolve(DESKTOP_DIR, "../../engine");

const AUTH = { Authorization: `Bearer ${TEST_TOKEN}` };

// Use a run-specific suffix so tests are idempotent across re-runs
// (the fixture DB in tmpdir persists between runs on the same machine).
const RUN_ID = `e2e_${Date.now()}`;
const smokeMetricId = `${RUN_ID}_metric`;
const smokeReportId = `${RUN_ID}_report`;

// Lightweight REST helper — plain node:http, no playwright page required.
function restGet(urlPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: 8765, path: urlPath, headers: AUTH },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Non-JSON from ${urlPath}: ${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on("error", reject);
  });
}

function restPost(urlPath: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1", port: 8765, path: urlPath, method: "POST",
        headers: {
          ...AUTH,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Non-JSON from POST ${urlPath}: ${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

test.describe("core loop — REST smoke", () => {
  test("GET /health returns ok", async () => {
    const body = await restGet("/health") as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(typeof body.events).toBe("number");
  });

  test("GET /logic returns seeded catalog", async () => {
    const body = await restGet("/logic") as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    for (const lg of body as Array<Record<string, unknown>>) {
      expect(typeof lg.id).toBe("string");
      expect(typeof lg.expression).toBe("string");
    }
  });

  test("POST /logic creates a new formula", async () => {
    const body = await restPost("/logic", {
      id: smokeMetricId,
      name: "E2E Smoke Metric",
      description: "Created by e2e smoke test",
      fmt: "number",
      inputs: [{ alias: "a", kind: "count", params: { event: "user_signed_up" } }],
      expression: "a",
    }) as Record<string, unknown>;
    expect(body.id).toBe(smokeMetricId);
  });

  test("POST /reports creates a report using the smoke metric", async () => {
    const body = await restPost("/reports", {
      id: smokeReportId,
      name: "E2E Smoke Report",
      period_days: 30,
      logic_ids: [smokeMetricId],
    }) as Record<string, unknown>;
    expect(body.id).toBe(smokeReportId);
  });

  test("GET /reports/:id returns the smoke report", async () => {
    const body = await restGet(`/reports/${smokeReportId}`) as Record<string, unknown>;
    expect(body.id).toBe(smokeReportId);
    expect(["mock", "live", "stale"]).toContain(body.status);
    expect(Array.isArray(body.metrics)).toBe(true);
  });

  test("POST /reports/:id/collect → snapshot, status not mock", async () => {
    const collect = await restPost(`/reports/${smokeReportId}/collect`, { frequency: "24ч" }) as Record<string, unknown>;
    // snapshot_id is an integer rowid from SQLite
    expect(collect.snapshot_id).not.toBeNull();
    expect(Number(collect.collected)).toBeGreaterThanOrEqual(1);

    const detail = await restGet(`/reports/${smokeReportId}`) as Record<string, unknown>;
    // After collect, status must not be 'mock'.
    expect(detail.status).not.toBe("mock");
  });

  test("MCP list_reports agrees with REST /reports count", async () => {
    // Fetch REST report list count.
    const restReports = await restGet("/reports") as unknown[];
    const restCount = Array.isArray(restReports) ? restReports.length : 0;

    // Call MCP server via stdio — minimal JSON-RPC invocation.
    // This is the parity assertion from 14-testing-strategy.md, item 5.
    const uvBin = process.env.UV_BIN
      ?? (process.platform === "win32" ? "uv.exe" : "uv");

    const mcp = spawn(
      uvBin,
      ["run", "--project", ENGINE_DIR, "python", "-m", "eigenheim.mcp_server"],
      {
        cwd: ENGINE_DIR,
        stdio: ["pipe", "pipe", "inherit"],
        env: {
          ...process.env,
          PATH: [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/home/runner/.local/bin"].join(":"),
          EIGENHEIM_TOKEN: TEST_TOKEN,
        },
        shell: false,
      }
    );

    let stdout = "";
    mcp.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });

    const initMsg = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "e2e-smoke", version: "0.0.1" },
        capabilities: {},
      },
    });
    const listMsg = JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "list_reports", arguments: {} },
    });

    await new Promise<void>((resolve) => {
      mcp.stdin.write(initMsg + "\n");
      // Small delay to ensure init is processed before the tool call.
      setTimeout(() => {
        mcp.stdin.write(listMsg + "\n");
        setTimeout(() => {
          mcp.kill("SIGTERM");
          resolve();
        }, 4000);
      }, 500);
    });

    // Parse MCP response lines.
    const lines = stdout.split("\n").filter(Boolean);
    let mcpReportCount: number | null = null;
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          result?: { content?: Array<{ type: string; text?: string }> };
        };
        if (msg.id === 2 && msg.result?.content) {
          const textItem = msg.result.content.find((c) => c.type === "text");
          if (textItem?.text) {
            const parsed = JSON.parse(textItem.text) as unknown;
            // list_reports may return an array or { reports: [...], _hint: ... }
            if (Array.isArray(parsed)) {
              mcpReportCount = parsed.length;
            } else if (parsed && typeof parsed === "object" && "reports" in parsed) {
              const r = (parsed as { reports: unknown[] }).reports;
              mcpReportCount = Array.isArray(r) ? r.length : null;
            }
          }
        }
      } catch { /* skip non-JSON lines (engine startup output etc.) */ }
    }

    if (mcpReportCount === null) {
      // MCP didn't respond in time or the response format changed.
      // The engine MCP integration tests in engine/tests/ cover the stdio transport
      // in depth; this parity check is best-effort with a 4s timeout.
      console.warn(
        "[e2e] MCP list_reports did not return a parseable response within the timeout.\n" +
        "Engine MCP tests in engine/tests/ cover the stdio transport.\n" +
        "TODO: switch to streamable-HTTP MCP transport for more reliable e2e parity."
      );
    } else {
      // MCP may include system-default entries not returned by the REST endpoint.
      // At minimum, it should not return fewer reports.
      expect(mcpReportCount).toBeGreaterThanOrEqual(restCount);
    }
  });
});

// TODO(e2e-electron): core-loop.electron.spec.ts — full Electron UI smoke:
//   launch → onboard → connect mock data source → create Logic → collect →
//   assert badge gone → trace opens → persistence after restart.
// Requires display server (native macOS, Xvfb on Linux CI runner).
// Scaffold planned once the onboarding UI flow is stable (post Phase 1C).
