/**
 * electron-bridge.d.ts
 *
 * Global type extension for the contextBridge surface exposed by preload.cjs.
 * Keeps call sites clean (no inline casts) and centralises the contract.
 * Update this file whenever preload.cjs adds or removes a bridge member.
 */

/** Shape returned by window.eigenheim.engineDiagnostics(). */
interface EngineDiagnosticsPayload {
  appVersion: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  enginePort: number;
  engineDir: string;
  /** Spawn command (token-free). */
  spawnCmd: string;
  healthReached: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  /** Last ~120 lines captured from the engine process (already redacted). */
  engineLog: string[];
}

interface EigenheimBridge {
  token: string | null;
  engineUrl: string;
  relaunch: () => Promise<void>;
  secrets: {
    saveSource: (payload: unknown) => Promise<void>;
    listSources: () => Promise<unknown[]>;
    getKey: (id: string) => Promise<string | null>;
    deleteSource: (id: string) => Promise<void>;
  };
  updater: {
    version: () => Promise<string>;
    check: () => Promise<void>;
    apply: () => Promise<void>;
    onStatus: (cb: (status: unknown) => void) => () => void;
  };
  /** Native folder picker. Returns the chosen path, or null if the user cancelled. */
  chooseDirectory: () => Promise<string | null>;
  /**
   * Returns engine diagnostics for the current launch: version, platform, spawn cmd,
   * health status, exit code/signal, and the last ~120 log lines (token-redacted).
   * Only present in packaged Electron (preload.cjs wires it via IPC).
   */
  engineDiagnostics: () => Promise<EngineDiagnosticsPayload>;
}

declare global {
  interface Window {
    /** Exposed by preload.cjs via contextBridge. Absent in browser dev mode. */
    eigenheim?: EigenheimBridge;
  }
}

export {};
