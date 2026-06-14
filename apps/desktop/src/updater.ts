// Typed wrapper over the Electron updater bridge (window.eigenheim.updater).
// Absent in the standalone-browser dev build, so every call is optional-chained.
import type { UpdaterStatus } from "./store";

export interface UpdaterBridge {
  version: () => Promise<string>;
  check: () => Promise<void>;
  apply: () => Promise<void>;
  onStatus: (cb: (s: UpdaterStatus) => void) => () => void;
}

export const updaterBridge: UpdaterBridge | undefined =
  typeof window !== "undefined"
    ? (window as { eigenheim?: { updater?: UpdaterBridge } }).eigenheim?.updater
    : undefined;
