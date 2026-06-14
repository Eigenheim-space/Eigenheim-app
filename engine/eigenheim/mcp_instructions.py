"""Single source of truth for every MCP server instructions string.

Why one module:
  - The `initialize` handshake exposes instructions PRE-AUTH. An injection here
    could trick an agent into bypassing auth or leaking data before any key is
    validated. Centralising every string makes it auditable in one place.
  - `_FORBIDDEN_FRAGMENTS` is the deny-list. The pytest in tests/test_phase1.py
    enforces that no fragment appears in any instructions string; that test must
    pass before any commit that touches this file or the MCP server.

Forbidden categories:
  1. Prompt-injection phrasings: anything telling an agent to ignore instructions.
  2. Non-sidecar localhost URLs: only http://127.0.0.1:8765 is the sidecar.
  3. Secret-shaped patterns: Bearer tokens, env-var references, raw key prefixes
     in prose (the prefix `eig_` is fine in code; not in instructions text).
  4. Scope/auth bypass: any phrasing asking the agent to skip scope checks.

Adding a new instructions string:
  1. Add a constant below.
  2. Register it in ALL_INSTRUCTIONS at the bottom of this file.
  3. The forbidden-fragment test runs automatically in CI.
"""
from __future__ import annotations

# ---- Deny-list (keep sorted by category for reviewability) ----------------

_FORBIDDEN_FRAGMENTS: list[str] = [
    # -- prompt-injection phrasings --
    "disregard",
    "forget previous",
    "ignore all",
    "ignore previous",
    "ignore scope",
    "ignore your",
    "override auth",
    "override instructions",
    "override scope",
    "pretend you",
    "you are now",
    # -- non-sidecar localhost URLs (the sidecar is 127.0.0.1:8765 only) --
    "http://localhost",
    "https://localhost",
    # -- secret-shaped patterns in prose --
    "Authorization: Bearer",
    "EIGENHEIM_TOKEN",
    "os.environ",
    "process.env",
    # -- scope/auth bypass phrasings --
    "bypass auth",
    "no auth",
    "skip auth",
    "skip scope",
    "without auth",
    "without scope",
]

# ---- Instructions strings --------------------------------------------------

SERVER_DESCRIPTION: str = (
    "eigenheim MCP server. Provides deterministic, versioned product metrics "
    "computed from validated Logic formulas and a local event store. "
    "Numbers are computed once, traced, and stable: fetch them, cite the "
    "version and formula, do not re-derive from raw data. "
    "All tools require a valid API key with the `read` scope. "
    "Documentation: https://eigenheim.space/docs"
    # Phase 2: a dedicated /docs/mcp/for-agents page will be linked here.
    # For now the root /docs URL is the placeholder.
)

TOOL_LIST_REPORTS: str = (
    "List available reports. Returns report IDs, names, period windows, and "
    "headline metric values. Use report IDs with get_report for full detail."
)

TOOL_GET_REPORT: str = (
    "Get a single report by ID. Returns all metric values with weekly series. "
    "Cite the report ID and the logic version when referencing a number."
)

TOOL_GET_TRACE: str = (
    "Get the full computation trace for one metric: the formula, every input, "
    "the SQL that ran, and the final result. Use this to show provenance when "
    "a stakeholder asks 'how was this computed?'"
)

TOOL_LIST_EVENTS: str = (
    "List the event catalog: event names, origins, and descriptions. "
    "Events are the raw inputs to Logic formulas."
)

TOOL_LIST_TASKS: str = (
    "List cached tasks from connected trackers. "
    "Supports filtering by tracker (jira or linear), status, assignee, and logic_id. "
    "When logic_id is supplied, only tasks linked to that metric are returned. "
    "eigenheim reads tasks; it does not write to trackers. "
    "To create or update a task, use your own tracker tooling."
)

TOOL_GET_TASK: str = (
    "Get one task by external_id and tracker. "
    "Returns the task fields, its linked metric value (if any), and a trace reference. "
    "The linked metric value is the same deterministic number the user sees in their report."
)

TOOL_LIST_GOALS: str = (
    "List all Objectives with their Key Results. "
    "Each KR carries: bound Logic name, live computed value, target, comparison operator, "
    "status (ahead | behind | stale | draft), progress (0 to 1), gap (live minus target), "
    "and a trace_ref — the formula string that produced the live value. "
    "A stale KR means the bound Logic failed to compute; a draft KR has no Logic bound yet. "
    "Supply the period parameter to filter KRs to a specific quarter or period label. "
    "Read-only; requires the goals:read scope (or the umbrella read scope)."
)

TOOL_GET_OBJECTIVE: str = (
    "Get one Objective by ID, including all its Key Results with live computed values. "
    "Returns the same KR fields as list_goals. "
    "Read-only; requires the goals:read scope (or the umbrella read scope)."
)

TOOL_GET_KR: str = (
    "Get one Key Result by ID with its live computed value, target, status, progress, "
    "gap, and trace_ref. "
    "trace_ref is the formula excerpt — cite it when referencing the KR value so the "
    "number's provenance is clear. "
    "Read-only; requires the goals:read scope (or the umbrella read scope)."
)

TOOL_CREATE_LOGIC: str = (
    "Propose a NEW Logic metric definition as a DRAFT for human review. "
    "The expression is validated with the DSL (AST whitelist, no eval) before any write — "
    "an invalid expression is rejected immediately and never stored. "
    "A valid proposal creates an INERT draft version that does NOT affect any computed value. "
    "A human must review and approve the draft at the promote endpoint before it becomes live. "
    "No agent self-promotion path exists. Requires the logic:write scope."
)

TOOL_UPDATE_LOGIC: str = (
    "Propose an UPDATE to an existing Logic metric definition as a DRAFT for human review. "
    "The current live definition is unchanged until a human promotes the draft. "
    "The expression is validated with the DSL (AST whitelist, no eval) before any write — "
    "an invalid expression is rejected and never stored. "
    "A valid proposal creates an INERT draft version alongside the current live version. "
    "A human must review and approve the draft at the promote endpoint before it becomes live. "
    "No agent self-promotion path exists. Requires the logic:write scope."
)

TOOL_LIST_DEFINITIONS: str = (
    "List the canonical versioned definition of every Logic metric: id, name, "
    "current version, expression (formula), inputs, format, and validated date. "
    "Use this to learn what a metric means before fetching its value with get_report. "
    "Returns definitions only — no computed values. "
    "To answer 'what does activation mean?', call this first, then get_report for the number."
)

TOOL_GET_DEFINITION: str = (
    "Get the full versioned definition of one Logic metric by id. "
    "Returns the current definition (expression, inputs, fmt, validated, sha) "
    "plus the complete version history so you can answer questions like "
    "'what did activation mean last month?' by inspecting earlier versions. "
    "Returns the definition only — no computed value. "
    "Use get_report or get_trace to fetch the actual number."
)

TOOL_LIST_HYPOTHESES: str = (
    "List hypotheses from the structured hypothesis log. "
    "Returns hypotheses with their statement, linked metric (logic_id), evidence, "
    "status (proposed | testing | confirmed | rejected), and source (agent | user). "
    "Filter by status or logic_id to narrow the result. "
    "To propose a new hypothesis grounded on metric evidence, use propose_hypothesis. "
    "Status is human-controlled — agents read hypotheses, they do not advance status. "
    "Read-only; requires the read scope (or hypotheses:read)."
)

TOOL_GET_HYPOTHESIS: str = (
    "Get one hypothesis by id. "
    "Returns the full hypothesis: statement, logic_id, evidence, status, source, created_at. "
    "Read-only; requires the read scope (or hypotheses:read)."
)

TOOL_PROPOSE_HYPOTHESIS: str = (
    "Propose a metric-grounded hypothesis for human review. "
    "The hypothesis lands as status='proposed' and source='agent'. "
    "A human must advance the status at PATCH /hypotheses/{id}/status — "
    "agents cannot set status beyond 'proposed'. This is the human-in-the-loop gate. "
    "key: the key must hold the hypotheses:write scope. "
    "The read scope alone does NOT grant write access to the hypothesis log. "
    "key: the MCP key with hypotheses:write scope. "
    "statement: the hypothesis text (required). "
    "logic_id: the metric id this hypothesis is grounded on (from list_definitions). "
    "rationale: your reasoning and the metric evidence that supports the hypothesis. "
    "evidence: optional additional evidence context."
)

TOOL_LIST_DECISIONS: str = (
    "List decisions from the decision log, newest first. "
    "Returns title, rationale, status, and created_at for each decision. "
    "The captured metric snapshot is NOT included in the list — "
    "use get_decision for the full snapshot. "
    "Read-only; requires the read scope (or decisions:read)."
)

TOOL_GET_DECISION: str = (
    "Get one decision by id, including its full captured metric snapshot. "
    "The snapshot captures the metric values AT the moment the decision was created — "
    "these values do not change when the underlying Logic is later recomputed. "
    "This lets you answer 'what did the numbers look like when we decided X?' "
    "with the same deterministic provenance eigenheim provides for every number. "
    "Read-only; requires the read scope (or decisions:read)."
)

TOOL_LIST_RICE: str = (
    "List all RICE prioritization items sorted by computed score descending. "
    "Each item carries: id, name, impact, confidence, effort, reach_value "
    "(resolved from the bound Logic's live value or a manual Reach), "
    "reach_trace_ref (the formula string from the bound Logic — the provenance identity "
    "proving the Reach came from a real metric, not a guess), score, and status. "
    "score = (Reach × Impact × Confidence) / Effort. "
    "status: 'live' = metric-backed Reach computed from a bound Logic; "
    "'manual' = static reach_manual used; "
    "'stale' = Logic missing, compute failed, or Effort is zero. "
    "Items with no score (stale) sort to the bottom. "
    "Read-only; requires the read scope (or rice:read)."
)

TOOL_GET_RICE_ITEM: str = (
    "Get one RICE prioritization item by id with its computed score and resolved Reach. "
    "Returns the same fields as list_rice but for one item. "
    "Cite reach_trace_ref when referencing the Reach value — it is the formula that "
    "produced the number and the proof that Reach came from a real metric. "
    "Read-only; requires the read scope (or rice:read)."
)

# ---- Registry (all strings the forbidden-fragment test checks) -------------

ALL_INSTRUCTIONS: list[str] = [
    SERVER_DESCRIPTION,
    TOOL_LIST_REPORTS,
    TOOL_GET_REPORT,
    TOOL_GET_TRACE,
    TOOL_LIST_EVENTS,
    TOOL_LIST_TASKS,
    TOOL_GET_TASK,
    TOOL_LIST_GOALS,
    TOOL_GET_OBJECTIVE,
    TOOL_GET_KR,
    TOOL_LIST_DEFINITIONS,
    TOOL_GET_DEFINITION,
    TOOL_CREATE_LOGIC,
    TOOL_UPDATE_LOGIC,
    TOOL_LIST_HYPOTHESES,
    TOOL_GET_HYPOTHESIS,
    TOOL_PROPOSE_HYPOTHESIS,
    TOOL_LIST_DECISIONS,
    TOOL_GET_DECISION,
    TOOL_LIST_RICE,
    TOOL_GET_RICE_ITEM,
]
