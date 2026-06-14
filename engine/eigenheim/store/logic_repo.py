"""Logic + logic_versions CRUD: get, list, upsert, deps, cycle detection, definitions."""
from __future__ import annotations

import json
import sqlite3

from ..catalog import Input, Logic
from ._helpers import _now, _inputs_to_json, _inputs_from_json


def _row_to_logic(conn: sqlite3.Connection, lid: str) -> Logic | None:
    """Resolve the latest LIVE version of a Logic.

    A draft version is INERT and must never be returned here.
    Only rows with status='live' are considered the current definition."""
    row = conn.execute("SELECT * FROM logic WHERE id=?", (lid,)).fetchone()
    if not row:
        return None
    # Walk versions in descending order and find the latest live one.
    v = conn.execute(
        "SELECT * FROM logic_versions WHERE logic_id=? AND status='live'"
        " ORDER BY version DESC LIMIT 1",
        (lid,),
    ).fetchone()
    if not v:
        return None
    return Logic(row["id"], row["name"], row["description"], v["version"], _inputs_from_json(v["inputs_json"]),
                 v["expression"], row["fmt"], v["validated"])


def get_logic(conn: sqlite3.Connection, lid: str) -> Logic | None:
    return _row_to_logic(conn, lid)


def list_logic(conn: sqlite3.Connection) -> list[Logic]:
    ids = [r["id"] for r in conn.execute("SELECT id FROM logic ORDER BY rowid").fetchall()]
    return [lg for lid in ids if (lg := _row_to_logic(conn, lid))]


def logic_deps(conn: sqlite3.Connection, lid: str) -> list[str]:
    lg = _row_to_logic(conn, lid)
    if not lg:
        return []
    # Use .get() defensively: a "logic" input with no "ref" key (should be caught
    # by dsl.validate_inputs before any write, but guard here so internal callers
    # never trigger a KeyError → 500).
    return [ref for i in lg.inputs if i.kind == "logic" and (ref := i.params.get("ref"))]


def would_cycle(conn: sqlite3.Connection, new_id: str, inputs: tuple[Input, ...]) -> bool:
    """True if adding `new_id` with these inputs introduces a cycle in the Logic DAG."""
    stack = [ref for i in inputs if i.kind == "logic" and (ref := i.params.get("ref"))]
    seen: set[str] = set()
    while stack:
        cur = stack.pop()
        if cur == new_id:
            return True
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(logic_deps(conn, cur))
    return False


def upsert_logic(conn: sqlite3.Connection, lid: str, name: str, description: str, fmt: str,
                 inputs: tuple[Input, ...], expression: str, validated: str) -> Logic:
    """Create or update a Logic with a new LIVE version (user/bundled write path).

    This is the human-driven path. The new version is immediately live.
    Agent proposals must use create_draft_version instead."""
    existing = conn.execute("SELECT latest_version FROM logic WHERE id=?", (lid,)).fetchone()
    version = (existing["latest_version"] + 1) if existing else 1
    lg = Logic(lid, name, description, version, inputs, expression, fmt, validated)
    if existing:
        conn.execute("UPDATE logic SET name=?, description=?, fmt=?, latest_version=? WHERE id=?", (name, description, fmt, version, lid))
    else:
        conn.execute("INSERT INTO logic(id, name, description, fmt, latest_version) VALUES (?,?,?,?,?)", (lid, name, description, fmt, version))
    conn.execute(
        "INSERT INTO logic_versions(logic_id, version, inputs_json, expression, sha, validated, created_at, status, source, rationale)"
        " VALUES (?,?,?,?,?,?,?,'live','user','')",
        (lid, version, _inputs_to_json(inputs), expression, lg.sha, validated, _now()),
    )
    conn.commit()
    return lg


# ---- Metric-contract definitions -------------------------------------------

def _logic_version_history(conn: sqlite3.Connection, lid: str) -> list[dict]:
    """Return all version rows for a Logic, ordered oldest-first."""
    rows = conn.execute(
        "SELECT version, expression, inputs_json, sha, validated, created_at,"
        " status, source, rationale"
        " FROM logic_versions WHERE logic_id=? ORDER BY version",
        (lid,),
    ).fetchall()
    return [
        {
            "version":   r["version"],
            "expression": r["expression"],
            "inputs":    json.loads(r["inputs_json"]),
            "sha":       r["sha"],
            "validated": r["validated"],
            "created_at": r["created_at"],
            "status":    r["status"],
            "source":    r["source"],
            "rationale": r["rationale"],
        }
        for r in rows
    ]


def get_logic_definition(conn: sqlite3.Connection, lid: str) -> dict | None:
    """Return the canonical versioned definition of one Logic, plus its full version history."""
    row = conn.execute("SELECT * FROM logic WHERE id=?", (lid,)).fetchone()
    if not row:
        return None
    v = conn.execute(
        "SELECT * FROM logic_versions WHERE logic_id=? AND status='live'"
        " ORDER BY version DESC LIMIT 1",
        (lid,),
    ).fetchone()
    if not v:
        return None
    (pending_count,) = conn.execute(
        "SELECT count(*) FROM logic_versions WHERE logic_id=? AND status='draft'",
        (lid,),
    ).fetchone()
    return {
        "id":            row["id"],
        "name":          row["name"],
        "description":   row["description"] or "",
        "version":       v["version"],
        "expression":    v["expression"],
        "inputs":        json.loads(v["inputs_json"]),
        "fmt":           row["fmt"],
        "validated":     v["validated"],
        "sha":           v["sha"],
        "pending_drafts": pending_count,
        "history":       _logic_version_history(conn, lid),
    }


def list_logic_definitions(conn: sqlite3.Connection) -> list[dict]:
    """Return the canonical versioned definition of every Logic (no values).

    Only Logic rows with at least one live version are included.
    Ordered by insertion order (rowid).
    """
    ids = [r["id"] for r in conn.execute("SELECT id FROM logic ORDER BY rowid").fetchall()]
    out = []
    for lid in ids:
        row = conn.execute("SELECT * FROM logic WHERE id=?", (lid,)).fetchone()
        if not row:
            continue
        v = conn.execute(
            "SELECT * FROM logic_versions WHERE logic_id=? AND status='live'"
            " ORDER BY version DESC LIMIT 1",
            (lid,),
        ).fetchone()
        if not v:
            continue
        (pending_count,) = conn.execute(
            "SELECT count(*) FROM logic_versions WHERE logic_id=? AND status='draft'",
            (lid,),
        ).fetchone()
        out.append({
            "id":             row["id"],
            "name":           row["name"],
            "description":    row["description"] or "",
            "version":        v["version"],
            "expression":     v["expression"],
            "inputs":         json.loads(v["inputs_json"]),
            "fmt":            row["fmt"],
            "validated":      v["validated"],
            "sha":            v["sha"],
            "pending_drafts": pending_count,
        })
    return out
