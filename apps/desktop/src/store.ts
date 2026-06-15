import { create } from "zustand";
import type { ChatMessage, ProviderKind } from "./chat/providers";

// ─── Onboarding persistence (localStorage, survives restarts) ─────────────────
// Fail-safe: treat localStorage errors as "seen" so we never nag on an error.
const OB_SEEN_KEY = "eigenheim.onboardingSeen";

export function onboardingSeen(): boolean {
  try {
    return localStorage.getItem(OB_SEEN_KEY) === "1";
  } catch {
    return true; // sandboxed / unavailable — don't nag
  }
}

export function markOnboardingSeen(): void {
  try {
    localStorage.setItem(OB_SEEN_KEY, "1");
  } catch {
    // игнорируем: если localStorage недоступен, просто не помечаем
  }
}

export type EngineState = "booting" | "ready" | "failed";
export type RightTab = "events" | "logic" | "syncs" | "tasks";
export type View = "reports" | "report" | "settings" | "tasks" | "goals" | "hypotheses" | "decisions" | "graph" | "rice";
export type SettingsSection = "datasources" | "apikeys" | "appearance" | "updates" | "about" | "aichat";
export type ObStep = "welcome" | "datasource" | "sync" | "coach" | "mcpkey" | null;
export type TasksView = "by-goal" | "all";
export type UpdaterState = "idle" | "checking" | "available" | "downloading" | "downloaded" | "none" | "error";
export interface UpdaterStatus { state: UpdaterState; version?: string; progress?: number; platform?: string; error?: string; }

export interface TasksFilter {
  search: string;
  status: string;
  source: string;
  assignee: string;
  metric: string;
  sort: "title" | "status" | "updated";
  sortDir: "asc" | "desc";
}

interface AppState {
  engine: EngineState;
  setEngine: (e: EngineState) => void;
  restartEngine: () => void;

  // engineLive: true once the bootstrap query succeeds.
  // Kept in Zustand (not query cache) because it is read by ChatOverlay
  // and Trace link resolution outside of React render (getState()).
  engineLive: boolean;
  setEngineLive: (v: boolean) => void;

  // onboarding
  firstRun: boolean;
  obStep: ObStep;
  coachIndex: number;
  dataSourceConnected: boolean;
  startOnboarding: () => void;
  setObStep: (s: ObStep) => void;
  nextCoach: () => void;
  dismissCoach: () => void;
  connectDataSource: () => void;
  finishOnboarding: () => void;
  toggleFirstRun: () => void;

  // shell
  railCollapsed: boolean;
  toggleRail: () => void;
  rightOpen: boolean;
  toggleRight: () => void;
  rightTab: RightTab;
  setRightTab: (t: RightTab) => void;
  rightWidth: number;
  setRightWidth: (w: number) => void;

  // nav
  view: View;
  openReportId: string | null;
  settingsSection: SettingsSection;
  goReports: () => void;
  openReport: (id: string) => void;
  goSettings: () => void;
  setSettingsSection: (s: SettingsSection) => void;
  goTasks: () => void;

  // overlays
  traceMetric: { reportId: string; metricId: string } | null;
  openTrace: (reportId: string, metricId: string) => void;
  closeTrace: () => void;
  collectOpen: boolean;
  setCollect: (v: boolean) => void;
  logicDrawer: boolean;
  setLogicDrawer: (v: boolean) => void;
  /** When set, LogicDrawer opens prefilled with these values (template "Use" flow). */
  logicDrawerSeed: { name: string; event: string; expression: string } | null;
  setLogicDrawerSeed: (seed: { name: string; event: string; expression: string } | null) => void;
  reportDrawer: boolean;
  setReportDrawer: (v: boolean) => void;
  syncDrawerId: string | null;
  setSyncDrawer: (id: string | null) => void;
  mcpDrawer: boolean;
  setMcpDrawer: (v: boolean) => void;

  // update toast (dev/mock override) + real updater status
  updateToast: boolean;
  setUpdateToast: (v: boolean) => void;
  updater: UpdaterStatus;
  setUpdater: (u: UpdaterStatus) => void;
  appVersion: string;
  setAppVersion: (v: string) => void;

  // chat overlay (Cmd+K)
  chatOpen: boolean;
  openChat: () => void;
  closeChat: () => void;
  chatProvider: ProviderKind;
  setChatProvider: (p: ProviderKind) => void;
  chatOllamaEndpoint: string;
  setChatOllamaEndpoint: (v: string) => void;
  chatOllamaModel: string;
  setChatOllamaModel: (v: string) => void;
  chatOpenRouterModel: string;
  setChatOpenRouterModel: (v: string) => void;
  chatHasCloudKey: boolean;
  setChatHasCloudKey: (v: boolean) => void;
  chatEgressConfirmedThisSession: boolean;
  setChatEgressConfirmed: (v: boolean) => void;
  chatMessages: ChatMessage[];
  appendChatMessage: (m: ChatMessage) => void;
  updateLastAssistantChunk: (delta: string) => void;
  clearChatMessages: () => void;
  chatStreaming: boolean;
  setChatStreaming: (v: boolean) => void;
  chatError: string | null;
  setChatError: (e: string | null) => void;

  // goals
  goalsPeriod: string;
  setGoalsPeriod: (p: string) => void;
  goalsObjectiveDrawer: boolean;
  setGoalsObjectiveDrawer: (v: boolean) => void;
  krDrawerId: string | null;
  openKRDrawer: (id: string) => void;
  closeKRDrawer: () => void;
  goGoals: () => void;

  // hypotheses
  hypothesesStatusFilter: string;
  hypothesesMetricFilter: string;
  hypothesesDrawerId: string | null;
  setHypothesesStatusFilter: (v: string) => void;
  setHypothesesMetricFilter: (v: string) => void;
  openHypothesisDrawer: (id: string) => void;
  closeHypothesisDrawer: () => void;
  goHypotheses: () => void;

  // decisions
  decisionsDrawerId: string | null;
  decisionsDetailId: string | null;
  openDecisionDrawer: (id: string) => void;
  closeDecisionDrawer: () => void;
  openDecisionDetail: (id: string) => void;
  closeDecisionDetail: () => void;
  goDecisions: () => void;

  // rice
  riceDrawerId: string | null;
  openRiceDrawer: (id: string) => void;
  closeRiceDrawer: () => void;
  goRice: () => void;

  // graph
  graphRunId: string | null;
  graphSelectedNodeId: string | null;
  graphDetailTab: "node" | "cluster" | "surprising";
  graphViewMode: "canvas" | "list";
  setGraphRunId: (id: string | null) => void;
  setGraphSelectedNodeId: (id: string | null) => void;
  setGraphDetailTab: (tab: "node" | "cluster" | "surprising") => void;
  setGraphViewMode: (mode: "canvas" | "list") => void;
  goGraph: () => void;

  // tasks
  trackerCount: number;
  setTrackerCount: (n: number) => void;
  tasksView: TasksView;
  setTasksView: (v: TasksView) => void;
  tasksFilter: TasksFilter;
  setTasksFilter: (patch: Partial<TasksFilter>) => void;
  resetTasksFilter: () => void;
  taskDrawerId: string | null;
  taskDrawerTracker: string | null;
  openTaskDrawer: (externalId: string, tracker: string) => void;
  closeTaskDrawer: () => void;
}

export const useApp = create<AppState>((set, get) => ({
  // Real engine state: starts "booting"; App's bootstrap query drives it to "ready"
  // (engine answered) or "failed" (offline after retries). No mock default.
  engine: "booting",
  setEngine: (engine) => set({ engine }),
  restartEngine: () => {
    set({ engine: "booting" });
    // Packaged: relaunch the app for a clean engine respawn. Browser-dev: soft reset.
    const eh = (window as { eigenheim?: { relaunch?: () => void } }).eigenheim;
    if (eh?.relaunch) eh.relaunch();
    else setTimeout(() => set({ engine: "ready" }), 1600);
  },

  engineLive: false,
  setEngineLive: (engineLive) => set({ engineLive }),

  firstRun: false,
  obStep: null,
  coachIndex: 0,
  dataSourceConnected: false,
  startOnboarding: () => set({ obStep: "welcome", dataSourceConnected: false, coachIndex: 0 }),
  setObStep: (obStep) => set({ obStep }),
  nextCoach: () => {
    const i = get().coachIndex;
    if (i >= 2) set({ obStep: "mcpkey", coachIndex: 0 });
    else set({ coachIndex: i + 1 });
  },
  dismissCoach: () => set({ obStep: "mcpkey", coachIndex: 0 }),
  connectDataSource: () => set({ dataSourceConnected: true, obStep: "sync" }),
  finishOnboarding: () => {
    markOnboardingSeen();
    set({ obStep: null, firstRun: false, dataSourceConnected: true });
  },
  toggleFirstRun: () => {
    const fr = !get().firstRun;
    if (fr) set({ firstRun: true, obStep: "welcome", dataSourceConnected: false, coachIndex: 0, view: "reports" });
    else set({ firstRun: false, obStep: null, dataSourceConnected: true });
  },

  railCollapsed: false,
  toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
  rightOpen: true,
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
  rightTab: "events",
  setRightTab: (rightTab) => set({ rightTab }),
  rightWidth: 320,
  setRightWidth: (w) => set({ rightWidth: Math.max(240, Math.min(480, w)) }),

  view: "reports",
  openReportId: null,
  settingsSection: "datasources",
  goReports: () => set({ view: "reports", openReportId: null }),
  openReport: (id) => set({ view: "report", openReportId: id }),
  goSettings: () => set({ view: "settings" }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),

  chatOpen: false,
  openChat: () => set({ chatOpen: true }),
  closeChat: () => set({ chatOpen: false, chatError: null, chatStreaming: false }),
  chatProvider: "ollama",
  setChatProvider: (chatProvider) => set({ chatProvider }),
  chatOllamaEndpoint: "http://localhost:11434",
  setChatOllamaEndpoint: (chatOllamaEndpoint) => set({ chatOllamaEndpoint }),
  chatOllamaModel: "mistral",
  setChatOllamaModel: (chatOllamaModel) => set({ chatOllamaModel }),
  chatOpenRouterModel: "anthropic/claude-3-haiku",
  setChatOpenRouterModel: (chatOpenRouterModel) => set({ chatOpenRouterModel }),
  chatHasCloudKey: false,
  setChatHasCloudKey: (chatHasCloudKey) => set({ chatHasCloudKey }),
  chatEgressConfirmedThisSession: false,
  setChatEgressConfirmed: (chatEgressConfirmedThisSession) => set({ chatEgressConfirmedThisSession }),
  chatMessages: [],
  appendChatMessage: (m) => set((s) => ({
    chatMessages: [...s.chatMessages, { ...m, id: m.id ?? crypto.randomUUID() }],
  })),
  updateLastAssistantChunk: (delta) =>
    set((s) => {
      const msgs = [...s.chatMessages];
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant") {
        msgs[msgs.length - 1] = { ...last, content: last.content + delta };
        return { chatMessages: msgs };
      }
      return { chatMessages: [...msgs, { role: "assistant", content: delta }] };
    }),
  clearChatMessages: () => set({ chatMessages: [], chatError: null }),
  chatStreaming: false,
  setChatStreaming: (chatStreaming) => set({ chatStreaming }),
  chatError: null,
  setChatError: (chatError) => set({ chatError }),

  goalsPeriod: "Q2",
  setGoalsPeriod: (goalsPeriod) => set({ goalsPeriod }),
  goalsObjectiveDrawer: false,
  setGoalsObjectiveDrawer: (goalsObjectiveDrawer) => set({ goalsObjectiveDrawer }),
  krDrawerId: null,
  openKRDrawer: (krDrawerId) => set({ krDrawerId }),
  closeKRDrawer: () => set({ krDrawerId: null }),
  goGoals: () => set({ view: "goals" }),

  hypothesesStatusFilter: "",
  hypothesesMetricFilter: "",
  hypothesesDrawerId: null,
  setHypothesesStatusFilter: (hypothesesStatusFilter) => set({ hypothesesStatusFilter }),
  setHypothesesMetricFilter: (hypothesesMetricFilter) => set({ hypothesesMetricFilter }),
  openHypothesisDrawer: (hypothesesDrawerId) => set({ hypothesesDrawerId }),
  closeHypothesisDrawer: () => set({ hypothesesDrawerId: null }),
  goHypotheses: () => set({ view: "hypotheses" }),

  decisionsDrawerId: null,
  decisionsDetailId: null,
  openDecisionDrawer: (decisionsDrawerId) => set({ decisionsDrawerId }),
  closeDecisionDrawer: () => set({ decisionsDrawerId: null }),
  openDecisionDetail: (decisionsDetailId) => set({ decisionsDetailId }),
  closeDecisionDetail: () => set({ decisionsDetailId: null }),
  goDecisions: () => set({ view: "decisions", decisionsDetailId: null }),

  riceDrawerId: null,
  openRiceDrawer: (riceDrawerId) => set({ riceDrawerId }),
  closeRiceDrawer: () => set({ riceDrawerId: null }),
  goRice: () => set({ view: "rice" }),

  graphRunId: null,
  graphSelectedNodeId: null,
  graphDetailTab: "node",
  graphViewMode: "canvas",
  setGraphRunId: (graphRunId) => set({ graphRunId }),
  setGraphSelectedNodeId: (graphSelectedNodeId) => set({ graphSelectedNodeId }),
  setGraphDetailTab: (graphDetailTab) => set({ graphDetailTab }),
  setGraphViewMode: (graphViewMode) => set({ graphViewMode }),
  goGraph: () => set({ view: "graph", graphSelectedNodeId: null }),

  goTasks: () => set({ view: "tasks", rightTab: "tasks" }),

  traceMetric: null,
  openTrace: (reportId, metricId) => set({ traceMetric: { reportId, metricId } }),
  closeTrace: () => set({ traceMetric: null }),
  collectOpen: false,
  setCollect: (collectOpen) => set({ collectOpen }),
  logicDrawer: false,
  setLogicDrawer: (logicDrawer) => set({ logicDrawer }),
  logicDrawerSeed: null,
  setLogicDrawerSeed: (logicDrawerSeed) => set({ logicDrawerSeed }),
  reportDrawer: false,
  setReportDrawer: (reportDrawer) => set({ reportDrawer }),
  syncDrawerId: null,
  setSyncDrawer: (syncDrawerId) => set({ syncDrawerId }),
  mcpDrawer: false,
  setMcpDrawer: (mcpDrawer) => set({ mcpDrawer }),

  updateToast: false,
  setUpdateToast: (updateToast) => set({ updateToast }),
  updater: { state: "idle" },
  setUpdater: (updater) => set({ updater }),
  appVersion: "0.1.0",
  setAppVersion: (appVersion) => set({ appVersion }),

  trackerCount: 0,
  setTrackerCount: (trackerCount) => set({ trackerCount }),
  tasksView: "by-goal",
  setTasksView: (tasksView) => set({ tasksView }),
  tasksFilter: { search: "", status: "", source: "", assignee: "", metric: "", sort: "updated", sortDir: "desc" },
  setTasksFilter: (patch) => set((s) => ({ tasksFilter: { ...s.tasksFilter, ...patch } })),
  resetTasksFilter: () => set({ tasksFilter: { search: "", status: "", source: "", assignee: "", metric: "", sort: "updated", sortDir: "desc" } }),
  taskDrawerId: null,
  taskDrawerTracker: null,
  openTaskDrawer: (taskDrawerId, taskDrawerTracker) => set({ taskDrawerId, taskDrawerTracker }),
  closeTaskDrawer: () => set({ taskDrawerId: null, taskDrawerTracker: null }),
}));
