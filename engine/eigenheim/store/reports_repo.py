"""Reports + report_logic + snapshots CRUD."""
from __future__ import annotations

import json
import sqlite3

from ..catalog import Report
from ._helpers import _now


def list_report_defs(conn: sqlite3.Connection) -> list[Report]:
    out = []
    for r in conn.execute("SELECT * FROM reports ORDER BY rowid").fetchall():
        lids = tuple(x["logic_id"] for x in conn.execute("SELECT logic_id FROM report_logic WHERE report_id=? ORDER BY ord", (r["id"],)).fetchall())
        out.append(Report(r["id"], r["name"], r["period_days"], lids))
    return out


def get_report_def(conn: sqlite3.Connection, rid: str) -> Report | None:
    r = conn.execute("SELECT * FROM reports WHERE id=?", (rid,)).fetchone()
    if not r:
        return None
    lids = tuple(x["logic_id"] for x in conn.execute("SELECT logic_id FROM report_logic WHERE report_id=? ORDER BY ord", (rid,)).fetchall())
    return Report(r["id"], r["name"], r["period_days"], lids)


def create_report(conn: sqlite3.Connection, rid: str, name: str, period_days: int, logic_ids: list[str]) -> Report:
    conn.execute("INSERT INTO reports(id, name, period_days, created_at) VALUES (?,?,?,?)", (rid, name, period_days, _now()))
    for ord_, lid in enumerate(logic_ids):
        conn.execute("INSERT INTO report_logic(report_id, logic_id, ord) VALUES (?,?,?)", (rid, lid, ord_))
    conn.commit()
    return Report(rid, name, period_days, tuple(logic_ids))


def update_report(
    conn: sqlite3.Connection,
    rid: str,
    *,
    name: str | None = None,
    period_days: int | None = None,
    logic_ids: list[str] | None = None,
) -> "Report | None":
    """Update name / period_days / logic_ids for report *rid*.

    Only the provided (non-None) fields are touched.  Returns the updated
    Report, or None if *rid* doesn't exist.
    """
    r = conn.execute("SELECT * FROM reports WHERE id=?", (rid,)).fetchone()
    if not r:
        return None
    if name is not None:
        conn.execute("UPDATE reports SET name=? WHERE id=?", (name, rid))
    if period_days is not None:
        conn.execute("UPDATE reports SET period_days=? WHERE id=?", (period_days, rid))
    if logic_ids is not None:
        conn.execute("DELETE FROM report_logic WHERE report_id=?", (rid,))
        for ord_, lid in enumerate(logic_ids):
            conn.execute("INSERT INTO report_logic(report_id, logic_id, ord) VALUES (?,?,?)", (rid, lid, ord_))
    conn.commit()
    return get_report_def(conn, rid)


def delete_report(conn: sqlite3.Connection, rid: str) -> bool:
    """Cascade-delete report *rid* and all its snapshot data.

    Returns False if the report doesn't exist, True after deletion.
    """
    r = conn.execute("SELECT id FROM reports WHERE id=?", (rid,)).fetchone()
    if not r:
        return False
    # Cascade: snapshot_metrics → snapshots → report_logic → reports
    snap_ids = [row[0] for row in conn.execute("SELECT id FROM snapshots WHERE report_id=?", (rid,)).fetchall()]
    for sid in snap_ids:
        conn.execute("DELETE FROM snapshot_metrics WHERE snapshot_id=?", (sid,))
    conn.execute("DELETE FROM snapshots WHERE report_id=?", (rid,))
    conn.execute("DELETE FROM report_logic WHERE report_id=?", (rid,))
    conn.execute("DELETE FROM reports WHERE id=?", (rid,))
    conn.commit()
    return True


def duplicate_report(conn: sqlite3.Connection, src_rid: str, new_rid: str, new_name: str) -> "Report | None":
    """Create a copy of *src_rid* with id *new_rid* and name *new_name*.

    Snapshots are NOT copied — the duplicate starts unbuilt.
    Returns None if *src_rid* doesn't exist.
    """
    src = get_report_def(conn, src_rid)
    if src is None:
        return None
    return create_report(conn, new_rid, new_name, src.period_days, list(src.logic_ids))


def save_snapshot(conn: sqlite3.Connection, report_id: str, period_start: str, period_end: str,
                  frequency: str, metrics: list[dict]) -> int:
    cur = conn.execute("INSERT INTO snapshots(report_id, collected_at, period_start, period_end, frequency) VALUES (?,?,?,?,?)",
                       (report_id, _now(), period_start, period_end, frequency))
    sid = cur.lastrowid
    for m in metrics:
        conn.execute("INSERT INTO snapshot_metrics(snapshot_id, logic_id, logic_version, value, fmt, trace_json, weeks_json, series_json) VALUES (?,?,?,?,?,?,?,?)",
                     (sid, m["logic_id"], m["logic_version"], m["value"], m["fmt"],
                      json.dumps(m["trace"]), json.dumps(m["weeks"]), json.dumps(m["series"])))
    conn.commit()
    return sid


def latest_snapshot(conn: sqlite3.Connection, report_id: str) -> dict | None:
    snap = conn.execute("SELECT * FROM snapshots WHERE report_id=? ORDER BY id DESC LIMIT 1", (report_id,)).fetchone()
    if not snap:
        return None
    mets = conn.execute("SELECT * FROM snapshot_metrics WHERE snapshot_id=?", (snap["id"],)).fetchall()
    return {
        "id": snap["id"], "collected_at": snap["collected_at"], "frequency": snap["frequency"],
        "metrics": [{"logic_id": m["logic_id"], "logic_version": m["logic_version"], "value": m["value"], "fmt": m["fmt"],
                     "trace": json.loads(m["trace_json"]), "weeks": json.loads(m["weeks_json"]), "series": json.loads(m["series_json"])}
                    for m in mets],
    }
