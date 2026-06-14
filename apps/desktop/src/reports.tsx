import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ArrowUpRight, ArrowDownRight, ArrowLeft, TrendingUp } from "lucide-react";
import { useApp } from "./store";
import { api } from "./api";
import { type Report, type Metric } from "./data";
import { Badge, StatusBadge, Button, Segmented, Sparkline, EmptyState, ErrorBanner, Modal, Tooltip } from "./ui";
import { ChatAffordance } from "./chat/ChatOverlay";
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

/* ---------------- Reports grid ---------------- */
export function ReportsGrid() {
  const openReport = useApp((s) => s.openReport);
  const firstRun = useApp((s) => s.firstRun);
  // Bootstrap gives us the live report list; fall back to mock on engine offline.
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const reports: Report[] = (bootstrap?.reports as Report[] | undefined) ?? [];
  if (firstRun) {
    return <EmptyState line="Create your first report" button={<Button hierarchy="primary" iconLeading={<Plus size={16} />}>Create report</Button>} />;
  }
  return (
    <div className="eh-scroll" style={{ height: "100%", overflowY: "auto", padding: 28 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em", margin: 0, flex: 1 }}>Reports</h1>
        <ChatAffordance />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
        {reports.map((r) => <ReportCard key={r.id} report={r} onOpen={() => openReport(r.id)} />)}
        <button
          onClick={() => reports[0] && openReport(reports[0].id)}
          style={{ ...cardBase, boxShadow: "none", border: "1px dashed var(--border-primary)", background: "transparent", minHeight: 132, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", color: "var(--text-tertiary)" }}>
          <Plus size={20} /><span style={{ fontSize: 14, fontWeight: 600 }}>Create report</span>
        </button>
      </div>
    </div>
  );
}

/* Card menu (rename/duplicate/delete) is removed — those mutations have no
   backend endpoints yet. The button would show a menu that lies about its
   ability to do anything. Removed until the endpoints exist. */
function ReportCard({ report, onOpen }: { report: Report; onOpen: () => void }) {
  return (
    <div
      role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}
      style={{ ...cardBase, padding: 16, minHeight: 132, cursor: "pointer", display: "flex", flexDirection: "column", position: "relative" }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = "var(--shadow-md)"; e.currentTarget.style.transform = "translateY(-2px)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "var(--shadow-xs)"; e.currentTarget.style.transform = "none"; }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 16, fontWeight: 600, flex: 1 }}>{report.name}</span>
        <StatusBadge kind={report.status} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
        {periodChip(report.period)}
        <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{report.metricCount ?? report.metrics.length} metrics</span>
      </div>
      <span style={{ flex: 1 }} />
      <div className="tnum" style={{ fontSize: 12, color: "var(--text-quaternary)", marginTop: 12 }}>built {report.lastBuilt}</div>
    </div>
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

  const engineReportIds = getEngineReportIds();
  const isEngineReport = id !== null && engineReportIds.includes(id);
  const days = period !== "custom" ? PERIOD_DAYS[period] : undefined;

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
        <ChatAffordance />
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
