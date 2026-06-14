/**
 * global-teardown.ts — kill the engine sidecar started by global-setup.ts.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

export default async function globalTeardown() {
  const pidFile = resolve(tmpdir(), "eigenheim-e2e-pid.txt");
  if (!existsSync(pidFile)) return;
  try {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (!isNaN(pid)) {
      process.kill(pid, "SIGTERM");
      console.log(`[e2e teardown] Engine pid ${pid} terminated.`);
    }
  } catch {
    // Already gone — fine.
  }
}
