// In-app update wiring.
//
// Windows + Linux: electron-updater (the real auto-updater). It reads latest.yml /
// latest-linux.yml from the GitHub Releases feed, verifies the download by sha512, and
// applies it on quitAndInstall(). Works on unsigned builds.
//
// macOS: electron-updater's Squirrel.Mac path requires a Developer ID signature to apply
// an update, which this build does not have (ad-hoc only). So on mac we do NOT use
// electron-updater. Instead we poll the GitHub Releases API, compare versions, and on a
// newer release download the arch-matched .dmg and open it (the user drags to replace).
// No manual checking; one drag remains until a Developer ID lands (see the auto-update
// council doc). Upgrade to true silent mac auto-update by signing + notarizing.
//
// Install is always user-gated: nothing is applied without the explicit Restart / open
// action from the toast. The auto-check on launch only downloads (win/linux) or notifies.
import { app, ipcMain, shell } from "electron";
import { createRequire } from "node:module";
import https from "node:https";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const REPO = "Eigenheim-space/Eigenheim-app";
const isMac = process.platform === "darwin";

let send = () => {}; // pushes a status object to the renderer
let macLatest = null; // { version, dmgUrl, name } cached from the last mac check

export function initUpdater(pushStatus) {
  send = pushStatus;
  ipcMain.handle("updater:version", () => app.getVersion());
  ipcMain.handle("updater:check", () => checkForUpdates());
  ipcMain.handle("updater:apply", () => applyUpdate());
  // Dev (unpackaged) has no release feed; skip auto-check, leave the manual button inert.
  if (!app.isPackaged) return;
  // Auto-check shortly after launch so the user is told about updates without clicking.
  setTimeout(() => { checkForUpdates().catch(() => {}); }, 4000);
}

async function checkForUpdates() {
  send({ state: "checking" });
  if (isMac) return checkMac();
  return checkElectronUpdater();
}

function applyUpdate() {
  if (isMac) return openMacDmg();
  const { autoUpdater } = require("electron-updater");
  autoUpdater.quitAndInstall(); // win/linux: relaunch into the downloaded update
}

// ── Windows / Linux: electron-updater ─────────────────────────────────────────
let euWired = false;
async function checkElectronUpdater() {
  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = true;            // the file is inert until quitAndInstall
  autoUpdater.autoInstallOnAppQuit = false;   // never apply silently on quit
  autoUpdater.allowPrerelease = false;        // releases are full (not GitHub "pre-release")
  if (!euWired) {
    euWired = true;
    autoUpdater.on("update-available", (i) => send({ state: "downloading", version: i?.version }));
    autoUpdater.on("update-not-available", () => send({ state: "none" }));
    autoUpdater.on("download-progress", (p) => send({ state: "downloading", progress: Math.round(p?.percent || 0) }));
    autoUpdater.on("update-downloaded", (i) => send({ state: "downloaded", version: i?.version }));
    autoUpdater.on("error", (e) => send({ state: "error", error: String(e?.message || e) }));
  }
  try { await autoUpdater.checkForUpdates(); }
  catch (e) { send({ state: "error", error: String(e?.message || e) }); }
}

// ── macOS: GitHub Releases API + download-and-open the .dmg ────────────────────
async function checkMac() {
  try {
    let rel;
    try {
      rel = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    } catch {
      // /releases/latest skips GitHub "pre-release" tagged releases; fall back to the list.
      const list = await fetchJson(`https://api.github.com/repos/${REPO}/releases`);
      rel = Array.isArray(list) ? list.find((r) => !r.draft) : null;
    }
    const tag = (rel?.tag_name || "").replace(/^v/, "");
    if (!tag || !isNewer(tag, app.getVersion())) { send({ state: "none" }); return; }
    const wantArm = process.arch === "arm64";
    const asset = (rel.assets || []).find((a) =>
      wantArm ? /arm64\.dmg$/i.test(a.name) : (/\.dmg$/i.test(a.name) && !/arm64/i.test(a.name)));
    if (!asset) { send({ state: "error", error: "no matching .dmg in the release" }); return; }
    macLatest = { version: tag, dmgUrl: asset.browser_download_url, name: asset.name };
    send({ state: "available", version: tag, platform: "mac" });
  } catch (e) {
    send({ state: "error", error: String(e?.message || e) });
  }
}

function openMacDmg() {
  if (!macLatest?.dmgUrl) { send({ state: "error", error: "no update download available" }); return; }
  send({ state: "downloading", version: macLatest.version, platform: "mac" });
  const dest = join(tmpdir(), macLatest.name);
  download(macLatest.dmgUrl, dest)
    .then(() => { send({ state: "downloaded", version: macLatest.version, platform: "mac" }); shell.openPath(dest); })
    .catch((e) => send({ state: "error", error: String(e?.message || e) }));
}

// ── helpers ────────────────────────────────────────────────────────────────────
function isNewer(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "eigenheim-updater", Accept: "application/vnd.github+json" } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) { res.resume(); fetchJson(res.headers.location).then(resolve, reject); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`GitHub API HTTP ${res.statusCode}`)); return; }
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "eigenheim-updater" } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) { res.resume(); download(res.headers.location, dest).then(resolve, reject); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`download HTTP ${res.statusCode}`)); return; }
      const f = createWriteStream(dest);
      res.pipe(f);
      f.on("finish", () => f.close(() => resolve(dest)));
      f.on("error", reject);
    }).on("error", reject);
  });
}
