import { useState, useEffect } from "react";
import { Check, AlertCircle, Trash2, Lock, Copy } from "lucide-react";
import { useApp, type SettingsSection } from "./store";
import { api, ENGINE } from "./api";
import { updaterBridge } from "./updater";
import { secrets, type SavedSource } from "./secrets";
import { buildMcpConfig } from "./data";
import { Badge, Button, Field, Input, Select, Segmented, Checkbox, Snippet, Drawer, copyText } from "./ui";
import { chatSecrets } from "./chat/chatSecrets";
import { testOpenRouterKey, detectOllamaModels } from "./chat/providers";
import { invalidate } from "./queries";

const NAV: { id: SettingsSection; label: string }[] = [
  { id: "datasources", label: "Data sources" },
  { id: "apikeys", label: "API keys" },
  { id: "aichat", label: "AI Chat" },
  { id: "appearance", label: "Appearance" },
  { id: "updates", label: "Updates" },
  { id: "about", label: "About" },
];

export function Settings() {
  const section = useApp((s) => s.settingsSection);
  const setSection = useApp((s) => s.setSettingsSection);
  return (
    <div style={{ height: "100%", display: "flex" }}>
      <nav style={{ width: 200, flexShrink: 0, borderRight: "1px solid var(--border-secondary)", padding: "24px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-quaternary)", padding: "0 10px 8px" }}>SETTINGS</div>
        {NAV.map((n) => {
          const on = section === n.id;
          return (
            <button key={n.id} onClick={() => setSection(n.id)} aria-current={on}
              style={{ textAlign: "left", padding: "8px 10px", fontSize: 14, fontWeight: 600, borderRadius: 8, border: "none", cursor: "pointer", background: on ? "var(--surface-active)" : "transparent", color: on ? "var(--text-primary)" : "var(--text-tertiary)" }}>
              {n.label}
            </button>
          );
        })}
      </nav>
      <div className="eh-scroll" style={{ flex: 1, overflowY: "auto", padding: 28, maxWidth: 720 }}>
        {section === "datasources" && <DataSources />}
        {section === "apikeys" && <ApiKeys />}
        {section === "aichat" && <AiChat />}
        {section === "appearance" && <Appearance />}
        {section === "updates" && <Updates />}
        {section === "about" && <About />}
      </div>
    </div>
  );
}

function H({ children }: { children: React.ReactNode }) { return <h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 16px" }}>{children}</h2>; }

function DataSources() {
  const [host, setHost] = useState("eu");
  const [project, setProject] = useState("");
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "ok" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SavedSource[]>([]);

  useEffect(() => { secrets.listSources().then(setSaved).catch(() => {}); }, []);

  const remember = async () => {
    setBusy(true);
    try {
      await secrets.saveSource({ id: `posthog:${project}`, kind: "posthog", host, projectId: project, days: 30, apiKey: key });
      setSaved(await secrets.listSources());
      setState("ok"); setMsg("Source saved — key encrypted in OS keychain");
    } catch (e) { setState("error"); setMsg(e instanceof Error ? e.message : "save failed"); }
    finally { setBusy(false); }
  };
  const syncSaved = async (snap: SavedSource) => {
    setBusy(true);
    try {
      const k = await secrets.getKey(snap.id);
      if (!k) throw new Error("key unavailable");
      const r = await api.syncPosthog(snap.host, snap.projectId, k);
      setMsg(`ingested: ${r.ingested.toLocaleString()}`);
      await invalidate.bootstrap();
      await invalidate.allReportDetails();
    } catch (e) { setState("error"); setMsg(e instanceof Error ? e.message : "sync failed"); }
    finally { setBusy(false); }
  };
  const forget = async (id: string) => { setSaved(await secrets.deleteSource(id)); };

  const test = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await api.testPosthog(host, project, key);
      setState("ok"); setMsg(`visible events: ${r.events_visible.toLocaleString()}`);
    } catch (e) { setState("error"); setMsg(e instanceof Error ? e.message : "connection failed"); }
    finally { setBusy(false); }
  };
  const sync = async () => {
    setBusy(true);
    try {
      const r = await api.syncPosthog(host, project, key);
      setMsg(`ingested: ${r.ingested.toLocaleString()}`);
      await invalidate.bootstrap();
      await invalidate.allReportDetails();
    } catch (e) { setState("error"); setMsg(e instanceof Error ? e.message : "sync failed"); }
    finally { setBusy(false); }
  };
  const onCsv = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const r = await api.ingestCsv(text);
      setMsg(`CSV import: ${r.ingested.toLocaleString()} events ingested`);
      await invalidate.bootstrap();
      await invalidate.allReportDetails();
    } catch (e) { setMsg(e instanceof Error ? e.message : "CSV error"); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <H>Data sources</H>
      <div style={{ border: "1px solid var(--border-secondary)", borderRadius: 12, padding: 20, maxWidth: 520 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>PostHog</span>
          {state === "ok" && <Badge tone="success" dot>verified</Badge>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Host"><Select value={host} onChange={(e) => setHost(e.target.value)} options={[{ value: "us", label: "Cloud · US" }, { value: "eu", label: "Cloud · EU" }, { value: "self", label: "Self-hosted (URL)" }]} /></Field>
          <Field label="Project ID"><Input value={project} onChange={(e) => setProject(e.target.value)} placeholder="111680" /></Field>
          <Field label="API key" hint={secrets.available ? "encrypted in OS keychain on save" : "stored locally, never written to disk"}>
            <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="phx_…" error={state === "error"} />
          </Field>
          {state === "error" && msg && (
            <div style={{ display: "flex", gap: 8, fontSize: 13, color: "var(--error-700)" }}>
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} /><span>{msg}</span>
            </div>
          )}
          {state === "ok" && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--success-700)" }}><Check size={16} />{msg || "Connection established."}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <Button hierarchy="secondary" disabled={busy || !project || !key} onClick={test}>{busy ? "…" : "Test connection"}</Button>
            {state === "ok" && <Button hierarchy="primary" disabled={busy} onClick={sync}>Sync</Button>}
            {state === "ok" && secrets.available && <Button hierarchy="secondary" disabled={busy} iconLeading={<Lock size={14} />} onClick={remember}>Save source</Button>}
          </div>
        </div>
      </div>

      {saved.length > 0 && (
        <div style={{ border: "1px solid var(--border-secondary)", borderRadius: 12, padding: 20, maxWidth: 520, marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Lock size={14} color="var(--text-tertiary)" />
            <span style={{ fontSize: 15, fontWeight: 600 }}>Saved sources</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 14 }}>Keys encrypted in OS keychain — resync without re-entering credentials</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {saved.map((snap) => (
              <div key={snap.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid var(--border-tertiary)", borderRadius: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)" }}>{snap.kind} · {snap.host} · {snap.projectId}</div>
                  <div style={{ fontSize: 11, color: snap.hasKey ? "var(--success-700)" : "var(--error-700)", marginTop: 2 }}>{snap.hasKey ? "key saved" : "key unavailable"}</div>
                </div>
                <Button hierarchy="secondary" size="sm" disabled={busy || !snap.hasKey} onClick={() => syncSaved(snap)}>Sync</Button>
                <button type="button" aria-label="Forget source" onClick={() => forget(snap.id)} style={{ display: "inline-flex", padding: 6, border: "none", background: "transparent", color: "var(--text-quaternary)", cursor: "pointer" }}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, border: "1px solid var(--border-secondary)", borderRadius: 12, padding: "16px 20px", marginTop: 12, maxWidth: 520 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>CSV export</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>columns: user_id, event, timestamp</div>
        </div>
        <label>
          <input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => onCsv(e.target.files?.[0])} />
          <span style={{ display: "inline-flex", alignItems: "center", height: 36, padding: "0 14px", fontSize: 14, fontWeight: 600, border: "1px solid var(--border-primary)", borderRadius: 8, cursor: "pointer", background: "var(--color-white)", boxShadow: "var(--shadow-xs)" }}>Import CSV</span>
        </label>
      </div>

      {["Amplitude", "Custom API"].map((s) => (
        <div key={s} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border-secondary)", borderRadius: 12, padding: "16px 20px", marginTop: 12, maxWidth: 520, opacity: 0.7 }}>
          <span style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>{s}</span>
          <Badge tone="neutral">soon</Badge>
        </div>
      ))}
    </div>
  );
}

interface LiveKey {
  id: string;
  name: string;
  scopes: string[];
  created_at: string;
  last_used_at?: string | null;
}

function ApiKeys() {
  const open = useApp((s) => s.mcpDrawer);
  const setOpen = useApp((s) => s.setMcpDrawer);
  const [keys, setKeys] = useState<LiveKey[]>([]);
  const [revoking, setRevoking] = useState<string | null>(null);
  const engineLive = useApp((s) => s.engineLive);

  const reload = () => {
    if (!engineLive) return;
    api.listMcpKeys().then(setKeys).catch(() => {});
  };
  useEffect(reload, [engineLive]);

  const revoke = async (id: string) => {
    setRevoking(id);
    try { await api.revokeMcpKey(id); reload(); } catch { /* ignore */ }
    finally { setRevoking(null); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <H>API keys</H><span style={{ flex: 1 }} />
        <Button hierarchy="primary" onClick={() => setOpen(true)}>Create key</Button>
      </div>
      {!engineLive && (
        <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 12 }}>
          Engine offline — API keys unavailable.
        </div>
      )}
      {keys.length > 0 && (
        <div style={{ border: "1px solid var(--border-secondary)", borderRadius: 12, overflow: "hidden", maxWidth: 640 }}>
          {keys.map((k, i) => (
            <div key={k.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: i < keys.length - 1 ? "1px solid var(--border-tertiary)" : "none" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{k.name}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                  {k.scopes.map((s) => (
                    <span key={s} style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", background: "var(--gray-100)", borderRadius: 6, padding: "1px 7px" }}>{s}</span>
                  ))}
                </div>
              </div>
              <div className="tnum" style={{ fontSize: 12, color: "var(--text-quaternary)" }}>
                {k.last_used_at ? `last: ${k.last_used_at.slice(0, 10)}` : "never used"}
              </div>
              <Button hierarchy="tertiary" size="sm" iconLeading={<Trash2 size={14} />}
                style={{ color: "var(--error-600)" }}
                disabled={revoking === k.id}
                onClick={() => revoke(k.id)}>
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}
      {keys.length === 0 && engineLive && (
        <div style={{ fontSize: 13, color: "var(--text-tertiary)", padding: "16px 0" }}>
          No keys yet. Create one to give your AI agent access to eigenheim.
        </div>
      )}
      {open && <CreateKeyDrawer onClose={() => { setOpen(false); reload(); }} />}
    </div>
  );
}

function CreateKeyDrawer({ onClose }: { onClose: () => void }) {
  const [stage, setStage] = useState<"form" | "busy" | "revealed">("form");
  const [name, setName] = useState("Claude Desktop");
  const [preset, setPreset] = useState<"read" | "full">("read");
  const [rawKey, setRawKey] = useState("");
  const [error, setError] = useState("");

  const generate = async () => {
    if (!name.trim()) return;
    setStage("busy");
    setError("");
    try {
      const scopes = preset === "read" ? ["read"] : ["read", "logic:write"];
      const res = await api.createMcpKey(name.trim(), scopes);
      setRawKey(res.raw_key);
      setStage("revealed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "key creation failed");
      setStage("form");
    }
  };

  return (
    <Drawer title={stage === "revealed" ? "Key created" : "New MCP key"} onClose={onClose}>
      {stage !== "revealed" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Desktop" />
          </Field>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 8 }}>Scope preset</div>
            <Segmented value={preset} onChange={(v) => setPreset(v as "read" | "full")}
              options={[{ value: "read", label: "read-only" }, { value: "full", label: "full" }]} />
          </div>
          {error && (
            <div style={{ display: "flex", gap: 8, fontSize: 13, color: "var(--error-700)" }}>
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} /><span>{error}</span>
            </div>
          )}
          <Button hierarchy="primary" disabled={stage === "busy" || !name.trim()} onClick={generate}>
            {stage === "busy" ? "Creating…" : "Create key"}
          </Button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 8, fontSize: 13, color: "var(--warning-700)", background: "var(--warning-50)", border: "1px solid var(--warning-300)", borderRadius: 8, padding: 12 }}>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span><b>Save the key now.</b> It is shown once and cannot be retrieved later.</span>
          </div>
          <Snippet value={rawKey} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", margin: "6px 0 8px" }}>Config for Claude Desktop / Code</div>
            <Snippet block value={buildMcpConfig(rawKey)} />
          </div>
          <Button hierarchy="secondary" onClick={onClose}>Done</Button>
        </div>
      )}
    </Drawer>
  );
}

// ─── AI Chat settings ─────────────────────────────────────────────────────────

function AiChat() {
  const {
    chatProvider, setChatProvider,
    chatOllamaEndpoint, setChatOllamaEndpoint,
    chatOllamaModel, setChatOllamaModel,
    chatOpenRouterModel, setChatOpenRouterModel,
    chatHasCloudKey, setChatHasCloudKey,
  } = useApp();

  // Option A — Cloud
  const [cloudKey, setCloudKey] = useState("");
  const [cloudState, setCloudState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [cloudMsg, setCloudMsg] = useState("");
  const [cloudModels, setCloudModels] = useState<string[]>([]);

  // Option B — Ollama
  const [ollamaState, setOllamaState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [ollamaMsg, setOllamaMsg] = useState("");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);

  // Engine MCP endpoint (for option C). Built from the engine URL the main process
  // actually bound this launch (the port is probed, not always 8765).
  const engineLive = useApp((s) => s.engineLive);
  const mcpEndpoint = `${ENGINE}/mcp`;

  // Check if cloud key already saved on mount
  useEffect(() => {
    chatSecrets.getKey().then((k) => {
      if (k) { setCloudState("ok"); setCloudMsg("Key saved. Clear below to remove it."); }
    }).catch(() => {});
  }, []);

  const testCloud = async () => {
    if (!cloudKey.trim()) return;
    setCloudState("testing"); setCloudMsg("");
    try {
      const { models } = await testOpenRouterKey(cloudKey.trim());
      setCloudModels(models);
      setCloudState("ok"); setCloudMsg(`Connected. ${models.length} models available.`);
    } catch (e) { setCloudState("error"); setCloudMsg(e instanceof Error ? e.message : "Connection failed"); }
  };

  const saveCloud = async () => {
    if (!cloudKey.trim()) return;
    try {
      await chatSecrets.saveKey(cloudKey.trim());
      setChatHasCloudKey(true);
      setCloudKey("");
      setCloudMsg("Key saved in OS keychain. Not stored in logs or SQLite.");
    } catch (e) { setCloudState("error"); setCloudMsg(e instanceof Error ? e.message : "Save failed"); }
  };

  const removeCloud = async () => {
    await chatSecrets.deleteKey();
    setChatHasCloudKey(false);
    if (chatProvider === "openrouter") setChatProvider("ollama");
    setCloudState("idle"); setCloudMsg(""); setCloudKey("");
  };

  const detectOllama = async () => {
    setOllamaState("testing"); setOllamaMsg("");
    try {
      const models = await detectOllamaModels(chatOllamaEndpoint);
      setOllamaModels(models);
      setOllamaState("ok");
      setOllamaMsg(`${models.length} model${models.length !== 1 ? "s" : ""} found.`);
      if (models.length > 0 && !models.includes(chatOllamaModel)) setChatOllamaModel(models[0]);
    } catch (e) { setOllamaState("error"); setOllamaMsg(e instanceof Error ? e.message : "Ollama not reachable"); }
  };

  const card = (children: React.ReactNode) => (
    <div style={{ border: "1px solid var(--border-secondary)", borderRadius: 12, padding: 20, maxWidth: 520, marginBottom: 14 }}>
      {children}
    </div>
  );

  const cardHeader = (title: string, badge?: React.ReactNode, defaultProv?: boolean) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
      <span style={{ fontSize: 15, fontWeight: 600 }}>{title}</span>
      {badge}
      {defaultProv && <span style={{ marginLeft: "auto", fontSize: 12, background: "var(--brand-50)", color: "var(--brand-700)", borderRadius: "var(--radius-badge)", padding: "1px 8px", fontWeight: 600 }}>Default</span>}
    </div>
  );

  return (
    <div>
      <H>AI Chat</H>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20, lineHeight: 1.6 }}>
        Your data and keys stay on your machine. If you point a cloud model at eigenheim,
        your messages and the report metric values go to the provider; your formulas and source keys never do.
      </p>

      {/* Option A — Cloud API */}
      {card(
        <>
          {cardHeader(
            "Cloud API",
            <Badge tone="danger">Data leaves your machine when active</Badge>,
            chatProvider === "openrouter",
          )}
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
            Connect an OpenRouter key to query eigenheim data with a cloud model.
            Your messages and report context go to the provider.
            Your formulas and source connection keys never do.
          </p>
          {chatHasCloudKey ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--success-700)" }}>
                <Check size={15} /> Key saved in OS keychain.
              </div>
              {cloudModels.length > 0 && (
                <Field label="Model">
                  <Select
                    value={chatOpenRouterModel}
                    onChange={(e) => setChatOpenRouterModel(e.target.value)}
                    options={cloudModels.map((m) => ({ value: m, label: m }))}
                  />
                </Field>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <Button hierarchy="primary" size="sm" onClick={() => { setChatProvider("openrouter"); }}>
                  Set as default
                </Button>
                <Button hierarchy="tertiary" size="sm" style={{ color: "var(--error-600)" }} onClick={removeCloud}>
                  Remove key
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Field label="OpenRouter API key" hint="Saved to OS keychain via safeStorage — never written to SQLite or logs. Excluded from any diagnostic export.">
                <Input
                  type="password"
                  value={cloudKey}
                  onChange={(e) => setCloudKey(e.target.value)}
                  placeholder="sk-or-..."
                  error={cloudState === "error"}
                />
              </Field>
              {cloudMsg && (
                <div style={{ fontSize: 13, color: cloudState === "error" ? "var(--error-700)" : "var(--success-700)" }}>
                  {cloudMsg}
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <Button hierarchy="secondary" size="sm" disabled={!cloudKey.trim() || cloudState === "testing"} onClick={testCloud}>
                  {cloudState === "testing" ? "Testing…" : "Test connection"}
                </Button>
                {cloudState === "ok" && (
                  <Button hierarchy="primary" size="sm" onClick={saveCloud}>Save key</Button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Option B — Local Ollama */}
      {card(
        <>
          {cardHeader("Local model · Fully local", undefined, chatProvider === "ollama")}
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
            eigenheim queries a model running on your machine. Nothing leaves.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="Ollama endpoint">
              <Input
                value={chatOllamaEndpoint}
                onChange={(e) => setChatOllamaEndpoint(e.target.value)}
                placeholder="http://localhost:11434"
              />
            </Field>
            {ollamaModels.length > 0 && (
              <Field label="Model">
                <Select
                  value={chatOllamaModel}
                  onChange={(e) => setChatOllamaModel(e.target.value)}
                  options={ollamaModels.map((m) => ({ value: m, label: m }))}
                />
              </Field>
            )}
            {ollamaMsg && (
              <div style={{ fontSize: 13, color: ollamaState === "error" ? "var(--error-700)" : "var(--success-700)" }}>
                {ollamaMsg}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <Button hierarchy="secondary" size="sm" onClick={detectOllama} disabled={ollamaState === "testing"}>
                {ollamaState === "testing" ? "Detecting…" : "Detect models"}
              </Button>
              <Button hierarchy="primary" size="sm" onClick={() => setChatProvider("ollama")}>
                Set as default
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Option C — External agent */}
      {card(
        <>
          {cardHeader("External agent · Local to your agent", undefined, chatProvider === "agent")}
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
            Your desktop agent reads eigenheim's MCP server and writes back into this chat.
            Nothing goes to any cloud provider through eigenheim.
          </p>
          <Field label="eigenheim MCP endpoint">
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Input value={mcpEndpoint} readOnly style={{ flex: 1 }} />
              <button
                onClick={() => copyText(mcpEndpoint)}
                aria-label="Copy MCP endpoint"
                title="Copy"
                style={{ padding: "0 10px", height: 40, border: "1px solid var(--border-primary)", borderRadius: "var(--radius-md)", background: "var(--color-white)", cursor: "pointer", display: "flex", alignItems: "center" }}
              >
                <Copy size={14} />
              </button>
            </div>
          </Field>
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <Badge tone={engineLive ? "success" : "neutral"} dot={engineLive}>
              {engineLive ? "MCP server running" : "Engine offline"}
            </Badge>
            <Button hierarchy="secondary" size="sm" onClick={() => setChatProvider("agent")}>
              Set as default
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Appearance() {
  const [theme, setTheme] = useState("light");
  return (
    <div>
      <H>Appearance</H>
      <Field label="Theme"><Segmented value={theme} onChange={setTheme} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "System" }]} /></Field>
      <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 12 }}>The app uses light theme by default.</div>
    </div>
  );
}

function Updates() {
  const updater = useApp((s) => s.updater);
  const appVersion = useApp((s) => s.appVersion);
  const [channel, setChannel] = useState("stable");
  const checking = updater.state === "checking" || updater.state === "downloading";

  let status = "";
  if (updater.state === "none") status = "You're on the latest version.";
  else if (updater.state === "available") status = `Update available: ${updater.version ?? ""} (see the toast to download).`;
  else if (updater.state === "downloading") status = updater.progress != null ? `Downloading… ${updater.progress}%` : "Downloading…";
  else if (updater.state === "downloaded") status = "Update downloaded. Restart to apply (see the toast).";
  else if (updater.state === "error") status = `Update check failed: ${updater.error ?? "unknown error"}.`;

  return (
    <div>
      <H>Updates</H>
      <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 480 }}>
        <Field label="Update channel" hint="stable — verified releases; dev — early access">
          <Segmented value={channel} onChange={setChannel} options={[{ value: "stable", label: "stable" }, { value: "dev", label: "dev" }]} />
        </Field>
        <div className="tnum" style={{ fontSize: 14, color: "var(--text-secondary)" }}>Current version: <b>{appVersion}</b></div>
        <div>
          <Button hierarchy="secondary" onClick={() => { updaterBridge?.check(); }}>{checking ? "Checking…" : "Check now"}</Button>
        </div>
        {status && <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>{status}</div>}
      </div>
    </div>
  );
}

function About() {
  return (
    <div>
      <H>About</H>
      <div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.7, maxWidth: 560 }}>
        <p style={{ marginTop: 0 }}>eigenheim is a local desktop app that gives you one definite state of your product metrics. Formulas are validated once, computation is deterministic, and there are zero LLM calls in the core.</p>
        <div className="tnum" style={{ fontSize: 13, color: "var(--text-quaternary)", marginTop: 12 }}>v0.1.0 · PolyForm Noncommercial 1.0.0 · eigenheim.space</div>
      </div>
    </div>
  );
}
