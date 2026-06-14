"""RICE prioritization (command-center surface 3)."""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from .. import rice as rice_module, store_db
from .deps import _auth
from .models import DeletedOut, RiceItemOut

router = APIRouter()


# ---- Request models ----

class RiceItemIn(BaseModel):
    name: str
    reach_logic_id: str = ""
    reach_manual: float | None = None
    impact: float = 1.0
    confidence: float = 1.0
    effort: float = 1.0


class RiceItemUpdateIn(BaseModel):
    name: str | None = None
    reach_logic_id: str | None = None
    reach_manual: float | None = None
    impact: float | None = None
    confidence: float | None = None
    effort: float | None = None


# ---- Routes ----

@router.get("/rice", response_model=list[RiceItemOut])
def list_rice(request: Request, authorization: str | None = Header(None)):
    """List all RICE items sorted by computed score descending."""
    _auth(authorization)
    return rice_module.compute_rice_list(request.app.state.conn)


@router.post("/rice", response_model=RiceItemOut)
def create_rice_item(body: RiceItemIn, request: Request, authorization: str | None = Header(None)):
    """Create a RICE prioritization item."""
    _auth(authorization)
    conn = request.app.state.conn
    if body.reach_logic_id and not store_db.get_logic(conn, body.reach_logic_id):
        raise HTTPException(422, f"unknown Logic '{body.reach_logic_id}'")
    item = store_db.create_rice_item(
        conn,
        name=body.name,
        impact=body.impact,
        confidence=body.confidence,
        effort=body.effort,
        reach_logic_id=body.reach_logic_id,
        reach_manual=body.reach_manual,
    )
    return rice_module.compute_rice_item(conn, item)


@router.get("/rice/{item_id}", response_model=RiceItemOut)
def get_rice_item(item_id: str, request: Request, authorization: str | None = Header(None)):
    """Get one RICE item with its computed score and resolved Reach."""
    _auth(authorization)
    conn = request.app.state.conn
    item = store_db.get_rice_item(conn, item_id)
    if not item:
        raise HTTPException(404, "rice item not found")
    return rice_module.compute_rice_item(conn, item)


@router.patch("/rice/{item_id}", response_model=RiceItemOut)
def update_rice_item(
    item_id: str,
    body: RiceItemUpdateIn,
    request: Request,
    authorization: str | None = Header(None),
):
    """Partial update of a RICE item. Returns the item with recomputed score."""
    _auth(authorization)
    conn = request.app.state.conn
    if body.reach_logic_id is not None and body.reach_logic_id:
        if not store_db.get_logic(conn, body.reach_logic_id):
            raise HTTPException(422, f"unknown Logic '{body.reach_logic_id}'")
    updated = store_db.update_rice_item(
        conn,
        item_id,
        name=body.name,
        reach_logic_id=body.reach_logic_id,
        reach_manual=body.reach_manual,
        impact=body.impact,
        confidence=body.confidence,
        effort=body.effort,
    )
    if updated is None:
        raise HTTPException(404, "rice item not found")
    return rice_module.compute_rice_item(conn, updated)


@router.delete("/rice/{item_id}", response_model=DeletedOut)
def delete_rice_item(item_id: str, request: Request, authorization: str | None = Header(None)):
    """Delete a RICE item."""
    _auth(authorization)
    ok = store_db.delete_rice_item(request.app.state.conn, item_id)
    if not ok:
        raise HTTPException(404, "rice item not found")
    return {"deleted": item_id}
