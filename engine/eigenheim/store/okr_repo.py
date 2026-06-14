"""Objectives + key_results CRUD."""
from __future__ import annotations

import secrets
import sqlite3

from ._helpers import _now
from ..constants import _VALID_COMPARISONS


def _obj_id() -> str:
    return "obj_" + secrets.token_hex(8)


def _kr_id() -> str:
    return "kr_" + secrets.token_hex(8)


# ---- Objectives ----

def create_objective(
    conn: sqlite3.Connection,
    title: str,
    period: str = "",
    source: str = "user",
) -> dict:
    oid = _obj_id()
    conn.execute(
        "INSERT INTO objectives(id, title, period, source, created_at) VALUES (?,?,?,?,?)",
        (oid, title, period, source, _now()),
    )
    conn.commit()
    return {"id": oid, "title": title, "period": period, "source": source}


def list_objectives(
    conn: sqlite3.Connection, period: str | None = None
) -> list[dict]:
    if period:
        rows = conn.execute(
            "SELECT * FROM objectives WHERE period=? ORDER BY rowid", (period,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM objectives ORDER BY rowid"
        ).fetchall()
    return [dict(r) for r in rows]


def get_objective(conn: sqlite3.Connection, oid: str) -> dict | None:
    r = conn.execute("SELECT * FROM objectives WHERE id=?", (oid,)).fetchone()
    return dict(r) if r else None


def update_objective(
    conn: sqlite3.Connection, oid: str, title: str | None = None, period: str | None = None
) -> dict | None:
    obj = get_objective(conn, oid)
    if obj is None:
        return None
    new_title = title if title is not None else obj["title"]
    new_period = period if period is not None else obj["period"]
    conn.execute(
        "UPDATE objectives SET title=?, period=? WHERE id=?",
        (new_title, new_period, oid),
    )
    conn.commit()
    return get_objective(conn, oid)


def delete_objective(conn: sqlite3.Connection, oid: str) -> bool:
    """Delete an Objective and all its KRs.  Returns True if a row was deleted."""
    conn.execute("DELETE FROM key_results WHERE objective_id=?", (oid,))
    cur = conn.execute("DELETE FROM objectives WHERE id=?", (oid,))
    conn.commit()
    return cur.rowcount == 1


# ---- Key Results ----

def create_key_result(
    conn: sqlite3.Connection,
    objective_id: str,
    name: str,
    logic_id: str = "",
    target: float | None = None,
    comparison: str = "gte",
    period: str = "",
) -> dict:
    if comparison not in _VALID_COMPARISONS:
        raise ValueError(f"comparison must be one of {_VALID_COMPARISONS}, got {comparison!r}")
    kid = _kr_id()
    conn.execute(
        "INSERT INTO key_results(id, objective_id, name, logic_id, target, comparison, period, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (kid, objective_id, name, logic_id, target, comparison, period, _now()),
    )
    conn.commit()
    return {
        "id": kid, "objective_id": objective_id, "name": name,
        "logic_id": logic_id, "target": target, "comparison": comparison, "period": period,
    }


def list_key_results(
    conn: sqlite3.Connection,
    objective_id: str | None = None,
    period: str | None = None,
    logic_id: str | None = None,
) -> list[dict]:
    clauses: list[str] = []
    params: list = []
    if objective_id:
        clauses.append("objective_id=?")
        params.append(objective_id)
    if period:
        clauses.append("period=?")
        params.append(period)
    if logic_id:
        clauses.append("logic_id=?")
        params.append(logic_id)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM key_results {where} ORDER BY rowid", params
    ).fetchall()
    return [dict(r) for r in rows]


def get_key_result(conn: sqlite3.Connection, kid: str) -> dict | None:
    r = conn.execute("SELECT * FROM key_results WHERE id=?", (kid,)).fetchone()
    return dict(r) if r else None


def update_key_result(
    conn: sqlite3.Connection,
    kid: str,
    name: str | None = None,
    logic_id: str | None = None,
    target: float | None = None,
    comparison: str | None = None,
    period: str | None = None,
) -> dict | None:
    kr = get_key_result(conn, kid)
    if kr is None:
        return None
    new_name = name if name is not None else kr["name"]
    new_logic_id = logic_id if logic_id is not None else kr["logic_id"]
    new_target = target if target is not None else kr["target"]
    new_comparison = comparison if comparison is not None else kr["comparison"]
    if new_comparison not in _VALID_COMPARISONS:
        raise ValueError(f"comparison must be one of {_VALID_COMPARISONS}")
    new_period = period if period is not None else kr["period"]
    conn.execute(
        "UPDATE key_results SET name=?, logic_id=?, target=?, comparison=?, period=? WHERE id=?",
        (new_name, new_logic_id, new_target, new_comparison, new_period, kid),
    )
    conn.commit()
    return get_key_result(conn, kid)


def delete_key_result(conn: sqlite3.Connection, kid: str) -> bool:
    cur = conn.execute("DELETE FROM key_results WHERE id=?", (kid,))
    conn.commit()
    return cur.rowcount == 1
