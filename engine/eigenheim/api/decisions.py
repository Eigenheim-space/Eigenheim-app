"""Decision log (command-center surface 2)."""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from .. import service, store_db
from ..service import snapshot_metric_for_decision
from .deps import _auth
from .models import DecisionListItemOut, DecisionOut, DeletedOut

router = APIRouter()


# ---- Request models ----

class DecisionIn(BaseModel):
    title: str
    rationale: str = ""
    status: str = ""
    metric_logic_ids: list[str] = []


class DecisionUpdateIn(BaseModel):
    title: str | None = None
    rationale: str | None = None
    status: str | None = None


# ---- Routes ----

@router.get("/decisions", response_model=list[DecisionListItemOut])
def list_decisions(request: Request, authorization: str | None = Header(None)):
    """List all decisions, newest first."""
    _auth(authorization)
    return store_db.list_decisions(request.app.state.conn)


@router.post("/decisions", response_model=DecisionOut)
def create_decision(body: DecisionIn, request: Request, authorization: str | None = Header(None)):
    """Create a decision, optionally capturing the current values of listed metrics."""
    _auth(authorization)
    conn = request.app.state.conn
    metric_snapshots = [
        snapshot_metric_for_decision(conn, lid)
        for lid in body.metric_logic_ids
        if store_db.get_logic(conn, lid) is not None
    ]
    return store_db.create_decision(
        conn,
        title=body.title,
        rationale=body.rationale,
        status=body.status,
        metric_snapshots=metric_snapshots,
    )


@router.get("/decisions/{decision_id}", response_model=DecisionOut)
def get_decision(decision_id: str, request: Request, authorization: str | None = Header(None)):
    """Get one decision with its full captured metric snapshot."""
    _auth(authorization)
    d = store_db.get_decision(request.app.state.conn, decision_id)
    if not d:
        raise HTTPException(404, "decision not found")
    return d


@router.patch("/decisions/{decision_id}", response_model=DecisionOut)
def update_decision(
    decision_id: str,
    body: DecisionUpdateIn,
    request: Request,
    authorization: str | None = Header(None),
):
    """Partial update of a decision's title, rationale, or status."""
    _auth(authorization)
    result = store_db.update_decision(
        request.app.state.conn,
        decision_id,
        title=body.title,
        rationale=body.rationale,
        status=body.status,
    )
    if result is None:
        raise HTTPException(404, "decision not found")
    return result


@router.delete("/decisions/{decision_id}", response_model=DeletedOut)
def delete_decision(decision_id: str, request: Request, authorization: str | None = Header(None)):
    """Delete a decision and all its captured metric snapshot rows."""
    _auth(authorization)
    ok = store_db.delete_decision(request.app.state.conn, decision_id)
    if not ok:
        raise HTTPException(404, "decision not found")
    return {"deleted": decision_id}
