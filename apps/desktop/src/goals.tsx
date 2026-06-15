/**
 * goals.tsx — Goals (OKR) surface.
 *
 * Wired to:
 *   GET  /goals                     — full OKR tree (objectives + KRs)
 *   POST /objectives                — create objective
 *   PATCH /objectives/{id}          — update objective
 *   DELETE /objectives/{id}         — delete objective
 *   POST /key-results               — create KR
 *   PATCH /key-results/{id}         — update KR
 *   DELETE /key-results/{id}        — delete KR
 *
 * Hard rules (brief 07 + CLAUDE.md):
 *   - No DC runtime imports.
 *   - English-first copy, blunt second person, no SaaS slop.
 *   - LIGHT aesthetic: white, green accent (#099250), no purple, no glassmorphism.
 *   - Flat scrim on drawer (no backdrop-filter blur).
 *   - AA contrast, tabular-nums on every numeric.
 *   - Trace link on EVERY bound KR row — always visible, never hover-only.
 *   - Status = color + text (never color alone).
 *   - Goals fills center only; right data panel (Events/Logic/Syncs) unchanged.
 */

import {
  useState, useRef, useEffect,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  GitBranch, Plus, X, ChevronDown, ChevronRight,
  Loader2, Share2, Printer, Copy, Check,
} from "lucide-react";
import { useApp } from "./store";
import {
  goalsApi,
  type ObjectiveRow,
  type KeyResultRow,
  type BoundLogic,
  type KRStatus,
  type GoalsResponse,
} from "./api";
import { queryKeys, goalsQueryFn, bootstrapQueryFn, invalidate, findReportForMetric } from "./queries";
import {
  Badge, Button, IconButton, Sparkline,
  EmptyState, ErrorBanner, Tooltip, Segmented,
  Modal, copyText, Drawer,
} from "./ui";
import { relativeTimestamp } from "./lib/time";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const PERIOD_OPTIONS = [
  { value: "Q1", label: "Q1" },
  { value: "Q2", label: "Q2" },
  { value: "Q3", label: "Q3" },
  { value: "Q4", label: "Q4" },
  { value: "Custom", label: "Custom" },
];

const COMPARISON_OPTIONS: { value: "gte" | "lte" | "eq"; label: string }[] = [
  { value: "gte", label: "≥" },
  { value: "lte", label: "≤" },
  { value: "eq",  label: "=" },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function krStatusTone(status: string): "success" | "danger" | "warning" | "neutral" {
  if (status === "ahead") return "success";
  if (status === "behind") return "danger";
  if (status === "stale") return "warning";
  return "neutral"; // draft
}

function krStatusLabel(status: string): string {
  if (status === "ahead") return "Ahead";
  if (status === "behind") return "Behind";
  if (status === "stale") return "At risk";
  return "Draft";
}

function krSparklineColor(status: string): string {
  if (status === "ahead") return "var(--success-500)";
  if (status === "behind") return "var(--error-500)";
  if (status === "stale") return "var(--warning-500)";
  return "var(--gray-300)";
}

function krProgressColor(status: string): string {
  if (status === "ahead") return "var(--success-500)";
  if (status === "behind") return "var(--error-500)";
  if (status === "stale") return "var(--warning-500)";
  return "var(--gray-300)";
}

function comparisonGlyph(c: string): string {
  return c === "gte" ? "≥" : c === "lte" ? "≤" : "=";
}

// live_value is now a pre-formatted string from the engine (e.g. "30.97%")
function formatValue(v: string | null | undefined): string {
  if (v == null) return "—";
  return v;
}

function isStale(iso: string | null | undefined): boolean {
  if (!iso) return true;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return true;
  return Date.now() - d.getTime() > 86400000; // > 24h
}

/* ------------------------------------------------------------------ */
/* KR status badge                                                     */
/* ------------------------------------------------------------------ */

function KRStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={krStatusTone(status)}>
      {krStatusLabel(status)}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/* Inline progress bar (48px × 4px)                                   */
/* ------------------------------------------------------------------ */

function ProgressBar({ progress, status }: { progress: number; status: string }) {
  const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
  return (
    <div
      aria-label={`${pct}% progress`}
      title={`${pct}%`}
      style={{
        width: 48, height: 4, borderRadius: "var(--radius-full)",
        background: "var(--gray-100)", flexShrink: 0, overflow: "hidden",
      }}
    >
      <div style={{
        height: "100%", width: `${pct}%`,
        background: krProgressColor(status),
        borderRadius: "inherit",
        transition: "width 400ms ease",
      }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Objective aggregate progress bar (4px, full width)                 */
/* ------------------------------------------------------------------ */

function ObjectiveProgressBar({ krs }: { krs: KeyResultRow[] }) {
  const bound = krs.filter((k) => k.status !== "draft");
  const onTrack = bound.filter((k) => k.status === "ahead").length;
  const pct = bound.length > 0 ? Math.round((onTrack / bound.length) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 80 }}>
      <div style={{ flex: 1, height: 4, borderRadius: "var(--radius-full)", background: "var(--gray-100)", overflow: "hidden", minWidth: 60 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: "var(--brand-500)", borderRadius: "inherit", transition: "width 400ms ease" }} />
      </div>
      <span className="tnum" style={{ fontSize: 12, color: "var(--text-quaternary)", whiteSpace: "nowrap", flexShrink: 0 }}>
        {onTrack} / {bound.length} on track
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Task count hover popover                                           */
/* ------------------------------------------------------------------ */

function TaskCountPill({ count, kr }: { count: number; kr: KeyResultRow }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <span ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          border: "none", background: "transparent", padding: "1px 0",
          fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500,
          color: "var(--text-quaternary)", cursor: count > 0 ? "pointer" : "default",
        }}
        onMouseEnter={(e) => { if (count > 0) e.currentTarget.style.color = "var(--text-secondary)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-quaternary)"; }}
      >
        <span className="tnum">{count} task{count !== 1 ? "s" : ""} linked</span>
      </button>
      {open && count > 0 && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 29 }} />
          <div className="eh-fadein" style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, width: 260,
            background: "var(--color-white)", border: "1px solid var(--border-secondary)",
            borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-lg)", zIndex: 30,
            overflow: "hidden",
          }}>
            <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-tertiary)", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
              {kr.name}
            </div>
            <div style={{ padding: "6px 0" }}>
              <div style={{ padding: "6px 12px", fontSize: 13, color: "var(--text-tertiary)" }}>
                {count} task{count !== 1 ? "s" : ""} linked to this KR. Edit links in the task detail drawer.
              </div>
            </div>
          </div>
        </>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* KR detail peek (inline card-lift)                                  */
/* ------------------------------------------------------------------ */

function KRPeekCard({
  kr, onClose, onEditInDrawer, onTrace,
}: {
  kr: KeyResultRow;
  onClose: () => void;
  onEditInDrawer: () => void;
  onTrace: () => void;
}) {
  const lv = kr.live_value;
  const target = kr.target;

  return (
    <div
      className="eh-fadein"
      style={{
        background: "var(--color-white)",
        border: "1px solid var(--border-secondary)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-md)",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        position: "relative",
        zIndex: 2,
        marginTop: -1,
      }}
    >
      {/* header row */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.1px" }}>{kr.name}</div>
          {kr.logic && (
            <div style={{ fontSize: 12, color: "var(--text-quaternary)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {kr.logic.name}
              {kr.logic.version && <span style={{ marginLeft: 6, opacity: 0.7 }}>v{kr.logic.version}</span>}
            </div>
          )}
        </div>
        <KRStatusBadge status={kr.status} />
        <IconButton label="Close detail" onClick={onClose}><X size={15} /></IconButton>
      </div>

      {/* metric card */}
      <div style={{
        background: "var(--gray-25)", border: "1px solid var(--border-secondary)",
        borderRadius: "var(--radius-xl)", padding: "12px 14px",
        display: "flex", alignItems: "center", gap: 16,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-quaternary)", marginBottom: 4 }}>
            Live value
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span className="tnum" style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.3px", color: kr.status === "behind" ? "var(--error-700)" : kr.status === "stale" ? "var(--warning-700)" : kr.status === "ahead" ? "var(--success-700)" : "var(--text-primary)" }}>
              {lv == null ? <span style={{ fontFamily: "var(--font-mono)" }}>&mdash;</span> : lv}
            </span>
            {target != null && (
              <span className="tnum" style={{ fontSize: 13, color: "var(--text-quaternary)" }}>
                {comparisonGlyph(kr.comparison)} {target.toLocaleString("en-US")}
              </span>
            )}
          </div>
          {kr.logic?.source_name && (
            <div style={{ fontSize: 12, color: "var(--text-quaternary)", marginTop: 2 }}>{kr.logic.source_name}</div>
          )}
        </div>
        {kr.spark.length > 1 && (
          <Sparkline data={kr.spark} w={80} h={34} color={krSparklineColor(kr.status)} />
        )}
        {kr.logic && (
          <button
            onClick={onTrace}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              border: "1px solid var(--border-primary)", background: "var(--color-white)",
              borderRadius: "var(--radius-md)", padding: "5px 9px",
              fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500,
              color: "var(--text-secondary)", cursor: "pointer", boxShadow: "var(--shadow-xs)",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-white)"; }}
          >
            <GitBranch size={12} /> Trace
          </button>
        )}
      </div>

      {/* task count + footer */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <TaskCountPill count={kr.task_count} kr={kr} />
        <span style={{ flex: 1 }} />
        <button
          onClick={onEditInDrawer}
          style={{
            border: "none", background: "transparent", padding: 0,
            fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500,
            color: "var(--brand-700)", cursor: "pointer",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
          onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
        >
          Edit in drawer
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* KR row                                                              */
/* ------------------------------------------------------------------ */

function KRRow({
  kr,
  peekOpen,
  onTogglePeek,
  onOpenDrawer,
  onTrace,
}: {
  kr: KeyResultRow;
  peekOpen: boolean;
  onTogglePeek: () => void;
  onOpenDrawer: () => void;
  onTrace: () => void;
}) {
  const lv = kr.live_value;
  const target = kr.target;
  const isDraft = kr.status === "draft";

  return (
    <div>
      {/* main row */}
      <div
        className="eh-kr-row"
        style={{
          display: "flex", alignItems: "center", gap: 12, padding: "0 14px",
          height: 48, borderTop: "1px solid var(--border-tertiary)",
          background: peekOpen ? "var(--gray-25)" : "var(--color-white)",
          cursor: "pointer",
          transition: "background 120ms ease",
        }}
        role="button"
        tabIndex={0}
        onClick={onTogglePeek}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onTogglePeek(); } }}
        onMouseEnter={(e) => { if (!peekOpen) (e.currentTarget as HTMLElement).style.background = "var(--gray-25)"; }}
        onMouseLeave={(e) => { if (!peekOpen) (e.currentTarget as HTMLElement).style.background = "var(--color-white)"; }}
      >
        {/* name + logic caption */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {kr.name}
          </div>
          {kr.logic && (
            <div style={{ fontSize: 12, color: "var(--text-quaternary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {kr.logic.name}
            </div>
          )}
          {isDraft && !kr.logic && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenDrawer(); }}
              style={{
                border: "none", background: "transparent", padding: 0,
                fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500,
                color: "var(--brand-700)", cursor: "pointer",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
            >
              Bind a Logic
            </button>
          )}
        </div>

        {/* live value */}
        <span
          className="tnum"
          style={{
            fontSize: lv === null ? 18 : 18, fontWeight: 600, letterSpacing: "-0.2px",
            color: lv === null ? "var(--text-quaternary)" : "var(--text-primary)",
            minWidth: 72, textAlign: "right", flexShrink: 0,
            fontFamily: lv === null ? "var(--font-mono)" : undefined,
          }}
        >
          {lv == null ? "—" : lv}
        </span>

        {/* target + comparison */}
        {target != null ? (
          <span className="tnum" style={{ fontSize: 13, color: "var(--text-quaternary)", flexShrink: 0, minWidth: 72, textAlign: "right" }}>
            {comparisonGlyph(kr.comparison)}&thinsp;{target.toLocaleString("en-US")}
          </span>
        ) : (
          <span style={{ minWidth: 72, flexShrink: 0 }} />
        )}

        {/* progress bar */}
        <ProgressBar progress={kr.progress} status={kr.status} />

        {/* status badge */}
        <span style={{ flexShrink: 0, minWidth: 72 }}>
          <KRStatusBadge status={kr.status} />
        </span>

        {/* sparkline — 32×24, or stale glyph for error */}
        <span style={{ flexShrink: 0, width: 32 }}>
          {lv === null ? (
            <span style={{ fontSize: 12, color: "var(--text-quaternary)", fontFamily: "var(--font-mono)" }}>&mdash;</span>
          ) : kr.spark.length > 1 ? (
            <Sparkline data={kr.spark} w={32} h={24} color={krSparklineColor(kr.status)} />
          ) : null}
        </span>

        {/* trace link — always visible, never hover-only */}
        {!isDraft && kr.logic ? (
          <button
            onClick={(e) => { e.stopPropagation(); onTrace(); }}
            aria-label={`Trace: ${kr.name}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0,
              border: "1px solid var(--border-primary)", background: "var(--color-white)",
              borderRadius: "var(--radius-md)", padding: "4px 8px",
              fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500,
              color: "var(--text-secondary)", cursor: "pointer", boxShadow: "var(--shadow-xs)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-white)"; }}
          >
            <GitBranch size={12} /> Trace
          </button>
        ) : (
          <span style={{ width: 67, flexShrink: 0 }} />
        )}
      </div>

      {/* task count secondary line on hover — handled via peek for simplicity */}

      {/* peek card */}
      {peekOpen && (
        <div style={{ padding: "0 14px 8px" }}>
          <KRPeekCard
            kr={kr}
            onClose={onTogglePeek}
            onEditInDrawer={onOpenDrawer}
            onTrace={onTrace}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Objective section header                                           */
/* ------------------------------------------------------------------ */

function ObjectiveSection({
  obj, peekKrId, onTogglePeek, onAddKR, onOpenKRDrawer, onTrace,
}: {
  obj: ObjectiveRow;
  peekKrId: string | null;
  onTogglePeek: (id: string) => void;
  onAddKR: (objectiveId: string) => void;
  onOpenKRDrawer: (krId: string) => void;
  onTrace: (kr: KeyResultRow) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={{
      background: "var(--color-white)", border: "1px solid var(--border-secondary)",
      borderRadius: "var(--radius-2xl)", overflow: "hidden",
    }}>
      {/* header row */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          padding: "12px 14px", background: "var(--gray-25)",
          borderBottom: collapsed ? "none" : "1px solid var(--border-secondary)",
          border: "none", cursor: "pointer", textAlign: "left",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "var(--gray-25)"; }}
      >
        {collapsed
          ? <ChevronRight size={15} color="var(--text-quaternary)" />
          : <ChevronDown size={15} color="var(--text-quaternary)" />}
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.15px", flex: 0, whiteSpace: "nowrap", color: "var(--text-primary)" }}>
          {obj.title}
        </span>
        <ObjectiveProgressBar krs={obj.krs} />
        <span className="tnum" style={{ fontSize: 12, color: "var(--text-quaternary)", whiteSpace: "nowrap", flexShrink: 0 }}>
          {obj.period}
        </span>
      </button>

      {/* KR list */}
      {!collapsed && (
        <>
          {obj.krs.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 14px", color: "var(--text-quaternary)", fontSize: 13 }}>
              <span>No key results yet.</span>
              <button
                onClick={() => onAddKR(obj.id)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  border: "none", background: "transparent", padding: 0,
                  fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500,
                  color: "var(--brand-700)", cursor: "pointer",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
                onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
              >
                <Plus size={13} /> Add KR
              </button>
            </div>
          ) : (
            <>
              {/* bound KRs */}
              {obj.krs.filter((k) => k.status !== "draft").map((kr) => (
                <KRRow
                  key={kr.id}
                  kr={kr}
                  peekOpen={peekKrId === kr.id}
                  onTogglePeek={() => onTogglePeek(kr.id)}
                  onOpenDrawer={() => onOpenKRDrawer(kr.id)}
                  onTrace={() => onTrace(kr)}
                />
              ))}

              {/* draft KRs at bottom */}
              {obj.krs.filter((k) => k.status === "draft").length > 0 && (
                <div style={{ borderTop: "1px solid var(--border-secondary)", background: "var(--gray-25)" }}>
                  <div style={{ padding: "6px 14px 2px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-quaternary)" }}>
                    Unbound KRs
                  </div>
                  {obj.krs.filter((k) => k.status === "draft").map((kr) => (
                    <KRRow
                      key={kr.id}
                      kr={kr}
                      peekOpen={peekKrId === kr.id}
                      onTogglePeek={() => onTogglePeek(kr.id)}
                      onOpenDrawer={() => onOpenKRDrawer(kr.id)}
                      onTrace={() => onTrace(kr)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* + Add KR footer */}
          <div style={{ borderTop: "1px solid var(--border-tertiary)", padding: "8px 14px" }}>
            <button
              onClick={() => onAddKR(obj.id)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                border: "none", background: "transparent", padding: "2px 0",
                fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500,
                color: "var(--brand-700)", cursor: "pointer",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
            >
              <Plus size={13} /> Key Result
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Objective create / edit (inline drawer via Drawer from ui.tsx)     */
/* ------------------------------------------------------------------ */

function ObjectiveDrawer({
  period,
  onClose,
  onCreate,
}: {
  period: string;
  onClose: () => void;
  onCreate: (name: string, period: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [p, setP] = useState(period);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true); setErr(null);
    try {
      await onCreate(name.trim(), p);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create objective");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      width={428}
      onClose={onClose}
      header={
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px 12px 20px", borderBottom: "1px solid var(--border-secondary)", flexShrink: 0 }}>
          <span style={{ fontSize: 16, fontWeight: 600, flex: 1 }}>New Objective</span>
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </div>
      }
      footer={
        <div style={{ padding: "12px 20px 20px", display: "flex", gap: 8 }}>
          <Button
            hierarchy="primary"
            style={{ flex: 1 }}
            disabled={!name.trim() || saving}
            onClick={handleSave}
          >
            {saving ? <><Loader2 size={14} style={{ animation: "eh-spin 1s linear infinite" }} />Saving…</> : "Create Objective"}
          </Button>
          <Button hierarchy="secondary" onClick={onClose}>Cancel</Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {err && (
          <ErrorBanner
            component="Objective"
            process="create stopped"
            detail={err}
            action={<Button hierarchy="tertiary" size="sm" onClick={() => setErr(null)}>Dismiss</Button>}
          />
        )}
        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
            Objective name
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            placeholder="e.g. Grow activation by end of Q2"
            style={{
              width: "100%", height: 40, padding: "0 12px", fontSize: 14,
              fontFamily: "var(--font-sans)", color: "var(--text-primary)",
              background: "var(--color-white)", border: "1px solid var(--border-primary)",
              borderRadius: "var(--radius-input)", outline: "none",
            }}
          />
        </div>
        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
            Period
          </label>
          <Segmented<string>
            value={p}
            options={PERIOD_OPTIONS}
            onChange={setP}
          />
        </div>
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* KR drawer (create / edit)                                          */
/* ------------------------------------------------------------------ */

interface KRDrawerProps {
  mode: "create" | "edit";
  objectiveId?: string;
  kr?: KeyResultRow;
  objectives: ObjectiveRow[];
  logicOptions: BoundLogic[];
  period: string;
  onClose: () => void;
  onSave: (p: {
    objective_id: string;
    name: string;
    logic_id: string | null;
    target: number | null;
    comparison: "gte" | "lte" | "eq";
    period: string;
    krId?: string;
  }) => Promise<void>;
}

function KRDrawer({
  mode, objectiveId, kr, objectives, logicOptions, period, onClose, onSave,
}: KRDrawerProps) {
  const [objId, setObjId] = useState(objectiveId ?? kr?.objective_id ?? objectives[0]?.id ?? "");
  const [name, setName] = useState(kr?.name ?? "");
  const [logicId, setLogicId] = useState<string | null>(kr?.logic_id ?? null);
  const [target, setTarget] = useState<string>(kr?.target != null ? String(kr.target) : "");
  const [comparison, setComparison] = useState<"gte" | "lte" | "eq">((kr?.comparison as "gte" | "lte" | "eq") ?? "gte");
  const [p, setP] = useState(kr?.period ?? period);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [logicSearch, setLogicSearch] = useState("");

  const selectedLogic = logicOptions.find((l) => l.id === logicId) ?? null;
  const targetNum = target !== "" && !isNaN(Number(target)) ? Number(target) : null;

  // live preview status
  const previewStatus: KRStatus | null = (() => {
    if (!selectedLogic || selectedLogic.current_value == null || targetNum === null) return null;
    const v = selectedLogic.current_value;
    if (comparison === "gte") return v >= targetNum ? "ahead" : "behind";
    if (comparison === "lte") return v <= targetNum ? "ahead" : "behind";
    return v === targetNum ? "ahead" : "behind";
  })();

  const filteredLogic = logicOptions.filter((l) =>
    !logicSearch || l.name.toLowerCase().includes(logicSearch.toLowerCase())
  );

  const canSave = name.trim() && objId;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true); setErr(null);
    try {
      await onSave({
        objective_id: objId,
        name: name.trim(),
        logic_id: logicId,
        target: targetNum,
        comparison,
        period: p,
        krId: kr?.id,
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save key result");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      width={460}
      onClose={onClose}
      header={
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px 12px 20px", borderBottom: "1px solid var(--border-secondary)", flexShrink: 0 }}>
          <span style={{ fontSize: 16, fontWeight: 600, flex: 1 }}>{mode === "create" ? "New Key Result" : "Edit Key Result"}</span>
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
            {saving ? <><Loader2 size={14} style={{ animation: "eh-spin 1s linear infinite" }} />Saving…</> : (mode === "create" ? "Create Key Result" : "Save")}
          </Button>
          <Button hierarchy="secondary" onClick={onClose}>Cancel</Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {err && (
          <ErrorBanner
            component="Key Result"
            process="save stopped"
            detail={err}
            action={<Button hierarchy="tertiary" size="sm" onClick={() => setErr(null)}>Dismiss</Button>}
          />
        )}

        {/* 1. Objective picker */}
        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>Objective</label>
          <select
            value={objId}
            onChange={(e) => setObjId(e.target.value)}
            style={{ width: "100%", height: 40, padding: "0 10px", fontSize: 14, fontFamily: "var(--font-sans)", color: "var(--text-primary)", background: "var(--color-white)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-input)", outline: "none" }}
          >
            {objectives.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
          </select>
        </div>

        {/* 2. KR name */}
        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>Key Result name</label>
          <input
            autoFocus={mode === "create"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Activation rate ≥ 40% by end of Q2"
            style={{ width: "100%", height: 40, padding: "0 12px", fontSize: 14, fontFamily: "var(--font-sans)", color: "var(--text-primary)", background: "var(--color-white)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-input)", outline: "none" }}
          />
        </div>

        {/* 3. Logic picker */}
        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
            Bound Logic <span style={{ fontWeight: 400, color: "var(--text-quaternary)" }}>(required for a live value)</span>
          </label>
          {logicOptions.length === 0 ? (
            <div style={{ padding: "12px 14px", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-xl)", background: "var(--gray-25)" }}>
              <EmptyState line="No Logics yet. Create one in the Logic panel." />
            </div>
          ) : (
            <>
              <input
                value={logicSearch}
                onChange={(e) => setLogicSearch(e.target.value)}
                placeholder="Search Logics…"
                style={{ width: "100%", height: 36, padding: "0 12px", fontSize: 13, fontFamily: "var(--font-sans)", color: "var(--text-primary)", background: "var(--color-white)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-input)", outline: "none", marginBottom: 6 }}
              />
              <div style={{ border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-xl)", overflow: "hidden", maxHeight: 180, overflowY: "auto" }} className="eh-scroll">
                {filteredLogic.map((l) => {
                  const sel = logicId === l.id;
                  return (
                    <button
                      key={l.id}
                      onClick={() => setLogicId(sel ? null : l.id)}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, width: "100%",
                        padding: "9px 12px", border: "none", textAlign: "left",
                        background: sel ? "var(--brand-50)" : "var(--color-white)",
                        borderBottom: "1px solid var(--border-tertiary)",
                        cursor: "pointer", fontFamily: "var(--font-sans)",
                      }}
                      onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = "var(--gray-25)"; }}
                      onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = "var(--color-white)"; }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: sel ? "var(--brand-700)" : "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</div>
                        <div style={{ fontSize: 11, color: "var(--text-quaternary)", marginTop: 1 }}>
                          v{l.version} · {l.usage_count} report{l.usage_count !== 1 ? "s" : ""}
                        </div>
                      </div>
                      {sel && <Check size={14} color="var(--brand-600)" />}
                    </button>
                  );
                })}
                {filteredLogic.length === 0 && (
                  <div style={{ padding: "12px 14px", fontSize: 13, color: "var(--text-quaternary)" }}>No Logics match.</div>
                )}
              </div>
            </>
          )}

          {/* live preview section */}
          {selectedLogic && (
            <div style={{
              marginTop: 10, padding: "11px 13px",
              background: "var(--brand-25)", border: "1px solid var(--brand-200)",
              borderRadius: "var(--radius-xl)", display: "flex", flexDirection: "column", gap: 6,
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--brand-800)" }}>{selectedLogic.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="tnum" style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.2px", color: "var(--brand-700)" }}>
                  {selectedLogic.current_value != null ? selectedLogic.current_value.toLocaleString("en-US") : <span style={{ fontFamily: "var(--font-mono)" }}>&mdash;</span>}
                </span>
                {selectedLogic.source_name && (
                  <span style={{ fontSize: 12, color: "var(--brand-600)" }}>{selectedLogic.source_name}</span>
                )}
                {selectedLogic.trace_ref && (
                  <span style={{ fontSize: 12, color: "var(--brand-600)", fontWeight: 500 }}>
                    · Trace available
                  </span>
                )}
              </div>
              {selectedLogic.computed_at && (
                <span style={{ fontSize: 11, color: "var(--brand-600)" }}>
                  Computed {relativeTimestamp(selectedLogic.computed_at).short}
                </span>
              )}
            </div>
          )}
        </div>

        {/* 4. Target */}
        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>Target</label>
          <input
            type="number"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="e.g. 4000"
            className="tnum"
            style={{ width: "100%", height: 40, padding: "0 12px", fontSize: 14, fontFamily: "var(--font-sans)", color: "var(--text-primary)", background: "var(--color-white)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-input)", outline: "none" }}
          />
        </div>

        {/* 5. Comparison */}
        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>Comparison</label>
          <Segmented<"gte" | "lte" | "eq">
            value={comparison}
            options={COMPARISON_OPTIONS}
            onChange={setComparison}
          />
        </div>

        {/* 6. Period */}
        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>Period</label>
          <Segmented<string>
            value={p}
            options={PERIOD_OPTIONS}
            onChange={setP}
          />
        </div>

        {/* 7. Live preview */}
        {selectedLogic && targetNum !== null && (
          <div style={{
            padding: "11px 13px", background: "var(--gray-50)", border: "1px solid var(--border-secondary)",
            borderRadius: "var(--radius-xl)", display: "flex", alignItems: "center", gap: 12,
          }}>
            <span className="tnum" style={{ fontSize: 14, fontWeight: 500, color: "var(--text-secondary)" }}>
              Live: {selectedLogic.current_value != null ? selectedLogic.current_value.toLocaleString("en-US") : "—"}
            </span>
            <span style={{ fontSize: 14, color: "var(--text-quaternary)" }}>{comparisonGlyph(comparison)}</span>
            <span className="tnum" style={{ fontSize: 14, fontWeight: 500, color: "var(--text-secondary)" }}>
              Target: {targetNum.toLocaleString("en-US")}
            </span>
            <span style={{ flex: 1 }} />
            {previewStatus && <KRStatusBadge status={previewStatus} />}
          </div>
        )}
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Board-deck export modal                                             */
/* ------------------------------------------------------------------ */

function ExportModal({ objectives, onClose }: { objectives: ObjectiveRow[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mdLines: string[] = [];
  objectives.forEach((obj) => {
    mdLines.push(`## ${obj.title}`);
    obj.krs.forEach((kr) => {
      const lv = formatValue(kr.live_value);
      const tgt = kr.target != null ? `${comparisonGlyph(kr.comparison)} ${kr.target.toLocaleString("en-US")}` : "—";
      const status = krStatusLabel(kr.status);
      mdLines.push(`- **${kr.name}** — ${lv} / ${tgt} · ${status}`);
      if (kr.logic) {
        mdLines.push(`  \`Trace: ${kr.logic.name} v${kr.logic.version}\``);
      }
    });
    mdLines.push("");
  });
  const md = mdLines.join("\n");

  const handleCopy = () => {
    copyText(md);
    setCopied(true);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setCopied(false), 1600);
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <Modal title="Board-deck export" onClose={onClose} width={720}>
      <div className="eh-scroll" style={{ maxHeight: "70vh", overflowY: "auto", padding: "20px 24px" }}>
        {objectives.map((obj) => (
          <div key={obj.id} style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.2px", marginBottom: 12, color: "var(--text-primary)" }}>
              {obj.title}
            </div>
            {obj.krs.map((kr) => (
              <div key={kr.id} style={{
                marginBottom: 14, padding: "12px 14px",
                border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-xl)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{kr.name}</span>
                  <KRStatusBadge status={kr.status} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
                  <span className="tnum" style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.2px" }}>
                    {formatValue(kr.live_value)}
                  </span>
                  {kr.target != null && (
                    <span className="tnum" style={{ fontSize: 13, color: "var(--text-quaternary)" }}>
                      {comparisonGlyph(kr.comparison)} {kr.target.toLocaleString("en-US")}
                    </span>
                  )}
                </div>
                {kr.logic && (
                  <div style={{
                    marginTop: 8,
                    fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: "18px",
                    color: "var(--text-tertiary)", background: "var(--gray-50)",
                    border: "1px solid var(--border-tertiary)", borderRadius: "var(--radius-sm)",
                    padding: "5px 8px", display: "inline-block",
                  }}>
                    Trace: {kr.logic.name} v{kr.logic.version}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, padding: "14px 20px", borderTop: "1px solid var(--border-secondary)" }}>
        <Button hierarchy="primary" iconLeading={copied ? <Check size={14} /> : <Copy size={14} />} onClick={handleCopy}>
          {copied ? "Copied" : "Copy as Markdown"}
        </Button>
        <Button hierarchy="secondary" iconLeading={<Printer size={14} />} onClick={handlePrint}>
          Print / Export PDF
        </Button>
        <span style={{ flex: 1 }} />
        <Button hierarchy="tertiary" onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* GoalsView (main export)                                            */
/* ------------------------------------------------------------------ */

export function GoalsView() {
  const goalsPeriod = useApp((s) => s.goalsPeriod);
  const setGoalsPeriod = useApp((s) => s.setGoalsPeriod);
  const goalsObjectiveDrawer = useApp((s) => s.goalsObjectiveDrawer);
  const setGoalsObjectiveDrawer = useApp((s) => s.setGoalsObjectiveDrawer);
  const krDrawerId = useApp((s) => s.krDrawerId);
  const openKRDrawer = useApp((s) => s.openKRDrawer);
  const closeKRDrawer = useApp((s) => s.closeKRDrawer);
  const openTrace = useApp((s) => s.openTrace);

  const [peekKrId, setPeekKrId] = useState<string | null>(null);
  const [krDrawerObjectiveId, setKrDrawerObjectiveId] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);

  // Server data via react-query
  const period = goalsPeriod === "Custom" ? undefined : goalsPeriod;
  const { data, isLoading: loading, isError, error: queryError, refetch } = useQuery({
    queryKey: queryKeys.goals(period),
    queryFn: () => goalsQueryFn(period),
    staleTime: 2 * 60 * 1000,
  });
  // Logic options for the KR drawer come from the bootstrap query
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });

  const error = isError ? (queryError instanceof Error ? queryError.message : "Failed to load goals") : null;
  const objectives = data?.objectives ?? [];
  const lastComputed = data?.period ?? null;
  const stale = isStale(lastComputed);
  const [errorKrName] = useState<string | null>(null);

  // find any error KRs for the ErrorBanner
  const errorKRs = objectives.flatMap((o) =>
    o.krs.filter((k) => k.live_value === null && k.logic_id !== null && k.status !== "draft")
  );

  const handleTogglePeek = (krId: string) => {
    setPeekKrId((prev) => (prev === krId ? null : krId));
  };

  const handleAddKR = (objectiveId: string) => {
    setKrDrawerObjectiveId(objectiveId);
    openKRDrawer(`new:${objectiveId}`);
  };

  const handleOpenKRDrawer = (krId: string) => {
    openKRDrawer(krId);
  };

  const handleTrace = (kr: KeyResultRow) => {
    if (!kr.logic || !kr.logic_id) return;
    const rep = findReportForMetric(kr.logic_id);
    if (rep) openTrace(rep.id, kr.logic_id);
  };

  const handleCreateObjective = async (name: string, objPeriod: string) => {
    await goalsApi.createObjective({ title: name, period: objPeriod });
    await invalidate.allGoals();
  };

  const handleKRSave = async (p: {
    objective_id: string;
    name: string;
    logic_id: string | null;
    target: number | null;
    comparison: "gte" | "lte" | "eq";
    period: string;
    krId?: string;
  }) => {
    if (p.krId) {
      await goalsApi.updateKR(p.krId, {
        name: p.name,
        logic_id: p.logic_id,
        target: p.target,
        comparison: p.comparison,
        period: p.period,
      });
    } else {
      await goalsApi.createKR({
        objective_id: p.objective_id,
        name: p.name,
        logic_id: p.logic_id ?? undefined,
        target: p.target ?? undefined,
        comparison: p.comparison,
        period: p.period,
      });
    }
    await invalidate.allGoals();
  };

  // resolve the kr being edited from krDrawerId
  const editingKR: KeyResultRow | undefined = (() => {
    if (!krDrawerId || krDrawerId.startsWith("new:")) return undefined;
    return objectives.flatMap((o) => o.krs).find((k) => k.id === krDrawerId);
  })();

  const editingObjectiveId: string = (() => {
    if (!krDrawerId) return objectives[0]?.id ?? "";
    if (krDrawerId.startsWith("new:")) return krDrawerObjectiveId ?? krDrawerId.slice(4);
    return editingKR?.objective_id ?? objectives[0]?.id ?? "";
  })();

  // logic options for the KR drawer — from the bootstrap query
  const logicOptions: BoundLogic[] = (bootstrap?.logic ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    version: l.version ?? "1",
    usage_count: l.usage ?? 0,
    current_value: null,
    source_name: null,
    trace_ref: null,
    computed_at: null,
  }));

  const computedLabel = stale
    ? <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--warning-600)", display: "inline-flex", alignItems: "center", gap: 5 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--warning-500)", display: "inline-block" }} />
        Stale
      </span>
    : lastComputed
      ? <Tooltip content={new Date(lastComputed).toLocaleString("en-US")}>
          <span className="tnum" style={{ fontSize: 12, color: "var(--text-quaternary)", cursor: "default" }}>
            Computed {relativeTimestamp(lastComputed).short}
          </span>
        </Tooltip>
      : null;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-secondary)", position: "relative" }}>
      {/* top bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "11px 20px 11px", borderBottom: "1px solid var(--border-secondary)",
        flexShrink: 0, background: "var(--surface-secondary)", zIndex: 20,
      }}>
        <Segmented<string>
          value={goalsPeriod}
          options={PERIOD_OPTIONS}
          onChange={setGoalsPeriod}
        />
        <span style={{ flex: 1 }} />
        {loading && <Loader2 size={14} color="var(--text-quaternary)" style={{ animation: "eh-spin 1s linear infinite" }} />}
        {computedLabel}
        <Button
          hierarchy="secondary"
          size="sm"
          iconLeading={<Share2 size={14} />}
          onClick={() => setShowExport(true)}
          disabled={objectives.length === 0}
        >
          Share
        </Button>
        <Button
          hierarchy="primary"
          size="sm"
          iconLeading={<Plus size={14} />}
          onClick={() => setGoalsObjectiveDrawer(true)}
        >
          Objective
        </Button>
      </div>

      {/* body */}
      <div className="eh-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {/* ErrorBanner for compute failures */}
        {errorKRs.length > 0 && (
          <div style={{ padding: "14px 24px 0" }}>
            <ErrorBanner
              component={`Logic "${errorKRs[0]?.logic?.name ?? errorKrName ?? "unknown"}"`}
              process="computation stopped"
              detail="The engine could not compute a live value for this key result. Check that the bound Logic inputs are reachable."
              action={<Button hierarchy="tertiary" size="sm" onClick={() => void refetch()}>Retry</Button>}
            />
          </div>
        )}

        {error && (
          <div style={{ padding: "14px 24px 0" }}>
            <ErrorBanner
              component="Goals"
              process="loading stopped"
              detail={error}
              action={<Button hierarchy="tertiary" size="sm" onClick={() => void refetch()}>Retry</Button>}
            />
          </div>
        )}

        {loading && !data && !error && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "64px 24px" }}>
            <Loader2 size={22} color="var(--text-quaternary)" style={{ animation: "eh-spin 1s linear infinite" }} />
          </div>
        )}

        {!loading && !error && objectives.length === 0 && (
          <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px", gap: 10 }}>
            <EmptyState
              line="No objectives for this period."
              button={
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <Button hierarchy="primary" iconLeading={<Plus size={14} />} onClick={() => setGoalsObjectiveDrawer(true)}>
                    Objective
                  </Button>
                  <span style={{ fontSize: 13, color: "var(--text-quaternary)" }}>
                    Create an Objective, then bind Key Results to your Logics.
                  </span>
                </div>
              }
            />
          </div>
        )}

        {!error && objectives.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "18px 24px 48px" }}>
            {objectives.map((obj) => (
              <ObjectiveSection
                key={obj.id}
                obj={obj}
                peekKrId={peekKrId}
                onTogglePeek={handleTogglePeek}
                onAddKR={handleAddKR}
                onOpenKRDrawer={handleOpenKRDrawer}
                onTrace={handleTrace}
              />
            ))}
          </div>
        )}
      </div>

      {/* Objective drawer */}
      {goalsObjectiveDrawer && (
        <ObjectiveDrawer
          period={goalsPeriod === "Custom" ? "Q2" : goalsPeriod}
          onClose={() => setGoalsObjectiveDrawer(false)}
          onCreate={handleCreateObjective}
        />
      )}

      {/* KR drawer */}
      {krDrawerId && (
        <KRDrawer
          mode={krDrawerId.startsWith("new:") ? "create" : "edit"}
          objectiveId={editingObjectiveId}
          kr={editingKR}
          objectives={objectives}
          logicOptions={logicOptions}
          period={goalsPeriod === "Custom" ? "Q2" : goalsPeriod}
          onClose={closeKRDrawer}
          onSave={handleKRSave}
        />
      )}

      {/* Export modal */}
      {showExport && (
        <ExportModal objectives={objectives} onClose={() => setShowExport(false)} />
      )}
    </div>
  );
}
