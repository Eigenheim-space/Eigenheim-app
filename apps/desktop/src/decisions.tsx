/**
 * decisions.tsx — Decisions mode center surface.
 *
 * Wired to:
 *   GET  /decisions           — list (no metric snapshots)
 *   GET  /decisions/{id}      — single decision with captured metric snapshot
 *   POST /decisions           — create + capture metric snapshot
 *   PATCH /decisions/{id}     — update title / rationale / status
 *   DELETE /decisions/{id}    — delete
 *
 * Hard rules (brief 10 + CLAUDE.md):
 *   - No DC runtime imports.
 *   - English-first copy, blunt second person, no SaaS slop.
 *   - LIGHT aesthetic: white surfaces, brand green #099250, no purple, no glassmorphism.
 *   - The frozen snapshot MUST read as immutable: left-border tint, muted bg,
 *     `Immutable` label + lock icon, no edit affordance inside the block.
 *   - Trace link on EVERY snapshot row — always visible, never hover-only.
 *   - Captured timestamp uses ISO datetime tabular-nums (YYYY-MM-DD HH:MM), never relative.
 *   - tabular-nums on every numeric value, date, and metric count.
 *   - Status = color + text (never color alone).
 *   - Captured metrics in edit drawer are grayed + locked; they cannot be deselected.
 *   - Right data panel (Events / Logic / Syncs) is unchanged. Decisions fills center only.
 */

import {
  useState, useMemo, useRef,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  GitBranch, Plus, X, ChevronDown, Loader2,
  Lock, ArrowLeft, Search,
} from "lucide-react";
import { useApp } from "./store";
import {
  decisionsApi,
  type DecisionListItem,
  type DecisionRow,
  type DecisionMetricRow,
} from "./api";
import type { LogicRow } from "./data";
import { queryKeys, decisionsListQueryFn, decisionDetailQueryFn, bootstrapQueryFn, invalidate, findReportForMetric } from "./queries";
import {
  Badge, Button, IconButton, EmptyState, ErrorBanner, Tooltip, Segmented, Drawer,
} from "./ui";
import { ChatAffordance } from "./chat/ChatOverlay";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type DecisionStatus = "Open" | "Revisit" | "Closed";

const STATUS_OPTIONS: { value: DecisionStatus; label: string }[] = [
  { value: "Open", label: "Open" },
  { value: "Revisit", label: "Revisit" },
  { value: "Closed", label: "Closed" },
];

const STATUS_FILTER_OPTIONS = [
  { value: "", label: "All" },
  { value: "Open", label: "Open" },
  { value: "Revisit", label: "Revisit" },
  { value: "Closed", label: "Closed" },
] as const;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function decisionStatusTone(status: string): "info" | "warning" | "neutral" {
  if (status === "Open") return "info";
  if (status === "Revisit") return "warning";
  return "neutral";
}

/** Format ISO datetime string as YYYY-MM-DD HH:MM (tabular, never relative) */
function isoDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Format as YYYY-MM-DD only */
function isoDate(iso: string): string {
  if (!iso) return "—";
  return isoDateTime(iso).slice(0, 10);
}

function daysBetween(earlier: string, later: string): number {
  const a = new Date(earlier).getTime();
  const b = new Date(later).getTime();
  return Math.round((b - a) / 86400000);
}

function rationaleSnippet(text: string, max = 120): string {
  if (!text) return "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
}

/** Format a captured metric value for display */
function fmtValue(v: number | null | undefined): string {
  if (v == null) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/* ------------------------------------------------------------------ */
/* Status badge                                                         */
/* ------------------------------------------------------------------ */

function DecisionStatusBadge({ status }: { status: string }) {
  const tone = decisionStatusTone(status);
  return <Badge tone={tone}>{status || "Open"}</Badge>;
}

/* ------------------------------------------------------------------ */
/* MetricCount chip                                                     */
/* ------------------------------------------------------------------ */

function MetricCountChip({ count }: { count: number | undefined }) {
  if (count === undefined) {
    // Count unknown (list endpoint doesn't return it) — show nothing.
    return null;
  }
  if (count === 0) {
    return <Badge tone="warning">No snapshot</Badge>;
  }
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      fontSize: 12, fontWeight: 500, color: "var(--text-tertiary)",
      background: "var(--gray-100)", borderRadius: "var(--radius-badge)",
      padding: "1px 7px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
    }}>
      {count} metric{count !== 1 ? "s" : ""}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Decision timeline row                                                */
/* ------------------------------------------------------------------ */

function DecisionTimelineRow({
  decision,
  metricCount,
  onClick,
}: {
  decision: DecisionListItem;
  metricCount: number | undefined;
  onClick: () => void;
}) {
  const snippet = rationaleSnippet(decision.rationale);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      className="eh-task-row"
      style={{
        display: "flex", alignItems: "flex-start", gap: 12, padding: "11px 18px",
        borderTop: "1px solid var(--border-tertiary)", minHeight: 56, cursor: "pointer",
      }}
    >
      {/* date */}
      <span className="tnum" style={{
        fontSize: 12, color: "var(--text-quaternary)", whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums", minWidth: 90, paddingTop: 2, flexShrink: 0,
      }}>
        {isoDate(decision.created_at)}
      </span>

      {/* title + snippet */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{
          fontSize: 14, fontWeight: 600, color: "var(--text-primary)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {decision.title}
        </span>
        {snippet && (
          <span style={{
            fontSize: 12, color: "var(--text-tertiary)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {snippet}
          </span>
        )}
      </div>

      {/* right chips */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <MetricCountChip count={metricCount} />
        <DecisionStatusBadge status={decision.status} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Frozen metric snapshot table                                         */
/* ------------------------------------------------------------------ */

function FrozenSnapshotTable({
  metrics,
  capturedAt,
  decisionDate,
  logicMap,
  onTrace,
}: {
  metrics: DecisionMetricRow[];
  capturedAt: string;   // ISO of the first metric's captured_at
  decisionDate: string; // ISO created_at of the decision
  logicMap: Map<string, string>; // logic_id -> name
  onTrace: (traceRef: string, logicId: string) => void;
}) {
  const lateDays = capturedAt ? daysBetween(decisionDate, capturedAt) : 0;

  return (
    <div style={{
      borderLeft: "4px solid var(--border-primary)",
      background: "var(--gray-50)",
      borderRadius: "var(--radius-card)",
      overflow: "hidden",
      marginTop: 4,
    }}>
      {/* section header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 14px", borderBottom: "1px solid var(--border-secondary)",
        background: "var(--gray-50)",
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>
          Metric snapshot
        </span>
        <span style={{ fontSize: 12, color: "var(--text-quaternary)" }}>·</span>
        <span className="tnum" style={{ fontSize: 12, color: "var(--text-quaternary)", fontVariantNumeric: "tabular-nums" }}>
          Captured {isoDateTime(capturedAt)}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-quaternary)" }}>·</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-quaternary)" }}>
          <Lock size={13} style={{ flexShrink: 0 }} />
          Immutable
        </span>
        {lateDays > 7 && (
          <>
            <span style={{ fontSize: 12, color: "var(--text-quaternary)" }}>·</span>
            <span className="tnum" style={{ fontSize: 12, color: "var(--warning-700)", fontVariantNumeric: "tabular-nums" }}>
              Captured {lateDays} days after the decision date.
            </span>
          </>
        )}
      </div>

      {/* table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "auto" }}>
          <thead>
            <tr style={{ background: "var(--gray-100)" }}>
              <th style={{ ...thStyle, textAlign: "left" }}>Metric name</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Value at decision</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Captured</th>
              <th style={{ ...thStyle, textAlign: "center" }}>Trace</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m, i) => {
              const name = logicMap.get(m.logic_id) ?? m.logic_id;
              const hasTrace = !!m.trace_ref;
              const isLast = i === metrics.length - 1;
              return (
                <tr key={m.id} style={{ borderTop: "1px solid var(--border-tertiary)" }}>
                  <td style={{ ...tdStyle, borderBottom: isLast ? "none" : undefined, fontSize: 14, color: "var(--text-primary)" }}>
                    {name}
                  </td>
                  <td className="tnum" style={{
                    ...tdStyle, textAlign: "right", borderBottom: isLast ? "none" : undefined,
                    fontSize: 20, fontWeight: 600, fontVariantNumeric: "tabular-nums",
                    color: "var(--text-primary)", letterSpacing: "-0.2px",
                    cursor: "default",
                  }}>
                    {fmtValue(m.captured_value)}
                  </td>
                  <td className="tnum" style={{
                    ...tdStyle, textAlign: "right", borderBottom: isLast ? "none" : undefined,
                    fontSize: 12, color: "var(--text-quaternary)", fontVariantNumeric: "tabular-nums",
                  }}>
                    {isoDateTime(m.captured_at)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "center", borderBottom: isLast ? "none" : undefined }}>
                    {hasTrace ? (
                      <button
                        onClick={() => onTrace(m.trace_ref, m.logic_id)}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 5,
                          border: "1px solid var(--border-primary)", background: "var(--color-white)",
                          borderRadius: "var(--radius-md)", padding: "4px 9px",
                          fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500,
                          color: "var(--text-secondary)", cursor: "pointer", boxShadow: "var(--shadow-xs)",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-white)"; }}
                      >
                        <GitBranch size={12} />Trace
                      </button>
                    ) : (
                      <Tooltip content="Logic deleted. Trace unavailable.">
                        <span style={{ fontSize: 13, color: "var(--text-quaternary)" }}>—</span>
                      </Tooltip>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "8px 14px", fontSize: 11, fontWeight: 600,
  textTransform: "uppercase", letterSpacing: "0.04em",
  color: "var(--text-quaternary)", whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
  padding: "10px 14px", verticalAlign: "middle",
};

/* ------------------------------------------------------------------ */
/* Decision detail view (full center replacement)                       */
/* ------------------------------------------------------------------ */

function DecisionDetail({
  id,
  onBack,
  onEdit,
  onDeleted,
  logicMap,
}: {
  id: string;
  onBack: () => void;
  onEdit: (d: DecisionRow) => void;
  onDeleted: () => void;
  logicMap: Map<string, string>;
}) {
  const openTrace = useApp((s) => s.openTrace);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: decision, isLoading: loading, isError, error: queryError } = useQuery({
    queryKey: queryKeys.decision(id),
    queryFn: () => decisionDetailQueryFn(id),
    staleTime: 2 * 60 * 1000,
  });
  const error = isError ? (queryError instanceof Error ? queryError.message : "unknown error") : null;

  const handleDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    try {
      await decisionsApi.delete(id);
      await invalidate.decisions();
      onDeleted();
    } catch (e) {
      setDeleting(false); setConfirmDelete(false);
    }
  };

  // Dynamic per-row trace: logicId varies per metric row, so we call findReportForMetric
  // directly in the handler rather than hooking (hook would be called once per render
  // for a single static id, not once per row). No window.alert fallback — no-op when
  // no report contains this logic entry; the trace button is disabled in that case.
  const handleTrace = (_traceRef: string, logicId: string) => {
    const rep = findReportForMetric(logicId);
    if (rep && logicId) openTrace(rep.id, logicId);
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, padding: 64 }}>
        <Loader2 size={22} color="var(--text-quaternary)" style={{ animation: "eh-spin 1s linear infinite" }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="eh-scroll" style={{ flex: 1, overflowY: "auto", padding: "16px 28px 48px", display: "flex", flexDirection: "column", gap: 12 }}>
        <button
          onClick={onBack}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            border: "none", background: "transparent", padding: "4px 0",
            fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500,
            color: "var(--text-tertiary)", cursor: "pointer",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--brand-700)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
        >
          <ArrowLeft size={14} />Decisions
        </button>
        <ErrorBanner
          component="Decision snapshot"
          process="metric values could not be loaded"
          detail={error}
          action={<Button hierarchy="tertiary" size="sm" onClick={onBack}>Back</Button>}
        />
      </div>
    );
  }

  if (!decision) return null;

  const capturedAt = decision.metrics[0]?.captured_at ?? decision.created_at;
  const hasMetrics = decision.metrics.length > 0;

  return (
    <div className="eh-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "16px 28px 56px", display: "flex", flexDirection: "column", gap: 20 }}>
      {/* breadcrumb */}
      <button
        onClick={onBack}
        tabIndex={0}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, alignSelf: "flex-start",
          border: "none", background: "transparent", padding: "4px 0",
          fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500,
          color: "var(--text-tertiary)", cursor: "pointer",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--brand-700)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
      >
        <ArrowLeft size={14} />Decisions
      </button>

      {/* header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0, lineHeight: "26px", letterSpacing: "-0.2px" }}>
            {decision.title}
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <DecisionStatusBadge status={decision.status} />
            <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Decided on</span>
            <span className="tnum" style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
              {isoDate(decision.created_at)}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <Button
            hierarchy="secondary"
            size="sm"
            onClick={() => onEdit(decision)}
          >
            Edit
          </Button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              border: "none", background: "transparent", padding: "4px 0",
              fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500,
              color: confirmDelete ? "var(--error-600)" : "var(--text-quaternary)",
              cursor: deleting ? "not-allowed" : "pointer",
            }}
            onMouseEnter={(e) => { if (!deleting) e.currentTarget.style.color = "var(--error-600)"; }}
            onMouseLeave={(e) => { if (!deleting && !confirmDelete) e.currentTarget.style.color = "var(--text-quaternary)"; }}
          >
            {deleting ? "Deleting…" : confirmDelete ? "Confirm delete" : "Delete"}
          </button>
          {confirmDelete && !deleting && (
            <button
              onClick={() => setConfirmDelete(false)}
              style={{ border: "none", background: "transparent", padding: "4px 0", fontFamily: "var(--font-sans)", fontSize: 13, color: "var(--text-quaternary)", cursor: "pointer" }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      <div style={{ height: 1, background: "var(--border-secondary)" }} />

      {/* rationale */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-quaternary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Rationale
        </span>
        <p style={{ fontSize: 14, lineHeight: "1.6", color: "var(--text-primary)", margin: 0, whiteSpace: "pre-wrap" }}>
          {decision.rationale || <span style={{ color: "var(--text-quaternary)", fontStyle: "italic" }}>No rationale provided.</span>}
        </p>
      </div>

      <div style={{ height: 1, background: "var(--border-secondary)" }} />

      {/* frozen metric snapshot */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-quaternary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Metric snapshot
        </span>
        {hasMetrics ? (
          <FrozenSnapshotTable
            metrics={decision.metrics}
            capturedAt={capturedAt}
            decisionDate={decision.created_at}
            logicMap={logicMap}
            onTrace={handleTrace}
          />
        ) : (
          <div style={{
            borderLeft: "4px solid var(--border-primary)",
            background: "var(--gray-50)",
            borderRadius: "var(--radius-card)",
            padding: "20px 18px",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Lock size={14} color="var(--text-quaternary)" />
              <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>
                No metrics were captured for this decision.
              </span>
            </div>
            <button
              onClick={() => onEdit(decision)}
              style={{
                alignSelf: "flex-start", border: "none", background: "transparent",
                padding: "2px 0", fontFamily: "var(--font-sans)", fontSize: 13,
                fontWeight: 500, color: "var(--brand-700)", cursor: "pointer",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
            >
              Edit decision
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Metric picker (for create / edit drawer)                            */
/* ------------------------------------------------------------------ */

interface LogicPickerItem {
  id: string;
  name: string;
  version?: string;
  usage_count?: number;
  current_value?: number | null;
}

function MetricPicker({
  logics,
  selected,       // ids already captured (locked in edit mode)
  added,          // ids newly added this session
  onAdd,
  onRemove,
}: {
  logics: LogicPickerItem[];
  selected: string[];
  added: string[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return logics.filter((l) =>
      !selected.includes(l.id) && !added.includes(l.id) &&
      l.name.toLowerCase().includes(q)
    );
  }, [logics, selected, added, search]);

  if (logics.length === 0) {
    return (
      <div style={{
        border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-md)",
        padding: "14px 16px", display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>
          No Logics yet. Create a Logic in the right panel.
        </span>
      </div>
    );
  }

  const allAdded = [...selected, ...added];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* search */}
      <div style={{ position: "relative" }}>
        <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-quaternary)", pointerEvents: "none" }} />
        <input
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search metrics…"
          aria-label="Search metrics"
          tabIndex={0}
          style={{
            width: "100%", height: 36, padding: "0 10px 0 32px", fontSize: 13,
            fontFamily: "var(--font-sans)", color: "var(--text-primary)",
            background: "var(--color-white)", border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-md)", outline: "none", boxSizing: "border-box",
          }}
        />
      </div>

      {/* results */}
      {filtered.length > 0 && (
        <div style={{
          border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-md)",
          overflow: "hidden", maxHeight: 200, overflowY: "auto",
        }} className="eh-scroll">
          {filtered.map((l, i) => (
            <button
              key={l.id}
              onClick={() => { onAdd(l.id); setSearch(""); }}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%",
                padding: "9px 14px", border: "none", borderTop: i > 0 ? "1px solid var(--border-tertiary)" : "none",
                background: "transparent", cursor: "pointer", fontFamily: "var(--font-sans)",
                textAlign: "left",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {l.name}
                </div>
                {(l.version || l.usage_count != null) && (
                  <div style={{ fontSize: 11, color: "var(--text-quaternary)", marginTop: 1 }}>
                    {l.version && <span>v{l.version}</span>}
                    {l.usage_count != null && <span> · in {l.usage_count} report{l.usage_count !== 1 ? "s" : ""}</span>}
                  </div>
                )}
              </div>
              {l.current_value != null && (
                <span className="tnum" style={{ fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {fmtValue(l.current_value)}
                </span>
              )}
              <Plus size={14} color="var(--brand-600)" style={{ flexShrink: 0 }} />
            </button>
          ))}
        </div>
      )}

      {/* selected list */}
      {allAdded.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-quaternary)", marginBottom: 4 }}>
            Selected metrics
          </span>
          {/* locked (already captured) */}
          {selected.map((id) => {
            const l = logics.find((x) => x.id === id);
            return (
              <div key={id} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 12px", background: "var(--gray-50)",
                border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-md)",
                opacity: 0.7,
              }}>
                <Lock size={12} color="var(--text-quaternary)" style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 13, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {l?.name ?? id}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-quaternary)" }}>captured</span>
              </div>
            );
          })}
          {/* newly added */}
          {added.map((id) => {
            const l = logics.find((x) => x.id === id);
            return (
              <div key={id} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 12px", background: "var(--color-white)",
                border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-md)",
              }}>
                <span style={{ flex: 1, fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {l?.name ?? id}
                </span>
                {l?.current_value != null && (
                  <span className="tnum" style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                    {fmtValue(l.current_value)}
                  </span>
                )}
                <button
                  onClick={() => onRemove(id)}
                  style={{ border: "none", background: "transparent", padding: 2, cursor: "pointer", display: "flex", alignItems: "center" }}
                  aria-label="Remove metric"
                >
                  <X size={14} color="var(--text-quaternary)" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create / edit drawer                                                 */
/* ------------------------------------------------------------------ */

function DecisionDrawer({
  existingDecision,
  logics,
  onClose,
  onSaved,
}: {
  existingDecision: DecisionRow | null;
  logics: LogicPickerItem[];
  onClose: () => void;
  onSaved: (d: DecisionRow) => void;
}) {
  const isEdit = existingDecision != null;

  // Already-captured metric ids (locked in edit mode)
  const capturedIds = useMemo(() =>
    existingDecision?.metrics.map((m) => m.logic_id) ?? []
  , [existingDecision]);

  const todayStr = new Date().toISOString().slice(0, 10);

  const [title, setTitle] = useState(existingDecision?.title ?? "");
  const [rationale, setRationale] = useState(existingDecision?.rationale ?? "");
  const [status, setStatus] = useState<DecisionStatus>(
    (existingDecision?.status as DecisionStatus) || "Open"
  );
  const [addedIds, setAddedIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const titleErr = !title.trim();

  const handleSave = async () => {
    if (titleErr) return;
    setSaving(true); setSaveError(null);
    try {
      let result: DecisionRow;
      if (isEdit) {
        // PATCH updates title / rationale / status only. Captured metrics are immutable.
        result = await decisionsApi.update(existingDecision!.id, { title: title.trim(), rationale, status });
      } else {
        result = await decisionsApi.create({
          title: title.trim(),
          rationale,
          status,
          metric_logic_ids: addedIds,
        });
      }
      onSaved(result);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      width={480}
      onClose={onClose}
      header={
        <div style={{
          display: "flex", alignItems: "center", padding: "16px 20px",
          borderBottom: "1px solid var(--border-secondary)", flexShrink: 0,
          background: "var(--color-white)",
        }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>
            {isEdit ? "Edit decision" : "New decision"}
          </span>
          <span style={{ flex: 1 }} />
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </div>
      }
      footer={
        <div style={{ display: "flex", gap: 10, padding: "14px 20px" }}>
          <Button
            hierarchy="primary"
            style={{ flex: 1 }}
            disabled={titleErr || !rationale.trim() || saving}
            onClick={handleSave}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button hierarchy="secondary" style={{ flex: 1 }} onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* title */}
          <label style={{ display: "block" }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
              Title <span style={{ color: "var(--error-500)" }}>*</span>
            </div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What did you decide?"
              tabIndex={0}
              style={{
                width: "100%", height: 40, padding: "0 12px", fontSize: 14,
                fontFamily: "var(--font-sans)", color: "var(--text-primary)",
                background: "var(--color-white)",
                border: `1px solid ${titleErr && title !== "" ? "var(--error-300)" : "var(--border-primary)"}`,
                borderRadius: "var(--radius-input)", outline: "none", boxSizing: "border-box",
              }}
            />
          </label>

          {/* decision date — read only display in v1 (set server-side as created_at) */}
          <label style={{ display: "block" }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
              Decision date
            </div>
            <input
              type="date"
              defaultValue={isEdit ? isoDate(existingDecision!.created_at) : todayStr}
              readOnly
              tabIndex={-1}
              className="tnum"
              style={{
                width: "100%", height: 40, padding: "0 12px", fontSize: 14,
                fontFamily: "var(--font-sans)", color: "var(--text-tertiary)",
                background: "var(--gray-50)", border: "1px solid var(--border-secondary)",
                borderRadius: "var(--radius-input)", outline: "none", boxSizing: "border-box",
                fontVariantNumeric: "tabular-nums",
              }}
            />
            <div style={{ fontSize: 12, color: "var(--text-quaternary)", marginTop: 4 }}>
              Set at creation. The engine timestamps the decision at save time.
            </div>
          </label>

          {/* status */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 8 }}>
              Status
            </div>
            <Segmented
              value={status}
              options={STATUS_OPTIONS}
              onChange={(v) => setStatus(v as DecisionStatus)}
            />
          </div>

          {/* rationale */}
          <label style={{ display: "block" }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
              Rationale <span style={{ color: "var(--error-500)" }}>*</span>
            </div>
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="What did we decide and why?"
              rows={5}
              tabIndex={0}
              style={{
                width: "100%", padding: "10px 12px", fontSize: 14,
                fontFamily: "var(--font-sans)", color: "var(--text-primary)",
                background: "var(--color-white)", border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-input)", outline: "none", resize: "vertical",
                minHeight: 100, lineHeight: "1.5", boxSizing: "border-box",
              }}
            />
          </label>

          {/* metric picker */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 4 }}>
              Captured metrics
            </div>
            {isEdit ? (
              // In edit mode the snapshot is immutable — only show what's already captured.
              // Adding new metrics to an existing decision requires a new decision (engine v1 constraint).
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {capturedIds.length === 0 ? (
                  <span style={{ fontSize: 13, color: "var(--text-quaternary)" }}>
                    No metrics were captured for this decision.
                  </span>
                ) : (
                  capturedIds.map((id) => {
                    const l = logics.find((x) => x.id === id);
                    return (
                      <div key={id} style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "8px 12px", background: "var(--gray-50)",
                        border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-md)",
                        opacity: 0.7,
                      }}>
                        <Lock size={12} color="var(--text-quaternary)" style={{ flexShrink: 0 }} />
                        <span style={{ flex: 1, fontSize: 13, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {l?.name ?? id}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--text-quaternary)" }}>captured</span>
                      </div>
                    );
                  })
                )}
                <div style={{ fontSize: 12, color: "var(--text-quaternary)", marginTop: 4 }}>
                  Captured metrics are immutable. To record additional metrics, create a new decision.
                </div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: "var(--text-quaternary)", marginBottom: 10 }}>
                  Select the metrics to freeze at this decision's moment. Values are captured on save and never updated again.
                </div>
                <MetricPicker
                  logics={logics}
                  selected={capturedIds}
                  added={addedIds}
                  onAdd={(id) => setAddedIds((prev) => [...prev, id])}
                  onRemove={(id) => setAddedIds((prev) => prev.filter((x) => x !== id))}
                />
              </>
            )}
          </div>

          {saveError && (
            <ErrorBanner
              component="Decisions"
              process="save stopped"
              detail={saveError}
              severity="error"
            />
          )}

          <div style={{ height: 16 }} />
        </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Decisions top bar                                                    */
/* ------------------------------------------------------------------ */

function DecisionsTopBar({
  search,
  onSearch,
  statusFilter,
  onStatusFilter,
  lastUpdated,
  onCreate,
}: {
  search: string;
  onSearch: (v: string) => void;
  statusFilter: string;
  onStatusFilter: (v: string) => void;
  lastUpdated: string | null;
  onCreate: () => void;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 10,
      padding: "13px 20px 12px", borderBottom: "1px solid var(--border-secondary)",
      flexShrink: 0, background: "var(--surface-secondary)", position: "relative", zIndex: 20,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {/* search */}
        <div style={{ position: "relative" }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-quaternary)", pointerEvents: "none" }} />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search decisions"
            aria-label="Search decisions"
            tabIndex={0}
            style={{
              width: 220, height: 34, padding: "0 10px 0 32px", fontSize: 13,
              fontFamily: "var(--font-sans)", color: "var(--text-primary)",
              background: "var(--color-white)", border: "1px solid var(--border-secondary)",
              borderRadius: "var(--radius-md)", outline: "none", boxShadow: "var(--shadow-xs)",
            }}
          />
        </div>

        {/* status filter */}
        <div style={{ position: "relative" }}>
          <StatusFilterSelect value={statusFilter} onChange={onStatusFilter} />
        </div>

        <span style={{ flex: 1 }} />

        {/* last updated */}
        {lastUpdated && (
          <span className="tnum" style={{ fontSize: 12, color: "var(--text-quaternary)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
            Last updated {isoDateTime(lastUpdated)}
          </span>
        )}

        <ChatAffordance />

        {/* create button */}
        <Button
          hierarchy="primary"
          size="sm"
          iconLeading={<Plus size={14} />}
          onClick={onCreate}
          tabIndex={0}
          style={{ minHeight: 34 }}
        >
          Decision
        </Button>
      </div>
    </div>
  );
}

function StatusFilterSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const label = STATUS_FILTER_OPTIONS.find((o) => o.value === value)?.label ?? "All";

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, height: 34, padding: "0 10px",
          border: "1px solid var(--border-secondary)", background: "var(--color-white)",
          borderRadius: "var(--radius-md)", cursor: "pointer", fontFamily: "var(--font-sans)",
          fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", boxShadow: "var(--shadow-xs)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-white)"; }}
      >
        {label}<ChevronDown size={13} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 9 }} />
          <div className="eh-fadein" style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: 140,
            background: "var(--color-white)", border: "1px solid var(--border-secondary)",
            borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-lg)", padding: 4,
            zIndex: 10, display: "flex", flexDirection: "column", gap: 1,
          }}>
            {STATUS_FILTER_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => { onChange(o.value); setOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", padding: "7px 10px",
                  border: "none", background: value === o.value ? "var(--brand-50)" : "transparent",
                  borderRadius: "var(--radius-md)", cursor: "pointer", fontFamily: "var(--font-sans)",
                  fontSize: 13, fontWeight: 500, color: value === o.value ? "var(--brand-700)" : "var(--text-secondary)",
                  width: "100%", textAlign: "left",
                }}
                onMouseEnter={(e) => { if (value !== o.value) e.currentTarget.style.background = "var(--gray-50)"; }}
                onMouseLeave={(e) => { if (value !== o.value) e.currentTarget.style.background = "transparent"; }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main DecisionsView export                                            */
/* ------------------------------------------------------------------ */

export function DecisionsView() {
  const decisionsDetailId = useApp((s) => s.decisionsDetailId);
  const decisionsDrawerId = useApp((s) => s.decisionsDrawerId);
  const openDecisionDetail = useApp((s) => s.openDecisionDetail);
  const closeDecisionDetail = useApp((s) => s.closeDecisionDetail);
  const openDecisionDrawer = useApp((s) => s.openDecisionDrawer);
  const closeDecisionDrawer = useApp((s) => s.closeDecisionDrawer);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [editDecision, setEditDecision] = useState<DecisionRow | null>(null);

  // Decisions list via react-query. The old N+1 (fetch each decision for metric_count)
  // is replaced by using the list items directly: DecisionListItemOut has no metric count
  // field from the engine, so metric counts are still loaded per-detail on demand
  // via the individual decision queries (prefetch when opening detail).
  const { data: decisions = [], isLoading: loading, isError, error: queryError, refetch } = useQuery({
    queryKey: queryKeys.decisions,
    queryFn: decisionsListQueryFn,
    staleTime: 2 * 60 * 1000,
  });

  // Bootstrap for logic options
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const storeLogic = bootstrap?.logic ?? [];

  const error = isError ? (queryError instanceof Error ? queryError.message : "failed to load decisions") : null;

  // Logic map for the metric picker and snapshot table
  const logicPickerItems: LogicPickerItem[] = useMemo(() =>
    storeLogic.map((l) => ({
      id: l.id,
      name: l.name,
      version: l.version ?? "",
    }))
  , [storeLogic]);

  const logicMap = useMemo(() => {
    const m = new Map<string, string>();
    storeLogic.forEach((l) => m.set(l.id, l.name));
    return m;
  }, [storeLogic]);

  const filteredDecisions = useMemo(() => {
    const q = search.toLowerCase();
    return decisions.filter((d) => {
      if (statusFilter && d.status !== statusFilter) return false;
      if (q && !d.title.toLowerCase().includes(q) && !d.rationale.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [decisions, search, statusFilter]);

  const lastUpdated = decisions[0]?.created_at ?? null;

  const handleCreate = () => {
    setEditDecision(null);
    openDecisionDrawer("new");
  };

  const handleEdit = (d: DecisionRow) => {
    setEditDecision(d);
    openDecisionDrawer(d.id);
  };

  const handleSaved = (saved: DecisionRow) => {
    closeDecisionDrawer();
    setEditDecision(null);
    void invalidate.decisions();
    // If we just created, open the detail view; otherwise stay
    if (!editDecision) {
      openDecisionDetail(saved.id);
    }
  };

  const handleDeleted = () => {
    closeDecisionDetail();
    void invalidate.decisions();
  };

  // Detail mode: replace center with the decision detail view
  if (decisionsDetailId) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-secondary)", position: "relative" }}>
        <DecisionDetail
          id={decisionsDetailId}
          onBack={closeDecisionDetail}
          onEdit={(d) => handleEdit(d)}
          onDeleted={handleDeleted}
          logicMap={logicMap}
        />
        {/* drawer still accessible from detail */}
        {decisionsDrawerId && (
          <DecisionDrawer
            existingDecision={editDecision}
            logics={logicPickerItems}
            onClose={() => { closeDecisionDrawer(); setEditDecision(null); }}
            onSaved={handleSaved}
          />
        )}
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-secondary)", position: "relative" }}>
      <DecisionsTopBar
        search={search}
        onSearch={setSearch}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        lastUpdated={lastUpdated}
        onCreate={handleCreate}
      />

      <div className="eh-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {loading && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "64px 24px" }}>
            <Loader2 size={22} color="var(--text-quaternary)" style={{ animation: "eh-spin 1s linear infinite" }} />
          </div>
        )}

        {!loading && error && (
          <div style={{ padding: "16px 24px 0" }}>
            <ErrorBanner
              component="Decisions"
              process="loading stopped"
              detail={error}
              action={<Button hierarchy="tertiary" size="sm" onClick={() => void refetch()}>Retry</Button>}
            />
          </div>
        )}

        {!loading && !error && decisions.length === 0 && (
          <EmptyState
            line="No decisions yet."
            button={
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <Button hierarchy="primary" iconLeading={<Plus size={15} />} onClick={handleCreate}>
                  Decision
                </Button>
                <span style={{ fontSize: 13, color: "var(--text-quaternary)", maxWidth: 320, textAlign: "center" }}>
                  Record a decision to freeze the metric snapshot that existed when you made it.
                </span>
              </div>
            }
          />
        )}

        {!loading && !error && decisions.length > 0 && filteredDecisions.length === 0 && (
          <EmptyState
            line={`No decisions match "${search || statusFilter}".`}
            button={
              <button
                onClick={() => { setSearch(""); setStatusFilter(""); }}
                style={{
                  border: "none", background: "transparent", fontFamily: "var(--font-sans)",
                  fontSize: 14, fontWeight: 500, color: "var(--brand-700)", cursor: "pointer",
                }}
              >
                Clear filters
              </button>
            }
          />
        )}

        {!loading && !error && filteredDecisions.length > 0 && (
          <div style={{ padding: "16px 20px 48px" }}>
            <div style={{
              background: "var(--color-white)", border: "1px solid var(--border-secondary)",
              borderRadius: "var(--radius-2xl)", boxShadow: "var(--shadow-xs)", overflow: "hidden",
            }}>
              {/* header row */}
              <div style={{
                display: "grid", gridTemplateColumns: "90px 1fr auto",
                padding: "9px 18px", background: "var(--gray-50)",
                borderBottom: "1px solid var(--border-secondary)",
              }}>
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-quaternary)" }}>Date</span>
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-quaternary)" }}>Decision</span>
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-quaternary)" }}>Status</span>
              </div>
              {filteredDecisions.map((d) => (
                <DecisionTimelineRow
                  key={d.id}
                  decision={d}
                  metricCount={undefined}
                  onClick={() => openDecisionDetail(d.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* create/edit drawer */}
      {decisionsDrawerId && (
        <DecisionDrawer
          existingDecision={editDecision}
          logics={logicPickerItems}
          onClose={() => { closeDecisionDrawer(); setEditDecision(null); }}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
