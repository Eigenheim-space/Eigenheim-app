import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, ArrowUpRight, ArrowDownRight, ArrowLeft, TrendingUp, X, Search, MoreHorizontal, FileText } from "lucide-react";
import { useApp } from "./store";
import { api, type ReportCreateOut } from "./api";
import { type Report, type Metric } from "./data";
import { Badge, StatusBadge, Button, Segmented, Sparkline, EmptyState, ErrorBanner, Modal, Tooltip, Field, Input, Drawer, IconButton } from "./ui";
import { queryKeys, bootstrapQueryFn, reportDetailQueryFn, getReportFromCache, getEngineReportIds, invalidate } from "./queries";

const cardBase: React.CSSProperties = {
  background: "var(--color-white)",
  border: "1px solid var(--border-secondary)",
  borderRadius: "var(--radius-xl)",
  boxShadow: "var(--shadow-xs)",
};
const periodChip = (p: string) => (
  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)", background: "var(--gray-100)", borderRadius: "var(--radius-sm)", padding: "1px 7px" }}>
    {p}
  </span>
);

/* Period label → days for the API ?days= param. "custom" is not yet
   implemented (no date-range picker), so we omit the override and the
   API returns the report's stored period_days. */
const PERIOD_DAYS: Record<string, number | undefined> = { "7d": 7, "30d": 30, "custom": undefined };

/* ---------------- Reports context list (two-tier Tier-2 column) ---------------- */
export function ReportsContextList() {
  const openReport = useApp((s) => s.openReport);
  const openReportId = useApp((s) => s.openReportId);
  const setReportDrawer = useApp((s) => s.setReportDrawer);
  const reportDrawer = useApp((s) => s.reportDrawer);
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const reports: Report[] = (bootstrap?.reports as Report[] | undefined) ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Section header */}
      <div style={{ padding: "16px 14px 8px", flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text-secondary)" }}>
          Reports
        </span>
      </div>

      {/* + New report row */}
      <div style={{ padding: "0 8px 4px", flexShrink: 0 }}>
        <button
          onClick={() => setReportDrawer(true)}
          aria-label="Create new report"
          style={{
            width: "100%", display: "flex", alignItems: "center", gap: 8,
            padding: "7px 8px", borderRadius: 7, border: "none", cursor: "pointer",
            background: "transparent", color: "var(--brand-600)",
            fontSize: 13, fontWeight: 600, fontFamily: "var(--font-sans)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        >
          <Plus size={14} style={{ flexShrink: 0 }} />
          New report
        </button>
      </div>

      {/* Divider */}
      {reports.length > 0 && (
        <div style={{ height: 1, background: "var(--border-tertiary)", margin: "0 10px 4px", flexShrink: 0 }} aria-hidden />
      )}

      {/* Report rows */}
      <div className="eh-scroll" style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
        {reports.length === 0 ? (
          <div style={{ padding: "12px 8px", fontSize: 12, color: "var(--text-quaternary)", lineHeight: 1.5 }}>
            No reports yet.
          </div>
        ) : (
          reports.map((r) => {
            const active = r.id === openReportId;
            return (
              <button
                key={r.id}
                tabIndex={0}
                onClick={() => openReport(r.id)}
                onKeyDown={(e) => { if (e.key === "Enter") openReport(r.id); }}
                aria-current={active ? "page" : undefined}
                title={r.name}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 8,
                  padding: "7px 8px", borderRadius: 7, border: "none", cursor: "pointer",
                  background: active ? "var(--surface-active)" : "transparent",
                  color: active ? "var(--text-primary)" : "var(--text-secondary)",
                  fontSize: 13, fontWeight: active ? 600 : 400,
                  fontFamily: "var(--font-sans)", textAlign: "left",
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--surface-hover)"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                {/* Name — truncated */}
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                  {r.name}
                </span>
                {/* Status badge */}
                <StatusBadge kind={r.status} />
                {/* Period chip */}
                <span style={{
                  fontSize: 11, fontWeight: 600, color: "var(--text-quaternary)",
                  background: "var(--gray-100)", borderRadius: "var(--radius-sm)",
                  padding: "1px 5px", flexShrink: 0,
                }}>
                  {r.period}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Create drawer — mounted here so it works from the context column */}
      {reportDrawer && (
        <CreateReportDrawer
          logics={bootstrap?.logic ?? []}
          onClose={() => setReportDrawer(false)}
          onCreated={(id) => { setReportDrawer(false); openReport(id); }}
        />
      )}
    </div>
  );
}

/* ---------------- Reports grid ---------------- */
export function ReportsGrid() {
  const openReport = useApp((s) => s.openReport);
  const setReportDrawer = useApp((s) => s.setReportDrawer);
  const reportDrawer = useApp((s) => s.reportDrawer);
  const firstRun = useApp((s) => s.firstRun);
  // Bootstrap gives us the live report list; fall back to mock on engine offline.
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const reports: Report[] = (bootstrap?.reports as Report[] | undefined) ?? [];
  if (firstRun) {
    return (
      <>
        <EmptyState line="Create your first report" button={<Button hierarchy="primary" iconLeading={<Plus size={16} />} onClick={() => setReportDrawer(true)}>Create report</Button>} />
        {reportDrawer && (
          <CreateReportDrawer
            logics={bootstrap?.logic ?? []}
            onClose={() => setReportDrawer(false)}
            onCreated={(id) => { setReportDrawer(false); openReport(id); }}
          />
        )}
      </>
    );
  }
  return (
    <div className="eh-scroll" style={{ height: "100%", overflowY: "auto", padding: 28 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em", margin: 0, flex: 1 }}>Reports</h1>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
        {reports.map((r) => <ReportCard key={r.id} report={r} onOpen={() => openReport(r.id)} />)}
        <button
          onClick={() => setReportDrawer(true)}
          aria-label="Create report"
          style={{ ...cardBase, boxShadow: "none", border: "1px dashed var(--border-primary)", background: "transparent", minHeight: 132, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", color: "var(--text-tertiary)" }}>
          <Plus size={20} /><span style={{ fontSize: 14, fontWeight: 600 }}>Create report</span>
        </button>
      </div>
      {reportDrawer && (
        <CreateReportDrawer
          logics={bootstrap?.logic ?? []}
          onClose={() => setReportDrawer(false)}
          onCreated={(id) => { setReportDrawer(false); openReport(id); }}
        />
      )}
    </div>
  );
}

/* ---------------- Card kebab dropdown ---------------- */

interface CardMenuProps {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  onClose: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function CardMenu({ anchorRef, open, onClose, onRename, onDuplicate, onDelete }: CardMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measure the anchor + rendered menu, then clamp/flip into the viewport so the
  // menu is never clipped at a screen edge (same approach as the Tooltip primitive).
  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !menuRef.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const MARGIN = 8, GAP = 4;
    let left = a.right - m.width;                                  // right-align under the kebab
    left = Math.max(MARGIN, Math.min(left, vw - m.width - MARGIN)); // keep on-screen horizontally
    let top = a.bottom + GAP;                                       // prefer below the anchor
    if (top + m.height > vh - MARGIN) {                             // flip above if no room below
      const above = a.top - m.height - GAP;
      top = above >= MARGIN ? above : Math.max(MARGIN, vh - m.height - MARGIN);
    }
    setPos({ top, left });
  }, [open, anchorRef]);

  // Reset position on close so a reopen re-measures instead of flashing at the old spot.
  useEffect(() => { if (!open) setPos(null); }, [open]);

  // Close on outside-click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose, anchorRef]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const itemStyle: React.CSSProperties = {
    display: "block", width: "100%", padding: "8px 14px", textAlign: "left", border: "none",
    background: "transparent", cursor: "pointer", fontSize: 13, fontFamily: "var(--font-sans)",
    color: "var(--text-primary)",
  };

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: pos ? pos.top : 0,
        left: pos ? pos.left : 0,
        visibility: pos ? "visible" : "hidden", // hide for the pre-measure frame
        width: 160,
        background: "var(--color-white)",
        border: "1px solid var(--border-secondary)",
        borderRadius: "var(--radius)",
        boxShadow: "var(--shadow-lg)",
        zIndex: 200,
        overflow: "hidden",
      }}
    >
      <button
        style={itemStyle}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        onClick={() => { onClose(); onRename(); }}
      >
        Rename
      </button>
      <button
        style={itemStyle}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        onClick={() => { onClose(); onDuplicate(); }}
      >
        Duplicate
      </button>
      <div style={{ height: 1, background: "var(--border-tertiary)", margin: "2px 0" }} />
      <button
        style={{ ...itemStyle, color: "var(--error-600)" }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--error-50)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        onClick={() => { onClose(); onDelete(); }}
      >
        Delete
      </button>
    </div>,
    document.body,
  );
}

/* ---------------- Rename modal ---------------- */
function RenameModal({ report, onClose, onSaved }: { report: Report; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(report.name);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameErr = !name.trim();

  const handleSave = async () => {
    if (nameErr) return;
    setSaving(true); setErr(null);
    try {
      await api.updateReport(report.id, { name: name.trim() });
      await invalidate.bootstrap();
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Rename report" onClose={onClose} width={400}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        <Field label="Name" error={nameErr && name !== report.name ? "Name is required" : undefined}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") void handleSave(); }}
          />
        </Field>
        {err && <ErrorBanner component="Report" process="rename stopped" detail={err} />}
        <div style={{ display: "flex", gap: 8 }}>
          <Button hierarchy="primary" disabled={nameErr || saving} onClick={() => void handleSave()}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button hierarchy="tertiary" onClick={onClose} disabled={saving}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- Delete confirm modal ---------------- */
function DeleteModal({ report, onClose, onDeleted }: { report: Report; onClose: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleDelete = async () => {
    setDeleting(true); setErr(null);
    try {
      await api.deleteReport(report.id);
      await invalidate.bootstrap();
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
      setDeleting(false);
    }
  };

  return (
    <Modal title="Delete report" onClose={onClose} width={420}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Delete report <strong>{report.name}</strong>? This removes its snapshots. This can't be undone.
        </p>
        {err && <ErrorBanner component="Report" process="delete stopped" detail={err} />}
        <div style={{ display: "flex", gap: 8 }}>
          <Button hierarchy="danger" disabled={deleting} onClick={() => void handleDelete()}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
          <Button hierarchy="tertiary" onClick={onClose} disabled={deleting}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- Report card ---------------- */
function ReportCard({ report, onOpen }: { report: Report; onOpen: () => void }) {
  const openReport = useApp((s) => s.openReport);
  const openReportId = useApp((s) => s.openReportId);
  const goReports = useApp((s) => s.goReports);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dupError, setDupError] = useState<string | null>(null);
  const kebabRef = useRef<HTMLDivElement>(null);

  const handleDuplicate = useCallback(async () => {
    setDupError(null);
    try {
      const result: ReportCreateOut = await api.duplicateReport(report.id);
      await invalidate.bootstrap();
      openReport(result.id);
    } catch (e) {
      setDupError(e instanceof Error ? e.message : "duplicate failed");
    }
  }, [report.id, openReport]);

  return (
    <>
      <div
        role="button" tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => e.key === "Enter" && onOpen()}
        style={{ ...cardBase, padding: 16, minHeight: 132, cursor: "pointer", display: "flex", flexDirection: "column", position: "relative" }}
        onMouseEnter={(e) => { e.currentTarget.style.boxShadow = "var(--shadow-md)"; e.currentTarget.style.transform = "translateY(-2px)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "var(--shadow-xs)"; e.currentTarget.style.transform = "none"; }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 600, flex: 1 }}>{report.name}</span>
          <StatusBadge kind={report.status} />
          <div ref={kebabRef} style={{ display: "inline-flex", flexShrink: 0 }}>
            <IconButton
              label="Report options"
              onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
              style={{ width: 28, height: 28 }}
            >
              <MoreHorizontal size={15} />
            </IconButton>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          {periodChip(report.period)}
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{report.metricCount ?? report.metrics.length} metrics</span>
        </div>
        <span style={{ flex: 1 }} />
        <div className="tnum" style={{ fontSize: 12, color: "var(--text-quaternary)", marginTop: 12 }}>{report.lastBuilt ? `built ${report.lastBuilt}` : "not built yet"}</div>
        {dupError && (
          <div style={{ position: "absolute", bottom: 8, left: 12, right: 12, fontSize: 12, color: "var(--error-600)" }}>
            {dupError}
          </div>
        )}
      </div>

      <CardMenu
        anchorRef={kebabRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onRename={() => setRenaming(true)}
        onDuplicate={() => void handleDuplicate()}
        onDelete={() => setDeleting(true)}
      />

      {renaming && (
        <RenameModal
          report={report}
          onClose={() => setRenaming(false)}
          onSaved={() => setRenaming(false)}
        />
      )}

      {deleting && (
        <DeleteModal
          report={report}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            // If this report is currently open in detail view, go back to the list.
            if (openReportId === report.id) goReports();
          }}
        />
      )}
    </>
  );
}

/* ---------------- Create report drawer ---------------- */

const PERIOD_OPTIONS: { label: string; days: number }[] = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "180d", days: 180 },
];

interface LogicItem { id: string; name: string; version: string; usage: number; expression: string; badge?: string | null }

function LogicPicker({
  logics,
  added,
  onAdd,
  onRemove,
}: {
  logics: LogicItem[];
  added: string[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = logics.filter(
    (l) => !added.includes(l.id) && l.name.toLowerCase().includes(search.toLowerCase())
  );

  if (logics.length === 0) {
    return (
      <div style={{ border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-md)", padding: "14px 16px" }}>
        <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>No Logics yet. Create a Logic in the right panel first.</span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ position: "relative" }}>
        <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-quaternary)", pointerEvents: "none" }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search formulas…"
          aria-label="Search Logic formulas"
          style={{ width: "100%", height: 36, padding: "0 10px 0 32px", fontSize: 13, fontFamily: "var(--font-sans)", color: "var(--text-primary)", background: "var(--color-white)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-md)", outline: "none", boxSizing: "border-box" }}
        />
      </div>
      {filtered.length > 0 && (
        <div style={{ border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-md)", overflow: "hidden", maxHeight: 180, overflowY: "auto" }} className="eh-scroll">
          {filtered.map((l, i) => (
            <button
              key={l.id}
              onClick={() => { onAdd(l.id); setSearch(""); }}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 14px", border: "none", borderTop: i > 0 ? "1px solid var(--border-tertiary)" : "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font-sans)", textAlign: "left" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</div>
                <div style={{ fontSize: 11, color: "var(--text-quaternary)", marginTop: 1 }}>{l.expression}</div>
              </div>
              <Plus size={14} color="var(--brand-600)" style={{ flexShrink: 0 }} />
            </button>
          ))}
        </div>
      )}
      {added.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-quaternary)", marginBottom: 4 }}>
            Selected ({added.length})
          </span>
          {added.map((id) => {
            const l = logics.find((x) => x.id === id);
            return (
              <div key={id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--color-white)", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-md)" }}>
                <span style={{ flex: 1, fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {l?.name ?? id}
                </span>
                <button
                  onClick={() => onRemove(id)}
                  aria-label={`Remove ${l?.name ?? id}`}
                  style={{ border: "none", background: "transparent", padding: 2, cursor: "pointer", display: "flex", alignItems: "center" }}
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

function CreateReportDrawer({
  logics,
  onClose,
  onCreated,
}: {
  logics: LogicItem[];
  onClose: () => void;
  onCreated: (reportId: string) => void;
}) {
  const [name, setName] = useState("");
  const [periodDays, setPeriodDays] = useState(30);
  const [logicIds, setLogicIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const nameErr = !name.trim();

  const handleSave = async () => {
    if (nameErr) return;
    setSaving(true); setSaveError(null);
    try {
      const result: ReportCreateOut = await api.createReport({
        name: name.trim(),
        period_days: periodDays,
        logic_ids: logicIds,
      });
      await Promise.all([invalidate.bootstrap(), invalidate.allReportDetails()]);
      onCreated(result.id);
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
        <div style={{ display: "flex", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid var(--border-secondary)", flexShrink: 0, background: "var(--color-white)" }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>New report</span>
          <span style={{ flex: 1 }} />
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </div>
      }
      footer={
        <div style={{ display: "flex", gap: 10, padding: "14px 20px" }}>
          <Button
            hierarchy="primary"
            style={{ flex: 1 }}
            disabled={nameErr || saving}
            onClick={handleSave}
          >
            {saving ? "Creating…" : "Create report"}
          </Button>
          <Button hierarchy="tertiary" onClick={onClose} disabled={saving}>Cancel</Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <Field label="Name" error={nameErr && name !== "" ? "Name is required" : undefined}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Activation · Weekly"
            autoFocus
          />
        </Field>

        <Field label="Period">
          <Segmented
            value={String(periodDays)}
            onChange={(v) => setPeriodDays(Number(v))}
            options={PERIOD_OPTIONS.map((p) => ({ value: String(p.days), label: p.label }))}
          />
        </Field>

        <Field
          label="Formulas"
          hint="Logic formulas to include as metric tiles. You can add more after creation."
        >
          <LogicPicker
            logics={logics}
            added={logicIds}
            onAdd={(id) => setLogicIds((prev) => [...prev, id])}
            onRemove={(id) => setLogicIds((prev) => prev.filter((x) => x !== id))}
          />
        </Field>

        {saveError && (
          <ErrorBanner
            component="Report"
            process="create stopped"
            detail={saveError}
          />
        )}

        <div style={{ fontSize: 12, color: "var(--text-quaternary)", lineHeight: 1.5, paddingBottom: 4 }}>
          The report is created empty. Use "Build report" inside the report to populate metric values.
        </div>
      </div>
    </Drawer>
  );
}

/* ---------------- Add metric drawer ---------------- */

/**
 * Lets the user add one or more Logic formulas to an existing report.
 * Reads existing logic_ids from the report definition (NOT from report.metrics,
 * which is empty while the report is in "collecting" status).
 * Dedupes: never adds an ID already present in existingLogicIds.
 */
function AddMetricDrawer({
  reportId,
  existingLogicIds,
  logics,
  onClose,
  onAdded,
}: {
  reportId: string;
  existingLogicIds: string[];
  logics: LogicItem[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [added, setAdded] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async () => {
    if (added.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Merge with existing, deduping by ID
      const merged = [...new Set([...existingLogicIds, ...added])];
      await api.updateReport(reportId, { logic_ids: merged });
      await Promise.all([
        invalidate.reportDetail(reportId),
        invalidate.bootstrap(),
      ]);
      onAdded();
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
        <div style={{ display: "flex", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid var(--border-secondary)", flexShrink: 0, background: "var(--color-white)" }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>Add metric</span>
          <span style={{ flex: 1 }} />
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </div>
      }
      footer={
        <div style={{ display: "flex", gap: 10, padding: "14px 20px" }}>
          <Button
            hierarchy="primary"
            style={{ flex: 1 }}
            disabled={added.length === 0 || saving}
            onClick={() => void handleSave()}
          >
            {saving ? "Adding…" : `Add ${added.length > 0 ? `${added.length} ` : ""}metric${added.length !== 1 ? "s" : ""}`}
          </Button>
          <Button hierarchy="tertiary" onClick={onClose} disabled={saving}>Cancel</Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Choose formulas to add to this report. Already-included metrics are excluded from the list.
        </div>
        <LogicPicker
          logics={logics}
          added={[...existingLogicIds, ...added]}
          onAdd={(id) => setAdded((prev) => [...prev, id])}
          onRemove={(id) => setAdded((prev) => prev.filter((x) => x !== id))}
        />
        {saveError && (
          <ErrorBanner
            component="Report"
            process="metric add stopped"
            detail={saveError}
          />
        )}
      </div>
    </Drawer>
  );
}

/* ---------------- Report view ---------------- */
export function ReportView() {
  const id = useApp((s) => s.openReportId);
  const goReports = useApp((s) => s.goReports);
  const openTrace = useApp((s) => s.openTrace);
  const collectOpen = useApp((s) => s.collectOpen);
  const setCollect = useApp((s) => s.setCollect);
  const engineLive = useApp((s) => s.engineLive);
  const [period, setPeriod] = useState<"7d" | "30d" | "custom">("30d");
  const [addMetricOpen, setAddMetricOpen] = useState(false);

  const engineReportIds = getEngineReportIds();
  const isEngineReport = id !== null && engineReportIds.includes(id);
  const days = period !== "custom" ? PERIOD_DAYS[period] : undefined;

  // Bootstrap gives us the logic list for the metric picker
  const { data: bootstrap } = useQuery({
    queryKey: queryKeys.engineBootstrap,
    queryFn: bootstrapQueryFn,
    staleTime: 2 * 60 * 1000,
  });

  // Live query for the detail view. Only enabled when the engine is up and
  // this report is engine-backed. Falls back to the mock on isError.
  const { data: liveReport, isError: detailError } = useQuery({
    queryKey: queryKeys.reportDetail(id ?? "", days),
    queryFn: () => reportDetailQueryFn(id!, days),
    enabled: !!id && engineLive && isEngineReport && period !== "custom",
    staleTime: 2 * 60 * 1000,
  });

  // Resolve report: live > query-cache fallback > mock
  const report = liveReport ?? getReportFromCache(id) ?? null;

  // Count-up animation fires only on first live-data load for this report ID.
  const firstLoadRef = useRef(true);
  const prevIdRef = useRef<string | null>(null);
  if (id !== prevIdRef.current) { firstLoadRef.current = true; prevIdRef.current = id; }
  const isFirstLoad = firstLoadRef.current && engineLive && isEngineReport;
  if (isFirstLoad && report?.metrics && report.metrics.length > 0) firstLoadRef.current = false;

  if (!report) return null;
  void detailError; // offline — the mock report is shown as fallback

  // Read existing logic_ids from the report definition — NOT from report.metrics,
  // which is empty while the report is in "collecting" status.
  const existingLogicIds: string[] = report.logic_ids ?? [];

  return (
    <div className="eh-scroll" style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ position: "sticky", top: 0, background: "var(--surface-secondary)", borderBottom: "1px solid var(--border-secondary)", padding: "16px 28px", display: "flex", alignItems: "center", gap: 14, zIndex: 4 }}>
        <button onClick={goReports} aria-label="Back" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--fg-tertiary)", display: "flex" }}><ArrowLeft size={18} /></button>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>{report.name}</h1>
        <StatusBadge kind={report.status} />
        <span style={{ flex: 1 }} />
        <Segmented
          value={period}
          onChange={setPeriod}
          options={[{ value: "7d", label: "7d" }, { value: "30d", label: "30d" }, { value: "custom", label: "Custom" }]}
        />
        <Button
          hierarchy="secondary"
          iconLeading={<Plus size={15} />}
          onClick={() => setAddMetricOpen(true)}
        >
          Add metric
        </Button>
        <Button hierarchy="primary" iconLeading={<TrendingUp size={15} />} onClick={() => setCollect(true)}>Build report</Button>
      </div>
      <div style={{ padding: 28 }}>
        {report.metrics.length === 0 ? (
          <EmptyState
            line="No metrics yet — build the report to populate it."
            button={
              <Tooltip content="Choose a rebuild frequency and run — the report will fill with metrics">
                <Button hierarchy="primary" iconLeading={<TrendingUp size={15} />} onClick={() => setCollect(true)}>
                  Build report
                </Button>
              </Tooltip>
            }
          />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 16 }}>
            {report.metrics.map((m) => <MetricCard key={m.id} metric={m} onOpen={() => openTrace(report.id, m.id)} animate={isFirstLoad} />)}
          </div>
        )}
      </div>
      {collectOpen && <CollectDialog reportId={report.id} onClose={() => setCollect(false)} count={Math.max(((report as Report).metricCount ?? report.metrics.length), 1)} />}
      {addMetricOpen && (
        <AddMetricDrawer
          reportId={report.id}
          existingLogicIds={existingLogicIds}
          logics={bootstrap?.logic ?? []}
          onClose={() => setAddMetricOpen(false)}
          onAdded={() => setAddMetricOpen(false)}
        />
      )}
    </div>
  );
}

function Delta({ v }: { v: number | null | undefined }) {
  if (v == null) return <span style={{ fontSize: 12, color: "var(--text-quaternary)" }}>—</span>;
  const up = v >= 0;
  const color = up ? "var(--success-600)" : "var(--error-600)";
  return (
    <span className="tnum" style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 12, fontWeight: 600, color }}>
      {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{Math.abs(v).toFixed(1)}%
    </span>
  );
}

/*
 * MetricCard accepts an optional `animate` flag (true = first real-data load).
 * When true, the value plays the eh-count-up keyframe (120ms, ease-out).
 * Static on all subsequent renders — the flag must NOT change after mount.
 */
export function MetricCard({ metric, onOpen, animate }: { metric: Metric; onOpen: () => void; animate?: boolean }) {
  const mock = metric.status === "mock";
  return (
    <div
      role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}
      style={{ ...cardBase, padding: 16, cursor: "pointer", position: "relative", overflow: "hidden" }}
      onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "var(--shadow-md)")}
      onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "var(--shadow-xs)")}>
      {mock && <div className="eh-mock-hatch" aria-hidden style={{ position: "absolute", inset: 0, opacity: 0.5, pointerEvents: "none" }} />}
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Tooltip content={`Open trace: how metric "${metric.name}" is calculated`}>
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{metric.name}</span>
          </Tooltip>
          {mock && <Badge tone="neutral">mock</Badge>}
          {metric.status === "stale" && <StatusBadge kind="stale" />}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 10, gap: 8 }}>
          <div>
            {/* 1.8 count-up: fires only when animate=true (first real load), collapses under reduced-motion via CSS */}
            <div className="tnum" style={{
              fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em", lineHeight: 1,
              animation: animate ? "eh-count-up 120ms ease-out both" : undefined,
            }}>{metric.value}</div>
            <div style={{ marginTop: 6 }}><Delta v={metric.delta} /></div>
          </div>
          <div style={{ opacity: mock ? 0.4 : 1 }}><Sparkline data={metric.spark} muted={mock} /></div>
        </div>
        {metric.note && (
          <div style={{ fontSize: 12, color: "var(--warning-700)", marginTop: 10 }}>
            {metric.note}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Collect dialog + in-progress ---------------- */
const FREQ = ["1h", "4h", "6h", "12h", "24h", "7d"];
function CollectDialog({ reportId, onClose, count }: { reportId: string; onClose: () => void; count: number }) {
  const [freq, setFreq] = useState("24h");
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [collectError, setCollectError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  const start = () => {
    setRunning(true); setDone(0); setCollectError(null);
    const collected = api.collect(reportId, freq).catch((e: unknown) => {
      setCollectError(e instanceof Error ? e.message : "unknown error");
      return null;
    });
    timer.current = setInterval(() => {
      setDone((d) => {
        if (d + 1 >= count) {
          if (timer.current) clearInterval(timer.current);
          collected.then(() => { void invalidate.reportDetail(reportId); setTimeout(onClose, 500); });
        }
        return d + 1;
      });
    }, 650);
  };
  const progress = Math.min(done / Math.max(count, 1), 1);
  return (
    <Modal title={running ? "Building report" : "Build report"} onClose={onClose} width={460}>
      <div style={{ padding: 20 }}>
        {!running ? (
          <>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 8 }}>Rebuild frequency</div>
            <Segmented value={freq} onChange={setFreq} options={FREQ.map((f) => ({ value: f, label: f }))} />
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 10 }}>The report rebuilds locally, with zero LLM calls.</div>
            <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
              <Button hierarchy="primary" onClick={start}>Build now</Button>
              <Button hierarchy="tertiary" onClick={onClose}>Cancel</Button>
            </div>
          </>
        ) : (
          <>
            <div className="tnum" style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 12 }}>
              metric {Math.min(done + 1, count)} of {count}
            </div>
            {/*
             * 1.8 sync wave: a horizontal bar that resolves left-to-right as items complete.
             * The outer track is the full width; the inner fill scaleX-animates via eh-sync-resolve
             * driven by the inline width. transform-origin: left ensures it resolves L→R.
             */}
            <div style={{ height: 6, borderRadius: 999, background: "var(--gray-100)", overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: `${progress * 100}%`,
                background: "var(--brand-500)",
                borderRadius: 999,
                transformOrigin: "left center",
                transition: "width 400ms cubic-bezier(0.4,0,0.2,1)",
              }} />
            </div>
            {/* waveform beneath the bar */}
            <div style={{ display: "flex", alignItems: "center", gap: 4, height: 28, marginTop: 14, justifyContent: "center" }} aria-hidden>
              {Array.from({ length: 9 }).map((_, i) => (
                <span key={i} style={{
                  width: 3, height: 20, borderRadius: 2,
                  /* resolved items are solid brand; pending items are muted */
                  background: i / 9 < progress ? "var(--brand-500)" : "var(--gray-200)",
                  animation: i / 9 < progress ? undefined : `eh-wave 1s ease-in-out ${i * 0.08}s infinite`,
                  transition: "background 200ms ease",
                }} />
              ))}
            </div>
            {collectError && (
              <div style={{ marginTop: 14 }}>
                <ErrorBanner
                  component="Collect"
                  process="report build stopped"
                  detail={collectError}
                  action={<Button hierarchy="secondary" size="sm" onClick={onClose}>Close</Button>}
                />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
