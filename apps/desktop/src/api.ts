// Thin client for the engine sidecar. Falls back to the bundled mock when the
// engine is not reachable (e.g. running the renderer standalone in a browser).
//
// Response types are generated from the engine's OpenAPI schema. Run:
//   npm run gen
// to regenerate src/api.gen.ts from the engine's live schema.
// DO NOT hand-edit the generated interfaces below — edit engine/eigenheim/api/models.py
// and re-run gen instead.

import type { components } from "./api.gen";

// Re-export generated schemas under stable names for consumers.
export type HealthOut        = components["schemas"]["HealthOut"];
export type EventOut         = components["schemas"]["EventOut"];
export type SyncOut          = components["schemas"]["SyncOut"];
export type LogicOut         = components["schemas"]["LogicOut"];
export type LogicCreateOut   = components["schemas"]["LogicCreateOut"];
export type LogicDefinitionListItem = components["schemas"]["LogicDefinitionListItem"];
export type LogicDefinitionOut = components["schemas"]["LogicDefinitionOut"];
export type ReportListItem   = components["schemas"]["ReportListItem"];
export type ReportOut        = components["schemas"]["ReportOut"];
export type ReportCreateOut  = components["schemas"]["ReportCreateOut"];
export type MetricOut        = components["schemas"]["MetricOut"];
export type WeekOut          = components["schemas"]["WeekOut"];
export type CollectOut       = components["schemas"]["CollectOut"];
export type TrackerOut       = components["schemas"]["TrackerOut"];
export type TrackerSyncOut   = components["schemas"]["TrackerSyncOut"];
export type TaskOut          = components["schemas"]["TaskOut"];
export type TaskFacetsOut    = components["schemas"]["TaskFacetsOut"];
export type TasksByGoalOut   = components["schemas"]["TasksByGoalOut"];
export type TaskLinkCreateOut = components["schemas"]["TaskLinkCreateOut"];
export type TaskUnlinkOut    = components["schemas"]["TaskUnlinkOut"];
export type BoundLogicOut    = components["schemas"]["BoundLogicOut"];
export type KeyResultOut     = components["schemas"]["KeyResultOut"];
export type ObjectiveOut     = components["schemas"]["ObjectiveOut"];
export type ObjectiveSimpleOut = components["schemas"]["ObjectiveSimpleOut"];
export type ObjectiveWithKRsOut = components["schemas"]["ObjectiveWithKRsOut"];
export type GoalsOut         = components["schemas"]["GoalsOut"];
export type HypothesisOut    = components["schemas"]["HypothesisOut"];
export type DecisionListItemOut = components["schemas"]["DecisionListItemOut"];
export type DecisionOut      = components["schemas"]["DecisionOut"];
export type McpKeyCreateOut  = components["schemas"]["McpKeyCreateOut"];
export type McpKeyOut        = components["schemas"]["McpKeyOut"];
export type RiceItemOut      = components["schemas"]["RiceItemOut"];
export type GraphBuildResponse = components["schemas"]["GraphBuildResponse"];
export type GraphResponse    = components["schemas"]["GraphResponse"];
export type GraphNode        = components["schemas"]["GraphNode"];
export type GraphEdge        = components["schemas"]["GraphEdge"];

// Stable aliases used by consumers (keep old names pointing to generated types
// so call sites don't need to change).
export type Report = ReportOut;
export type Metric = MetricOut;

// ── Engine URL + auth ────────────────────────────────────────────────────────

// In Electron, the preload exposes the locked engine URL + per-launch session
// token via window.eigenheim. In the browser (standalone dev) it is absent, so we
// fall back to the env URL and send no auth header (the dev engine has no token).
const bridge = typeof window !== "undefined" ? (window as { eigenheim?: { token: string | null; engineUrl: string } }).eigenheim : undefined;
export const ENGINE = bridge?.engineUrl || (import.meta as { env?: Record<string, string> }).env?.VITE_ENGINE_URL || "http://127.0.0.1:8765";

function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  return bridge?.token ? { ...base, Authorization: `Bearer ${bridge.token}` } : base;
}

// ── Low-level fetch helpers ───────────────────────────────────────────────────

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(ENGINE + path, { signal, headers: authHeaders() });
  if (!r.ok) throw new Error(`engine ${path} -> ${r.status}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown, raw = false): Promise<T> {
  const r = await fetch(ENGINE + path, {
    method: "POST",
    headers: authHeaders({ "Content-Type": raw ? "text/plain" : "application/json" }),
    body: raw ? (body as string) : JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = `${r.status}`;
    try { detail = (await r.json()).detail ?? detail; } catch { /* ignore */ }
    throw new Error(detail);
  }
  return r.json() as Promise<T>;
}

const _del = async <T>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(ENGINE + path, {
    method: "DELETE",
    headers: authHeaders(body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let detail = `${r.status}`;
    try { detail = (await r.json()).detail ?? detail; } catch { /* ignore */ }
    throw new Error(detail);
  }
  return r.json() as Promise<T>;
};

const _patch = async <T>(path: string, body: unknown): Promise<T> => {
  const r = await fetch(ENGINE + path, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = `${r.status}`;
    try { detail = (await r.json()).detail ?? detail; } catch { /* ignore */ }
    throw new Error(detail);
  }
  return r.json() as Promise<T>;
};

// ── Request payload types ────────────────────────────────────────────────────
// These are the shapes we SEND to the engine (not generated, but aligned to
// the engine's input models via OpenAPI components["schemas"]["*In"]).

export interface LogicPayload {
  name: string; description?: string; fmt?: string;
  inputs: { alias: string; kind: string; params: Record<string, unknown> }[];
  expression: string;
}

export interface ReportPayload {
  /** optional client-supplied id; engine generates one if omitted */
  id?: string;
  name: string;
  /** number of days the report covers; default 30 */
  period_days: number;
  /** logic ids to include as metric tiles */
  logic_ids: string[];
}

// ── Core report + event API ───────────────────────────────────────────────────

export const api = {
  health: () => get<HealthOut>("/health"),
  // Fixed: was `Omit<Report,"metrics">[] & {metricCount:number}[]` (malformed intersection).
  // Correct: each item is a ReportListItem (a single object type with metricCount).
  reports: () => get<ReportListItem[]>("/reports"),
  report: (id: string, days?: number) => get<ReportOut>(`/reports/${id}${days != null ? `?days=${days}` : ""}`),
  events: () => get<EventOut[]>("/events"),
  logic: () => get<LogicOut[]>("/logic"),
  syncs: () => get<SyncOut[]>("/syncs"),
  collect: (id: string, frequency: string) => post<CollectOut>(`/reports/${id}/collect`, { frequency }),
  createReport: (p: ReportPayload) => post<ReportCreateOut>("/reports", p),
  createLogic: (p: LogicPayload) => post<LogicCreateOut>("/logic", p),
  testPosthog: (host: string, projectId: string, apiKey: string) => post<{ ok: boolean; events_visible: number }>("/datasources/posthog/test", { host, project_id: projectId, api_key: apiKey }),
  syncPosthog: (host: string, projectId: string, apiKey: string, days = 30) => post<{ ingested: number }>("/datasources/posthog/sync", { host, project_id: projectId, api_key: apiKey, days }),
  ingestCsv: (text: string) => post<{ ingested: number }>("/ingest/csv", text, true),
  // MCP key management
  createMcpKey: (name: string, scopes?: string[]) =>
    post<McpKeyCreateOut>("/mcp-keys", { name, scopes }),
  listMcpKeys: () =>
    get<McpKeyOut[]>("/mcp-keys"),
  revokeMcpKey: (keyId: string) =>
    fetch(ENGINE + `/mcp-keys/${keyId}`, { method: "DELETE", headers: authHeaders() }).then((r) => {
      if (!r.ok) throw new Error(`revoke ${keyId} -> ${r.status}`);
      return r.json() as Promise<{ revoked: string }>;
    }),
  // Task tracker endpoints
  connectTracker: (p: {
    tracker: "jira" | "linear";
    token: string;
    base_url?: string;
    project_key?: string;
  }) => post<TrackerOut>("/trackers", p),
  syncTracker: (connectionId: string, token: string, opts?: { max_results?: number }) =>
    post<TrackerSyncOut>(`/trackers/${encodeURIComponent(connectionId)}/sync`, {
      token, ...opts,
    }),
  disconnectTracker: (connectionId: string) =>
    fetch(ENGINE + `/trackers/${encodeURIComponent(connectionId)}`, { method: "DELETE", headers: authHeaders() }).then(async (r) => {
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error((d as { detail?: string }).detail ?? `${r.status}`); }
      return r.json() as Promise<{ disconnected: string }>;
    }),
  trackers: () => get<TrackerOut[]>("/trackers"),
  tasks: (params?: { tracker?: string; status?: string; assignee?: string; logic_id?: string }) => {
    const q = new URLSearchParams();
    if (params?.tracker) q.set("tracker", params.tracker);
    if (params?.status) q.set("status", params.status);
    if (params?.assignee) q.set("assignee", params.assignee);
    if (params?.logic_id) q.set("logic_id", params.logic_id);
    const qs = q.toString();
    return get<TaskOut[]>(`/tasks${qs ? `?${qs}` : ""}`);
  },
  tasksByGoal: () => get<TasksByGoalOut>("/tasks/by-goal"),
  taskFacets: (params?: { tracker?: string; status?: string; assignee?: string; linked_metric?: string }) => {
    const q = new URLSearchParams();
    if (params?.tracker) q.set("tracker", params.tracker);
    if (params?.status) q.set("status", params.status);
    if (params?.assignee) q.set("assignee", params.assignee);
    if (params?.linked_metric) q.set("linked_metric", params.linked_metric);
    const qs = q.toString();
    return get<TaskFacetsOut>(`/tasks/facets${qs ? `?${qs}` : ""}`);
  },
  linkTask: (external_id: string, tracker: string, logic_id: string) =>
    post<TaskLinkCreateOut>("/task-links", { external_id, tracker, logic_id }),
  unlinkTask: (external_id: string, tracker: string, logic_id: string) =>
    fetch(ENGINE + "/task-links", {
      method: "DELETE",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ external_id, tracker, logic_id }),
    }).then(async (r) => {
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error((d as { detail?: string }).detail ?? `${r.status}`); }
      return r.json() as Promise<TaskUnlinkOut>;
    }),
};

// ── Legacy aliases (keep old names stable for consumers) ─────────────────────

/**
 * TrackerRow — stable alias for TrackerOut.
 * @deprecated Use TrackerOut from api.gen.ts directly.
 */
export type TrackerRow = TrackerOut;

/** TaskRow — stable alias for TaskOut. */
export type TaskRow = TaskOut;

/** TaskLink — stable alias for TaskLinkOut. */
export type TaskLink = components["schemas"]["TaskLinkOut"];

/** TasksByGoalGroup — stable alias. */
export type TasksByGoalGroup = components["schemas"]["TasksByGoalGroup"];

/** TasksByGoalResponse — stable alias for TasksByGoalOut. */
export type TasksByGoalResponse = TasksByGoalOut;

/** TaskFacets — stable alias for TaskFacetsOut. */
export type TaskFacets = TaskFacetsOut;

// ── Goals / OKR ──────────────────────────────────────────────────────────────

/**
 * ObjectiveRow — stable alias for the enriched objective from /goals.
 *
 * Engine uses `title` (not `name`) for the objective label.
 * Engine uses `krs` (not `key_results`) for the key results array.
 * Both are reflected in the generated ObjectiveOut type.
 */
export type ObjectiveRow = ObjectiveOut;

/** KeyResultRow — stable alias for KeyResultOut. */
export type KeyResultRow = KeyResultOut;

/** BoundLogic — stable alias for BoundLogicOut. */
export type BoundLogic = BoundLogicOut;

export type KRStatus = "ahead" | "behind" | "stale" | "draft";

export interface CreateObjectivePayload {
  /** Engine field name is `title` (ObjectiveIn.title). */
  title: string;
  period: string;
}

export interface UpdateObjectivePayload {
  title?: string;
  period?: string;
}

export interface CreateKRPayload {
  objective_id: string;
  name: string;
  logic_id?: string | null;
  target?: number | null;
  comparison?: "gte" | "lte" | "eq";
  period?: string;
}

export interface UpdateKRPayload {
  name?: string;
  logic_id?: string | null;
  target?: number | null;
  comparison?: "gte" | "lte" | "eq";
  period?: string;
}

export interface GoalsResponse {
  objectives: ObjectiveRow[];
  /** Engine returns `period` (the filter passed to /goals), not `last_computed`. */
  period: string | null;
}

export const goalsApi = {
  goals: (period?: string) => get<GoalsResponse>(`/goals${period ? `?period=${encodeURIComponent(period)}` : ""}`),
  createObjective: (p: CreateObjectivePayload) => post<ObjectiveSimpleOut>("/objectives", p),
  updateObjective: (id: string, p: UpdateObjectivePayload) => _patch<ObjectiveSimpleOut>(`/objectives/${id}`, p),
  deleteObjective: (id: string) => _del<{ deleted: string }>(`/objectives/${id}`),
  createKR: (p: CreateKRPayload) => post<KeyResultOut>("/key-results", p),
  updateKR: (id: string, p: UpdateKRPayload) => _patch<KeyResultOut>(`/key-results/${id}`, p),
  deleteKR: (id: string) => _del<{ deleted: string }>(`/key-results/${id}`),
};

// ── Hypotheses ───────────────────────────────────────────────────────────────

export type HypothesisRow = HypothesisOut;
export type HypothesisStatus = "proposed" | "testing" | "confirmed" | "rejected";
export type HypothesisSource = "agent" | "user";

export interface CreateHypothesisPayload {
  statement: string;
  logic_id?: string;
  evidence?: string;
}

export interface UpdateHypothesisStatusPayload {
  status: HypothesisStatus;
}

export const hypothesesApi = {
  list: (params?: { status?: HypothesisStatus; logic_id?: string }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.logic_id) q.set("logic_id", params.logic_id);
    const qs = q.toString();
    return get<HypothesisOut[]>(`/hypotheses${qs ? `?${qs}` : ""}`);
  },
  get: (id: string) => get<HypothesisOut>(`/hypotheses/${id}`),
  create: (p: CreateHypothesisPayload) => post<HypothesisOut>("/hypotheses", p),
  updateStatus: (id: string, status: HypothesisStatus) =>
    _patch<HypothesisOut>(`/hypotheses/${id}/status`, { status }),
  delete: (id: string) =>
    fetch(ENGINE + `/hypotheses/${id}`, { method: "DELETE", headers: authHeaders() }).then(async (r) => {
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error((d as { detail?: string }).detail ?? `${r.status}`); }
      return r.json() as Promise<{ deleted: string }>;
    }),
};

// ── Decisions ────────────────────────────────────────────────────────────────

export type DecisionStatus = "Open" | "Revisit" | "Closed";

export type DecisionMetricRow = components["schemas"]["DecisionMetricOut"];

/**
 * DecisionListItem — shape of items from GET /decisions (no metrics).
 * Engine uses `title` (same as DecisionListItemOut).
 */
export type DecisionListItem = DecisionListItemOut;

/**
 * DecisionRow — full decision with captured metric snapshots.
 * Engine uses `title` (same as DecisionOut).
 */
export type DecisionRow = DecisionOut;

export interface CreateDecisionPayload {
  title: string;
  rationale?: string;
  status?: string;
  metric_logic_ids?: string[];
}

export interface UpdateDecisionPayload {
  title?: string;
  rationale?: string;
  status?: string;
}

export const decisionsApi = {
  list: () => get<DecisionListItemOut[]>("/decisions"),
  get: (id: string) => get<DecisionOut>(`/decisions/${id}`),
  create: (p: CreateDecisionPayload) => post<DecisionOut>("/decisions", p),
  update: (id: string, p: UpdateDecisionPayload) => _patch<DecisionOut>(`/decisions/${id}`, p),
  delete: (id: string) => _del<{ deleted: string }>(`/decisions/${id}`),
};

// ── Graph ─────────────────────────────────────────────────────────────────────

/** GraphData — stable alias for GraphResponse. */
export type GraphData = GraphResponse;

export interface GraphBuildPayload {
  path: string;
  infer?: boolean;
}

export const graphApi = {
  build: (path: string, infer = false) =>
    post<GraphBuildResponse>("/graph/build", { path, infer }),
  getJson: (runId: string) =>
    get<GraphResponse>(`/graph/${runId}/json`),
};

// ── RICE ──────────────────────────────────────────────────────────────────────

/**
 * RiceItem — the shape the renderer works with.
 *
 * Engine returns: {id, name, reach_logic_id, reach_manual, impact, confidence,
 * effort, source, created_at, reach_value, reach_trace_ref, score, status}.
 *
 * reach_stale, reach_source, last_known_score, trace_ref are NOT in the engine
 * contract. They were in the old hand-typed api.ts but never populated by the
 * engine. Consumer code in rice.tsx is updated to derive stale from `status`.
 */
export type RiceItem = RiceItemOut;

/** Possible values for the Impact field (standard RICE scale). */
export type RiceImpact = 0.25 | 0.5 | 1 | 2 | 3;

export interface CreateRicePayload {
  name: string;
  reach_logic_id?: string | null;
  reach_manual?: number | null;
  impact?: RiceImpact;
  confidence?: number;
  effort?: number;
}

export interface UpdateRicePayload {
  name?: string;
  reach_logic_id?: string | null;
  reach_manual?: number | null;
  impact?: RiceImpact;
  confidence?: number;
  effort?: number;
}

export const riceApi = {
  list: () => get<RiceItemOut[]>("/rice"),
  get: (id: string) => get<RiceItemOut>(`/rice/${id}`),
  create: (p: CreateRicePayload) => post<RiceItemOut>("/rice", p),
  update: (id: string, p: UpdateRicePayload) => _patch<RiceItemOut>(`/rice/${id}`, p),
  delete: (id: string) => _del<{ deleted: string }>(`/rice/${id}`),
};

// ── EngineReport ──────────────────────────────────────────────────────────────

/**
 * EngineReport — convenience alias used by the store and panel.
 * Equivalent to ReportOut (which includes metrics[]).
 */
export type EngineReport = ReportOut;
