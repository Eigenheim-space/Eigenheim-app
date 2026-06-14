// Secrets custodian (main process). Source API keys are encrypted at rest with
// Electron safeStorage, which is backed by the OS keychain (macOS Keychain,
// libsecret on Linux, DPAPI on Windows). Plaintext keys never touch disk; only
// the OS-encrypted ciphertext is persisted, in a 0600 JSON file under userData.
const { safeStorage, app } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

function storePath() {
  return join(app.getPath("userData"), "sources.json");
}

function load() {
  try {
    return JSON.parse(readFileSync(storePath(), "utf8"));
  } catch {
    return { sources: [] };
  }
}

function persist(data) {
  writeFileSync(storePath(), JSON.stringify(data), { mode: 0o600 });
}

// Strip the ciphertext before anything leaves the main process.
function publicView(s) {
  const { cipher, ...rest } = s; // eslint-disable-line no-unused-vars
  return { ...rest, hasKey: Boolean(s.cipher) };
}

function saveSource({ id, kind, host, projectId, days, apiKey }) {
  if (!safeStorage.isEncryptionAvailable()) {
    // Never fall back to plaintext on disk; report so the UI can warn.
    throw new Error("OS keychain unavailable — refusing to store the key in plaintext");
  }
  const data = load();
  const rec = {
    id, kind, host, projectId, days,
    cipher: safeStorage.encryptString(apiKey).toString("base64"),
  };
  const i = data.sources.findIndex((s) => s.id === id);
  if (i >= 0) data.sources[i] = rec;
  else data.sources.push(rec);
  persist(data);
  return publicView(rec);
}

function listSources() {
  return load().sources.map(publicView);
}

// Decrypts just-in-time for a sync. The renderer already handles the key when you
// type it, so this is the same trust level; safeStorage protects it at rest only.
function getKey(id) {
  const s = load().sources.find((x) => x.id === id);
  if (!s || !s.cipher || !safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.decryptString(Buffer.from(s.cipher, "base64"));
}

function deleteSource(id) {
  const data = load();
  data.sources = data.sources.filter((s) => s.id !== id);
  persist(data);
  return listSources();
}

module.exports = { saveSource, listSources, getKey, deleteSource, storePath };
