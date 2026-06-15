import { useEffect, useRef } from "react";
import { FileText, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useApp, onboardingSeen, markOnboardingSeen } from "./store";
import { secrets } from "./secrets";
import { LeftRail, RightPanel, ContextColumn, BootState, EngineFailure } from "./shell";
import { ReportView } from "./reports";
import { Settings } from "./settings";
import { TraceModal } from "./trace";
import { LogicDrawer, SyncDrawer } from "./panel";
import { Onboarding, CoachMarks, UpdateToast } from "./onboarding";
import { TasksView } from "./tasks";
import { GoalsView } from "./goals";
import { HypothesesView } from "./hypotheses";
import { DecisionsView } from "./decisions";
import { GraphView } from "./graph";
import { RiceView } from "./rice";
import { ChatOverlay } from "./chat/ChatOverlay";
import { ChatPage } from "./chat/ChatPage";
import { queryKeys, bootstrapQueryFn, reportDetailQueryFn, getEngineReportIds, queryClient } from "./queries";
import { api } from "./api";
import { updaterBridge } from "./updater";

/* Center empty/select state shown in the Reports section when no report is open yet. */
function ReportsSelectState() {
  const setReportDrawer = useApp((s) => s.setReportDrawer);
  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 14,
      color: "var(--text-tertiary)",
    }}>
      <FileText size={36} strokeWidth={1.25} style={{ opacity: 0.45 }} />
      <div style={{ fontSize: 14, color: "var(--text-tertiary)" }}>
        Select a report from the list, or create one.
      </div>
      <button
        onClick={() => setReportDrawer(true)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "7px 14px", borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-primary)", background: "var(--color-white)",
          color: "var(--text-secondary)", fontSize: 13, fontWeight: 600,
          fontFamily: "var(--font-sans)", cursor: "pointer",
          boxShadow: "var(--shadow-xs)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-white)"; }}
      >
        <Plus size={14} />
        Create report
      </button>
    </div>
  );
}

export function App() {
  const engine = useApp((s) => s.engine);
  const view = useApp((s) => s.view);
  const rightOpen = useApp((s) => s.rightOpen);
  const toggleRail = useApp((s) => s.toggleRail);
  const toggleRight = useApp((s) => s.toggleRight);
  const openChat = useApp((s) => s.openChat);
  const closeChat = useApp((s) => s.closeChat);
  const chatOpen = useApp((s) => s.chatOpen);
  const setEngineLive = useApp((s) => s.setEngineLive);
  const setEngine = useApp((s) => s.setEngine);
  const setTrackerCount = useApp((s) => s.setTrackerCount);
  const setUpdater = useApp((s) => s.setUpdater);
  const setAppVersion = useApp((s) => s.setAppVersion);
  const startOnboarding = useApp((s) => s.startOnboarding);

  // Subscribe to in-app update status + load the real app version (Electron only).
  useEffect(() => {
    if (!updaterBridge) return;
    updaterBridge.version().then(setAppVersion).catch(() => {});
    return updaterBridge.onStatus(setUpdater);
  }, [setUpdater, setAppVersion]);

  // Bootstrap query: replaces the old loadFromEngine() + trackers useEffect.
  // On success → engineLive=true; on error → engineLive=false (offline/mock mode).
  // retry:20 / retryDelay:1000 gives ~20s of patience after the window opens.
  // The Electron main process waits up to 30s for /health before opening the window,
  // so in practice the engine is already up — but on a slow first launch (bundled
  // python cold-start) the window may appear before /health answers, and this retry
  // loop keeps the BootState visible rather than prematurely declaring failure.
  const { isSuccess: bootstrapOk, isError: bootstrapErr } = useQuery({
    queryKey: queryKeys.engineBootstrap,
    queryFn: bootstrapQueryFn,
    retry: 20,
    retryDelay: 1000,
  });

  useEffect(() => {
    if (bootstrapOk) {
      setEngineLive(true);
      setEngine("ready"); // engine answered → leave the boot screen
      // Prefetch every report detail into the query cache so findReportForMetric
      // can resolve Trace links against LIVE data even when the user lands on
      // Goals/Hypotheses/Decisions/Rice/Tasks before opening a ReportView.
      getEngineReportIds().forEach((id) => {
        queryClient.prefetchQuery({
          queryKey: queryKeys.reportDetail(id),
          queryFn: () => reportDetailQueryFn(id),
        });
      });
    }
  }, [bootstrapOk, setEngineLive, setEngine]);

  useEffect(() => {
    if (bootstrapErr) { setEngineLive(false); setEngine("failed"); }
  }, [bootstrapErr, setEngineLive, setEngine]);

  // Auto-show onboarding exactly once on first run.
  // Latch ensures the check never re-fires on re-renders even if bootstrapOk
  // flickers; the seen flag in localStorage prevents re-triggering across launches.
  const obChecked = useRef(false);
  useEffect(() => {
    if (!bootstrapOk) return;
    if (obChecked.current) return;
    obChecked.current = true;

    async function checkFirstRun() {
      if (onboardingSeen()) return;
      // Источник уже настроен — не тревожим, просто помечаем seen
      const sources = await secrets.listSources().catch(() => []);
      if (sources.length > 0) {
        markOnboardingSeen();
        return;
      }
      startOnboarding();
    }

    checkFirstRun();
  }, [bootstrapOk, startOnboarding]);

  // Tracker count: used only for the Tasks rail gate.
  useQuery({
    queryKey: queryKeys.trackers,
    queryFn: async () => {
      const rows = await api.trackers();
      setTrackerCount(rows.length);
      return rows;
    },
  });

  // Keyboard shortcuts: Cmd/Ctrl+B (left rail), Cmd/Ctrl+Shift+B (right panel), Cmd/Ctrl+K (chat)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (e.shiftKey) toggleRight();
        else toggleRail();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (chatOpen) closeChat();
        else openChat();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [toggleRail, toggleRight, openChat, closeChat, chatOpen]);

  // Auto-collapse the right panel below 1100px window width
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 1100 && useApp.getState().rightOpen) useApp.setState({ rightOpen: false });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The context column is visible on reports/report views.
  // When it's present, suppress the right panel to avoid a four-column layout.
  const hasContextColumn = engine === "ready" && (view === "reports" || view === "report");

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-secondary)" }}>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <LeftRail />
        {/* Context column: Reports section only; null on every other view */}
        <ContextColumn />
        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--surface-secondary)", overflow: "hidden" }}>
          {engine === "booting" ? <BootState />
            : engine === "failed" ? <EngineFailure />
            : view === "settings" ? <Settings />
            : view === "chat" ? <ChatPage />
            : view === "report" ? <ReportView />
            : view === "tasks" ? <TasksView />
            : view === "goals" ? <GoalsView />
            : view === "hypotheses" ? <HypothesesView />
            : view === "decisions" ? <DecisionsView />
            : view === "graph" ? <GraphView />
            : view === "rice" ? <RiceView />
            : /* view === "reports" — no report selected yet */
              <ReportsSelectState />}
        </main>
        {/* Suppress the right data panel on chat (has its own sidebar) and when
            the context column is visible (avoids four-column layout collision). */}
        {engine === "ready" && view !== "chat" && !hasContextColumn && <RightPanel />}
      </div>

      {/* overlays */}
      <TraceModal />
      <LogicDrawer />
      <SyncDrawer />
      <Onboarding />
      <CoachMarks />
      <UpdateToast />
      <ChatOverlay />
      {/* silence unused warning when right panel hidden */}
      <span hidden>{String(rightOpen)}</span>
    </div>
  );
}
