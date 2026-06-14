"""MCP server: agents read the SAME numbers the user sees, computed by the SAME
engine, from the SAME persisted store.

Auth (1.1):
  Every tool call requires a valid MCP key passed as the `_key` argument.
  Keys are validated via mcp_auth.require_scope(conn, raw_key, "read").
  An invalid key, revoked key, or missing scope raises McpAuthError and
  the tool returns a structured error dict (never an exception to the wire).
  A key that exceeds 60 calls/min raises McpRateLimitError; same handling.

First-call hint (1.4):
  On the FIRST tool dispatch per MCP connection (tracked by _session_hinted, a
  per-connection flag cleared on connection teardown — FastMCP does not yet
  expose a connection teardown hook, so the flag lives on the mcp instance and
  is reset on process restart, which is the right lifetime for a local desktop
  app), a `_hint` field is injected into the structured result envelope.

  The hint points at the docs URL and states the determinism contract:
    the numbers are deterministic and versioned; fetch once, cite, do not re-derive.

  CRITICAL: this runs POST-AUTH, inside a tool result, NOT in `initialize`
  (which is pre-auth and guarded by mcp_instructions._FORBIDDEN_FRAGMENTS test).
"""
from __future__ import annotations

from datetime import timedelta

from mcp.server.fastmcp import FastMCP

from . import db, dsl, goals, rice, store_db
from .catalog import Input, fmt_value
from .compute import build_trace, compute_value, weekly_series
from .mcp_auth import McpAuthError, McpRateLimitError, require_scope
from .mcp_instructions import (
    SERVER_DESCRIPTION,
    TOOL_CREATE_LOGIC,
    TOOL_GET_DECISION,
    TOOL_GET_DEFINITION,
    TOOL_GET_HYPOTHESIS,
    TOOL_GET_KR,
    TOOL_GET_OBJECTIVE,
    TOOL_GET_REPORT,
    TOOL_GET_RICE_ITEM,
    TOOL_GET_TASK,
    TOOL_GET_TRACE,
    TOOL_LIST_DECISIONS,
    TOOL_LIST_DEFINITIONS,
    TOOL_LIST_EVENTS,
    TOOL_LIST_GOALS,
    TOOL_LIST_HYPOTHESES,
    TOOL_LIST_REPORTS,
    TOOL_LIST_RICE,
    TOOL_LIST_TASKS,
    TOOL_PROPOSE_HYPOTHESIS,
    TOOL_UPDATE_LOGIC,
)

mcp = FastMCP("eigenheim", instructions=SERVER_DESCRIPTION)

# Open the persisted store (same path the REST layer uses).
_conn = db.connect()
db.init_schema(_conn)  # production starts empty; sample events are test/dev only
store_db.ensure_schema(_conn)
store_db.seed_defaults(_conn)
store_db.run_migrations(_conn)

# Session-scoped hint flag. Set to False after the first successful tool call.
# A local desktop app restarts the MCP process per session, so per-process is
# per-session for the typical usage. No teardown hook needed.
_session_hinted = False


# ---- Docs hint URL ---------------------------------------------------------
# Phase 2: replace with https://eigenheim.space/docs/mcp/for-agents once that
# page ships (05-execution-plan.md §2.3).
_DOCS_URL = "https://eigenheim.space/docs"

_HINT_TEXT = (
    f"eigenheim metrics are deterministic and versioned. "
    f"Fetch once, cite the report/logic version, do not re-derive from raw events. "
    f"Docs: {_DOCS_URL}"
)


def _maybe_hint(result: dict) -> dict:
    """Inject a _hint field into the result on the first call of the session.
    The hint is a dedicated top-level field, never mixed into data content."""
    global _session_hinted
    if not _session_hinted:
        _session_hinted = True
        result["_hint"] = _HINT_TEXT
    return result


def _period_days(days: int) -> tuple[str, str]:
    end = db.PERIOD_END
    start = max(end - timedelta(days=days), db.PERIOD_START)
    return start.strftime("%Y-%m-%d %H:%M:%S"), end.strftime("%Y-%m-%d %H:%M:%S")


def _resolve(lid: str):
    return store_db.get_logic(_conn, lid)


def _auth(key: str, scope: str = "read") -> dict | None:
    """Validate key + scope. Returns an error dict on failure, None on success."""
    try:
        require_scope(_conn, key, scope)
        return None
    except McpRateLimitError as e:
        return {"error": "rate_limit", "detail": str(e)}
    except McpAuthError as e:
        return {"error": "auth_error", "detail": str(e)}


@mcp.tool(description=TOOL_LIST_REPORTS)
def list_reports(key: str) -> dict:
    """key: your eigenheim MCP API key (eig_…)."""
    err = _auth(key)
    if err:
        return err
    out = []
    for r in store_db.list_report_defs(_conn):
        start, end = _period_days(r.period_days)
        metrics = []
        for lid in r.logic_ids:
            lg = store_db.get_logic(_conn, lid)
            if lg is None:
                continue
            v, _ = compute_value(_conn, lg, start, end, _resolve)
            metrics.append({"id": lid, "value": fmt_value(v, lg.fmt)})
        out.append({"id": r.id, "name": r.name, "period_days": r.period_days, "metrics": metrics})
    return _maybe_hint({"reports": out})


@mcp.tool(description=TOOL_GET_REPORT)
def get_report(key: str, report_id: str) -> dict:
    """key: your eigenheim MCP API key (eig_…)."""
    err = _auth(key)
    if err:
        return err
    r = store_db.get_report_def(_conn, report_id)
    if not r:
        return {"error": f"unknown report '{report_id}'"}
    start, end = _period_days(r.period_days)
    metrics = []
    for lid in r.logic_ids:
        lg = store_db.get_logic(_conn, lid)
        if lg is None:
            continue
        v, _ = compute_value(_conn, lg, start, end, _resolve)
        weeks, _series = weekly_series(_conn, lg, start, end, _resolve)
        metrics.append({"id": lid, "name": lg.name, "value": fmt_value(v, lg.fmt), "weeks": weeks})
    return _maybe_hint({"id": r.id, "name": r.name, "metrics": metrics})


@mcp.tool(description=TOOL_GET_TRACE)
def get_trace(key: str, report_id: str, logic_id: str) -> dict:
    """key: your eigenheim MCP API key (eig_…)."""
    err = _auth(key)
    if err:
        return err
    r = store_db.get_report_def(_conn, report_id)
    lg = store_db.get_logic(_conn, logic_id)
    if not r or logic_id not in r.logic_ids or lg is None:
        return {"error": "unknown report or metric"}
    start, end = _period_days(r.period_days)
    return _maybe_hint(build_trace(_conn, lg, start, end, _resolve))


@mcp.tool(description=TOOL_LIST_EVENTS)
def list_events(key: str) -> dict:
    """key: your eigenheim MCP API key (eig_…)."""
    err = _auth(key)
    if err:
        return err
    from .catalog import EVENTS
    return _maybe_hint({"events": EVENTS})


@mcp.tool(description=TOOL_LIST_TASKS)
def list_tasks(
    key: str,
    tracker: str = "",
    status: str = "",
    assignee: str = "",
    logic_id: str = "",
) -> dict:
    """key: your eigenheim MCP API key (eig_…).
    tracker: 'jira' or 'linear' (optional filter).
    status: task status filter (optional).
    assignee: assignee filter (optional).
    logic_id: only return tasks linked to this metric (optional).
    """
    err = _auth(key, scope="tasks:read")
    if err:
        return err
    tasks = store_db.list_tasks(
        _conn,
        tracker=tracker or None,
        status=status or None,
        assignee=assignee or None,
        logic_id=logic_id or None,
    )
    return _maybe_hint({"tasks": tasks, "count": len(tasks)})


@mcp.tool(description=TOOL_GET_TASK)
def get_task(key: str, external_id: str, tracker: str) -> dict:
    """key: your eigenheim MCP API key (eig_…).
    external_id: the task's external identifier (e.g. 'EIG-42').
    tracker: 'jira' or 'linear'.
    """
    err = _auth(key, scope="tasks:read")
    if err:
        return err
    task = store_db.get_task(_conn, external_id, tracker)
    if not task:
        return _maybe_hint({"error": f"task '{external_id}' not found in cache"})
    result: dict = {"task": task}

    # If the task has a linked Logic, compute its live value + trace.
    link = task.get("link")
    if link and link.get("logic_id"):
        lid = link["logic_id"]
        lg = store_db.get_logic(_conn, lid)
        if lg:
            start, end = _period_days(30)
            try:
                v, _ = compute_value(_conn, lg, start, end, _resolve)
                trace = build_trace(_conn, lg, start, end, _resolve)
                result["linked_metric"] = {
                    "logic_id": lid,
                    "name": lg.name,
                    "value": fmt_value(v, lg.fmt),
                    "trace_ref": trace.get("formula"),
                }
            except Exception:
                result["linked_metric"] = {"logic_id": lid, "error": "compute failed"}

    return _maybe_hint(result)


@mcp.tool(description=TOOL_LIST_GOALS)
def list_goals(key: str, period: str = "") -> dict:
    """key: your eigenheim MCP API key (eig_…).
    period: optional quarter / period label to filter KRs (e.g. 'Q2 2026').
    """
    err = _auth(key, scope="goals:read")
    if err:
        return err
    tree = goals.compute_objective_tree(_conn, period=period or None)
    return _maybe_hint({"objectives": tree, "period": period or None})


@mcp.tool(description=TOOL_GET_OBJECTIVE)
def get_objective(key: str, objective_id: str) -> dict:
    """key: your eigenheim MCP API key (eig_…).
    objective_id: the Objective id (obj_…).
    """
    err = _auth(key, scope="goals:read")
    if err:
        return err
    obj = store_db.get_objective(_conn, objective_id)
    if not obj:
        return _maybe_hint({"error": f"unknown objective '{objective_id}'"})
    krs_raw = store_db.list_key_results(_conn, objective_id=objective_id)
    computed_krs = [goals.compute_kr(_conn, kr) for kr in krs_raw]
    return _maybe_hint({**obj, "krs": computed_krs})


@mcp.tool(description=TOOL_GET_KR)
def get_kr(key: str, kr_id: str) -> dict:
    """key: your eigenheim MCP API key (eig_…).
    kr_id: the Key Result id (kr_…).
    """
    err = _auth(key, scope="goals:read")
    if err:
        return err
    kr = store_db.get_key_result(_conn, kr_id)
    if not kr:
        return _maybe_hint({"error": f"unknown key result '{kr_id}'"})
    return _maybe_hint(goals.compute_kr(_conn, kr))


@mcp.tool(description=TOOL_LIST_DEFINITIONS)
def list_definitions(key: str) -> dict:
    """key: your eigenheim MCP API key (eig_…)."""
    err = _auth(key)
    if err:
        return err
    defs = store_db.list_logic_definitions(_conn)
    return _maybe_hint({"definitions": defs})


@mcp.tool(description=TOOL_GET_DEFINITION)
def get_definition(key: str, logic_id: str) -> dict:
    """key: your eigenheim MCP API key (eig_…).
    logic_id: the Logic id (e.g. 'activation', 'mau').
    """
    err = _auth(key)
    if err:
        return err
    defn = store_db.get_logic_definition(_conn, logic_id)
    if defn is None:
        return _maybe_hint({"error": f"unknown logic '{logic_id}'"})
    return _maybe_hint(defn)


@mcp.tool(description=TOOL_CREATE_LOGIC)
def create_logic(
    key: str,
    logic_id: str,
    name: str,
    expression: str,
    inputs: list[dict],
    rationale: str,
    fmt: str = "number",
    description: str = "",
) -> dict:
    """key: your eigenheim MCP API key (eig_…) — must have logic:write scope.
    logic_id: identifier for the new Logic (e.g. 'my_metric').
    name: human-readable metric name.
    expression: DSL formula (e.g. 'activated / signed_up').
    inputs: list of {alias, kind, params} dicts defining the formula's inputs.
    rationale: your reasoning for this definition (required for human reviewer).
    fmt: 'number' | 'percent' | 'days' (default 'number').
    description: optional long-form description.
    """
    err = _auth(key, scope="logic:write")
    if err:
        return err

    # Validate inputs shape.
    try:
        parsed_inputs = tuple(
            Input(i["alias"], i["kind"], i.get("params", {})) for i in inputs
        )
    except (KeyError, TypeError) as exc:
        return {"error": "validation_error", "detail": f"inputs malformed: {exc}"}

    # Kind + params whitelist: reject unknown kinds and missing/wrong-typed params.
    inp_err = dsl.validate_inputs(parsed_inputs)
    if inp_err:
        return {"error": "validation_error", "detail": f"invalid input: {inp_err}"}

    # DSL guardrail: validate the expression before any write.
    aliases = {i.alias for i in parsed_inputs}
    val_err = dsl.validate(expression, aliases)
    if val_err:
        return {"error": "validation_error", "detail": f"expression invalid: {val_err}"}

    # Cycle check: reject if the proposed inputs would introduce a cycle.
    if store_db.would_cycle(_conn, logic_id, parsed_inputs):
        return {"error": "validation_error", "detail": "proposed inputs would introduce a dependency cycle"}

    # Check any logic-kind input refs exist (unless it's a new one being proposed).
    for inp in parsed_inputs:
        if inp.kind == "logic":
            ref = inp.params.get("ref", "")
            if ref and ref != logic_id and not store_db.get_logic(_conn, ref):
                return {"error": "validation_error", "detail": f"unknown Logic reference: '{ref}'"}

    # All checks passed: create the inert draft.
    result = store_db.create_draft_version(
        _conn, logic_id, name, description, fmt, parsed_inputs, expression,
        rationale=rationale, actor="agent",
    )
    return _maybe_hint({
        "status": "draft_created",
        "draft_id": result["draft_id"],
        "logic_id": result["logic_id"],
        "version": result["version"],
        "spec_hash": result["spec_hash"],
        "audit_hash": result["audit_hash"],
        "diff": result["diff"],
        "note": (
            "This is a DRAFT. It is INERT and does not affect any computed value. "
            "A human must review and promote it at POST /logic/{logic_id}/versions/{version}/promote."
        ),
    })


@mcp.tool(description=TOOL_UPDATE_LOGIC)
def update_logic(
    key: str,
    logic_id: str,
    expression: str,
    inputs: list[dict],
    rationale: str,
    fmt: str = "",
    description: str = "",
) -> dict:
    """key: your eigenheim MCP API key (eig_…) — must have logic:write scope.
    logic_id: the id of the Logic to update (must already exist).
    expression: new DSL formula.
    inputs: updated list of {alias, kind, params} dicts.
    rationale: your reasoning for the change (required for the human reviewer).
    fmt: optional format override ('number' | 'percent' | 'days'); empty = keep existing.
    description: optional description override; empty = keep existing.
    """
    err = _auth(key, scope="logic:write")
    if err:
        return err

    # The Logic must already exist.
    existing_lg = store_db.get_logic(_conn, logic_id)
    if not existing_lg:
        return {"error": "not_found", "detail": f"unknown Logic '{logic_id}' — use create_logic for new metrics"}

    try:
        parsed_inputs = tuple(
            Input(i["alias"], i["kind"], i.get("params", {})) for i in inputs
        )
    except (KeyError, TypeError) as exc:
        return {"error": "validation_error", "detail": f"inputs malformed: {exc}"}

    aliases = {i.alias for i in parsed_inputs}
    val_err = dsl.validate(expression, aliases)
    if val_err:
        return {"error": "validation_error", "detail": f"expression invalid: {val_err}"}

    if store_db.would_cycle(_conn, logic_id, parsed_inputs):
        return {"error": "validation_error", "detail": "proposed inputs would introduce a dependency cycle"}

    for inp in parsed_inputs:
        if inp.kind == "logic":
            ref = inp.params.get("ref", "")
            if ref and ref != logic_id and not store_db.get_logic(_conn, ref):
                return {"error": "validation_error", "detail": f"unknown Logic reference: '{ref}'"}

    effective_fmt = fmt or existing_lg.fmt
    effective_desc = description or (existing_lg.description or "")
    effective_name = existing_lg.name

    result = store_db.create_draft_version(
        _conn, logic_id, effective_name, effective_desc, effective_fmt,
        parsed_inputs, expression, rationale=rationale, actor="agent",
    )
    return _maybe_hint({
        "status": "draft_created",
        "draft_id": result["draft_id"],
        "logic_id": result["logic_id"],
        "version": result["version"],
        "spec_hash": result["spec_hash"],
        "audit_hash": result["audit_hash"],
        "diff": result["diff"],
        "note": (
            "This is a DRAFT. It is INERT and does not affect any computed value. "
            "A human must review and promote it at POST /logic/{logic_id}/versions/{version}/promote."
        ),
    })


@mcp.tool(description=TOOL_LIST_HYPOTHESES)
def list_hypotheses(
    key: str,
    status: str = "",
    logic_id: str = "",
) -> dict:
    """key: your eigenheim MCP API key (eig_…).
    status: optional filter (proposed|testing|confirmed|rejected).
    logic_id: optional filter; only hypotheses linked to this metric.
    """
    err = _auth(key, scope="hypotheses:read")
    if err:
        return err
    hyps = store_db.list_hypotheses(
        _conn,
        status=status or None,
        logic_id=logic_id or None,
    )
    return _maybe_hint({"hypotheses": hyps, "count": len(hyps)})


@mcp.tool(description=TOOL_GET_HYPOTHESIS)
def get_hypothesis(key: str, hypothesis_id: str) -> dict:
    """key: your eigenheim MCP API key (eig_…).
    hypothesis_id: the hypothesis id (hyp_…).
    """
    err = _auth(key, scope="hypotheses:read")
    if err:
        return err
    h = store_db.get_hypothesis(_conn, hypothesis_id)
    if not h:
        return _maybe_hint({"error": f"unknown hypothesis '{hypothesis_id}'"})
    return _maybe_hint(h)


@mcp.tool(description=TOOL_PROPOSE_HYPOTHESIS)
def propose_hypothesis(
    key: str,
    statement: str,
    logic_id: str,
    rationale: str,
    evidence: str = "",
) -> dict:
    """key: your eigenheim MCP API key (eig_…) — must have hypotheses:write scope.
    statement: the hypothesis text (what you believe is true and why it matters).
    logic_id: the metric id this hypothesis is grounded on (from list_definitions).
    rationale: your reasoning and the metric evidence that supports the hypothesis.
    evidence: optional additional quoted evidence context (metric excerpts, etc.).
    """
    # hypotheses:write is default-deny: NOT satisfied by the `read` umbrella.
    err = _auth(key, scope="hypotheses:write")
    if err:
        return err

    # Validate logic_id when supplied: it must exist in the Logic store.
    if logic_id and not store_db.get_logic(_conn, logic_id):
        return {"error": "validation_error", "detail": f"unknown Logic '{logic_id}'"}

    h = store_db.create_hypothesis(
        _conn,
        statement=statement,
        logic_id=logic_id,
        evidence=evidence,
        source="agent",
    )
    # Rationale is not a stored field (the structured evidence field covers it);
    # surface it in the response so the human reviewer sees the agent's reasoning
    # without requiring a schema field for it.
    return _maybe_hint({
        "status": "proposed",
        "id": h["id"],
        "statement": h["statement"],
        "logic_id": h["logic_id"],
        "evidence": h["evidence"],
        "source": h["source"],
        "created_at": h["created_at"],
        "rationale_submitted": rationale,
        "note": (
            "Hypothesis landed as status='proposed'. "
            "A human must advance the status at PATCH /hypotheses/{id}/status. "
            "Agents cannot set status beyond 'proposed'."
        ),
    })


@mcp.tool(description=TOOL_LIST_DECISIONS)
def list_decisions(key: str) -> dict:
    """key: your eigenheim MCP API key (eig_…)."""
    err = _auth(key, scope="decisions:read")
    if err:
        return err
    decisions = store_db.list_decisions(_conn)
    return _maybe_hint({"decisions": decisions, "count": len(decisions)})


@mcp.tool(description=TOOL_GET_DECISION)
def get_decision(key: str, decision_id: str) -> dict:
    """key: your eigenheim MCP API key (eig_…).
    decision_id: the decision id (dec_…).
    """
    err = _auth(key, scope="decisions:read")
    if err:
        return err
    d = store_db.get_decision(_conn, decision_id)
    if not d:
        return _maybe_hint({"error": f"unknown decision '{decision_id}'"})
    return _maybe_hint(d)


@mcp.tool(description=TOOL_LIST_RICE)
def list_rice(key: str) -> dict:
    """key: your eigenheim MCP API key (eig_…)."""
    err = _auth(key, scope="rice:read")
    if err:
        return err
    computed = rice.compute_rice_list(_conn)
    return _maybe_hint({"items": computed, "count": len(computed)})


@mcp.tool(description=TOOL_GET_RICE_ITEM)
def get_rice_item(key: str, item_id: str) -> dict:
    """key: your eigenheim MCP API key (eig_…).
    item_id: the RICE item id (rice_…).
    """
    err = _auth(key, scope="rice:read")
    if err:
        return err
    item = store_db.get_rice_item(_conn, item_id)
    if not item:
        return _maybe_hint({"error": f"unknown RICE item '{item_id}'"})
    computed = rice.compute_rice_item(_conn, item)
    return _maybe_hint(computed)


if __name__ == "__main__":
    mcp.run()
