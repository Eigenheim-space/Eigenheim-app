"""Draft/promote/reject protocol and hash-chain audit log (Vector 3).

_AUDIT_JSONL_PATH is the module-level mutable global for the JSONL mirror path.
It lives on eigenheim.store_db (the shim) so that tests can monkeypatch
sdb._AUDIT_JSONL_PATH on that module object. _append_audit reads it from the
shim at call time via a deferred import (no circular import at module load time).
"""
from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from pathlib import Path

from ..catalog import Input, Logic
from ._helpers import _now, _inputs_to_json
from .logic_repo import _row_to_logic

log = logging.getLogger(__name__)


def _spec_hash(expression: str, inputs_json: str) -> str:
    """Stable sha256 of the proposed expression + inputs."""
    return hashlib.sha256(f"{expression}|{inputs_json}".encode()).hexdigest()


def _prev_audit_hash(conn: sqlite3.Connection) -> str:
    """Return the audit_hash of the most recent audit row, or '' for the genesis row."""
    row = conn.execute(
        "SELECT audit_hash FROM logic_audit ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return row["audit_hash"] if row else ""


def _compute_audit_hash(event: str, logic_id: str, version: int,
                        spec_hash: str, prev_audit_hash: str) -> str:
    payload = f"{event}|{logic_id}|{version}|{spec_hash}|{prev_audit_hash}"
    return hashlib.sha256(payload.encode()).hexdigest()


def _append_audit(
    conn: sqlite3.Connection,
    event: str,
    logic_id: str,
    version: int,
    spec_hash: str,
    rationale: str,
    actor: str,
) -> str:
    """Append a hash-chained row to logic_audit and mirror to JSONL.

    Reads _AUDIT_JSONL_PATH from eigenheim.store_db (the shim) at call time
    so that monkeypatching sdb._AUDIT_JSONL_PATH in tests is respected.

    Returns the new audit_hash."""
    prev_hash = _prev_audit_hash(conn)
    audit_hash = _compute_audit_hash(event, logic_id, version, spec_hash, prev_hash)
    ts = _now()
    conn.execute(
        "INSERT INTO logic_audit(event, logic_id, version, spec_hash, prev_audit_hash, audit_hash, rationale, actor, ts)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (event, logic_id, version, spec_hash, prev_hash, audit_hash, rationale, actor, ts),
    )
    # Read the JSONL path from the shim's namespace so monkeypatching works.
    import eigenheim.store_db as _shim  # noqa: PLC0415 (deferred, avoids circular at load time)
    jsonl_path: Path | None = getattr(_shim, "_AUDIT_JSONL_PATH", None)
    if jsonl_path:
        try:
            jsonl_path.parent.mkdir(parents=True, exist_ok=True)
            row_dict = {
                "event": event, "logic_id": logic_id, "version": version,
                "spec_hash": spec_hash, "prev_audit_hash": prev_hash,
                "audit_hash": audit_hash, "rationale": rationale,
                "actor": actor, "ts": ts,
            }
            with open(jsonl_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row_dict) + "\n")
        except OSError:
            log.warning("logic_audit JSONL mirror failed (audit row still stored in DB)")
    return audit_hash


def _draft_version_id(logic_id: str, conn: sqlite3.Connection) -> int:
    """Next draft version number: max(all versions for this logic) + 1, or 1."""
    row = conn.execute(
        "SELECT COALESCE(MAX(version), 0) AS m FROM logic_versions WHERE logic_id=?",
        (logic_id,),
    ).fetchone()
    return row["m"] + 1


def create_draft_version(
    conn: sqlite3.Connection,
    logic_id: str,
    name: str,
    description: str,
    fmt: str,
    inputs: tuple[Input, ...],
    expression: str,
    rationale: str,
    actor: str = "agent",
) -> dict:
    """Create an INERT agent-draft version for an existing or new Logic."""
    inputs_json = _inputs_to_json(inputs)
    version = _draft_version_id(logic_id, conn)

    existing = conn.execute("SELECT id FROM logic WHERE id=?", (logic_id,)).fetchone()
    if not existing:
        conn.execute(
            "INSERT INTO logic(id, name, description, fmt, latest_version, source) VALUES (?,?,?,?,0,'user')",
            (logic_id, name, description, fmt),
        )

    _lg = Logic(logic_id, name, description, version, inputs, expression, fmt, "draft")
    sha = _lg.sha

    conn.execute(
        "INSERT INTO logic_versions(logic_id, version, inputs_json, expression, sha, validated, created_at, status, source, rationale)"
        " VALUES (?,?,?,?,?,'draft',?,'draft','agent-draft',?)",
        (logic_id, version, inputs_json, expression, sha, _now(), rationale),
    )

    sh = _spec_hash(expression, inputs_json)
    audit_hash = _append_audit(conn, "draft-created", logic_id, version, sh, rationale, actor)
    conn.commit()

    live = _row_to_logic(conn, logic_id)
    diff: dict = {}
    if live:
        diff["previous_expression"] = live.expression
        diff["new_expression"] = expression
    else:
        diff["note"] = "new Logic — no current live version"

    return {
        "draft_id": f"{logic_id}:{version}",
        "logic_id": logic_id,
        "version": version,
        "spec_hash": sh,
        "audit_hash": audit_hash,
        "diff": diff,
        "status": "draft",
    }


def promote_version(
    conn: sqlite3.Connection,
    logic_id: str,
    version: int,
    actor: str = "human",
) -> dict:
    """Promote a draft version to live (human-only path)."""
    v_row = conn.execute(
        "SELECT * FROM logic_versions WHERE logic_id=? AND version=?",
        (logic_id, version),
    ).fetchone()
    if not v_row:
        raise ValueError(f"version {version} of '{logic_id}' not found")
    if v_row["status"] == "live":
        raise ValueError(f"version {version} of '{logic_id}' is already live")
    if v_row["status"] == "rejected":
        raise ValueError(f"version {version} of '{logic_id}' was rejected and cannot be promoted")

    conn.execute(
        "UPDATE logic_versions SET status='live' WHERE logic_id=? AND version=?",
        (logic_id, version),
    )
    conn.execute(
        "UPDATE logic SET latest_version=? WHERE id=?",
        (version, logic_id),
    )
    sh = _spec_hash(v_row["expression"], v_row["inputs_json"])
    audit_hash = _append_audit(conn, "promoted", logic_id, version, sh, v_row["rationale"], actor)
    conn.commit()
    return {
        "logic_id": logic_id,
        "version": version,
        "status": "live",
        "spec_hash": sh,
        "audit_hash": audit_hash,
    }


def reject_version(
    conn: sqlite3.Connection,
    logic_id: str,
    version: int,
    actor: str = "human",
) -> dict:
    """Reject a draft version (human-only path)."""
    v_row = conn.execute(
        "SELECT * FROM logic_versions WHERE logic_id=? AND version=?",
        (logic_id, version),
    ).fetchone()
    if not v_row:
        raise ValueError(f"version {version} of '{logic_id}' not found")
    if v_row["status"] == "live":
        raise ValueError(f"version {version} of '{logic_id}' is live and cannot be rejected")
    if v_row["status"] == "rejected":
        raise ValueError(f"version {version} of '{logic_id}' is already rejected")

    conn.execute(
        "UPDATE logic_versions SET status='rejected' WHERE logic_id=? AND version=?",
        (logic_id, version),
    )
    sh = _spec_hash(v_row["expression"], v_row["inputs_json"])
    audit_hash = _append_audit(conn, "rejected", logic_id, version, sh, v_row["rationale"], actor)
    conn.commit()
    return {
        "logic_id": logic_id,
        "version": version,
        "status": "rejected",
        "spec_hash": sh,
        "audit_hash": audit_hash,
    }


def list_drafts(conn: sqlite3.Connection, logic_id: str | None = None) -> list[dict]:
    """Return all pending draft versions (status='draft'), optionally for one Logic."""
    if logic_id:
        rows = conn.execute(
            "SELECT * FROM logic_versions WHERE logic_id=? AND status='draft' ORDER BY created_at",
            (logic_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM logic_versions WHERE status='draft' ORDER BY created_at"
        ).fetchall()

    out = []
    for v in rows:
        lid = v["logic_id"]
        live = _row_to_logic(conn, lid)
        diff: dict = {}
        if live:
            diff["previous_expression"] = live.expression
            diff["new_expression"] = v["expression"]
        else:
            diff["note"] = "new Logic — no current live version"
        sh = _spec_hash(v["expression"], v["inputs_json"])
        out.append({
            "logic_id": lid,
            "version": v["version"],
            "expression": v["expression"],
            "inputs": json.loads(v["inputs_json"]),
            "rationale": v["rationale"],
            "created_at": v["created_at"],
            "spec_hash": sh,
            "diff": diff,
        })
    return out


def get_audit_trail(conn: sqlite3.Connection, logic_id: str | None = None) -> list[dict]:
    """Return the audit trail, optionally filtered to one Logic."""
    if logic_id:
        rows = conn.execute(
            "SELECT * FROM logic_audit WHERE logic_id=? ORDER BY id",
            (logic_id,),
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM logic_audit ORDER BY id").fetchall()
    return [dict(r) for r in rows]
