"""Hypothesis log (command-center surface 1)."""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from .. import store_db
from ..constants import _VALID_HYPOTHESIS_STATUSES
from .deps import _auth
from .models import DeletedOut, HypothesisOut

router = APIRouter()


# ---- Request models ----

class HypothesisIn(BaseModel):
    statement: str
    logic_id: str = ""
    evidence: str = ""


class HypothesisStatusIn(BaseModel):
    status: str


# ---- Routes ----

@router.get("/hypotheses", response_model=list[HypothesisOut])
def list_hypotheses(
    request: Request,
    status: str | None = None,
    logic_id: str | None = None,
    authorization: str | None = Header(None),
):
    """List hypotheses with optional filters.

    status: proposed | testing | confirmed | rejected (omit = all).
    logic_id: filter to hypotheses linked to a specific metric (omit = all).
    """
    _auth(authorization)
    if status and status not in _VALID_HYPOTHESIS_STATUSES:
        raise HTTPException(422, f"status must be one of {sorted(_VALID_HYPOTHESIS_STATUSES)}")
    return store_db.list_hypotheses(request.app.state.conn, status=status, logic_id=logic_id)


@router.post("/hypotheses", response_model=HypothesisOut)
def create_hypothesis(body: HypothesisIn, request: Request, authorization: str | None = Header(None)):
    """Create a hypothesis (human path; source='user', status='proposed')."""
    _auth(authorization)
    conn = request.app.state.conn
    if body.logic_id and not store_db.get_logic(conn, body.logic_id):
        raise HTTPException(422, f"unknown Logic '{body.logic_id}'")
    return store_db.create_hypothesis(
        conn,
        statement=body.statement,
        logic_id=body.logic_id,
        evidence=body.evidence,
        source="user",
    )


@router.get("/hypotheses/{hyp_id}", response_model=HypothesisOut)
def get_hypothesis(hyp_id: str, request: Request, authorization: str | None = Header(None)):
    """Get one hypothesis by id."""
    _auth(authorization)
    h = store_db.get_hypothesis(request.app.state.conn, hyp_id)
    if not h:
        raise HTTPException(404, "hypothesis not found")
    return h


@router.patch("/hypotheses/{hyp_id}/status", response_model=HypothesisOut)
def update_hypothesis_status(
    hyp_id: str,
    body: HypothesisStatusIn,
    request: Request,
    authorization: str | None = Header(None),
):
    """Advance the status of a hypothesis (human-only gate)."""
    _auth(authorization)
    if body.status not in _VALID_HYPOTHESIS_STATUSES:
        raise HTTPException(422, f"status must be one of {sorted(_VALID_HYPOTHESIS_STATUSES)}")
    result = store_db.update_hypothesis_status(request.app.state.conn, hyp_id, body.status)
    if result is None:
        raise HTTPException(404, "hypothesis not found")
    return result


@router.delete("/hypotheses/{hyp_id}", response_model=DeletedOut)
def delete_hypothesis(hyp_id: str, request: Request, authorization: str | None = Header(None)):
    """Delete a hypothesis."""
    _auth(authorization)
    ok = store_db.delete_hypothesis(request.app.state.conn, hyp_id)
    if not ok:
        raise HTTPException(404, "hypothesis not found")
    return {"deleted": hyp_id}
