import { useState, useEffect } from "react";
import { Check, AlertCircle, X, RefreshCw } from "lucide-react";
import { useApp } from "./store";
import { api } from "./api";
import { buildMcpConfig } from "./data";
import { Ket, Button, Field, Input, Select, Badge, Snippet, ErrorBanner, useCoachAnchor } from "./ui";

function StepCard({ children, width = 460 }: { children: React.ReactNode; width?: number }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--surface-overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70, padding: 24 }}>
      <div className="eh-fadein" style={{ width: "min(100%," + width + "px)", maxWidth: width, background: "var(--color-white)", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-modal)", boxShadow: "var(--shadow-2xl)", padding: 28 }}>{children}</div>
    </div>
  );
}

export function Onboarding() {
  const step = useApp((s) => s.obStep);
  const { setObStep, finishOnboarding, connectDataSource } = useApp();
  if (!step) return null;

  if (step === "welcome") {
    return (
      <StepCard>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}><Ket size={40} /></div>
        <h2 style={{ fontSize: 22, fontWeight: 600, textAlign: "center", letterSpacing: "-0.01em", margin: "0 0 10px" }}>One definite state of your product metrics</h2>
        <p style={{ fontSize: 14, color: "var(--text-tertiary)", textAlign: "center", margin: "0 0 24px", lineHeight: 1.6 }}>Connect a data source, validate your formulas once, and get deterministic numbers — for you and your AI.</p>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <Button hierarchy="primary" size="lg" onClick={() => setObStep("datasource")}>Connect data</Button>
          <button onClick={finishOnboarding} style={{ background: "none", border: "none", fontSize: 13, color: "var(--text-tertiary)", cursor: "pointer", fontWeight: 600 }}>Skip</button>
        </div>
      </StepCard>
    );
  }

  if (step === "datasource") {
    return <DataSourceStep onBack={() => setObStep("welcome")} onConnect={connectDataSource} />;
  }

  if (step === "sync") return <SyncStep onDone={() => setObStep("coach")} />;

  if (step === "mcpkey") {
    return <McpKeyStep onDone={finishOnboarding} />;
  }
  return null; // 'coach' handled by CoachMarks (not a dimmed card)
}

function DataSourceStep({ onBack, onConnect }: { onBack: () => void; onConnect: () => void }) {
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "ok" | "error">("idle");
  return (
    <StepCard width={500}>
      <h2 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 16px" }}>Connect a data source</h2>
      <div style={{ border: "1px solid var(--border-secondary)", borderRadius: 12, padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}><span style={{ fontSize: 15, fontWeight: 600 }}>PostHog</span>{state === "ok" && <Badge tone="success" dot>ok</Badge>}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Host"><Select options={[{ value: "us", label: "Cloud · US" }, { value: "eu", label: "Cloud · EU" }, { value: "self", label: "Self-hosted" }]} defaultValue="eu" /></Field>
          <Field label="Project ID"><Input placeholder="111680" /></Field>
          <Field label="API key" hint="stored locally in OS Keychain"><Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="phx_…" error={state === "error"} /></Field>
          {state === "error" && <div style={{ display: "flex", gap: 8, fontSize: 13, color: "var(--error-700)" }}><AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} /><span>PostHog adapter: connection stopped. Key rejected by server (401). Check your key.</span></div>}
          {state === "ok" && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--success-700)" }}><Check size={16} />Connection established.</div>}
        </div>
      </div>
      {["Amplitude", "Custom API"].map((s) => <div key={s} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--border-secondary)", borderRadius: 12, padding: "12px 16px", marginTop: 10, opacity: 0.65 }}><span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{s}</span><Badge tone="neutral">soon</Badge></div>)}
      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        {state === "ok"
          ? <Button hierarchy="primary" onClick={onConnect}>Continue</Button>
          : <Button hierarchy="secondary" onClick={() => setState(key.trim() ? "ok" : "error")}>Test connection</Button>}
        <Button hierarchy="tertiary" onClick={onBack}>Back</Button>
      </div>
    </StepCard>
  );
}

function SyncStep({ onDone }: { onDone: () => void }) {
  const [n, setN] = useState(0);
  const target = 184320;
  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 2500);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick); else setTimeout(onDone, 500);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onDone]);
  return (
    <StepCard>
      <h2 style={{ fontSize: 20, fontWeight: 600, textAlign: "center", margin: "0 0 6px" }}>Loading event catalog</h2>
      <div className="tnum" style={{ fontSize: 36, fontWeight: 600, textAlign: "center", letterSpacing: "-0.02em", margin: "14px 0" }}>{n.toLocaleString()}</div>
      <div style={{ fontSize: 13, color: "var(--text-tertiary)", textAlign: "center", marginBottom: 18 }}>events received</div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, height: 28, justifyContent: "center" }} aria-hidden>
        {Array.from({ length: 11 }).map((_, i) => <span key={i} style={{ width: 4, height: 22, borderRadius: 2, background: "var(--brand-400)", animation: `eh-wave 1s ease-in-out ${i * 0.08}s infinite` }} />)}
      </div>
    </StepCard>
  );
}

/*
 * McpKeyStep — 3-step coachmark for the highest-friction first-run moment.
 * Step 1: Generate the key (explain scope, press button)
 * Step 2: Copy the raw key (reveal-once warning)
 * Step 3: Paste the config snippet into Claude Desktop / Code
 *
 * Each step advances only when the user completes the action — no forced autoplay.
 */
function McpKeyStep({ onDone }: { onDone: () => void }) {
  const [mcpStep, setMcpStep] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState(false);
  const [rawKey, setRawKey] = useState("");
  const [error, setError] = useState("");
  const engineLive = useApp((s) => s.engineLive);

  const generate = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api.createMcpKey("Claude Desktop", ["read"]);
      setRawKey(res.raw_key);
      setMcpStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "key creation failed");
    } finally {
      setBusy(false);
    }
  };

  const stepIndicator = (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 18 }}>
      {([1, 2, 3] as const).map((n) => (
        <div key={n} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{
            width: 22, height: 22, borderRadius: "var(--radius-full)", border: `2px solid ${mcpStep >= n ? "var(--brand-600)" : "var(--gray-300)"}`,
            background: mcpStep > n ? "var(--brand-600)" : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 600, color: mcpStep > n ? "#fff" : mcpStep === n ? "var(--brand-600)" : "var(--gray-400)",
          }}>
            {mcpStep > n ? <Check size={12} strokeWidth={3} /> : n}
          </div>
          {n < 3 && <div style={{ width: 32, height: 1, background: mcpStep > n ? "var(--brand-300)" : "var(--gray-200)" }} />}
        </div>
      ))}
    </div>
  );

  return (
    <StepCard width={520}>
      <h2 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>Give your AI access</h2>
      <p style={{ fontSize: 14, color: "var(--text-tertiary)", margin: "0 0 18px", lineHeight: 1.6 }}>
        An MCP key is a read-only token. Your agent reads the same numbers you do — no write access.
      </p>
      {stepIndicator}

      {mcpStep === 1 && (
        <>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>Step 1: generate a key</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 14, lineHeight: 1.6 }}>
            Choose scope <b>read</b> — it lets the agent read metrics and Logic, but not modify data.
          </div>
          {!engineLive && (
            <div style={{ marginBottom: 14 }}>
              <ErrorBanner
                component="eigenheim"
                process="key creation blocked"
                detail="Engine offline. Create a key later in Settings → API keys."
                severity="warning"
              />
            </div>
          )}
          {error && (
            <div style={{ marginBottom: 12 }}>
              <ErrorBanner
                component="MCP key generator"
                process="key creation stopped"
                detail={error}
                action={<Button hierarchy="secondary" size="sm" onClick={() => setError("")}>Try again</Button>}
              />
            </div>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <Button hierarchy="primary" disabled={busy || !engineLive} onClick={generate}>
              {busy ? "Creating…" : "Generate key (read)"}
            </Button>
            <Button hierarchy="tertiary" onClick={onDone}>Skip</Button>
          </div>
        </>
      )}

      {mcpStep === 2 && (
        <>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 8 }}>Step 2: copy the key — shown once</div>
          <div style={{ marginBottom: 12 }}>
            <ErrorBanner
              component="eigenheim"
              process="key shown once"
              detail="After closing this window the key cannot be recovered. Copy it now."
              severity="warning"
            />
          </div>
          <Snippet value={rawKey} />
          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <Button hierarchy="primary" onClick={() => setMcpStep(3)}>Copied — next</Button>
            <Button hierarchy="tertiary" onClick={onDone}>Skip</Button>
          </div>
        </>
      )}

      {mcpStep === 3 && (
        <>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 8 }}>Step 3: paste the config into Claude Desktop or Claude Code</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 12, lineHeight: 1.6 }}>
            Open Settings → Integrations in Claude and paste this JSON. Your agent can then query your metrics over MCP.
          </div>
          <Snippet block value={buildMcpConfig(rawKey)} />
          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Button hierarchy="primary" onClick={onDone}>Done</Button>
          </div>
        </>
      )}
    </StepCard>
  );
}

/* ---------------- Coach marks (exactly three) ---------------- */
/*
 * Positions are derived from data-coach-anchor elements via getBoundingClientRect()
 * so they survive window resize and layout changes. Fallback to centered if
 * the anchor element hasn't mounted yet.
 */
const COACH_MARKS = [
  {
    title: "Events",
    body: "Your event catalog from the data source. These are the inputs for Logic formulas.",
    anchor: "events-tab",
  },
  {
    title: "Logic",
    body: "Formulas are validated once. After that, every metric is computed from them only — no LLM in the core.",
    anchor: "logic-tab",
  },
  {
    title: "Create your first report",
    body: "Click \"Create report\" on the grid and build metrics from Logic and Events.",
    anchor: null, // center of viewport
  },
] as const;

function CoachPopover({
  title, body, idx, total, onNext, onDismiss, anchorAttr,
}: {
  title: string;
  body: string;
  idx: number;
  total: number;
  onNext: () => void;
  onDismiss: () => void;
  anchorAttr: string | null;
}) {
  const rect = useCoachAnchor(anchorAttr ?? "");
  const W = 280;
  const GAP = 12;

  /* Compute position: place popover below+right of the anchor, or center fallback */
  let top: number | string = "45%";
  let left: number | string = "50%";
  let transform = "translate(-50%, -50%)";

  if (rect && anchorAttr) {
    // Place it just below the anchor, aligned to its left edge (clamped to viewport)
    const tentativeLeft = rect.left;
    const tentativeTop = rect.bottom + GAP;
    const clampedLeft = Math.min(tentativeLeft, window.innerWidth - W - 16);
    top = Math.min(tentativeTop, window.innerHeight - 200);
    left = Math.max(16, clampedLeft);
    transform = "none";
  }

  return (
    <div className="eh-fadein" style={{ position: "fixed", top, left, transform, width: W, background: "var(--gray-900)", color: "#fff", borderRadius: "var(--radius-tooltip)", padding: 16, boxShadow: "var(--shadow-2xl)", zIndex: 66 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{title}</span>
        <span style={{ fontSize: 12, color: "var(--gray-400)" }}>{idx + 1} / {total}</span>
        <button onClick={onDismiss} aria-label="Dismiss tip" style={{ background: "none", border: "none", color: "var(--gray-400)", cursor: "pointer", display: "flex", padding: 2 }}><X size={16} /></button>
      </div>
      <div style={{ fontSize: 13, color: "var(--gray-200)", lineHeight: 1.5, marginBottom: 14 }}>{body}</div>
      <button
        onClick={onNext}
        style={{ width: "100%", padding: "7px 0", fontSize: 13, fontWeight: 600, background: "var(--brand-600)", color: "#fff", border: "none", borderRadius: "var(--radius-button)", cursor: "pointer" }}
      >
        {idx >= total - 1 ? "Got it" : "Next"}
      </button>
    </div>
  );
}

export function CoachMarks() {
  const step = useApp((s) => s.obStep);
  const idx = useApp((s) => s.coachIndex);
  const { nextCoach, dismissCoach } = useApp();
  if (step !== "coach") return null;
  const m = COACH_MARKS[idx];
  if (!m) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 65, background: "rgba(12,17,29,0.28)" }} onClick={dismissCoach}>
      <div onClick={(e) => e.stopPropagation()}>
        <CoachPopover
          title={m.title}
          body={m.body}
          idx={idx}
          total={COACH_MARKS.length}
          onNext={nextCoach}
          onDismiss={dismissCoach}
          anchorAttr={m.anchor}
        />
      </div>
    </div>
  );
}

/* ---------------- Update toast ---------------- */
export function UpdateToast() {
  const show = useApp((s) => s.updateToast);
  const setShow = useApp((s) => s.setUpdateToast);
  const restart = useApp((s) => s.restartEngine);
  if (!show) return null;
  return (
    <div className="eh-fadein" role="status" style={{ position: "fixed", bottom: 16, right: 16, zIndex: 55, width: 320, background: "var(--color-white)", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-toast)", boxShadow: "var(--shadow-2xl)", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}><RefreshCw size={16} color="var(--brand-600)" /><span style={{ fontSize: 14, fontWeight: 600 }}>Update ready</span></div>
      <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 14 }}>Restart eigenheim to apply?</div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button hierarchy="primary" size="sm" onClick={() => { setShow(false); restart(); }}>Restart</Button>
        <Button hierarchy="tertiary" size="sm" onClick={() => setShow(false)}>Later</Button>
      </div>
    </div>
  );
}
