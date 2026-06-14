/**
 * queries.ts — TanStack Query layer for all engine sidecar data.
 *
 * Query keys are stable string tuples. QueryFns call api.ts directly —
 * no duplication of fetch logic here. Mutations call api.ts and invalidate
 * the relevant key(s) so surfaces re-fetch automatically.
 *
 * Offline / engine-unreachable: queries that fail are surfaced as
 * isError=true. Each surface maps that to its ErrorBanner + Retry UX.
 * The engineLive flag in Zustand is kept for the ChatOverlay context builder
 * and the Trace link resolution — it is set by the bootstrap query below.
 */

import { QueryClient } from "@tanstack/react-query";
import {
  api,
  goalsApi,
  hypothesesApi,
  decisionsApi,
  riceApi,
  graphApi,
  type GoalsResponse,
  type HypothesisOut,
  type DecisionListItemOut,
  type DecisionOut,
  type RiceItemOut,
  type ReportListItem,
  type ReportOut,
  type EventOut,
  type LogicOut,
  type SyncOut,
  type GraphResponse,
  type TrackerOut,
  type TaskOut,
  type TasksByGoalOut,
  type TaskFacetsOut,
  type HypothesisStatus,
  type CreateHypothesisPayload,
  type UpdateHypothesisStatusPayload,
  type CreateDecisionPayload,
  type UpdateDecisionPayload,
  type CreateObjectivePayload,
  type UpdateObjectivePayload,
  type CreateKRPayload,
  type UpdateKRPayload,
  type CreateRicePayload,
  type UpdateRicePayload,
} from "./api";

// ── QueryClient singleton ─────────────────────────────────────────────────────

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Desktop app: no window-focus refetch (app windows don't "focus" like browser tabs)
      refetchOnWindowFocus: false,
      // Data is fresh for 2 minutes; background refetch after that on use
      staleTime: 2 * 60 * 1000,
      // Retry once on failure (engine might be starting)
      retry: 1,
      retryDelay: 800,
    },
  },
});

// ── Query keys ────────────────────────────────────────────────────────────────

export const queryKeys = {
  // Engine bootstrap (reports list + events + logic + syncs)
  engineBootstrap: ["engine", "bootstrap"] as const,

  // Reports
  reports: ["reports"] as const,
  reportDetail: (id: string, days?: number) =>
    days != null ? (["reports", id, days] as const) : (["reports", id] as const),

  // Events / Logic / Syncs (right panel data)
  events: ["events"] as const,
  logic: ["logic"] as const,
  syncs: ["syncs"] as const,

  // Trackers
  trackers: ["trackers"] as const,

  // Tasks
  tasks: (params?: { tracker?: string; status?: string; assignee?: string; logic_id?: string }) =>
    ["tasks", params ?? {}] as const,
  tasksByGoal: ["tasks", "by-goal"] as const,
  taskFacets: (params?: { tracker?: string; status?: string; assignee?: string; linked_metric?: string }) =>
    ["tasks", "facets", params ?? {}] as const,

  // Goals / OKRs
  goals: (period?: string) => ["goals", period ?? ""] as const,

  // Hypotheses
  hypotheses: (params?: { status?: HypothesisStatus; logic_id?: string }) =>
    ["hypotheses", params ?? {}] as const,
  hypothesis: (id: string) => ["hypotheses", id] as const,

  // Decisions
  decisions: ["decisions"] as const,
  decision: (id: string) => ["decisions", id] as const,

  // RICE
  rice: ["rice"] as const,

  // Graph
  graphJson: (runId: string) => ["graph", runId] as const,
} as const;

// ── Bootstrap query (replaces loadFromEngine) ─────────────────────────────────

export interface BootstrapData {
  reports: ReportListItem[];
  events: EventOut[];
  logic: LogicOut[];
  syncs: SyncOut[];
}

export function bootstrapQueryFn(): Promise<BootstrapData> {
  return Promise.all([
    api.reports(),
    api.events(),
    api.logic(),
    api.syncs(),
  ]).then(([reports, events, logic, syncs]) => ({ reports, events, logic, syncs }));
}

// ── Report detail query ───────────────────────────────────────────────────────

export function reportDetailQueryFn(id: string, days?: number): Promise<ReportOut> {
  return api.report(id, days);
}

// ── Events / Logic / Syncs ───────────────────────────────────────────────────

export const eventsQueryFn = () => api.events();
export const logicQueryFn = () => api.logic();
export const syncsQueryFn = () => api.syncs();

// ── Trackers ──────────────────────────────────────────────────────────────────

export const trackersQueryFn = (): Promise<TrackerOut[]> => api.trackers();

// ── Tasks ─────────────────────────────────────────────────────────────────────

export const tasksQueryFn = (params?: {
  tracker?: string; status?: string; assignee?: string; logic_id?: string;
}): Promise<TaskOut[]> => api.tasks(params);

export const tasksByGoalQueryFn = (): Promise<TasksByGoalOut> => api.tasksByGoal();

export const taskFacetsQueryFn = (params?: {
  tracker?: string; status?: string; assignee?: string; linked_metric?: string;
}): Promise<TaskFacetsOut> => api.taskFacets(params);

// ── Goals / OKRs ─────────────────────────────────────────────────────────────

export const goalsQueryFn = (period?: string): Promise<GoalsResponse> =>
  goalsApi.goals(period);

// ── Hypotheses ───────────────────────────────────────────────────────────────

export const hypothesesQueryFn = (params?: {
  status?: HypothesisStatus; logic_id?: string;
}): Promise<HypothesisOut[]> => hypothesesApi.list(params);

// ── Decisions ────────────────────────────────────────────────────────────────

export const decisionsListQueryFn = (): Promise<DecisionListItemOut[]> => decisionsApi.list();

export const decisionDetailQueryFn = (id: string): Promise<DecisionOut> => decisionsApi.get(id);

// ── RICE ─────────────────────────────────────────────────────────────────────

export const riceQueryFn = (): Promise<RiceItemOut[]> => riceApi.list();

// ── Graph ─────────────────────────────────────────────────────────────────────

export const graphJsonQueryFn = (runId: string): Promise<GraphResponse> =>
  graphApi.getJson(runId);

// ── Invalidation helpers ──────────────────────────────────────────────────────
// Used by mutations to trigger re-fetch of relevant queries.

export const invalidate = {
  goals: (period?: string) =>
    queryClient.invalidateQueries({ queryKey: queryKeys.goals(period) }),
  allGoals: () =>
    queryClient.invalidateQueries({ queryKey: ["goals"] }),
  hypotheses: () =>
    queryClient.invalidateQueries({ queryKey: ["hypotheses"] }),
  decisions: () =>
    queryClient.invalidateQueries({ queryKey: ["decisions"] }),
  rice: () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.rice }),
  tasks: () =>
    queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  bootstrap: () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.engineBootstrap }),
  reports: () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.reports }),
  reportDetail: (id: string) =>
    queryClient.invalidateQueries({ queryKey: ["reports", id] }),
  allReportDetails: () =>
    queryClient.invalidateQueries({ queryKey: ["reports"] }),
};

// ── Report cache helpers (replaces Zustand reportCache / engineReportIds) ──────

import { REPORTS } from "./data";

/**
 * Read a report (with metrics) from the query cache.
 * Falls back to the bundled mock if no live data is cached yet.
 * Use inside event handlers and ChatOverlay.buildContextBlock (outside React).
 */
export function getReportFromCache(id: string | null | undefined): ReportOut | import("./data").Report | null {
  if (!id) return null;
  const cached = queryClient.getQueryData<ReportOut>(queryKeys.reportDetail(id));
  if (cached) return cached;
  return REPORTS.find((r) => r.id === id) ?? null;
}

/**
 * Return the list of report IDs that the engine has live data for.
 * Used for offline-gate checks (no fetch if engine is offline).
 */
export function getEngineReportIds(): string[] {
  const data = queryClient.getQueryData<BootstrapData>(queryKeys.engineBootstrap);
  return data?.reports.map((r) => r.id) ?? [];
}

/**
 * Find the report that contains a given logic/metric ID.
 * Searches all cached report-detail entries then falls back to mock.
 * Call from event handlers only (not during render — no reactivity).
 */
export function findReportForMetric(metricId: string): ReportOut | import("./data").Report | null {
  // Search all cached detail entries
  for (const key of (queryClient.getQueryCache().getAll() as unknown as { queryKey: readonly unknown[]; state: { data?: unknown } }[])) {
    if (
      Array.isArray(key.queryKey) &&
      key.queryKey[0] === "reports" &&
      typeof key.queryKey[1] === "string" &&
      key.queryKey.length >= 2
    ) {
      const data = key.state.data as ReportOut | undefined;
      if (data?.metrics?.some((m) => m.id === metricId)) return data;
    }
  }
  // Fall back to mock
  return REPORTS.find((r) => r.metrics?.some((m) => m.id === metricId)) ?? null;
}

// Re-export payload types used by mutations (avoids import chains in surfaces)
export type {
  CreateObjectivePayload,
  UpdateObjectivePayload,
  CreateKRPayload,
  UpdateKRPayload,
  CreateHypothesisPayload,
  UpdateHypothesisStatusPayload,
  CreateDecisionPayload,
  UpdateDecisionPayload,
  CreateRicePayload,
  UpdateRicePayload,
};
