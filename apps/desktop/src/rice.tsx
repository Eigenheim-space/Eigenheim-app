/**
 * rice.tsx — Prioritization (RICE) surface.
 *
 * Wired to:
 *   GET    /rice            — sorted item list (score desc, computed server-side)
 *   POST   /rice            — create item
 *   PATCH  /rice/{id}       — update item
 *   DELETE /rice/{id}       — delete item (not exposed in v1 UI, reserved)
 *
 * Hard rules (brief 11 + CLAUDE.md):
 *   - No DC runtime imports.
 *   - English-first copy, blunt second person, no SaaS slop.
 *   - LIGHT aesthetic: white surfaces, brand green #099250, no purple, no glassmorphism.
 *   - tabular-nums on EVERY number: Reach, Impact, Confidence, Effort, Score, timestamps.
 *   - Score column is the most prominent: data-value 20/600 weight.
 *   - Stale metric-bound Reach → literal U+2014 in data-value cell, never 0, never hyphen.
 *   - Effort=0 → Score shown as U+2014 with `needs input` badge (user gap, not engine failure).
 *   - Stale Reach → Score shown as U+2014 with `stale` badge (engine failure).
 *   - Trace link always visible on metric-bound rows — never hover-only.
 *   - manual badge = neutral; synced badge = info (blue); stale badge = warning (amber).
 *   - Row height 56px to accommodate two-line Reach cell.
 *   - Right data panel (Events / Logic / Syncs) is unchanged; Prioritization fills center only.
 *   - Flat scrim on drawer (no backdrop-filter blur).
 *   - AA contrast, keyboard focus ring on rows + Trace buttons + drawer controls.
 */

import {
  useState, useMemo,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  GitBranch, Plus, X, Loader2, Search, Check,
} from "lucide-react";
import { useApp } from "./store";
import {
  riceApi,
  type RiceItem, type RiceImpact, type CreateRicePayload, type UpdateRicePayload,
  type BoundLogic,
} from "./api";
import { queryKeys, riceQueryFn, bootstrapQueryFn, invalidate, findReportForMetric } from "./queries";
import {
  Badge, Button, IconButton, EmptyState, ErrorBanner, Segmented,
} from "./ui";
import { ChatAffordance } from "./chat/ChatOverlay";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Compute the live score from drawer fields — mirrors engine formula. */
function computeScore(reach: number | null, impact: RiceImpact, confidence: number, effort: number): number | null {
  if (reach === null || effort === 0) return null;
  return (reach * impact * (confidence / 100)) / effort;
}

function formatScore(v: number | null | undefined): string {
  if (v == null) return "—"; // U+2014 em dash
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (v >= 10) return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatReach(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("en-US");
}

function relativeTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const hrs = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  if (hrs < 1) return "< 1h ago";
  if (hrs < 24) return `${hrs}h ago`;
  return `${days}d ago`;
}

function lastComputedLabel(items: RiceItem[]): string | null {
  // Find most recent trace_ref timestamp — engines don't return a board-level ts yet,
  // so we use the earliest created_at as a proxy. When real data arrives this should
  // be the server's sync_at field.
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const ts = sorted[0]?.created_at;
  if (!ts) return null;
  return relativeTimestamp(ts);
}

/* ------------------------------------------------------------------ */
/* Impact segment options                                              */
/* ------------------------------------------------------------------ */

// Segmented<T> constrains T extends string, so we keep impact as a string key.
const IMPACT_OPTIONS: { value: string; label: string }[] = [
  { value: "0.25", label: "0.25" },
  { value: "0.5",  label: "0.5"  },
  { value: "1",    label: "1"    },
  { value: "2",    label: "2"    },
  { value: "3",    label: "3"    },
];

function impactToNum(s: string): RiceImpact {
  const n = Number(s) as RiceImpact;
  return [0.25, 0.5, 1, 2, 3].includes(n) ? n : 1;
}

/* ------------------------------------------------------------------ */
/* Reach cell (table)                                                  */
/* ------------------------------------------------------------------ */

interface ReachCellProps {
  item: RiceItem;
  onTrace: () => void;
}

function ReachCell({ item, onTrace }: ReachCellProps) {
  const isBound = item.reach_logic_id != null;
  // engine status="stale" when reach_logic_id is bound but compute failed
  const isStale = isBound && item.status === "stale";
  const reachValue = item.reach_value ?? item.reach_manual ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      {/* value row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span
          className="tnum"
          style={{
            fontSize: 14, fontWeight: 600,
            color: isStale ? "var(--text-quaternary)" : "var(--text-primary)",
            fontFamily: isStale ? "var(--font-mono)" : undefined,
          }}
        >
          {formatReach(reachValue)}
        </span>

        {isBound && !isStale && (
          <>
            <Badge tone="info">synced</Badge>
            <button
              onClick={(e) => { e.stopPropagation(); onTrace(); }}
              aria-label="Trace Reach metric"
              style={{
                display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0,
                border: "1px solid var(--border-primary)", background: "var(--color-white)",
                borderRadius: "var(--radius-md)", padding: "2px 7px",
                fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500,
                color: "var(--text-secondary)", cursor: "pointer", boxShadow: "var(--shadow-xs)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-white)"; }}
            >
              <GitBranch size={11} />Trace
            </button>
          </>
        )}

        {isBound && isStale && (
          <Badge tone="warning">stale</Badge>
        )}

        {!isBound && (
          <Badge tone="neutral">manual</Badge>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Score cell (table)                                                  */
/* ------------------------------------------------------------------ */

interface ScoreCellProps {
  item: RiceItem;
}

function ScoreCell({ item }: ScoreCellProps) {
  const isBound = item.reach_logic_id != null;
  const isReachStale = isBound && item.status === "stale";
  const isEffortZero = item.effort === 0;

  // Score is null for both stale reach AND effort=0
  const showDash = item.score === null || isReachStale || isEffortZero;

  if (!showDash) {
    return (
      <span
        className="tnum"
        style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.3px", color: "var(--text-primary)" }}
      >
        {formatScore(item.score)}
      </span>
    );
  }

  // Distinguish: engine failure (stale) vs user gap (effort=0)
  const badgeLabel = isReachStale ? "stale" : "needs input";
  const badgeTone = "warning" as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-end" }}>
      <span
        className="tnum"
        style={{
          fontSize: 20, fontWeight: 600, letterSpacing: "-0.3px",
          color: "var(--text-quaternary)", fontFamily: "var(--font-mono)",
        }}
      >
        {"—"}
      </span>
      <Badge tone={badgeTone}>{badgeLabel}</Badge>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* RICE table row                                                      */
/* ------------------------------------------------------------------ */

interface RiceRowProps {
  item: RiceItem;
  onClick: () => void;
  onTrace: () => void;
}

function RiceRow({ item, onClick, onTrace }: RiceRowProps) {
  // cols: Name | Reach | Impact | Confidence | Effort | Score
  const cols = "minmax(0,1fr) 200px 72px 96px 80px 130px";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      className="eh-task-row"
      style={{
        display: "grid", gridTemplateColumns: cols, alignItems: "center", gap: 10,
        padding: "0 18px", minHeight: 56, borderTop: "1px solid var(--border-tertiary)",
        cursor: "pointer", minWidth: 680,
      }}
    >
      {/* Name */}
      <span style={{
        fontSize: 14, fontWeight: 500, color: "var(--text-primary)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
      }}>
        {item.name}
      </span>

      {/* Reach */}
      <div style={{ minWidth: 0 }}>
        <ReachCell item={item} onTrace={onTrace} />
      </div>

      {/* Impact */}
      <span className="tnum" style={{ fontSize: 14, fontWeight: 500, color: "var(--text-secondary)" }}>
        {item.impact}
      </span>

      {/* Confidence */}
      <span className="tnum" style={{ fontSize: 14, fontWeight: 500, color: "var(--text-secondary)" }}>
        {item.confidence}%
      </span>

      {/* Effort */}
      <span className="tnum" style={{ fontSize: 14, fontWeight: 500, color: "var(--text-secondary)" }}>
        {item.effort === 0 ? "0" : item.effort.toFixed(1)} pm
      </span>

      {/* Score */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <ScoreCell item={item} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* RICE table header                                                   */
/* ------------------------------------------------------------------ */

function RiceTableHeader() {
  const cols = "minmax(0,1fr) 200px 72px 96px 80px 130px";
  const colStyle = {
    fontSize: 11, fontWeight: 600, textTransform: "uppercase" as const,
    letterSpacing: "0.04em", color: "var(--text-quaternary)",
  };
  return (
    <div style={{
      display: "grid", gridTemplateColumns: cols, alignItems: "center", gap: 10,
      padding: "9px 18px", background: "var(--gray-50)", borderBottom: "1px solid var(--border-secondary)",
      minWidth: 680,
    }}>
      <span style={colStyle}>Name</span>
      <span style={colStyle}>Reach</span>
      <span style={colStyle}>Impact</span>
      <span style={colStyle}>Confidence</span>
      <span style={colStyle}>Effort</span>
      <span style={{ ...colStyle, textAlign: "right" }}>Score</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Logic picker (drawer)                                               */
/* ------------------------------------------------------------------ */

interface LogicPickerProps {
  logicOptions: BoundLogic[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function LogicPicker({ logicOptions, selectedId, onSelect }: LogicPickerProps) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() =>
    logicOptions.filter((l) => !search || l.name.toLowerCase().includes(search.toLowerCase())),
    [logicOptions, search]
  );

  if (logicOptions.length === 0) {
    return (
      <div style={{ padding: "14px", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-xl)", background: "var(--gray-25)", textAlign: "center" }}>
        <span style={{ fontSize: 13, color: "var(--text-quaternary)" }}>
          No Logics yet. Create one in the Logic panel.
        </span>
      </div>
    );
  }

  return (
    <div>
      <div style={{ position: "relative", marginBottom: 6 }}>
        <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-quaternary)", pointerEvents: "none" }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search Logics…"
          style={{
            width: "100%", height: 36, padding: "0 12px 0 32px", fontSize: 13,
            fontFamily: "var(--font-sans)", color: "var(--text-primary)",
            background: "var(--color-white)", border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-input)", outline: "none",
          }}
        />
      </div>
      <div style={{ border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-xl)", overflow: "hidden", maxHeight: 180, overflowY: "auto" }} className="eh-scroll">
        {filtered.map((l) => {
          const sel = selectedId === l.id;
          return (
            <button
              key={l.id}
              onClick={() => onSelect(sel ? null : l.id)}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%",
                padding: "9px 12px", border: "none", textAlign: "left",
                background: sel ? "var(--brand-50)" : "var(--color-white)",
                borderBottom: "1px solid var(--border-tertiary)",
                cursor: "pointer", fontFamily: "var(--font-sans)",
              }}
              onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = "var(--gray-25)"; }}
              onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = sel ? "var(--brand-50)" : "var(--color-white)"; }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: sel ? "var(--brand-700)" : "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {l.name}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-quaternary)", marginTop: 1 }}>
                  v{l.version} · {l.usage_count} report{l.usage_count !== 1 ? "s" : ""}
                </div>
              </div>
              {sel && <Check size={14} color="var(--brand-600)" />}
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ padding: "12px 14px", fontSize: 13, color: "var(--text-quaternary)" }}>No Logics match.</div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Logic live preview (drawer — metric-bound mode)                    */
/* ------------------------------------------------------------------ */

interface LogicPreviewProps {
  logic: BoundLogic;
  onTrace: () => void;
}

function LogicPreview({ logic, onTrace }: LogicPreviewProps) {
  const isStale = logic.current_value === null;
  return (
    <div style={{
      padding: "12px 14px",
      background: "var(--brand-25)", border: "1px solid var(--brand-200)",
      borderRadius: "var(--radius-xl)", display: "flex", flexDirection: "column", gap: 6,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--brand-800)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {logic.name}
        </span>
        {logic.version && (
          <span style={{ fontSize: 11, color: "var(--brand-600)", flexShrink: 0 }}>v{logic.version}</span>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          className="tnum"
          style={{
            fontSize: 20, fontWeight: 600, letterSpacing: "-0.2px",
            color: isStale ? "var(--text-quaternary)" : "var(--brand-700)",
            fontFamily: isStale ? "var(--font-mono)" : undefined,
          }}
        >
          {isStale ? "—" : logic.current_value!.toLocaleString("en-US")}
        </span>

        {isStale && <Badge tone="warning">stale</Badge>}

        {logic.source_name && !isStale && (
          <span style={{ fontSize: 12, color: "var(--brand-600)" }}>{logic.source_name}</span>
        )}

        {logic.trace_ref && !isStale && (
          <button
            onClick={onTrace}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4, marginLeft: "auto",
              border: "1px solid var(--brand-300)", background: "var(--color-white)",
              borderRadius: "var(--radius-md)", padding: "3px 8px",
              fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500,
              color: "var(--brand-700)", cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--brand-50)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-white)"; }}
          >
            <GitBranch size={11} />Trace
          </button>
        )}
      </div>

      {logic.computed_at && (
        <span style={{ fontSize: 11, color: "var(--brand-600)" }}>
          Computed {relativeTimestamp(logic.computed_at)}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Live Score preview (drawer)                                         */
/* ------------------------------------------------------------------ */

interface ScorePreviewProps {
  reach: number | null;
  impact: RiceImpact;
  confidence: number;
  effort: number;
}

function ScorePreview({ reach, impact, confidence, effort }: ScorePreviewProps) {
  const score = computeScore(reach, impact, confidence, effort);
  const isDash = score === null;

  return (
    <div style={{
      padding: "11px 14px", background: "var(--gray-25)", border: "1px solid var(--border-secondary)",
      borderRadius: "var(--radius-xl)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
    }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>Score:</span>
      <span
        className="tnum"
        style={{
          fontSize: 20, fontWeight: 600, letterSpacing: "-0.3px",
          color: isDash ? "var(--text-quaternary)" : "var(--text-primary)",
          fontFamily: isDash ? "var(--font-mono)" : undefined,
        }}
      >
        {isDash ? "—" : formatScore(score)}
      </span>
      <span style={{ flex: 1 }} />
      <span
        className="tnum"
        style={{ fontSize: 12, color: "var(--text-quaternary)", fontFamily: "var(--font-mono)", letterSpacing: "0.01em" }}
      >
        ({reach !== null ? reach.toLocaleString("en-US") : "R"} × {impact} × {confidence}%) / {effort === 0 ? "0" : effort.toFixed(1)} pm
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Item editor drawer                                                  */
/* ------------------------------------------------------------------ */

interface RiceDrawerProps {
  mode: "create" | "edit";
  item?: RiceItem;
  logicOptions: BoundLogic[];
  onClose: () => void;
  onSave: (p: { id?: string; payload: CreateRicePayload | UpdateRicePayload }) => Promise<void>;
  onTrace: (traceRef: string) => void;
}

function RiceDrawer({ mode, item, logicOptions, onClose, onSave, onTrace }: RiceDrawerProps) {
  const [name, setName] = useState(item?.name ?? "");
  const [reachMode, setReachMode] = useState<"metric" | "manual">(
    item?.reach_logic_id ? "metric" : "manual"
  );
  const [logicId, setLogicId] = useState<string | null>(item?.reach_logic_id ?? null);
  const [reachManual, setReachManual] = useState<string>(
    item?.reach_manual != null ? String(item.reach_manual) : ""
  );
  const [impactStr, setImpactStr] = useState<string>(String(item?.impact ?? 1));
  const [confidence, setConfidence] = useState<string>(String(item?.confidence ?? 80));
  const [effort, setEffort] = useState<string>(item?.effort != null ? String(item.effort) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selectedLogic = useMemo(() => logicOptions.find((l) => l.id === logicId) ?? null, [logicOptions, logicId]);

  const confidenceNum = useMemo(() => {
    const n = Number(confidence);
    return isNaN(n) ? 0 : Math.min(100, Math.max(0, n));
  }, [confidence]);

  const impact = useMemo(() => impactToNum(impactStr), [impactStr]);

  const effortNum = useMemo(() => {
    const n = Number(effort);
    return isNaN(n) ? 0 : Math.max(0, n);
  }, [effort]);

  const reachNum = useMemo((): number | null => {
    if (reachMode === "metric") {
      return selectedLogic?.current_value ?? null;
    }
    const n = Number(reachManual);
    return reachManual !== "" && !isNaN(n) ? n : null;
  }, [reachMode, selectedLogic, reachManual]);

  const canSave = name.trim().length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true); setErr(null);
    try {
      const payload: CreateRicePayload | UpdateRicePayload = {
        name: name.trim(),
        reach_logic_id: reachMode === "metric" ? logicId : null,
        reach_manual: reachMode === "manual" && reachManual !== "" ? Number(reachManual) : null,
        impact,
        confidence: confidenceNum,
        effort: effortNum,
      };
      await onSave({ id: item?.id, payload });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save item");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "var(--overlay-scrim)", zIndex: 60 }}
        className="eh-task-scrim"
      />
      <aside
        className="eh-fadein"
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, width: 460, maxWidth: "95vw",
          background: "var(--color-white)", borderLeft: "1px solid var(--border-secondary)",
          boxShadow: "var(--shadow-2xl)", zIndex: 61, display: "flex", flexDirection: "column",
        }}
      >
        {/* header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "12px 16px 12px 20px",
          borderBottom: "1px solid var(--border-secondary)", flexShrink: 0,
        }}>
          <span style={{ fontSize: 16, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {mode === "create" ? "New item" : (item?.name ?? "Edit item")}
          </span>
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </div>

        {/* body */}
        <div className="eh-scroll" style={{ flex: 1, overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: 18 }}>
          {err && (
            <ErrorBanner
              component="RICE item"
              process="save stopped"
              detail={err}
              action={<Button hierarchy="tertiary" size="sm" onClick={() => setErr(null)}>Dismiss</Button>}
            />
          )}

          {/* 1. Name */}
          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
              Name
            </label>
            <input
              autoFocus={mode === "create"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Add batch CSV import"
              style={{
                width: "100%", height: 40, padding: "0 12px", fontSize: 14,
                fontFamily: "var(--font-sans)", color: "var(--text-primary)",
                background: "var(--color-white)", border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-input)", outline: "none",
              }}
            />
          </div>

          {/* 2. Reach control */}
          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 8 }}>
              Reach
            </label>
            <Segmented<"metric" | "manual">
              value={reachMode}
              options={[
                { value: "metric", label: "From metric" },
                { value: "manual", label: "Manual" },
              ]}
              onChange={setReachMode}
            />

            <div style={{ marginTop: 12 }}>
              {reachMode === "metric" ? (
                <>
                  <LogicPicker
                    logicOptions={logicOptions}
                    selectedId={logicId}
                    onSelect={setLogicId}
                  />
                  {selectedLogic && (
                    <div style={{ marginTop: 10 }}>
                      <LogicPreview
                        logic={selectedLogic}
                        onTrace={() => {
                          if (selectedLogic.trace_ref) onTrace(selectedLogic.trace_ref);
                        }}
                      />
                    </div>
                  )}
                </>
              ) : (
                <>
                  <input
                    type="number"
                    value={reachManual}
                    onChange={(e) => setReachManual(e.target.value)}
                    placeholder="e.g. 12000"
                    className="tnum"
                    style={{
                      width: "100%", height: 40, padding: "0 12px", fontSize: 14,
                      fontFamily: "var(--font-sans)", color: "var(--text-primary)",
                      background: "var(--color-white)", border: "1px solid var(--border-primary)",
                      borderRadius: "var(--radius-input)", outline: "none",
                    }}
                  />
                  <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-quaternary)", lineHeight: "18px" }}>
                    This is an estimate. Bind a Logic to get a traced, auto-updating value.
                  </div>
                </>
              )}
            </div>
          </div>

          {/* 3. Impact */}
          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 8 }}>
              Impact
            </label>
            <Segmented<string>
              value={impactStr}
              options={IMPACT_OPTIONS}
              onChange={setImpactStr}
            />
          </div>

          {/* 4. Confidence */}
          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
              Confidence
            </label>
            <div style={{ position: "relative" }}>
              <input
                type="number"
                value={confidence}
                onChange={(e) => setConfidence(e.target.value)}
                onBlur={() => {
                  const n = Number(confidence);
                  if (!isNaN(n)) setConfidence(String(Math.min(100, Math.max(0, n))));
                }}
                min={0}
                max={100}
                className="tnum"
                style={{
                  width: "100%", height: 40, padding: "0 36px 0 12px", fontSize: 14,
                  fontFamily: "var(--font-sans)", color: "var(--text-primary)",
                  background: "var(--color-white)", border: "1px solid var(--border-primary)",
                  borderRadius: "var(--radius-input)", outline: "none",
                }}
              />
              <span style={{
                position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                fontSize: 14, color: "var(--text-quaternary)", pointerEvents: "none",
              }}>%</span>
            </div>
          </div>

          {/* 5. Effort */}
          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
              Effort
            </label>
            <div style={{ position: "relative" }}>
              <input
                type="number"
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                placeholder="e.g. 1.5"
                step={0.1}
                min={0}
                className="tnum"
                style={{
                  width: "100%", height: 40, padding: "0 44px 0 12px", fontSize: 14,
                  fontFamily: "var(--font-sans)", color: "var(--text-primary)",
                  background: "var(--color-white)", border: "1px solid var(--border-primary)",
                  borderRadius: "var(--radius-input)", outline: "none",
                }}
              />
              <span style={{
                position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                fontSize: 14, color: "var(--text-quaternary)", pointerEvents: "none",
              }}>pm</span>
            </div>
          </div>

          {/* 6. Live Score preview */}
          <ScorePreview
            reach={reachNum}
            impact={impact}
            confidence={confidenceNum}
            effort={effortNum}
          />
        </div>

        {/* footer */}
        <div style={{ padding: "12px 20px 20px", borderTop: "1px solid var(--border-secondary)", display: "flex", gap: 8, flexShrink: 0 }}>
          <Button
            hierarchy="primary"
            style={{ flex: 1 }}
            disabled={!canSave || saving}
            onClick={handleSave}
          >
            {saving
              ? <><Loader2 size={14} style={{ animation: "eh-spin 1s linear infinite" }} />Saving…</>
              : mode === "create" ? "Save" : "Save"}
          </Button>
          <Button hierarchy="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </aside>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* RiceView (main export)                                              */
/* ------------------------------------------------------------------ */

export function RiceView() {
  const riceDrawerId = useApp((s) => s.riceDrawerId);
  const openRiceDrawer = useApp((s) => s.openRiceDrawer);
  const closeRiceDrawer = useApp((s) => s.closeRiceDrawer);
  const openTrace = useApp((s) => s.openTrace);

  const [search, setSearch] = useState("");

  const { data: items = [], isLoading: loading, isError, error: queryError, refetch } = useQuery({
    queryKey: queryKeys.rice,
    queryFn: riceQueryFn,
    staleTime: 2 * 60 * 1000,
  });
  const error = isError ? (queryError instanceof Error ? queryError.message : "Failed to load items") : null;

  // Bootstrap for logic options
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const logic = bootstrap?.logic ?? [];

  // Stale items (bound Logic failed) — show ErrorBanner
  const staleItems = useMemo(() =>
    items.filter((i) => i.reach_logic_id != null && i.status === "stale"),
    [items]
  );

  // Filtered items (search)
  const filteredItems = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter((i) => i.name.toLowerCase().includes(q));
  }, [items, search]);

  // Sort: keep server order (score desc), but push brand-new items with null
  // score to the bottom (they have no prior score).
  const sortedItems = useMemo(() => {
    return [...filteredItems].sort((a, b) => {
      const sa = a.score ?? -Infinity;
      const sb = b.score ?? -Infinity;
      return sb - sa;
    });
  }, [filteredItems]);

  const editingItem = useMemo(() => {
    if (!riceDrawerId || riceDrawerId === "new") return undefined;
    return items.find((i) => i.id === riceDrawerId);
  }, [riceDrawerId, items]);

  // Logic options for the drawer (reuse BoundLogic shape).
  // In EDIT mode, if the item already has a live reach_value, thread it through
  // so the LogicPreview / ScorePreview show the correct current value.
  const logicOptions: BoundLogic[] = useMemo(() =>
    logic.map((l) => {
      const liveValue = editingItem?.reach_logic_id === l.id
        ? (editingItem.reach_value ?? null)
        : null;
      return {
        id: l.id,
        name: l.name,
        version: l.version ?? "1",
        usage_count: l.usage ?? 0,
        current_value: liveValue,
        source_name: null,
        trace_ref: editingItem?.reach_logic_id === l.id ? (editingItem.reach_trace_ref ?? null) : null,
        computed_at: null,
      };
    }),
    [logic, editingItem]
  );

  const handleSave = async ({ id, payload }: { id?: string; payload: CreateRicePayload | UpdateRicePayload }) => {
    if (id) {
      await riceApi.update(id, payload as UpdateRicePayload);
    } else {
      await riceApi.create(payload as CreateRicePayload);
    }
    await invalidate.rice();
  };

  const handleTrace = (item: RiceItem) => {
    if (!item.reach_logic_id) return;
    const rep = findReportForMetric(item.reach_logic_id);
    if (rep) openTrace(rep.id, item.reach_logic_id);
  };

  const handleDrawerTrace = (traceRef: string) => {
    // Drawer passes a formula string — split only if it looks like "reportId:metricId".
    const [reportId, metricId] = traceRef.split(":");
    if (reportId && metricId) openTrace(reportId, metricId);
  };

  const lastComputed = useMemo(() => lastComputedLabel(items), [items]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-secondary)", position: "relative" }}>

      {/* top bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "11px 20px", borderBottom: "1px solid var(--border-secondary)",
        flexShrink: 0, background: "var(--surface-secondary)", zIndex: 20,
      }}>
        {/* search */}
        <div style={{ position: "relative" }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-quaternary)", pointerEvents: "none" }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items"
            aria-label="Search items"
            style={{
              width: 200, height: 34, padding: "0 10px 0 32px", fontSize: 13,
              fontFamily: "var(--font-sans)", color: "var(--text-primary)",
              background: "var(--color-white)", border: "1px solid var(--border-secondary)",
              borderRadius: "var(--radius-md)", outline: "none", boxShadow: "var(--shadow-xs)",
            }}
          />
        </div>

        <span style={{ flex: 1 }} />

        {loading && <Loader2 size={14} color="var(--text-quaternary)" style={{ animation: "eh-spin 1s linear infinite" }} />}

        {lastComputed && (
          <span className="tnum" style={{ fontSize: 12, color: "var(--text-quaternary)", whiteSpace: "nowrap" }}>
            Last computed {lastComputed}
          </span>
        )}

        <ChatAffordance />

        <Button
          hierarchy="primary"
          size="sm"
          iconLeading={<Plus size={14} />}
          onClick={() => openRiceDrawer("new")}
        >
          Item
        </Button>
      </div>

      {/* body */}
      <div className="eh-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>

        {/* ErrorBanner for stale bound Logics */}
        {staleItems.length > 0 && (
          <div style={{ padding: "14px 24px 0" }}>
            <ErrorBanner
              component={`Logic "${staleItems[0].name}"`}
              process="computation stopped"
              detail="The engine could not compute a live Reach value. The score is suppressed until the next successful sync."
              action={<Button hierarchy="tertiary" size="sm" onClick={() => void refetch()}>Retry</Button>}
            />
          </div>
        )}

        {error && (
          <div style={{ padding: "14px 24px 0" }}>
            <ErrorBanner
              component="Prioritization"
              process="loading stopped"
              detail={error}
              action={<Button hierarchy="tertiary" size="sm" onClick={() => void refetch()}>Retry</Button>}
            />
          </div>
        )}

        {loading && items.length === 0 && !error && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "64px 24px" }}>
            <Loader2 size={22} color="var(--text-quaternary)" style={{ animation: "eh-spin 1s linear infinite" }} />
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <EmptyState
            line="No items yet."
            button={
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <Button hierarchy="primary" iconLeading={<Plus size={14} />} onClick={() => openRiceDrawer("new")}>
                  Item
                </Button>
                <span style={{ fontSize: 13, color: "var(--text-quaternary)" }}>
                  Add an item, then bind Reach to a Logic or enter a manual estimate.
                </span>
              </div>
            }
          />
        )}

        {!error && sortedItems.length > 0 && (
          <div style={{ padding: "18px 24px 48px" }}>
            <div style={{
              background: "var(--color-white)", border: "1px solid var(--border-secondary)",
              borderRadius: "var(--radius-2xl)", boxShadow: "var(--shadow-xs)", overflowX: "auto",
            }}>
              <RiceTableHeader />
              {sortedItems.map((item) => (
                <RiceRow
                  key={item.id}
                  item={item}
                  onClick={() => openRiceDrawer(item.id)}
                  onTrace={() => handleTrace(item)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Item editor drawer */}
      {riceDrawerId && (
        <RiceDrawer
          mode={riceDrawerId === "new" ? "create" : "edit"}
          item={editingItem}
          logicOptions={logicOptions}
          onClose={closeRiceDrawer}
          onSave={handleSave}
          onTrace={handleDrawerTrace}
        />
      )}
    </div>
  );
}
