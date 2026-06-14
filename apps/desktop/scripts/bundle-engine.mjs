#!/usr/bin/env node
/**
 * bundle-engine.mjs — vendor a python-build-standalone CPython + the uv-locked
 * engine deps into engine/runtime/, so electron-builder can include them as
 * extraResources and the packaged app works without uv/Python on the user's box.
 *
 * Pattern: Datasette Desktop (https://github.com/simonw/datasette-desktop).
 * Runtime source: Astral python-build-standalone (same builds uv uses internally).
 * Run this script ONCE on the build machine before `electron-builder`.
 *
 * Usage:
 *   node apps/desktop/scripts/bundle-engine.mjs [--platform darwin-arm64|darwin-x86_64|linux-x86_64]
 *
 * The --platform flag defaults to the current host triple.
 * On a CI matrix, run once per target platform on the matching runner.
 *
 * After this script completes, engine/runtime/ will contain:
 *   runtime/python/          — the standalone CPython installation
 *   runtime/python/bin/python3 — (macOS/Linux) the interpreter to spawn
 *   runtime/python/lib/python3.12/site-packages/ — uv-locked dependencies
 *
 * The engine source (eigenheim/) is NOT installed into site-packages; it is
 * provided at runtime via PYTHONPATH=resourcesPath/engine/ by main.mjs.
 * This keeps the bundled runtime lighter and avoids any .pth / editable-install
 * machinery that python-build-standalone may not support cleanly.
 *
 * electron-builder.yml then picks up:
 *   engine/runtime   → resourcesPath/engine/runtime  (the Python interpreter)
 *   engine/eigenheim → resourcesPath/engine/eigenheim (the source package)
 *   engine/data      → resourcesPath/engine/data      (seed DB)
 * main.mjs reads process.resourcesPath + "/engine/runtime/python/bin/python3" (mac/linux).
 *
 * Requirements on the build machine: uv (to install deps into the bundled runtime).
 * The script itself only uses Node.js built-ins + uv.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream, chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const ENGINE_DIR = resolve(REPO_ROOT, "engine");
const RUNTIME_DIR = resolve(ENGINE_DIR, "runtime");

// python-build-standalone version tag — pin to a known-good release.
// Check https://github.com/astral-sh/python-build-standalone/releases for updates.
// Format: YYYYMMDT<HHmmss>Z
const PBS_TAG = "20250612";
const PYTHON_VERSION = "3.12.11";

/**
 * Map a Node.js platform/arch pair to the python-build-standalone asset name.
 * Targets: macOS arm64/x64, Linux x64, Windows x64.
 */
const PLATFORM_MAP = {
  "darwin-arm64": {
    asset: `cpython-${PYTHON_VERSION}+${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz`,
    pythonBin: "python/bin/python3",
  },
  "darwin-x86_64": {
    asset: `cpython-${PYTHON_VERSION}+${PBS_TAG}-x86_64-apple-darwin-install_only.tar.gz`,
    pythonBin: "python/bin/python3",
  },
  "linux-x86_64": {
    asset: `cpython-${PYTHON_VERSION}+${PBS_TAG}-x86_64-unknown-linux-gnu-install_only.tar.gz`,
    pythonBin: "python/bin/python3",
  },
  "win-x86_64": {
    asset: `cpython-${PYTHON_VERSION}+${PBS_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz`,
    pythonBin: "python/python.exe",
  },
};

function hostTriple() {
  if (process.platform === "win32") return "win-x86_64";
  const plat = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  return `${plat}-${arch}`;
}

function parseArgs() {
  const idx = process.argv.indexOf("--platform");
  return idx !== -1 ? process.argv[idx + 1] : hostTriple();
}

function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    httpsGet(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        downloadTo(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
  });
}

async function extractTarGz(tarGzPath, destDir) {
  // Use system tar — available on macOS + Linux CI runners.
  mkdirSync(destDir, { recursive: true });
  const result = spawnSync("tar", ["xzf", tarGzPath, "-C", destDir], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("tar extraction failed");
}

async function main() {
  const platform = parseArgs();
  const entry = PLATFORM_MAP[platform];
  if (!entry) {
    const known = Object.keys(PLATFORM_MAP).join(", ");
    console.error(`Unknown platform: ${platform}. Known: ${known}`);
    process.exit(1);
  }

  const { asset, pythonBin } = entry;
  const BASE_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}`;
  const downloadUrl = `${BASE_URL}/${asset}`;

  console.log(`\nbundle-engine: platform=${platform}`);
  console.log(`  asset: ${asset}`);
  console.log(`  runtime dest: ${RUNTIME_DIR}\n`);

  // -- 1. Download python-build-standalone --
  if (existsSync(join(RUNTIME_DIR, "python"))) {
    console.log("Runtime already exists — skipping download. Delete engine/runtime/python to re-fetch.");
  } else {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    const tmp = join(tmpdir(), `pbs-${randomBytes(6).toString("hex")}.tar.gz`);
    console.log(`Downloading ${downloadUrl} …`);
    await downloadTo(downloadUrl, tmp);
    console.log("Extracting …");
    await extractTarGz(tmp, RUNTIME_DIR);
    try { rmSync(tmp); } catch { /* noop */ }
    console.log("Python runtime extracted.");
  }

  const pythonExe = join(RUNTIME_DIR, pythonBin);
  if (!existsSync(pythonExe)) {
    throw new Error(`Expected Python binary not found at ${pythonExe}. Check the asset layout.`);
  }
  // Make sure the binary is executable (tar usually preserves perms, belt-and-suspenders).
  chmodSync(pythonExe, 0o755);

  // -- 2. Install uv-locked deps into the bundled runtime --
  // requirements-bundle.txt is generated via:
  //   cd engine && uv export --format requirements-txt --hashes --no-dev --no-emit-project > requirements-bundle.txt
  // The engine source itself (eigenheim/) is NOT installed here; main.mjs provides it
  // via PYTHONPATH at launch. Only the third-party dependency wheels go into site-packages.
  console.log("\nInstalling engine deps into bundled runtime …");
  const uvResult = spawnSync(
    "uv",
    [
      "pip", "install",
      "--python", pythonExe,
      "--require-hashes",          // fail on any unlocked dep
      "--no-cache",                 // repeatable — no stale wheel cache
      "-r", resolve(ENGINE_DIR, "requirements-bundle.txt"),
    ],
    { cwd: ENGINE_DIR, stdio: "inherit" },
  );

  if (uvResult.status !== 0) {
    // Fallback: install the runtime deps from pyproject.toml without hash verification.
    // Regenerate requirements-bundle.txt to fix this: cd engine && uv export
    //   --format requirements-txt --hashes --no-dev --no-emit-project > requirements-bundle.txt
    console.warn(
      "requirements-bundle.txt install failed; falling back to pyproject.toml (no hash verification).\n" +
      "Regenerate requirements-bundle.txt for a reproducible build."
    );
    const fallback = spawnSync(
      "uv",
      [
        "pip", "install",
        "--python", pythonExe,
        "--no-cache",
        // Install only the production deps declared in pyproject.toml.
        // The engine source itself is NOT installed here; it is provided via
        // PYTHONPATH pointing at resourcesPath/engine/ in main.mjs.
        "--no-deps",
        "fastapi>=0.115", "uvicorn[standard]>=0.32", "pydantic>=2.9", "mcp>=1.2",
      ],
      { cwd: ENGINE_DIR, stdio: "inherit" },
    );
    if (fallback.status !== 0) {
      throw new Error(
        "uv pip install fallback also failed. " +
        "Ensure uv is installed and the engine pyproject.toml is valid."
      );
    }
  }

  console.log("\nbundle-engine: done.");
  console.log(`  Bundled Python: ${pythonExe}`);
  console.log("  Next: run electron-builder to include engine/runtime/ via extraResources.\n");
  console.log("NOTE: Add engine/runtime/ to .gitignore (already done in Phase 0).");
  console.log("      Commit only requirements-bundle.txt, not the runtime itself.");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
