"""FastAPI application assembly.

Creates the FastAPI app, configures the lifespan (migrations + backup +
session-token handshake), attaches CORS middleware, and includes all
domain routers.

The public surface (URLs, status codes, response shapes) is unchanged.
Business logic lives in service.py; routes live in api/*.
"""
from __future__ import annotations

import asyncio
import logging
import os
import pathlib
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db, scheduler, store_db
from .api.deps import _auth, _auth_state  # re-exported so tests can monkeypatch appmod._auth_state
from .service import _snap_status  # re-exported so tests can call appmod._snap_status(...)
from .api.tasks import _tracker_health  # re-exported so tests can import from eigenheim.app

log = logging.getLogger(__name__)

# PERIOD_END alias kept for any code that imported it from here directly.
PERIOD_END = db.PERIOD_END


# ---- Session-token bootstrap ----

def _resolve_session_token() -> None:
    """Read the per-launch token file once and unlink it.

    Electron passes a per-launch token via a 0600 file whose path is in
    EIGENHEIM_TOKEN_FILE. The engine reads it once and unlinks it so the
    secret never lingers on disk or shows up in `ps` / process env.
    EIGENHEIM_TOKEN (raw env) stays as a dev / back-compat fallback.
    No token configured => the engine is open (standalone-browser dev case).
    """
    path = os.environ.get("EIGENHEIM_TOKEN_FILE")
    if not path or not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as fh:
            tok = fh.read().strip()
        if tok:
            _auth_state["token"] = tok
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


# ---- Lifespan ----

@asynccontextmanager
async def lifespan(app: FastAPI):
    _resolve_session_token()
    # EIGENHEIM_DB lets tests (and CI) point at an isolated DB path without
    # touching the developer's or user's default data directory.
    db_path = os.environ.get("EIGENHEIM_DB") or None
    # CRITICAL path — failures here mean the engine cannot serve anything useful.
    # Let them propagate so uvicorn aborts with a clear traceback.
    conn = db.connect(db_path)
    db.init_schema(conn)  # production starts empty; no sample events (data comes from synced sources)
    store_db.ensure_schema(conn)
    store_db.seed_defaults(conn)

    # BEST-EFFORT steps — a failure in any of these must NOT prevent the engine
    # from reaching "serving" and answering /health. Log loudly and continue so
    # the user can at least open the app and report diagnostics via "Copy diagnostics".

    # Back up before migrating so a bad migration never corrupts the only copy.
    _backup_dir = (
        pathlib.Path(db_path).parent / "backups"
        if db_path
        else db._DEFAULT_DB.parent / "backups"
    )
    try:
        store_db.backup(conn, _backup_dir, keep_n=5)
    except Exception:
        log.warning("eigenheim.app lifespan: backup step failed (continuing)", exc_info=True)

    try:
        store_db.run_migrations(conn)
    except Exception:
        log.warning("eigenheim.app lifespan: run_migrations failed (continuing with current schema)", exc_info=True)

    # Wire the audit JSONL path so hash-chain events are mirrored to disk.
    try:
        store_db._init_audit_path(db_path)
    except Exception:
        log.warning("eigenheim.app lifespan: _init_audit_path failed (continuing)", exc_info=True)

    # Refresh bundled catalog rows whose content changed; user edits always win.
    try:
        store_db.sync_bundled_catalog(conn)
    except Exception:
        log.warning("eigenheim.app lifespan: sync_bundled_catalog failed (continuing)", exc_info=True)

    app.state.conn = conn

    try:
        task = asyncio.create_task(scheduler.run(conn))
    except Exception:
        log.warning("eigenheim.app lifespan: scheduler.run task creation failed (continuing without scheduler)", exc_info=True)
        task = None

    yield

    if task is not None:
        task.cancel()
    conn.close()


# ---- App assembly ----

app = FastAPI(title="eigenheim engine", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3020", "http://127.0.0.1:3020"],
    # Local sidecar: the origin list is the real boundary, so allow every method
    # (PATCH was missing here, which 400'd the report-rename + objective/decision/rice
    # update preflights). "*" keeps a new verb from silently breaking a mutation again.
    allow_methods=["*"],
    allow_headers=["*"],
)

# Domain routers — import here to keep router modules free of circular deps.
from .api import (  # noqa: E402 (post-app import is intentional)
    chat,
    datasources,
    decisions,
    goals,
    graph,
    health,
    hypotheses,
    logic,
    mcp_keys,
    reports,
    rice,
    tasks,
)

app.include_router(health.router)
app.include_router(logic.router)
app.include_router(reports.router)
app.include_router(datasources.router)
app.include_router(tasks.router)
app.include_router(goals.router)
app.include_router(hypotheses.router)
app.include_router(decisions.router)
app.include_router(rice.router)
app.include_router(mcp_keys.router)
app.include_router(graph.router)
# Chat persistence: LOCAL ONLY — transcripts never leave the machine.
app.include_router(chat.router)
