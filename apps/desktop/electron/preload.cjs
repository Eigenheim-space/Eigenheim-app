// Sandbox-safe preload (CommonJS — sandboxed preloads do not support ESM).
// Exposes the per-launch session token + engine URL to the renderer via the
// contextBridge, so api.ts can authenticate to the locked sidecar. The token
// arrives as a process argument from the main process (additionalArguments);
// there is no Node access in the renderer itself.
const { contextBridge, ipcRenderer } = require("electron");

// The main process passes the per-launch token + the engine port it actually bound
// (it probes for a free one, so it is not always 8765) as process arguments.
const TOKEN_PREFIX = "--eigenheim-token=";
const PORT_PREFIX = "--eigenheim-port=";
const tokenArg = process.argv.find((a) => a.startsWith(TOKEN_PREFIX));
const token = tokenArg ? tokenArg.slice(TOKEN_PREFIX.length) : null;
const portArg = process.argv.find((a) => a.startsWith(PORT_PREFIX));
const enginePort = portArg ? portArg.slice(PORT_PREFIX.length) : "8765";

contextBridge.exposeInMainWorld("eigenheim", {
  token,
  engineUrl: `http://127.0.0.1:${enginePort}`,
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
