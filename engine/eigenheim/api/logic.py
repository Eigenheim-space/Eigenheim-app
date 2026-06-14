"""Logic metric definitions: CRUD, drafts, promote/reject, audit."""
from __future__ import annotations

import re

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from .. import dsl, store_db
from ..catalog import Input
from .deps import _auth
from .models import (
    AuditEntryOut,
    DraftOut,
    LogicCreateOut,
    LogicDefinitionListItem,
    LogicDefinitionOut,
    LogicOut,
    PromoteRejectOut,
)

router = APIRouter()


# ---- Request models ----

class InputIn(BaseModel):
    alias: str
    kind: str
    params: dict


class LogicIn(BaseModel):
    id: str | None = None
    name: str
    description: str = ""
    fmt: str = "number"
    inputs: list[InputIn]
    expression: str
    validated: str = "today"


# ---- Helpers ----

def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9_]+", "_", s.lower()).strip("_") or "logic"


# ---- Routes ----

@router.get("/logic", response_model=list[LogicOut])
def logic(request: Request, authorization: str | None = Header(None)):
    _auth(authorization)
    conn = request.app.state.conn
    defs = store_db.list_report_defs(conn)
    out = []
    for lg in store_db.list_logic(conn):
        usage = sum(1 for r in defs if lg.id in r.logic_ids)
        out.append({
            "id": lg.id, "name": lg.name, "version": f"v{lg.version}", "usage": usage,
            "expression": lg.expression,
            "badge": "needs-validation" if lg.id == "d7_retention" else None,
        })
    return out


@router.post("/logic", response_model=LogicCreateOut)
def create_logic(body: LogicIn, request: Request, authorization: str | None = Header(None)):
    _auth(authorization)
    conn = request.app.state.conn
    inputs = tuple(Input(i.alias, i.kind, i.params) for i in body.inputs)
    inp_err = dsl.validate_inputs(inputs)
    if inp_err:
        raise HTTPException(422, f"invalid input: {inp_err}")
    aliases = {i.alias for i in body.inputs}
    err = dsl.validate(body.expression, aliases)
    if err:
        raise HTTPException(422, f"expression invalid: {err}")
    lid = body.id or _slug(body.name)
    for i in inputs:
        if i.kind == "logic" and not store_db.get_logic(conn, i.params.get("ref", "")):
            raise HTTPException(422, f"unknown Logic reference: {i.params.get('ref')}")
    if store_db.would_cycle(conn, lid, inputs):
        raise HTTPException(422, "cycle detected in Logic dependencies")
    lg = store_db.upsert_logic(
        conn, lid, body.name, body.description, body.fmt, inputs, body.expression, body.validated
    )
    return {"id": lg.id, "name": lg.name, "version": f"v{lg.version}", "expression": lg.expression}


# ---- Definitions ----

@router.get("/definitions", response_model=list[LogicDefinitionListItem])
def list_definitions(request: Request, authorization: str | None = Header(None)):
    """List the canonical versioned definition of every Logic metric."""
    _auth(authorization)
    return store_db.list_logic_definitions(request.app.state.conn)


@router.get("/definitions/{logic_id}", response_model=LogicDefinitionOut)
def get_definition(logic_id: str, request: Request, authorization: str | None = Header(None)):
    """Get the full versioned definition of one Logic metric."""
    _auth(authorization)
    defn = store_db.get_logic_definition(request.app.state.conn, logic_id)
    if defn is None:
        raise HTTPException(404, f"logic '{logic_id}' not found")
    return defn


# ---- Drafts ----

@router.get("/logic/{logic_id}/drafts", response_model=list[DraftOut])
def list_logic_drafts(logic_id: str, request: Request, authorization: str | None = Header(None)):
    """List all pending draft versions for a Logic metric."""
    _auth(authorization)
    conn = request.app.state.conn
    if not store_db.get_logic(conn, logic_id):
        raise HTTPException(404, f"logic '{logic_id}' not found")
    return store_db.list_drafts(conn, logic_id)


@router.get("/logic/drafts/all", response_model=list[DraftOut])
def list_all_drafts(request: Request, authorization: str | None = Header(None)):
    """List all pending draft versions across every Logic metric."""
    _auth(authorization)
    return store_db.list_drafts(request.app.state.conn)


# ---- Promote / reject ----

@router.post("/logic/{logic_id}/versions/{version}/promote", response_model=PromoteRejectOut)
def promote_version(
    logic_id: str,
    version: int,
    request: Request,
    authorization: str | None = Header(None),
):
    """Promote a draft version of a Logic metric to live (human gate)."""
    _auth(authorization)
    conn = request.app.state.conn
    if not conn.execute("SELECT id FROM logic WHERE id=?", (logic_id,)).fetchone():
        raise HTTPException(404, f"logic '{logic_id}' not found")
    try:
        result = store_db.promote_version(conn, logic_id, version, actor="human")
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return result


@router.post("/logic/{logic_id}/versions/{version}/reject", response_model=PromoteRejectOut)
def reject_version(
    logic_id: str,
    version: int,
    request: Request,
    authorization: str | None = Header(None),
):
    """Reject a draft version of a Logic metric (human gate)."""
    _auth(authorization)
    conn = request.app.state.conn
    if not conn.execute("SELECT id FROM logic WHERE id=?", (logic_id,)).fetchone():
        raise HTTPException(404, f"logic '{logic_id}' not found")
    try:
        result = store_db.reject_version(conn, logic_id, version, actor="human")
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return result


# ---- Audit ----

@router.get("/logic/{logic_id}/audit", response_model=list[AuditEntryOut])
def get_logic_audit(logic_id: str, request: Request, authorization: str | None = Header(None)):
    """Return the hash-chain audit trail for one Logic metric."""
    _auth(authorization)
    conn = request.app.state.conn
    if not conn.execute("SELECT id FROM logic WHERE id=?", (logic_id,)).fetchone():
        raise HTTPException(404, f"logic '{logic_id}' not found")
    return store_db.get_audit_trail(conn, logic_id)
