"""Reports: list, detail, collect, ingest."""
from __future__ import annotations

from fastapi import APIRouter, Body, Header, HTTPException, Request
from pydantic import BaseModel

from .. import adapters, service, store_db
from ..service import _NAMES, _metric, _snap_status
from .deps import _auth
from .logic import _slug
from .models import CollectOut, IngestOut, ReportCreateOut, ReportDeleteOut, ReportListItem, ReportOut

router = APIRouter()


# ---- Request models ----

class ReportIn(BaseModel):
    id: str | None = None
    name: str
    period_days: int = 30
    logic_ids: list[str]


class ReportPatchIn(BaseModel):
    name: str | None = None
    period_days: int | None = None
    logic_ids: list[str] | None = None


class ReportDuplicateIn(BaseModel):
    name: str | None = None


class CollectIn(BaseModel):
    frequency: str = "24h"


# ---- Routes ----

@router.get("/reports", response_model=list[ReportListItem])
def reports(request: Request, authorization: str | None = Header(None)):
    _auth(authorization)
    conn = request.app.state.conn
    out = []
    for r in store_db.list_report_defs(conn):
        snap = store_db.latest_snapshot(conn, r.id)
        out.append({
            "id": r.id, "name": r.name, "period": f"{r.period_days}d",
            "status": _snap_status(snap),
            "lastBuilt": snap["collected_at"] if snap else "",
            "metricCount": len(r.logic_ids),
        })
    return out


@router.get("/reports/{report_id}", response_model=ReportOut)
def report_detail(
    report_id: str,
    request: Request,
    days: int | None = None,
    authorization: str | None = Header(None),
):
    _auth(authorization)
    conn = request.app.state.conn
    r = store_db.get_report_def(conn, report_id)
    if not r:
        raise HTTPException(404, "report not found")
    period_days = days if days is not None else r.period_days
    snap = store_db.latest_snapshot(conn, report_id)
    if snap and days is None:
        status = _snap_status(snap)
        metric_status = "stale" if status == "stale" else "live"
        metrics = [
            {
                "id": m["logic_id"], "name": _NAMES.get(m["logic_id"], m["logic_id"]),
                "value": m["value"], "delta": None,
                "spark": (m["series"][-7:] or [0]), "series": m["series"] or [0],
                "status": metric_status, "weeks": m["weeks"], "trace": m["trace"],
            }
            for m in snap["metrics"]
        ]
        return {
            "id": r.id, "name": r.name, "period": f"{r.period_days}d",
            "status": status, "lastBuilt": snap["collected_at"], "metrics": metrics,
        }
    status = "collecting" if snap is None else "live"
    metrics = [
        _metric(conn, store_db.get_logic(conn, lid), period_days)
        for lid in r.logic_ids
        if store_db.get_logic(conn, lid)
    ]
    period_label = f"{period_days}d" if days is not None else f"{r.period_days}d"
    return {
        "id": r.id, "name": r.name, "period": period_label,
        "status": status, "lastBuilt": "", "metrics": metrics,
    }


@router.post("/reports", response_model=ReportCreateOut)
def create_report(body: ReportIn, request: Request, authorization: str | None = Header(None)):
    _auth(authorization)
    rid = body.id or _slug(body.name)
    r = store_db.create_report(request.app.state.conn, rid, body.name, body.period_days, body.logic_ids)
    return {"id": r.id, "name": r.name, "period": f"{r.period_days}d"}


@router.patch("/reports/{report_id}", response_model=ReportCreateOut)
def patch_report(
    report_id: str,
    body: ReportPatchIn,
    request: Request,
    authorization: str | None = Header(None),
):
    _auth(authorization)
    conn = request.app.state.conn
    r = store_db.update_report(
        conn, report_id,
        name=body.name,
        period_days=body.period_days,
        logic_ids=body.logic_ids,
    )
    if r is None:
        raise HTTPException(404, "report not found")
    return {"id": r.id, "name": r.name, "period": f"{r.period_days}d"}


@router.delete("/reports/{report_id}", response_model=ReportDeleteOut)
def delete_report(
    report_id: str,
    request: Request,
    authorization: str | None = Header(None),
):
    _auth(authorization)
    conn = request.app.state.conn
    ok = store_db.delete_report(conn, report_id)
    if not ok:
        raise HTTPException(404, "report not found")
    return {"ok": True}


@router.post("/reports/{report_id}/duplicate", response_model=ReportCreateOut)
def duplicate_report(
    report_id: str,
    request: Request,
    body: ReportDuplicateIn = Body(default=ReportDuplicateIn()),
    authorization: str | None = Header(None),
):
    _auth(authorization)
    conn = request.app.state.conn
    src = store_db.get_report_def(conn, report_id)
    if src is None:
        raise HTTPException(404, "report not found")
    base_name = body.name or f"{src.name} copy"
    # Build a unique slug: try base, then base-2, base-3, …
    candidate = _slug(base_name)
    new_rid = candidate
    suffix = 2
    while store_db.get_report_def(conn, new_rid) is not None:
        new_rid = f"{candidate}-{suffix}"
        suffix += 1
    r = store_db.duplicate_report(conn, report_id, new_rid, base_name)
    if r is None:
        raise HTTPException(404, "report not found")
    return {"id": r.id, "name": r.name, "period": f"{r.period_days}d"}


@router.post("/reports/{report_id}/collect", response_model=CollectOut)
def collect(
    report_id: str,
    request: Request,
    body: CollectIn = Body(default=CollectIn()),
    authorization: str | None = Header(None),
):
    _auth(authorization)
    conn = request.app.state.conn
    r = store_db.get_report_def(conn, report_id)
    if not r:
        raise HTTPException(404, "report not found")
    sid = service.collect_report(conn, report_id, body.frequency)
    return {"snapshot_id": sid, "collected": len(r.logic_ids)}


# ---- Ingest ----

@router.post("/ingest/csv", response_model=IngestOut)
def ingest_csv(
    request: Request,
    text: str = Body(..., media_type="text/plain"),
    authorization: str | None = Header(None),
):
    _auth(authorization)
    try:
        n = adapters.ingest_csv(request.app.state.conn, text)
    except adapters.AdapterError as e:
        raise HTTPException(422, str(e))
    return {"ingested": n}
