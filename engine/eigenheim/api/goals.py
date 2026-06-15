"""Goals (OKR): Objectives and Key Results."""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from .. import goals as goals_module, store_db
from ..constants import _VALID_COMPARISONS
from .deps import _auth
from .models import (
    DeletedOut,
    GoalsOut,
    KeyResultOut,
    ObjectiveOut,
    ObjectiveSimpleOut,
    ObjectiveWithKRsOut,
)

router = APIRouter()


# ---- Request models ----

class ObjectiveIn(BaseModel):
    title: str
    period: str = ""


class ObjectiveUpdateIn(BaseModel):
    title: str | None = None
    period: str | None = None


class KeyResultIn(BaseModel):
    objective_id: str
    name: str
    logic_id: str = ""
    target: float | None = None
    comparison: str = "gte"
    period: str = ""


class KeyResultUpdateIn(BaseModel):
    name: str | None = None
    logic_id: str | None = None
    target: float | None = None
    comparison: str | None = None
    period: str | None = None


# ---- Routes ----

@router.get("/goals", response_model=GoalsOut)
def list_goals(
    request: Request,
    period: str | None = None,
    authorization: str | None = Header(None),
):
    """OKR tree: Objectives with KRs, each KR carrying live value, target,
    comparison, status, progress, gap, trace_ref, and task_count."""
    _auth(authorization)
    tree = goals_module.compute_objective_tree(request.app.state.conn, period=period)
    return {"objectives": tree, "period": period}


@router.get("/objectives", response_model=list[ObjectiveSimpleOut])
def list_objectives_endpoint(
    request: Request,
    period: str | None = None,
    authorization: str | None = Header(None),
):
    """List Objectives (lightweight, no KR computation)."""
    _auth(authorization)
    return store_db.list_objectives(request.app.state.conn, period=period)


@router.post("/objectives", response_model=ObjectiveSimpleOut)
def create_objective(body: ObjectiveIn, request: Request, authorization: str | None = Header(None)):
    """Create an Objective."""
    _auth(authorization)
    return store_db.create_objective(request.app.state.conn, body.title, body.period)


@router.get("/objectives/{objective_id}", response_model=ObjectiveWithKRsOut)
def get_objective(objective_id: str, request: Request, authorization: str | None = Header(None)):
    """Get one Objective with its KRs (live-computed)."""
    _auth(authorization)
    conn = request.app.state.conn
    obj = store_db.get_objective(conn, objective_id)
    if not obj:
        raise HTTPException(404, "objective not found")
    krs_raw = store_db.list_key_results(conn, objective_id=objective_id)
    computed_krs = [goals_module.compute_kr(conn, kr) for kr in krs_raw]
    return {**obj, "krs": computed_krs}


@router.patch("/objectives/{objective_id}", response_model=ObjectiveSimpleOut)
def update_objective(
    objective_id: str,
    body: ObjectiveUpdateIn,
    request: Request,
    authorization: str | None = Header(None),
):
    """Update an Objective's title and/or period."""
    _auth(authorization)
    obj = store_db.update_objective(request.app.state.conn, objective_id, body.title, body.period)
    if not obj:
        raise HTTPException(404, "objective not found")
    return obj


@router.delete("/objectives/{objective_id}", response_model=DeletedOut)
def delete_objective(objective_id: str, request: Request, authorization: str | None = Header(None)):
    """Delete an Objective and all its KRs."""
    _auth(authorization)
    ok = store_db.delete_objective(request.app.state.conn, objective_id)
    if not ok:
        raise HTTPException(404, "objective not found")
    return {"deleted": objective_id}


@router.post("/key-results", response_model=KeyResultOut)
def create_key_result(body: KeyResultIn, request: Request, authorization: str | None = Header(None)):
    """Create a KR under an Objective."""
    _auth(authorization)
    conn = request.app.state.conn
    if not store_db.get_objective(conn, body.objective_id):
        raise HTTPException(422, f"unknown objective '{body.objective_id}'")
    if body.logic_id and not store_db.get_logic(conn, body.logic_id):
        raise HTTPException(422, f"unknown Logic '{body.logic_id}'")
    if body.comparison not in _VALID_COMPARISONS:
        raise HTTPException(422, f"comparison must be one of {sorted(_VALID_COMPARISONS)}")
    raw = store_db.create_key_result(
        conn,
        objective_id=body.objective_id,
        name=body.name,
        logic_id=body.logic_id,
        target=body.target,
        comparison=body.comparison,
        period=body.period,
    )
    # Re-fetch from DB so the dict includes created_at (create_key_result omits it).
    kr = store_db.get_key_result(conn, raw["id"])
    return goals_module.compute_kr(conn, kr)


@router.get("/key-results/{kr_id}", response_model=KeyResultOut)
def get_key_result(kr_id: str, request: Request, authorization: str | None = Header(None)):
    """Get one KR with live-computed value, status, progress, gap, trace_ref."""
    _auth(authorization)
    kr = store_db.get_key_result(request.app.state.conn, kr_id)
    if not kr:
        raise HTTPException(404, "key result not found")
    return goals_module.compute_kr(request.app.state.conn, kr)


@router.patch("/key-results/{kr_id}", response_model=KeyResultOut)
def update_key_result(
    kr_id: str,
    body: KeyResultUpdateIn,
    request: Request,
    authorization: str | None = Header(None),
):
    """Update a KR's fields. Partial update: only supplied fields change."""
    _auth(authorization)
    conn = request.app.state.conn
    if body.logic_id is not None and body.logic_id and not store_db.get_logic(conn, body.logic_id):
        raise HTTPException(422, f"unknown Logic '{body.logic_id}'")
    if body.comparison is not None and body.comparison not in _VALID_COMPARISONS:
        raise HTTPException(422, f"comparison must be one of {sorted(_VALID_COMPARISONS)}")
    kr = store_db.update_key_result(
        conn,
        kr_id,
        name=body.name,
        logic_id=body.logic_id,
        target=body.target,
        comparison=body.comparison,
        period=body.period,
    )
    if not kr:
        raise HTTPException(404, "key result not found")
    return goals_module.compute_kr(conn, kr)


@router.delete("/key-results/{kr_id}", response_model=DeletedOut)
def delete_key_result(kr_id: str, request: Request, authorization: str | None = Header(None)):
    """Delete a KR."""
    _auth(authorization)
    ok = store_db.delete_key_result(request.app.state.conn, kr_id)
    if not ok:
        raise HTTPException(404, "key result not found")
    return {"deleted": kr_id}
