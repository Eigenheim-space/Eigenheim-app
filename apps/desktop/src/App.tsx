import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApp } from "./store";
import { LeftRail, RightPanel, BootState, EngineFailure, DemoBar } from "./shell";
import { ReportsGrid, ReportView } from "./reports";
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
import { queryKeys, bootstrapQueryFn, reportDetailQueryFn, getEngineReportIds, queryClient } from "./queries";
import { api } from "./api";

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
  const setTrackerCount = useApp((s) => s.setTrackerCount);

  // Bootstrap query: replaces the old loadFromEngine() + trackers useEffect.
  // On success → engineLive=true; on error → engineLive=false (offline/mock mode).
  const { isSuccess: bootstrapOk, isError: bootstrapErr } = useQuery({
    queryKey: queryKeys.engineBootstrap,
    queryFn: bootstrapQueryFn,
    // Retry aggressively at startup — engine may be starting up
    retry: 3,
    retryDelay: 1000,
  });

  useEffect(() => {
    if (bootstrapOk) {
      setEngineLive(true);
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
  }, [bootstrapOk, setEngineLive]);

  useEffect(() => {
    if (bootstrapErr) setEngineLive(false);
  }, [bootstrapErr, setEngineLive]);

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

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-secondary)" }}>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <LeftRail />
        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--surface-secondary)", overflow: "hidden" }}>
          {engine === "booting" ? <BootState />
            : engine === "failed" ? <EngineFailure />
            : view === "settings" ? <Settings />
            : view === "report" ? <ReportView />
            : view === "tasks" ? <TasksView />
            : view === "goals" ? <GoalsView />
            : view === "hypotheses" ? <HypothesesView />
            : view === "decisions" ? <DecisionsView />
            : view === "graph" ? <GraphView />
            : view === "rice" ? <RiceView />
            : <ReportsGrid />}
        </main>
        {engine === "ready" && <RightPanel />}
      </div>

      {/* overlays */}
      <TraceModal />
      <LogicDrawer />
      <SyncDrawer />
      <Onboarding />
      <CoachMarks />
      <UpdateToast />
      <ChatOverlay />
      <DemoBar />
      {/* silence unused warning when right panel hidden */}
      <span hidden>{String(rightOpen)}</span>
    </div>
  );
}
