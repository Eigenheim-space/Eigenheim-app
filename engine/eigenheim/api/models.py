"""Pydantic response models for all eigenheim API routes.

These models exist solely to populate the OpenAPI schema so that
openapi-typescript can generate typed TS interfaces for the renderer.
They must stay in sync with the dicts returned by each route handler.
"""
from __future__ import annotations

from pydantic import BaseModel


# ── Health / events / syncs ────────────────────────────────────────────────────

class HealthOut(BaseModel):
    status: str
    engine: str
    events: int


class EventOut(BaseModel):
    id: str | None = None
    name: str
    origin: str        # "synced" | "custom"
    source: str
    description: str


class SyncHistoryItem(BaseModel):
    at: str
    status: str        # "ok" | "error"
    detail: str


class SyncOut(BaseModel):
    id: str
    target: str
    frequency: str
    nextRun: str
    lastStatus: str    # "ok" | "error"
    lastRun: str
    history: list[SyncHistoryItem] = []


# ── Logic ──────────────────────────────────────────────────────────────────────

class LogicOut(BaseModel):
    id: str
    name: str
    version: str
    usage: int
    expression: str
    badge: str | None = None   # "needs-validation" | "draft"


class LogicCreateOut(BaseModel):
    id: str
    name: str
    version: str
    expression: str


class LogicVersionHistoryItem(BaseModel):
    version: int
    status: str
    expression: str
    validated: str | None = None
    sha: str | None = None
    actor: str | None = None
    decided_at: str | None = None


class LogicDefinitionListItem(BaseModel):
    """Lightweight definition as returned by GET /definitions (no history)."""
    id: str
    name: str
    description: str
    version: int
    expression: str
    inputs: list[dict]
    fmt: str
    validated: str | None = None
    sha: str | None = None
    pending_drafts: int


class LogicDefinitionOut(BaseModel):
    """Full definition as returned by GET /definitions/{id} (includes history)."""
    id: str
    name: str
    description: str
    version: int
    expression: str
    inputs: list[dict]
    fmt: str
    validated: str | None = None
    sha: str | None = None
    pending_drafts: int
    history: list[LogicVersionHistoryItem]


class DraftOut(BaseModel):
    logic_id: str
    version: int
    name: str
    description: str
    fmt: str
    inputs: list[dict]
    expression: str
    validated: str
    created_at: str
    status: str        # "pending"
    actor: str | None = None


class PromoteRejectOut(BaseModel):
    logic_id: str
    version: int
    status: str        # "live" | "rejected"
    spec_hash: str
    audit_hash: str


class AuditEntryOut(BaseModel):
    logic_id: str
    version: int
    action: str
    actor: str
    hash: str
    prev_hash: str | None = None
    at: str


# ── Reports ───────────────────────────────────────────────────────────────────

class WeekOut(BaseModel):
    week: str
    value: str
    deltaPct: float | None = None


class MetricOut(BaseModel):
    id: str
    name: str
    value: str | None
    delta: float | None = None
    spark: list[float]
    series: list[float]
    status: str       # "live" | "stale" | "mock"
    weeks: list[WeekOut]
    trace: dict
    _raw: float | None = None
    _version: int | None = None


class ReportListItem(BaseModel):
    id: str
    name: str
    period: str        # e.g. "30д"
    status: str        # "live" | "stale" | "mock" | "collecting" | "error"
    lastBuilt: str
    metricCount: int


class ReportOut(BaseModel):
    id: str
    name: str
    period: str
    status: str
    lastBuilt: str
    metrics: list[MetricOut]


class ReportCreateOut(BaseModel):
    id: str
    name: str
    period: str


class CollectOut(BaseModel):
    snapshot_id: int
    collected: int


class IngestOut(BaseModel):
    ingested: int


# ── Data sources ──────────────────────────────────────────────────────────────

class PosthogTestOut(BaseModel):
    ok: bool
    events_visible: int


class PosthogSyncOut(BaseModel):
    ingested: int


# ── Tracker connections ────────────────────────────────────────────────────────

class TrackerOut(BaseModel):
    id: str
    tracker: str
    workspace: str
    project_key: str
    base_url: str | None = None
    status: str
    health: str
    last_sync_at: str | None = None
    created_at: str


class TrackerSyncOut(BaseModel):
    synced: int
    tracker: str


class TrackerDeleteOut(BaseModel):
    disconnected: str


# ── Tasks ─────────────────────────────────────────────────────────────────────

class TaskLinkOut(BaseModel):
    logic_id: str | None = None
    okr_ref: str
    kr_ref: str


class TaskOut(BaseModel):
    external_id: str
    tracker: str
    title: str
    status: str
    assignee: str | None = None
    description: str | None = None
    url: str | None = None
    updated_at: str | None = None
    link: TaskLinkOut | None = None


class MetricSummaryOut(BaseModel):
    id: str
    name: str
    value: str | None = None
    delta: float | None = None
    spark: list[float]
    series: list[float]
    status: str
    weeks: list[WeekOut]
    trace: dict
    _raw: float | None = None
    _version: int | None = None


class TasksByGoalGroup(BaseModel):
    metric: MetricSummaryOut
    tasks: list[TaskOut]


class TasksByGoalOut(BaseModel):
    groups: list[TasksByGoalGroup]
    unlinked: list[TaskOut]


class TaskFacetsOut(BaseModel):
    status: dict[str, int]
    source: dict[str, int]
    assignee: dict[str, int]
    goal: dict[str, int]


class TaskLinkCreateOut(BaseModel):
    external_id: str
    tracker: str
    logic_id: str
    okr_ref: str
    kr_ref: str


class TaskUnlinkOut(BaseModel):
    unlinked: bool
    external_id: str
    logic_id: str


# ── Goals / OKR ───────────────────────────────────────────────────────────────

class BoundLogicOut(BaseModel):
    id: str
    name: str
    version: str
    usage_count: int
    current_value: float | None = None
    source_name: str | None = None
    trace_ref: str | None = None
    computed_at: str | None = None


class KeyResultOut(BaseModel):
    id: str
    objective_id: str
    name: str
    logic_id: str | None = None
    target: float | None = None
    comparison: str              # "gte" | "lte" | "eq"
    period: str
    created_at: str
    # computed fields (added by goals.compute_kr)
    status: str                  # "ahead" | "behind" | "stale" | "draft"
    progress: float              # 0-1
    gap: float | None = None
    live_value: str | None = None  # formatted string (e.g. "30.97%"), not a float
    live_raw: float | None = None
    trace_ref: str | None = None
    task_count: int
    logic: BoundLogicOut | None = None  # embedded to avoid N+1 per-KR fetches
    spark: list[float]           # always [] in v1; per-KR history not computed server-side


class ObjectiveOut(BaseModel):
    id: str
    title: str                   # NOTE: engine stores "title", not "name"
    period: str
    source: str
    krs: list[KeyResultOut]              # NOTE: engine uses "krs", not "key_results"
    on_track_count: int
    total_kr_count: int
    aggregate_progress: float


class GoalsOut(BaseModel):
    objectives: list[ObjectiveOut]
    period: str | None = None    # NOTE: engine returns "period", not "last_computed"


class ObjectiveSimpleOut(BaseModel):
    """Lightweight objective returned by GET /objectives (no KR computation)."""
    id: str
    title: str
    period: str
    source: str


class ObjectiveWithKRsOut(BaseModel):
    """Single-objective response from GET /objectives/{id}."""
    id: str
    title: str
    period: str
    source: str
    krs: list[KeyResultOut]


class DeletedOut(BaseModel):
    deleted: str


# ── Hypotheses ────────────────────────────────────────────────────────────────

class HypothesisOut(BaseModel):
    id: str
    statement: str
    logic_id: str
    evidence: str
    status: str     # "proposed" | "testing" | "confirmed" | "rejected"
    source: str     # "agent" | "user"
    created_at: str


# ── Decisions ────────────────────────────────────────────────────────────────

class DecisionMetricOut(BaseModel):
    id: int
    decision_id: str
    logic_id: str
    captured_value: float | None = None
    trace_ref: str
    captured_at: str


class DecisionListItemOut(BaseModel):
    id: str
    title: str
    rationale: str
    status: str
    created_at: str


class DecisionOut(BaseModel):
    id: str
    title: str
    rationale: str
    status: str
    created_at: str
    metrics: list[DecisionMetricOut]


# ── RICE ──────────────────────────────────────────────────────────────────────

class RiceItemOut(BaseModel):
    """RICE item as returned by the compute layer.

    Fields are the raw store columns plus the computed fields added by
    rice.compute_rice_item. Note: the renderer's api.ts has extra fields
    (reach_stale, reach_source, last_known_score, trace_ref) that do NOT
    exist in the engine — those are a renderer-side contract drift, fixed in
    api.ts to align with this model.
    """
    id: str
    name: str
    reach_logic_id: str | None = None
    reach_manual: float | None = None
    impact: float
    confidence: float
    effort: float
    source: str
    created_at: str
    # computed fields (added by rice.compute_rice_item)
    reach_value: float | None = None
    reach_trace_ref: str | None = None
    score: float | None = None
    status: str    # "live" | "manual" | "stale"


# ── MCP keys ──────────────────────────────────────────────────────────────────

class McpKeyCreateOut(BaseModel):
    key_id: str
    raw_key: str
    warning: str


class McpKeyOut(BaseModel):
    id: str
    name: str
    scopes: list[str]
    created_at: str
    last_used_at: str | None = None


class McpKeyRevokeOut(BaseModel):
    revoked: str


# ── Graph ─────────────────────────────────────────────────────────────────────

# GraphBuildResponse, GraphResponse re-exported from graph.py via response_model
# — imported directly in api/graph.py to avoid duplication.
