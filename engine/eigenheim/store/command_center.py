"""Hypotheses + decisions + RICE prioritization (command-center surfaces 1–3)."""
from __future__ import annotations

import secrets
import sqlite3

from ._helpers import _now
from ..constants import _VALID_HYPOTHESIS_STATUSES

_VALID_HYPOTHESIS_SOURCES = {"agent", "user"}


def _hyp_id() -> str:
    return "hyp_" + secrets.token_hex(8)


def _dec_id() -> str:
    return "dec_" + secrets.token_hex(8)


def _rice_id() -> str:
    return "rice_" + secrets.token_hex(8)


# ---- Hypotheses ----

def create_hypothesis(
    conn: sqlite3.Connection,
    statement: str,
    logic_id: str = "",
    evidence: str = "",
    source: str = "user",
) -> dict:
    if source not in _VALID_HYPOTHESIS_SOURCES:
        raise ValueError(f"source must be one of {_VALID_HYPOTHESIS_SOURCES}")
    hid = _hyp_id()
    conn.execute(
        "INSERT INTO hypotheses(id, statement, logic_id, evidence, status, source, created_at)"
        " VALUES (?,?,?,?,'proposed',?,?)",
        (hid, statement, logic_id, evidence, source, _now()),
    )
    conn.commit()
    return {
        "id": hid,
        "statement": statement,
        "logic_id": logic_id,
        "evidence": evidence,
        "status": "proposed",
        "source": source,
        "created_at": conn.execute(
            "SELECT created_at FROM hypotheses WHERE id=?", (hid,)
        ).fetchone()["created_at"],
    }


def list_hypotheses(
    conn: sqlite3.Connection,
    status: str | None = None,
    logic_id: str | None = None,
) -> list[dict]:
    clauses: list[str] = []
    params: list = []
    if status:
        clauses.append("status=?")
        params.append(status)
    if logic_id:
        clauses.append("logic_id=?")
        params.append(logic_id)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM hypotheses {where} ORDER BY created_at DESC", params
    ).fetchall()
    return [dict(r) for r in rows]


def get_hypothesis(conn: sqlite3.Connection, hid: str) -> dict | None:
    r = conn.execute("SELECT * FROM hypotheses WHERE id=?", (hid,)).fetchone()
    return dict(r) if r else None


def update_hypothesis_status(
    conn: sqlite3.Connection,
    hid: str,
    status: str,
) -> dict | None:
    if status not in _VALID_HYPOTHESIS_STATUSES:
        raise ValueError(
            f"status must be one of {sorted(_VALID_HYPOTHESIS_STATUSES)}, got {status!r}"
        )
    existing = get_hypothesis(conn, hid)
    if existing is None:
        return None
    conn.execute("UPDATE hypotheses SET status=? WHERE id=?", (status, hid))
    conn.commit()
    return get_hypothesis(conn, hid)


def delete_hypothesis(conn: sqlite3.Connection, hid: str) -> bool:
    cur = conn.execute("DELETE FROM hypotheses WHERE id=?", (hid,))
    conn.commit()
    return cur.rowcount == 1


# ---- Decisions ----

def create_decision(
    conn: sqlite3.Connection,
    title: str,
    rationale: str = "",
    status: str = "",
    metric_snapshots: list[dict] | None = None,
) -> dict:
    did = _dec_id()
    now = _now()
    conn.execute(
        "INSERT INTO decisions(id, title, rationale, status, created_at)"
        " VALUES (?,?,?,?,?)",
        (did, title, rationale, status, now),
    )
    captured: list[dict] = []
    for snap in (metric_snapshots or []):
        logic_id = snap.get("logic_id", "")
        if not logic_id:
            continue
        captured_value = snap.get("captured_value")
        trace_ref = snap.get("trace_ref", "")
        cur = conn.execute(
            "INSERT INTO decision_metrics(decision_id, logic_id, captured_value, trace_ref, captured_at)"
            " VALUES (?,?,?,?,?)",
            (did, logic_id, captured_value, trace_ref, now),
        )
        captured.append({
            "id": cur.lastrowid,
            "decision_id": did,
            "logic_id": logic_id,
            "captured_value": captured_value,
            "trace_ref": trace_ref,
            "captured_at": now,
        })
    conn.commit()
    return {
        "id": did,
        "title": title,
        "rationale": rationale,
        "status": status,
        "created_at": now,
        "metrics": captured,
    }


def list_decisions(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM decisions ORDER BY created_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def get_decision(conn: sqlite3.Connection, did: str) -> dict | None:
    row = conn.execute("SELECT * FROM decisions WHERE id=?", (did,)).fetchone()
    if not row:
        return None
    metrics_rows = conn.execute(
        "SELECT * FROM decision_metrics WHERE decision_id=? ORDER BY id",
        (did,),
    ).fetchall()
    return {
        **dict(row),
        "metrics": [dict(m) for m in metrics_rows],
    }


def update_decision(
    conn: sqlite3.Connection,
    did: str,
    title: str | None = None,
    rationale: str | None = None,
    status: str | None = None,
) -> dict | None:
    existing = get_decision(conn, did)
    if existing is None:
        return None
    new_title = title if title is not None else existing["title"]
    new_rationale = rationale if rationale is not None else existing["rationale"]
    new_status = status if status is not None else existing["status"]
    conn.execute(
        "UPDATE decisions SET title=?, rationale=?, status=? WHERE id=?",
        (new_title, new_rationale, new_status, did),
    )
    conn.commit()
    return get_decision(conn, did)


def delete_decision(conn: sqlite3.Connection, did: str) -> bool:
    conn.execute("DELETE FROM decision_metrics WHERE decision_id=?", (did,))
    cur = conn.execute("DELETE FROM decisions WHERE id=?", (did,))
    conn.commit()
    return cur.rowcount == 1


# ---- RICE items ----

def create_rice_item(
    conn: sqlite3.Connection,
    name: str,
    impact: float,
    confidence: float,
    effort: float,
    reach_logic_id: str = "",
    reach_manual: float | None = None,
    source: str = "user",
) -> dict:
    rid = _rice_id()
    now = _now()
    conn.execute(
        "INSERT INTO rice_items(id, name, reach_logic_id, reach_manual,"
        " impact, confidence, effort, source, created_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (rid, name, reach_logic_id, reach_manual, impact, confidence, effort, source, now),
    )
    conn.commit()
    return _rice_row_to_dict(conn.execute(
        "SELECT * FROM rice_items WHERE id=?", (rid,)
    ).fetchone())


def list_rice_items(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM rice_items ORDER BY created_at DESC"
    ).fetchall()
    return [_rice_row_to_dict(r) for r in rows]


def get_rice_item(conn: sqlite3.Connection, rid: str) -> dict | None:
    r = conn.execute("SELECT * FROM rice_items WHERE id=?", (rid,)).fetchone()
    return _rice_row_to_dict(r) if r else None


def update_rice_item(
    conn: sqlite3.Connection,
    rid: str,
    name: str | None = None,
    reach_logic_id: str | None = None,
    reach_manual: float | None = None,
    impact: float | None = None,
    confidence: float | None = None,
    effort: float | None = None,
) -> dict | None:
    existing = get_rice_item(conn, rid)
    if existing is None:
        return None
    new_name = name if name is not None else existing["name"]
    new_reach_logic_id = reach_logic_id if reach_logic_id is not None else existing["reach_logic_id"]
    new_reach_manual = reach_manual if reach_manual is not None else existing["reach_manual"]
    new_impact = impact if impact is not None else existing["impact"]
    new_confidence = confidence if confidence is not None else existing["confidence"]
    new_effort = effort if effort is not None else existing["effort"]
    conn.execute(
        "UPDATE rice_items SET name=?, reach_logic_id=?, reach_manual=?,"
        " impact=?, confidence=?, effort=? WHERE id=?",
        (new_name, new_reach_logic_id, new_reach_manual,
         new_impact, new_confidence, new_effort, rid),
    )
    conn.commit()
    return get_rice_item(conn, rid)


def delete_rice_item(conn: sqlite3.Connection, rid: str) -> bool:
    cur = conn.execute("DELETE FROM rice_items WHERE id=?", (rid,))
    conn.commit()
    return cur.rowcount == 1


def _rice_row_to_dict(r) -> dict:
    return {
        "id":             r["id"],
        "name":           r["name"],
        "reach_logic_id": r["reach_logic_id"],
        "reach_manual":   r["reach_manual"],
        "impact":         r["impact"],
        "confidence":     r["confidence"],
        "effort":         r["effort"],
        "source":         r["source"],
        "created_at":     r["created_at"],
    }
