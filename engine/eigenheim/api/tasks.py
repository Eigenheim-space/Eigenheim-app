"""Task tracker connections, cached tasks, task links."""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from .. import store_db, task_adapters
from ..service import partition_tasks_by_goal
from .deps import _auth
from .models import (
    TaskFacetsOut,
    TaskLinkCreateOut,
    TaskOut,
    TasksByGoalOut,
    TaskUnlinkOut,
    TrackerDeleteOut,
    TrackerOut,
    TrackerSyncOut,
)

router = APIRouter()

_VALID_TRACKERS = {"jira", "linear"}


# ---- Request models ----

class TrackerConnectIn(BaseModel):
    tracker: str
    base_url: str = ""
    project_key: str = ""
    token: str


class TrackerSyncIn(BaseModel):
    token: str
    jql_extra: str = ""
    max_results: int = 100


class TaskLinkIn(BaseModel):
    external_id: str
    tracker: str
    logic_id: str
    okr_ref: str = ""
    kr_ref: str = ""


class TaskUnlinkIn(BaseModel):
    external_id: str
    tracker: str
    logic_id: str


# ---- Helpers ----

def _tracker_health(status: str, last_sync_at: str | None) -> str:
    """Derive a health label from the stored connection status.

    ok           — status is 'connected' AND at least one sync completed.
    error        — status is 'error'.
    never-synced — connection registered but no successful sync yet.
    """
    if status == "error":
        return "error"
    if status == "connected" and last_sync_at:
        return "ok"
    return "never-synced"


# ---- Tracker connections ----

@router.post("/trackers", response_model=TrackerOut)
def connect_tracker(body: TrackerConnectIn, request: Request, authorization: str | None = Header(None)):
    """Register a tracker connection after testing the token."""
    _auth(authorization)
    if body.tracker not in _VALID_TRACKERS:
        raise HTTPException(400, f"unsupported tracker '{body.tracker}'; use jira or linear")
    try:
        if body.tracker == "jira":
            if not body.base_url:
                raise HTTPException(400, "base_url required for Jira (e.g. https://myorg.atlassian.net)")
            adapter = task_adapters.JiraAdapter(
                base_url=body.base_url,
                project_key=body.project_key,
            )
        else:
            adapter = task_adapters.LinearAdapter(team_key=body.project_key)
        result = adapter.test_connection(body.token)
    except task_adapters.TaskAdapterError as e:
        raise HTTPException(400, str(e))
    conn_row = store_db.create_task_connection(
        request.app.state.conn,
        tracker=body.tracker,
        base_url=body.base_url,
        workspace=result.get("workspace", ""),
        project_key=result.get("project_key", body.project_key),
    )
    return conn_row


@router.get("/trackers", response_model=list[TrackerOut])
def list_trackers(request: Request, authorization: str | None = Header(None)):
    """List all registered tracker connections."""
    _auth(authorization)
    rows = store_db.list_task_connections(request.app.state.conn)
    for row in rows:
        row["health"] = _tracker_health(row["status"], row.get("last_sync_at"))
    return rows


@router.delete("/trackers/{connection_id}", response_model=TrackerDeleteOut)
def disconnect_tracker(connection_id: str, request: Request, authorization: str | None = Header(None)):
    """Remove a tracker connection. Cached tasks are NOT deleted (stale-gate)."""
    _auth(authorization)
    ok = store_db.delete_task_connection(request.app.state.conn, connection_id)
    if not ok:
        raise HTTPException(404, "connection not found")
    return {"disconnected": connection_id}


@router.post("/trackers/{connection_id}/sync", response_model=TrackerSyncOut)
def sync_tracker(
    connection_id: str,
    body: TrackerSyncIn,
    request: Request,
    authorization: str | None = Header(None),
):
    """Trigger a task pull for a registered tracker."""
    _auth(authorization)
    conn = request.app.state.conn
    conn_row = store_db.get_task_connection(conn, connection_id)
    if not conn_row:
        raise HTTPException(404, "connection not found")
    tracker = conn_row["tracker"]
    try:
        if tracker == "jira":
            base_url = conn_row.get("base_url", "")
            if not base_url:
                store_db.mark_connection_status(conn, connection_id, "error")
                raise HTTPException(
                    400, "connection is missing base_url; reconnect via Settings → Integrations."
                )
            adapter = task_adapters.JiraAdapter(
                base_url=base_url,
                project_key=conn_row["project_key"],
                jql_extra=body.jql_extra,
                max_results=body.max_results,
            )
        else:
            adapter = task_adapters.LinearAdapter(
                team_key=conn_row["project_key"],
                max_results=body.max_results,
            )
        tasks = adapter.fetch_tasks(body.token)
    except task_adapters.TaskAdapterError as e:
        store_db.mark_connection_status(conn, connection_id, "error")
        raise HTTPException(400, str(e))
    n = store_db.upsert_tasks(conn, tracker, tasks)
    store_db.mark_connection_status(conn, connection_id, "connected", update_sync_at=True)
    return {"synced": n, "tracker": tracker}


# ---- Cached tasks ----

@router.get("/tasks", response_model=list[TaskOut])
def list_tasks_endpoint(
    request: Request,
    tracker: str | None = None,
    status: str | None = None,
    assignee: str | None = None,
    logic_id: str | None = None,
    authorization: str | None = Header(None),
):
    """List cached tasks with optional filters."""
    _auth(authorization)
    return store_db.list_tasks(
        request.app.state.conn,
        tracker=tracker,
        status=status,
        assignee=assignee,
        logic_id=logic_id,
    )


@router.get("/tasks/facets", response_model=TaskFacetsOut)
def task_facets(
    request: Request,
    tracker: str | None = None,
    status: str | None = None,
    assignee: str | None = None,
    linked_metric: str | None = None,
    authorization: str | None = Header(None),
):
    """Pre-aggregated facet counts for the right-panel navigator."""
    _auth(authorization)
    return store_db.get_task_facets(
        request.app.state.conn,
        tracker=tracker,
        status=status,
        assignee=assignee,
        logic_id=linked_metric,
    )


@router.get("/tasks/by-goal", response_model=TasksByGoalOut)
def tasks_by_goal(request: Request, authorization: str | None = Header(None)):
    """Tasks grouped by their linked metric (the 'By Goals' view)."""
    _auth(authorization)
    conn = request.app.state.conn
    all_tasks = store_db.list_tasks(conn)
    return partition_tasks_by_goal(conn, all_tasks)


# ---- Task links ----

@router.post("/task-links", response_model=TaskLinkCreateOut)
def link_task_endpoint(body: TaskLinkIn, request: Request, authorization: str | None = Header(None)):
    """Link a task to a Logic (eigenheim-native data)."""
    _auth(authorization)
    conn = request.app.state.conn
    if body.tracker not in _VALID_TRACKERS:
        raise HTTPException(400, f"unsupported tracker '{body.tracker}'")
    if not store_db.get_logic(conn, body.logic_id):
        raise HTTPException(422, f"unknown Logic '{body.logic_id}'")
    if not store_db.get_task(conn, body.external_id, body.tracker):
        raise HTTPException(422, f"task '{body.external_id}' not found in cache")
    result = store_db.link_task(
        conn,
        body.external_id,
        body.tracker,
        body.logic_id,
        body.okr_ref,
        body.kr_ref,
    )
    return result


@router.delete("/task-links", response_model=TaskUnlinkOut)
def unlink_task_endpoint(body: TaskUnlinkIn, request: Request, authorization: str | None = Header(None)):
    """Remove the link between a task and a Logic."""
    _auth(authorization)
    ok = store_db.unlink_task(request.app.state.conn, body.external_id, body.tracker, body.logic_id)
    if not ok:
        raise HTTPException(404, "link not found")
    return {"unlinked": True, "external_id": body.external_id, "logic_id": body.logic_id}
