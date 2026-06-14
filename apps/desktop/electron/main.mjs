// Electron main process: start the deterministic engine sidecar, then open the
// window with the renderer. In dev the renderer is the Vite server; when packaged
// it is the built dist. The sidecar is killed when the app quits.
//
// Spawn strategy:
//   DEV (app.isPackaged === false):
//     `uv run --project <ENGINE_DIR> eigenheim serve --host … --port … --log-level …`
//     Uses the `eigenheim serve` CLI entrypoint (thin uvicorn wrapper).
//     Requires uv + Python on the developer's PATH.
//   PACKAGED (app.isPackaged === true):
//     `<resourcesPath>/engine/runtime/python/bin/python3 -m uvicorn eigenheim.app:app …`
//     Uses the python-build-standalone runtime bundled via bundle-engine.mjs +
//     extraResources. No uv or system Python required on the end-user's machine.
//
// Session-token handshake and /health wait are identical in both paths.
import { app, BrowserWindow, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";

const require = createRequire(import.meta.url);
const secrets = require("./secrets.cjs"); // safeStorage custodian (CJS — needs Electron's require)
const __dirname = dirname(fileURLToPath(import.meta.url));
// The packaged package.json "name" is the scoped "@eigenheim/desktop", which would give
// an ugly userData dir (Application Support/@eigenheim/desktop/). Pin a clean, stable app
// name early so userData (and the EIGENHEIM_DB path below) land in .../eigenheim/.
app.setName("eigenheim");
// In dev: engine lives at repo-root/engine/
// In packaged: engine source is in extraResources at resourcesPath/engine/
const ENGINE_DIR = app.isPackaged
  ? resolve(process.resourcesPath, "engine")
  : resolve(__dirname, "../../../engine");
// Preferred starting port for the engine sidecar. NOT a fixed binding: startSidecar
// probes upward from here for a free port, so a port already taken on the user's
// machine never blocks startup. The resolved port is handed to the renderer via preload.
const PREFERRED_PORT = 8765;
let enginePort = PREFERRED_PORT; // resolved in startSidecar before the engine spawns
const RENDERER_DEV_URL = "http://localhost:3020";

let sidecar = null;
let win = null;
// Per-launch session token, set only when WE spawn the sidecar (so the value is
// known). Left null when reusing an already-running dev engine, which has no token.
let sessionToken = null;
let tokenDir = null;

function ping(port) {
  return new Promise((res) => {
    // /health is gated whenever a session token is configured, so the probe must
    // authenticate with the token we minted. Without this, the probe gets 401, never
    // sees 200, and waitForHealth burns its full timeout before the window opens.
    // sessionToken is null here only in the dev-reuse case (an open engine returns 200).
    const headers = sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 800, headers }, (r) => {
      r.resume();
      res(r.statusCode === 200);
    });
    req.on("error", () => res(false));
    req.on("timeout", () => { req.destroy(); res(false); });
  });
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping(enginePort)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// True if we can bind 127.0.0.1:port right now (i.e. it is currently free).
function probePort(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once("error", () => res(false)); // EADDRINUSE / EACCES — treat as taken
    srv.once("listening", () => srv.close(() => res(true)));
    srv.listen(port, "127.0.0.1");
  });
}

// Walk upward from `start` until a free port is found. Bounded so a fully saturated
// range fails loudly instead of looping forever. (A tiny TOCTOU window exists between
// the probe and uvicorn binding; if the engine then fails to come up, waitForHealth
// reports it rather than hanging.)
async function findFreePort(start, attempts = 64) {
  for (let p = start; p < start + attempts; p++) {
    if (await probePort(p)) return p;
  }
  throw new Error(`No free port in [${start}, ${start + attempts}) for the engine sidecar.`);
}

/**
 * Resolve the interpreter + argv to start the engine sidecar.
 * In dev: delegates to uv, which manages the venv from pyproject.toml.
 * Packaged: uses the python-build-standalone interpreter from extraResources.
 *   The bundled layout (after bundle-engine.mjs):
 *     resourcesPath/engine/runtime/python/bin/python3  — interpreter
 *     resourcesPath/engine/eigenheim/                  — engine source
 */
function resolveEngineSpawn() {
  if (!app.isPackaged) {
    // Dev path: delegate to the `eigenheim serve` CLI (thin uvicorn wrapper).
    // `--project ENGINE_DIR` tells uv which pyproject.toml/venv to use.
    return {
      cmd: "uv",
      args: [
        "run", "--project", ENGINE_DIR,
        "eigenheim", "serve",
        "--host", "127.0.0.1", "--port", String(enginePort), "--log-level", "warning",
      ],
      cwd: ENGINE_DIR,
    };
  }

  // Packaged path: bundled CPython.
  const pythonBin = process.platform === "win32"
    ? resolve(process.resourcesPath, "engine", "runtime", "python", "python.exe")
    : resolve(process.resourcesPath, "engine", "runtime", "python", "bin", "python3");

  if (!existsSync(pythonBin)) {
    // Emit a clear error so it shows up in crash reports; the app will fail to
    // connect but won't silently hang. The fix is to run bundle-engine.mjs first.
    throw new Error(
      `Bundled Python not found at ${pythonBin}. ` +
      "Run: node apps/desktop/scripts/bundle-engine.mjs before building."
    );
  }

  // PYTHONPATH ensures the engine source (extraResources/engine/eigenheim/) is
  // importable even if the editable install (-e .) is not present in site-packages.
  const engineSrcParent = resolve(process.resourcesPath, "engine");

  return {
    cmd: pythonBin,
    args: [
      "-m", "uvicorn", "eigenheim.app:app",
      "--host", "127.0.0.1", "--port", String(enginePort), "--log-level", "warning",
    ],
    cwd: engineSrcParent,
    extraEnv: {
      PYTHONPATH: engineSrcParent,
      // Prevent Python from writing .pyc files into the read-only app bundle.
      PYTHONDONTWRITEBYTECODE: "1",
      // The app bundle's Resources are read-only, so the engine cannot write its
      // SQLite DB there. Point it at a writable per-user dir; the engine creates +
      // deterministically seeds the DB on first run and persists it across launches.
      EIGENHEIM_DB: join(app.getPath("userData"), "eigenheim.db"),
    },
  };
}

async function startSidecar() {
  // Reuse an already-running engine on the preferred port (dev convenience): if a
  // healthy engine answers /health there, attach to it and skip spawn + token mint.
  if (await ping(PREFERRED_PORT)) { enginePort = PREFERRED_PORT; return; }
  // Otherwise pick a free port (PREFERRED_PORT if open, else the next one up) so a
  // port already taken on the user's machine never blocks startup.
  enginePort = await findFreePort(PREFERRED_PORT);
  // Mint a token and hand it to the engine via a 0600 file (path in env). The
  // engine reads it once and unlinks it, so the secret never sits in process env
  // or `ps`. This locks the localhost engine to this app instance.
  sessionToken = randomBytes(32).toString("hex");
  tokenDir = mkdtempSync(join(tmpdir(), "eigenheim-"));
  const tokenFile = join(tokenDir, "session.token");
  writeFileSync(tokenFile, sessionToken, { mode: 0o600 });

  const { cmd, args, cwd, extraEnv = {} } = resolveEngineSpawn();
  // stdio:"inherit" forwards uvicorn output to the Electron process console, which
  // is useful for crash diagnostics. The session token is never emitted by uvicorn
  // (it arrives via EIGENHEIM_TOKEN_FILE and is unlinked before any log line fires;
  // log level is "warning"). If future uvicorn middleware or debug logging ever
  // outputs request headers, switch to piped stdio and strip /Bearer\s+[a-f0-9]{64}/
  // before forwarding lines to console.
  sidecar = spawn(
    cmd,
    args,
    {
      cwd,
      stdio: "inherit",
      env: { ...process.env, ...extraEnv, EIGENHEIM_TOKEN_FILE: tokenFile },
    }
  );
  sidecar.on("error", (e) => console.error("[engine] spawn failed:", e.message));
}

function cleanupToken() {
  if (tokenDir) {
    try { rmSync(tokenDir, { recursive: true, force: true }); } catch { /* noop */ }
    tokenDir = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1100,
    minHeight: 640,
    backgroundColor: "#f9fafb",
    title: "eigenheim",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: resolve(__dirname, "preload.cjs"),
      // The renderer loads only our local bundle (no remote content), so handing it
      // the session token + resolved engine port via contextBridge is safe; it lets
      // api.ts authenticate to the locked sidecar on whatever port we picked. The
      // token is omitted when reusing an unauthenticated dev engine; the port is
      // always passed so the renderer never assumes a fixed 8765.
      additionalArguments: [
        ...(sessionToken ? [`--eigenheim-token=${sessionToken}`] : []),
        `--eigenheim-port=${enginePort}`,
      ],
    },
  });
  if (app.isPackaged) win.loadFile(resolve(__dirname, "../dist/index.html"));
  else win.loadURL(RENDERER_DEV_URL);
}

// Secrets IPC. Decryption stays in main; the renderer receives only metadata, plus
// a just-in-time plaintext key for a sync it initiates (same trust level as typing it).
ipcMain.handle("secrets:saveSource", (_e, payload) => secrets.saveSource(payload));
ipcMain.handle("secrets:listSources", () => secrets.listSources());
ipcMain.handle("secrets:getKey", (_e, id) => secrets.getKey(id));
ipcMain.handle("secrets:deleteSource", (_e, id) => secrets.deleteSource(id));

app.whenReady().then(async () => {
  await startSidecar();
  await waitForHealth();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("quit", () => {
  if (sidecar) try { sidecar.kill(); } catch { /* noop */ }
  cleanupToken();
});
