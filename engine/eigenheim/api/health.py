"""Health, events, syncs — meta/infrastructure endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Header, Request

from .deps import _auth
from .models import EventOut, HealthOut, SyncOut

router = APIRouter()


@router.get("/health", response_model=HealthOut)
def health(request: Request, authorization: str | None = Header(None)):
    _auth(authorization)
    (n,) = request.app.state.conn.execute("SELECT count(*) FROM events").fetchone()
    return {"status": "ok", "engine": "ready", "events": n}


@router.get("/events", response_model=list[EventOut])
def events(request: Request, authorization: str | None = Header(None)):
    _auth(authorization)
    from ..catalog import EVENTS
    conn = request.app.state.conn
    names = {r[0] for r in conn.execute("SELECT DISTINCT name FROM events").fetchall()}
    known = [e for e in EVENTS if e["name"] in names]
    extra = [
        {"name": n, "origin": "synced", "source": "data source", "description": ""}
        for n in names if n not in {e["name"] for e in EVENTS}
    ]
    return known + extra


@router.get("/syncs", response_model=list[SyncOut])
def syncs(authorization: str | None = Header(None)):
    _auth(authorization)
    from ..catalog import SYNCS
    return [
        {
            "id": s["id"], "target": s["target"], "frequency": s["frequency"],
            "nextRun": s["next_run"], "lastStatus": s["last_status"], "lastRun": s["last_run"],
        }
        for s in SYNCS
    ]
