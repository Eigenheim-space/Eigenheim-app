/**
 * hypotheses.tsx — Hypotheses mode center surface.
 *
 * Wired to:
 *   GET  /hypotheses          — list with optional status/logic_id filter
 *   GET  /hypotheses/{id}     — single row (for drawer live-refresh)
 *   POST /hypotheses          — create (source=user, status=proposed)
 *   PATCH /hypotheses/{id}/status — human-only status advance
 *   DELETE /hypotheses/{id}   — delete
 *
 * Hard rules (brief 09 + CLAUDE.md):
 *   - LIGHT aesthetic: white surfaces, brand green, no purple, no glassmorphism.
 *   - English-first copy, blunt second person, no SaaS slop.
 *   - Status = color + text (never color alone).
 *   - Trace link on every row with a linked metric — always visible, never hover-only.
 *   - The agent NEVER advances status; only the human does via the drawer Segmented.
 *   - Agent-proposed rows in a visually separated sub-group inside Proposed.
 *   - tabular-nums on every numeric value and timestamp.
 *   - No DC runtime imports.
 */

import {
  useState, useMemo, useRef,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  GitBranch, Plus, X, ChevronDown, ChevronRight,
  Loader2, Search, Check,
} from "lucide-react";
import { useApp } from "./store";
import {
  hypothesesApi,
  type HypothesisRow,
  type HypothesisStatus,
} from "./api";
import type { Metric } from "./data";
import type { MetricOut } from "./api";
import { queryKeys, hypothesesQueryFn, bootstrapQueryFn, invalidate, findReportForMetric } from "./queries";
import {
  Badge, Button, IconButton, EmptyState, ErrorBanner, Tooltip, Segmented, Drawer, Sparkline,
} from "./ui";
import { relativeTime } from "./lib/time";
import { useTraceForLogic } from "./hooks/useTraceForLogic";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const STATUS_ORDER: HypothesisStatus[] = ["proposed", "testing", "confirmed", "rejected"];

const STATUS_FILTER_OPTIONS = [
  { value: "", label: "All" },
  { value: "proposed", label: "Proposed" },
  { value: "testing", label: "Testing" },
  { value: "confirmed", label: "Confirmed" },
  { value: "rejected", label: "Rejected" },
] as const;

const STATUS_WORKFLOW_OPTIONS = [
  { value: "proposed" as HypothesisStatus, label: "Proposed" },
  { value: "testing" as HypothesisStatus, label: "Testing" },
  { value: "confirmed" as HypothesisStatus, label: "Confirmed" },
  { value: "rejected" as HypothesisStatus, label: "Rejected" },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function statusTone(status: string): "neutral" | "info" | "success" | "danger" {
  if (status === "proposed") return "neutral";
  if (status === "testing") return "info";
  if (status === "confirmed") return "success";
  return "danger";
}

/** Sparkline color mirrors the hypothesis status — validation-loop signal. */
function hypSparklineColor(status: string): string {
  if (status === "confirmed") return "var(--success-500)";
  if (status === "rejected") return "var(--error-500)";
  if (status === "testing") return "var(--warning-500)";
  return "var(--gray-300)"; // proposed
}

function statusLabel(status: string): string {
  if (status === "proposed") return "Proposed";
  if (status === "testing") return "Testing";
  if (status === "confirmed") return "Confirmed";
  return "Rejected";
}

/* ------------------------------------------------------------------ */
/* Status badge                                                        */
/* ------------------------------------------------------------------ */

function HypStatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>;
}

/* ------------------------------------------------------------------ */
/* Agent badge — reuses warning slot, text "Agent" (brief 09)        */
/* ------------------------------------------------------------------ */

function AgentBadge() {
  return <Badge tone="warning">Agent</Badge>;
}

/* ------------------------------------------------------------------ */
/* Metric lookup helper                                               */
/* ------------------------------------------------------------------ */

function useCachedMetric(logicId: string | null): { metric: Metric | MetricOut | null; reportId: string | null } {
  if (!logicId) return { metric: null, reportId: null };
  // Reads from the react-query cache (non-reactive; for event handlers only).
  const rep = findReportForMetric(logicId);
  if (rep) {
    const m = rep.metrics?.find((m) => m.id === logicId) ?? null;
    return { metric: m, reportId: rep.id };
  }
  return { metric: null, reportId: null };
}

/* ------------------------------------------------------------------ */
/* Linked-metric chip (row inline display)                            */
/* ------------------------------------------------------------------ */

function MetricChip({ logicId }: { logicId: string }) {
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const logic = bootstrap?.logic ?? [];
  const { metric } = useCachedMetric(logicId);
  const { reportId, handleTrace: handleTraceHook } = useTraceForLogic(logicId);
  const logicRow = logic.find((l) => l.id === logicId);

  const name = logicRow?.name ?? metric?.name ?? logicId;
  const isStale = !metric || metric.status === "stale";
  const value = metric?.value ?? "—";

  const handleTrace = (e: React.MouseEvent) => {
    e.stopPropagation();
    handleTraceHook();
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: "var(--text-quaternary)" }}>{name}</span>
      <span
        className="tnum"
        style={{
          fontSize: 12, fontWeight: 600,
          color: isStale ? "var(--text-quaternary)" : "var(--text-primary)",
          fontFamily: isStale ? "var(--font-mono)" : undefined,
        }}
      >
        {isStale ? "—" : value}
      </span>
      {isStale && <Badge tone="warning">stale</Badge>}
      {/* Trace link: always visible when a report contains this logic — never hover-only */}
      {reportId && !isStale && (
        <button
          onClick={handleTrace}
          aria-label={`Trace: ${name}`}
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            border: "1px solid var(--border-primary)", background: "var(--color-white)",
            borderRadius: "var(--radius-md)", padding: "2px 7px",
            fontFamily: "var(--font-sans)", fontSize: 11, fontWeight: 500,
            color: "var(--text-secondary)", cursor: "pointer", boxShadow: "var(--shadow-xs)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-white)"; }}
        >
          <GitBranch size={10} />Trace
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hypothesis row                                                      */
/* ------------------------------------------------------------------ */

function HypothesisRow({
  hyp,
  onClick,
}: {
  hyp: HypothesisRow;
  onClick: () => void;
}) {
  const { short, full } = relativeTime(hyp.created_at);
  const hasMetric = !!hyp.logic_id;
  // Sparkline: show when linked metric has a non-empty series from the engine.
  const hasSpark = hasMetric && Array.isArray(hyp.spark) && hyp.spark.length > 1;
  // prefers-reduced-motion: render static final-point dot instead of the line.
  const prefersReduced = typeof window !== "undefined"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
      }}
      className="eh-task-row"
      style={{
        display: "flex", alignItems: "flex-start", gap: 10,
        padding: "10px 16px",
        minHeight: 56,
        borderTop: "1px solid var(--border-tertiary)",
        background: "var(--color-white)",
        cursor: "pointer",
      }}
    >
      {/* statement + metric sub-line */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            color: hyp.status === "rejected" ? "var(--text-tertiary)" : "var(--text-primary)",
            lineHeight: "20px",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
          title={hyp.statement}
        >
          {hyp.statement}
        </div>
        {hasMetric && <MetricChip logicId={hyp.logic_id} />}
      </div>

      {/* sparkline — validation-loop trend, status-colored */}
      {hasSpark && (
        <div style={{ flexShrink: 0, alignSelf: "center" }} aria-hidden="true">
          {prefersReduced ? (
            // reduced-motion: static final-point dot
            <div style={{
              width: 6, height: 6, borderRadius: "var(--radius-full)",
              background: hypSparklineColor(hyp.status),
            }} />
          ) : (
            <Sparkline
              data={hyp.spark}
              w={64}
              h={28}
              color={hypSparklineColor(hyp.status)}
            />
          )}
        </div>
      )}

      {/* badges */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, paddingTop: 1 }}>
        {hyp.source === "agent" && <AgentBadge />}
        <HypStatusBadge status={hyp.status} />
      </div>

      {/* timestamp */}
      <Tooltip content={full}>
        <span className="tnum" style={{
          fontSize: 12, color: "var(--text-quaternary)",
          whiteSpace: "nowrap", flexShrink: 0, paddingTop: 2,
          minWidth: 32, textAlign: "right",
        }}>
          {short}
        </span>
      </Tooltip>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Status section (collapsible group)                                 */
/* ------------------------------------------------------------------ */

function StatusSection({
  status,
  hypotheses,
  onOpenDrawer,
}: {
  status: HypothesisStatus;
  hypotheses: HypothesisRow[];
  onOpenDrawer: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (hypotheses.length === 0) return null;

  const agentProposals = status === "proposed" ? hypotheses.filter((h) => h.source === "agent") : [];
  const humanProposals = status === "proposed" ? hypotheses.filter((h) => h.source === "user") : hypotheses;

  return (
    <div style={{
      background: "var(--color-white)", border: "1px solid var(--border-secondary)",
      borderRadius: "var(--radius-2xl)", overflow: "hidden",
    }}>
      {/* collapsible header */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10,
          padding: "10px 16px", background: "var(--gray-25)",
          borderBottom: collapsed ? "none" : "1px solid var(--border-secondary)",
          border: "none", cursor: "pointer", textAlign: "left", minHeight: 44,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "var(--gray-25)"; }}
      >
        {collapsed
          ? <ChevronRight size={14} color="var(--text-quaternary)" />
          : <ChevronDown size={14} color="var(--text-quaternary)" />}
        <span style={{
          fontSize: 14, fontWeight: 600, color: "var(--text-secondary)",
        }}>
          {statusLabel(status)}
        </span>
        <span style={{
          display: "inline-flex", alignItems: "center",
          fontSize: 12, fontWeight: 500, color: "var(--text-quaternary)",
          background: "var(--gray-100)", borderRadius: "var(--radius-badge)",
          padding: "1px 7px",
        }}>
          {hypotheses.length} {hypotheses.length === 1 ? "hypothesis" : "hypotheses"}
        </span>
      </button>

      {!collapsed && (
        <>
          {/* Agent proposals sub-group (top of Proposed only) */}
          {agentProposals.length > 0 && (
            <>
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 16px",
                borderBottom: "1px solid var(--border-secondary)",
                background: "var(--warning-50)",
              }}>
                <span style={{
                  fontSize: 11, fontWeight: 600, color: "var(--warning-700)",
                  textTransform: "uppercase", letterSpacing: "0.05em",
                }}>
                  Agent proposals awaiting review
                </span>
              </div>
              {agentProposals.map((h) => (
                <HypothesisRow key={h.id} hyp={h} onClick={() => onOpenDrawer(h.id)} />
              ))}
              {humanProposals.length > 0 && (
                <div style={{ height: 1, background: "var(--border-secondary)" }} />
              )}
            </>
          )}

          {/* Human-created rows (or all rows for non-proposed sections) */}
          {humanProposals.map((h) => (
            <HypothesisRow key={h.id} hyp={h} onClick={() => onOpenDrawer(h.id)} />
          ))}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Logic picker (for the create form + drawer link-metric affordance) */
/* ------------------------------------------------------------------ */

function LogicPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const logic = bootstrap?.logic ?? [];
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search) return logic;
    return logic.filter((l) => l.name.toLowerCase().includes(search.toLowerCase()));
  }, [logic, search]);

  if (logic.length === 0) {
    return (
      <div style={{ padding: "10px 12px", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-xl)", background: "var(--gray-25)" }}>
        <span style={{ fontSize: 13, color: "var(--text-quaternary)" }}>No Logics yet. Create one in the Logic panel.</span>
      </div>
    );
  }

  return (
    <div>
      <div style={{ position: "relative", marginBottom: 6 }}>
        <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-quaternary)", pointerEvents: "none" }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search metrics…"
          style={{
            width: "100%", height: 34, padding: "0 10px 0 30px", fontSize: 13,
            fontFamily: "var(--font-sans)", color: "var(--text-primary)",
            background: "var(--color-white)", border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-input)", outline: "none", boxSizing: "border-box",
          }}
        />
      </div>
      <div style={{
        border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-xl)",
        overflow: "hidden", maxHeight: 180, overflowY: "auto",
      }} className="eh-scroll">
        {/* "None" option */}
        <button
          onClick={() => onChange("")}
          style={{
            display: "flex", alignItems: "center", gap: 10, width: "100%",
            padding: "8px 12px", border: "none", textAlign: "left",
            background: value === "" ? "var(--gray-100)" : "var(--color-white)",
            borderBottom: "1px solid var(--border-tertiary)",
            cursor: "pointer", fontFamily: "var(--font-sans)",
            fontSize: 13, color: "var(--text-tertiary)",
          }}
          onMouseEnter={(e) => { if (value !== "") e.currentTarget.style.background = "var(--gray-25)"; }}
          onMouseLeave={(e) => { if (value !== "") e.currentTarget.style.background = "var(--color-white)"; }}
        >
          No metric (unlinked)
        </button>
        {filtered.map((l) => {
          const sel = value === l.id;
          return (
            <button
              key={l.id}
              onClick={() => onChange(sel ? "" : l.id)}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%",
                padding: "8px 12px", border: "none", textAlign: "left",
                background: sel ? "var(--brand-50)" : "var(--color-white)",
                borderBottom: "1px solid var(--border-tertiary)",
                cursor: "pointer", fontFamily: "var(--font-sans)",
              }}
              onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = "var(--gray-25)"; }}
              onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = "var(--color-white)"; }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13, fontWeight: 500,
                  color: sel ? "var(--brand-700)" : "var(--text-primary)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {l.name}
                </div>
                {l.version && (
                  <div style={{ fontSize: 11, color: "var(--text-quaternary)", marginTop: 1 }}>
                    v{l.version}
                  </div>
                )}
              </div>
              {sel && <Check size={14} color="var(--brand-600)" />}
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--text-quaternary)" }}>
            No metrics match.
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create drawer                                                       */
/* ------------------------------------------------------------------ */

function CreateHypothesisDrawer({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [statement, setStatement] = useState("");
  const [logicId, setLogicId] = useState("");
  const [evidence, setEvidence] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSave = statement.trim().length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true); setErr(null);
    try {
      await hypothesesApi.create({
        statement: statement.trim(),
        logic_id: logicId || undefined,
        evidence: evidence.trim() || undefined,
      });
      onCreated();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      width={460}
      onClose={onClose}
      header={
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "12px 16px 12px 20px",
          borderBottom: "1px solid var(--border-secondary)", flexShrink: 0,
        }}>
          <span style={{ fontSize: 16, fontWeight: 600, flex: 1 }}>New Hypothesis</span>
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </div>
      }
      footer={
        <div style={{ padding: "12px 20px 20px", display: "flex", gap: 8 }}>
          <Button
            hierarchy="primary"
            style={{ flex: 1 }}
            disabled={!canSave || saving}
            onClick={handleSave}
          >
            {saving ? <><Loader2 size={14} style={{ animation: "eh-spin 1s linear infinite" }} />Saving…</> : "Add Hypothesis"}
          </Button>
          <Button hierarchy="secondary" onClick={onClose}>Cancel</Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {err && (
          <ErrorBanner
            component="Hypothesis"
            process="create stopped"
            detail={err}
            action={<Button hierarchy="tertiary" size="sm" onClick={() => setErr(null)}>Dismiss</Button>}
          />
        )}

        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
            Statement <span style={{ color: "var(--error-600)" }}>*</span>
          </label>
          <textarea
            autoFocus
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            placeholder="We believe that increasing activation from X to Y will lift D30 retention by Z pp."
            rows={4}
            style={{
              width: "100%", padding: "10px 12px", fontSize: 14,
              fontFamily: "var(--font-sans)", color: "var(--text-primary)",
              background: "var(--color-white)", border: "1px solid var(--border-primary)",
              borderRadius: "var(--radius-input)", outline: "none", resize: "vertical",
              boxSizing: "border-box", lineHeight: "20px",
            }}
          />
        </div>

        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
            Linked metric <span style={{ fontWeight: 400, color: "var(--text-quaternary)" }}>(optional)</span>
          </label>
          <LogicPicker value={logicId} onChange={setLogicId} />
        </div>

        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
            Evidence / rationale <span style={{ fontWeight: 400, color: "var(--text-quaternary)" }}>(optional)</span>
          </label>
          <textarea
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="Cite the numbers, research, or prior experiments that motivate this bet."
            rows={3}
            style={{
              width: "100%", padding: "10px 12px", fontSize: 14,
              fontFamily: "var(--font-sans)", color: "var(--text-primary)",
              background: "var(--color-white)", border: "1px solid var(--border-primary)",
              borderRadius: "var(--radius-input)", outline: "none", resize: "vertical",
              boxSizing: "border-box", lineHeight: "20px",
            }}
          />
        </div>
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Detail drawer                                                       */
/* ------------------------------------------------------------------ */

function HypothesisDetailDrawer({
  hyp,
  onClose,
  onUpdated,
  onDeleted,
}: {
  hyp: HypothesisRow;
  onClose: () => void;
  onUpdated: () => void;
  onDeleted: () => void;
}) {
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const logic = bootstrap?.logic ?? [];
  const { metric: cachedMetric } = useCachedMetric(hyp.logic_id || null);
  const { reportId, handleTrace } = useTraceForLogic(hyp.logic_id || null);
  const [statusPending, setStatusPending] = useState<HypothesisStatus | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const logicRow = hyp.logic_id ? logic.find((l) => l.id === hyp.logic_id) : null;
  const metricName = logicRow?.name ?? cachedMetric?.name ?? hyp.logic_id;
  const isStale = !cachedMetric || cachedMetric.status === "stale";
  const liveValue = cachedMetric?.value ?? "—";

  const currentStatus: HypothesisStatus = statusPending ?? (hyp.status as HypothesisStatus);

  const handleStatusChange = async (s: HypothesisStatus) => {
    if (s === hyp.status) return;
    setStatusPending(s);
    setErr(null);
    try {
      await hypothesesApi.updateStatus(hyp.id, s);
      onUpdated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Status update failed");
      setStatusPending(null);
    }
  };

  const handleDelete = async () => {
    setDeleting(true); setErr(null);
    try {
      await hypothesesApi.delete(hyp.id);
      onDeleted();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setDeleting(false);
    }
  };

  return (
    <Drawer
      width={460}
      onClose={onClose}
      header={
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "12px 16px 12px 20px",
          borderBottom: "1px solid var(--border-secondary)", flexShrink: 0,
        }}>
          <HypStatusBadge status={currentStatus} />
          {hyp.source === "agent" && <AgentBadge />}
          <span style={{ flex: 1 }} />
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </div>
      }
      footer={
        <div style={{
          padding: "12px 20px 20px",
          display: "flex", gap: 8, alignItems: "center",
        }}>
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              border: "none", background: "transparent", padding: "0 4px",
              fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500,
              color: "var(--error-600)", cursor: deleting ? "not-allowed" : "pointer",
              opacity: deleting ? 0.5 : 1,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
          <span style={{ flex: 1 }} />
          <Button hierarchy="secondary" onClick={onClose}>Close</Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 20, paddingBottom: 12 }}>
        {/* stale error banner */}
        {hyp.logic_id && isStale && (
          <ErrorBanner
            component={`Logic "${metricName}"`}
            process="computation stopped"
            detail="The engine could not produce a current value for this metric."
            action={<Button hierarchy="tertiary" size="sm">Check Syncs → Run now</Button>}
            severity="warning"
          />
        )}

        {err && (
          <ErrorBanner
            component="Hypothesis"
            process="update stopped"
            detail={err}
            action={<Button hierarchy="tertiary" size="sm" onClick={() => setErr(null)}>Dismiss</Button>}
          />
        )}

        {/* 1. Statement */}
        <div>
          <div style={{
            fontSize: 11, fontWeight: 600, textTransform: "uppercase",
            letterSpacing: "0.05em", color: "var(--text-quaternary)", marginBottom: 8,
          }}>
            Statement
          </div>
          <p style={{
            fontSize: 15, lineHeight: "22px", color: "var(--text-primary)",
            margin: 0, userSelect: "text",
          }}>
            {hyp.statement}
          </p>
        </div>

        <div style={{ height: 1, background: "var(--border-tertiary)" }} />

        {/* 2. Linked metric mini-card */}
        <div>
          <div style={{
            fontSize: 11, fontWeight: 600, textTransform: "uppercase",
            letterSpacing: "0.05em", color: "var(--text-quaternary)", marginBottom: 8,
          }}>
            Linked metric
          </div>

          {(logicRow || cachedMetric) ? (
            <div style={{
              background: "var(--color-white)", border: isStale ? "1px solid var(--warning-300)" : "1px solid var(--brand-200)",
              borderRadius: "var(--radius-2xl)", boxShadow: "var(--shadow-xs)", padding: 14,
              display: "flex", flexDirection: "column", gap: 10,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{metricName}</span>
                {isStale && <Badge tone="warning">stale</Badge>}
                {!isStale && reportId && (
                  <button
                    onClick={handleTrace}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 5,
                      border: "1px solid var(--border-primary)", background: "var(--color-white)",
                      borderRadius: "var(--radius-md)", padding: "5px 9px",
                      fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500,
                      color: "var(--text-secondary)", cursor: "pointer", boxShadow: "var(--shadow-xs)",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-white)"; }}
                  >
                    <GitBranch size={12} /> Trace
                  </button>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span
                  className="tnum"
                  style={{
                    fontSize: 23, fontWeight: 600, letterSpacing: "-0.3px",
                    color: isStale ? "var(--text-quaternary)" : "var(--text-primary)",
                    fontFamily: isStale ? "var(--font-mono)" : undefined,
                  }}
                >
                  {isStale ? "—" : liveValue}
                </span>
                {/* Drawer sparkline: show trend alongside the live value */}
                {!isStale && Array.isArray(hyp.spark) && hyp.spark.length > 1 && (
                  <div aria-hidden="true">
                    <Sparkline
                      data={hyp.spark}
                      w={80}
                      h={32}
                      color={hypSparklineColor(hyp.status)}
                    />
                  </div>
                )}
              </div>
              {!isStale && metricName && (
                <p style={{ fontSize: 12, color: "var(--text-quaternary)", margin: 0 }}>
                  This hypothesis is about {metricName}, now at {liveValue}.
                </p>
              )}
            </div>
          ) : hyp.logic_id ? (
            /* Logic deleted */
            <div style={{
              padding: "12px 14px", border: "1px solid var(--border-secondary)",
              borderRadius: "var(--radius-xl)", background: "var(--gray-25)",
            }}>
              <span style={{ fontSize: 13, color: "var(--text-quaternary)" }}>
                The linked Logic was removed. This hypothesis is now unlinked.
              </span>
            </div>
          ) : (
            /* No metric linked */
            <div style={{
              padding: "12px 14px", border: "1px dashed var(--border-primary)",
              borderRadius: "var(--radius-xl)", background: "var(--gray-25)",
            }}>
              <span style={{ fontSize: 13, color: "var(--text-quaternary)" }}>
                No metric linked. A linked metric anchors this hypothesis to a live, verifiable number.
              </span>
            </div>
          )}
        </div>

        <div style={{ height: 1, background: "var(--border-tertiary)" }} />

        {/* 3. Evidence */}
        <div>
          <div style={{
            fontSize: 11, fontWeight: 600, textTransform: "uppercase",
            letterSpacing: "0.05em", color: "var(--text-quaternary)", marginBottom: 8,
          }}>
            Evidence / rationale
          </div>
          {hyp.evidence ? (
            <p style={{ fontSize: 14, lineHeight: "21px", color: "var(--text-secondary)", margin: 0 }}>
              {hyp.evidence}
            </p>
          ) : (
            <p style={{ fontSize: 14, color: "var(--text-quaternary)", margin: 0, fontStyle: "italic" }}>
              No evidence recorded.
            </p>
          )}
        </div>

        <div style={{ height: 1, background: "var(--border-tertiary)" }} />

        {/* 4. Status workflow control */}
        <div>
          <div style={{
            fontSize: 11, fontWeight: 600, textTransform: "uppercase",
            letterSpacing: "0.05em", color: "var(--text-quaternary)", marginBottom: 8,
          }}>
            Status
          </div>
          <Segmented<HypothesisStatus>
            value={currentStatus}
            options={STATUS_WORKFLOW_OPTIONS}
            onChange={handleStatusChange}
          />
          {hyp.source === "agent" && hyp.status === "proposed" && (
            <p style={{ fontSize: 12, color: "var(--text-quaternary)", margin: "8px 0 0", lineHeight: "17px" }}>
              Proposed by agent. You advance status.
            </p>
          )}
        </div>

        {/* 5. Source */}
        <div style={{ fontSize: 12, color: "var(--text-quaternary)" }}>
          {hyp.source === "agent" ? "Proposed by agent" : "Proposed by you"} · {relativeTime(hyp.created_at).full}
        </div>
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* HypothesesView (main export)                                       */
/* ------------------------------------------------------------------ */

export function HypothesesView() {
  const hypothesesStatusFilter = useApp((s) => s.hypothesesStatusFilter);
  const setHypothesesStatusFilter = useApp((s) => s.setHypothesesStatusFilter);
  const hypothesesDrawerId = useApp((s) => s.hypothesesDrawerId);
  const openHypothesisDrawer = useApp((s) => s.openHypothesisDrawer);
  const closeHypothesisDrawer = useApp((s) => s.closeHypothesisDrawer);

  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const lastUpdated = useRef<Date | null>(null);

  const { data: hypotheses = [], isLoading: loading, isError, error: queryError, refetch } = useQuery({
    queryKey: queryKeys.hypotheses(),
    queryFn: () => hypothesesQueryFn(),
    staleTime: 2 * 60 * 1000,
    select: (rows) => { lastUpdated.current = new Date(); return rows; },
  });

  const error = isError ? (queryError instanceof Error ? queryError.message : "Failed to load hypotheses") : null;

  // Filtered list
  const filtered = useMemo(() => {
    return hypotheses.filter((h) => {
      if (hypothesesStatusFilter && h.status !== hypothesesStatusFilter) return false;
      if (search && !h.statement.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [hypotheses, hypothesesStatusFilter, search]);

  // Open drawer item (resolved from full list, not filtered — to survive filter changes)
  const drawerHyp = hypothesesDrawerId
    ? hypotheses.find((h) => h.id === hypothesesDrawerId) ?? null
    : null;

  // Grouped for the full log (statusFilter === "")
  const grouped = useMemo(() => {
    const byStatus: Record<HypothesisStatus, HypothesisRow[]> = {
      proposed: [], testing: [], confirmed: [], rejected: [],
    };
    filtered.forEach((h) => {
      const s = h.status as HypothesisStatus;
      if (s in byStatus) byStatus[s].push(h);
    });
    return byStatus;
  }, [filtered]);

  const isFiltered = !!hypothesesStatusFilter;
  const isEmpty = filtered.length === 0;

  const formatLastUpdated = () => {
    if (!lastUpdated.current) return null;
    return `Last updated ${relativeTime(lastUpdated.current.toISOString()).full}`;
  };

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
      background: "var(--surface-secondary)", position: "relative",
    }}>
      {/* top bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        padding: "11px 20px 11px", borderBottom: "1px solid var(--border-secondary)",
        flexShrink: 0, background: "var(--surface-secondary)", zIndex: 20,
      }}>
        {/* status filter segmented */}
        <Segmented<string>
          value={hypothesesStatusFilter}
          options={STATUS_FILTER_OPTIONS as unknown as { value: string; label: string }[]}
          onChange={setHypothesesStatusFilter}
        />

        {/* search */}
        <div style={{ position: "relative" }}>
          <Search size={13} style={{
            position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
            color: "var(--text-quaternary)", pointerEvents: "none",
          }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search hypotheses"
            aria-label="Search hypotheses"
            style={{
              width: 200, height: 34, padding: "0 10px 0 30px", fontSize: 13,
              fontFamily: "var(--font-sans)", color: "var(--text-primary)",
              background: "var(--color-white)", border: "1px solid var(--border-secondary)",
              borderRadius: "var(--radius-md)", outline: "none", boxShadow: "var(--shadow-xs)",
            }}
          />
        </div>

        <span style={{ flex: 1 }} />

        {loading && <Loader2 size={14} color="var(--text-quaternary)" style={{ animation: "eh-spin 1s linear infinite" }} />}
        {!loading && lastUpdated.current && (
          <span className="tnum" style={{ fontSize: 12, color: "var(--text-quaternary)", whiteSpace: "nowrap" }}>
            {formatLastUpdated()}
          </span>
        )}

        <Button
          hierarchy="primary"
          size="sm"
          iconLeading={<Plus size={14} />}
          onClick={() => setShowCreate(true)}
        >
          Hypothesis
        </Button>
      </div>

      {/* body */}
      <div className="eh-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {error && (
          <div style={{ padding: "16px 24px 0" }}>
            <ErrorBanner
              component="Hypotheses"
              process="loading stopped"
              detail={error}
              action={<Button hierarchy="tertiary" size="sm" onClick={() => void refetch()}>Retry</Button>}
            />
          </div>
        )}

        {loading && hypotheses.length === 0 && !error && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "64px 24px" }}>
            <Loader2 size={22} color="var(--text-quaternary)" style={{ animation: "eh-spin 1s linear infinite" }} />
          </div>
        )}

        {!loading && !error && isEmpty && (
          isFiltered ? (
            /* filtered empty state */
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px", gap: 10 }}>
              <EmptyState
                line={`No ${statusLabel(hypothesesStatusFilter as HypothesisStatus)} hypotheses.`}
                button={
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <Button hierarchy="primary" iconLeading={<Plus size={14} />} onClick={() => setShowCreate(true)}>
                      Hypothesis
                    </Button>
                    <span style={{ fontSize: 13, color: "var(--text-quaternary)" }}>
                      Your agent can propose via MCP, or add one manually.
                    </span>
                  </div>
                }
              />
            </div>
          ) : (
            /* global empty state */
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px", gap: 10 }}>
              <EmptyState
                line="No hypotheses yet."
                button={
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <Button hierarchy="primary" iconLeading={<Plus size={14} />} onClick={() => setShowCreate(true)}>
                      Hypothesis
                    </Button>
                    <span style={{ fontSize: 13, color: "var(--text-quaternary)" }}>
                      Add one yourself, or let your agent propose hypotheses via MCP.
                    </span>
                  </div>
                }
              />
            </div>
          )
        )}

        {!error && !isEmpty && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "16px 24px 48px" }}>
            {isFiltered ? (
              /* Flat list when a specific status is selected */
              <div style={{
                background: "var(--color-white)", border: "1px solid var(--border-secondary)",
                borderRadius: "var(--radius-2xl)", overflow: "hidden",
              }}>
                {filtered.map((h) => (
                  <HypothesisRow
                    key={h.id}
                    hyp={h}
                    onClick={() => openHypothesisDrawer(h.id)}
                  />
                ))}
              </div>
            ) : (
              /* Grouped by status */
              STATUS_ORDER.map((status) => (
                <StatusSection
                  key={status}
                  status={status}
                  hypotheses={grouped[status]}
                  onOpenDrawer={openHypothesisDrawer}
                />
              ))
            )}
          </div>
        )}
      </div>

      {/* create drawer */}
      {showCreate && (
        <CreateHypothesisDrawer
          onClose={() => setShowCreate(false)}
          onCreated={() => void invalidate.hypotheses()}
        />
      )}

      {/* detail drawer */}
      {drawerHyp && (
        <HypothesisDetailDrawer
          hyp={drawerHyp}
          onClose={closeHypothesisDrawer}
          onUpdated={() => void invalidate.hypotheses()}
          onDeleted={() => void invalidate.hypotheses()}
        />
      )}

    </div>
  );
}
