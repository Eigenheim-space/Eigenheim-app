/**
 * chat/chatSecrets.ts
 *
 * Custodian for the OpenRouter API key.
 * Uses the same Electron safeStorage bridge as secrets.ts (OS keychain).
 * The key is stored under a fixed "chat:openrouter" id so it is never
 * written to SQLite, log files, or included in any diagnostic bundle.
 *
 * In the browser (standalone dev), the bridge is absent — saving is
 * unavailable, getKey returns null, and the cloud option will not activate.
 */

const CHAT_KEY_ID = "chat:openrouter";

// The Electron preload exposes window.eigenheim.secrets for the data-source
// custodian. We reuse the same bridge for chat keys — same OS keychain,
// different key ID.
type Bridge = {
  saveSource: (p: {
    id: string; kind: string; host: string; projectId: string; apiKey: string;
  }) => Promise<{ hasKey: boolean }>;
  getKey: (id: string) => Promise<string | null>;
  deleteSource: (id: string) => Promise<unknown>;
};

const bridge =
  typeof window !== "undefined"
    ? (window as { eigenheim?: { secrets?: Bridge } }).eigenheim?.secrets
    : undefined;

export const chatSecrets = {
  /** Whether safeStorage is available (Electron context only). */
  available: Boolean(bridge),

  /**
   * Persist the OpenRouter API key in the OS keychain via safeStorage.
   * The raw key is NOT kept in JS memory after this call completes.
   * Throws if the bridge is unavailable.
   */
  saveKey: (apiKey: string): Promise<void> => {
    if (!bridge) return Promise.reject(new Error("safeStorage unavailable — run in Electron"));
    return bridge
      .saveSource({ id: CHAT_KEY_ID, kind: "chat", host: "openrouter.ai", projectId: "openrouter", apiKey })
      .then(() => undefined);
  },

  /**
   * Retrieve the stored key. Returns null if not saved.
   * The key should be used immediately and not stored in React state.
   */
  getKey: (): Promise<string | null> =>
    bridge ? bridge.getKey(CHAT_KEY_ID) : Promise.resolve(null),

  /**
   * Remove the key from safeStorage (equivalent to disconnecting the cloud option).
   */
  deleteKey: (): Promise<void> =>
    bridge ? bridge.deleteSource(CHAT_KEY_ID).then(() => undefined) : Promise.resolve(),
};
