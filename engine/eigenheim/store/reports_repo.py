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
