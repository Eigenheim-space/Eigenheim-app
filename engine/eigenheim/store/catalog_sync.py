"""Bundled-catalog sync: sync_bundled_catalog + _catalog_content_hash.

Called on lifespan startup after migrations. Never raises on error.

SEED_LOGIC is read from eigenheim.store_db (the shim) at call time via a
deferred import so that tests which monkeypatch sdb_mod.SEED_LOGIC on the
shim see their patched value inside _sync_bundled_catalog."""
from __future__ import annotations

import hashlib
import logging
import sqlite3

from ..catalog import Logic
from ._helpers import _inputs_to_json, _now

log = logging.getLogger(__name__)


def _catalog_content_hash(lg: Logic) -> str:
    """Stable sha256 of a Logic's canonical bundled content."""
    parts = [
        lg.id,
        lg.expression,
        lg.fmt,
        "|".join(f"{i.alias}:{i.kind}:{sorted(i.params.items())}" for i in lg.inputs),
    ]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def sync_bundled_catalog(conn: sqlite3.Connection) -> None:
    """UPSERT bundled Logic rows whose content has changed, unless user-edited.

    Never raises — errors are logged so a sync failure never blocks app start."""
    try:
        _sync_bundled_catalog(conn)
    except Exception:
        log.exception("sync_bundled_catalog failed; continuing startup without it")


def _sync_bundled_catalog(conn: sqlite3.Connection) -> None:
    # Read SEED_LOGIC from the shim at call time so test monkeypatching works.
    import eigenheim.store_db as _shim  # noqa: PLC0415
    seed_logic = _shim.SEED_LOGIC

    for lg in seed_logic.values():
        new_hash = _catalog_content_hash(lg)
        row = conn.execute(
            "SELECT content_hash, source FROM logic WHERE id=?", (lg.id,)
        ).fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO logic(id, name, description, fmt, latest_version, content_hash, source) VALUES (?,?,?,?,?,?,?)",
                (lg.id, lg.name, lg.description, lg.fmt, lg.version, new_hash, "bundled"),
            )
            conn.execute(
                "INSERT INTO logic_versions(logic_id, version, inputs_json, expression, sha, validated, created_at, status, source, rationale)"
                " VALUES (?,?,?,?,?,?,?,'live','bundled','')",
                (lg.id, lg.version, _inputs_to_json(lg.inputs), lg.expression, lg.sha, lg.validated, _now()),
            )
            log.info("sync_bundled_catalog: inserted missing bundled Logic '%s'", lg.id)
        elif row["source"] == "user":
            continue
        elif row["content_hash"] != new_hash:
            existing = conn.execute("SELECT latest_version FROM logic WHERE id=?", (lg.id,)).fetchone()
            new_version = (existing["latest_version"] + 1) if existing else lg.version
            updated = Logic(lg.id, lg.name, lg.description, new_version, lg.inputs, lg.expression, lg.fmt, lg.validated)
            conn.execute(
                "UPDATE logic SET name=?, description=?, fmt=?, latest_version=?, content_hash=?, source='bundled' WHERE id=?",
                (lg.name, lg.description, lg.fmt, new_version, new_hash, lg.id),
            )
            conn.execute(
                "INSERT INTO logic_versions(logic_id, version, inputs_json, expression, sha, validated, created_at, status, source, rationale)"
                " VALUES (?,?,?,?,?,?,?,'live','bundled','')",
                (lg.id, new_version, _inputs_to_json(lg.inputs), lg.expression, updated.sha, lg.validated, _now()),
            )
            log.info("sync_bundled_catalog: refreshed bundled Logic '%s' to version %d", lg.id, new_version)
    conn.commit()
