// Typed wrapper over the Electron secrets custodian (window.eigenheim.secrets).
// In the browser (standalone dev) the bridge is absent, so saving is unavailable
// and listing returns empty — the form falls back to ephemeral, in-memory keys.
export type SavedSource = {
  id: string;
  kind: string;
  host: string;
  projectId: string;
  days?: number;
  hasKey: boolean;
};

type SaveInput = {
  id: string;
  kind: string;
  host: string;
  projectId: string;
  days?: number;
  apiKey: string;
};

type Bridge = {
  saveSource: (p: SaveInput) => Promise<SavedSource>;
  listSources: () => Promise<SavedSource[]>;
  getKey: (id: string) => Promise<string | null>;
  deleteSource: (id: string) => Promise<SavedSource[]>;
};

const bridge =
  typeof window !== "undefined"
    ? (window as { eigenheim?: { secrets?: Bridge } }).eigenheim?.secrets
    : undefined;

export const secrets = {
  available: Boolean(bridge),
  saveSource: (p: SaveInput): Promise<SavedSource> =>
    bridge ? bridge.saveSource(p) : Promise.reject(new Error("secrets store unavailable (browser dev)")),
  listSources: (): Promise<SavedSource[]> => (bridge ? bridge.listSources() : Promise.resolve([])),
  getKey: (id: string): Promise<string | null> => (bridge ? bridge.getKey(id) : Promise.resolve(null)),
  deleteSource: (id: string): Promise<SavedSource[]> => (bridge ? bridge.deleteSource(id) : Promise.resolve([])),
};
