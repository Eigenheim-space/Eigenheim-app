// Sandbox-safe preload (CommonJS — sandboxed preloads do not support ESM).
// Exposes the per-launch session token + engine URL to the renderer via the
// contextBridge, so api.ts can authenticate to the locked sidecar. The token
// arrives as a process argument from the main process (additionalArguments);
// there is no Node access in the renderer itself.
const { contextBridge, ipcRenderer } = require("electron");

const PREFIX = "--eigenheim-token=";
const arg = process.argv.find((a) => a.startsWith(PREFIX));
const token = arg ? arg.slice(PREFIX.length) : null;

contextBridge.exposeInMainWorld("eigenheim", {
  token,
  engineUrl: "http://127.0.0.1:8765",
  // safeStorage-backed source secrets. The key is encrypted at rest by the OS
  // keychain in the main process; the renderer only ever holds metadata + a
  // just-in-time decrypted key for a sync it triggers.
  secrets: {
    saveSource: (payload) => ipcRenderer.invoke("secrets:saveSource", payload),
    listSources: () => ipcRenderer.invoke("secrets:listSources"),
    getKey: (id) => ipcRenderer.invoke("secrets:getKey", id),
    deleteSource: (id) => ipcRenderer.invoke("secrets:deleteSource", id),
  },
});
