"""Deterministic compute: run one SQL aggregate per Logic input, compose them
with the DSL expression, and emit the trace tree (how it was computed).

Numeric aggregation uses stdlib statistics (median) + raw sqlite3 aggregates.
pandas/numpy are not used; the engine stays lightweight for the bundled sidecar."""
from __future__ import annotations

import sqlite3
import statistics
from datetime import datetime, timedelta, timezone

from . import dsl
from .catalog import Input, Logic, fmt_value


def _aggregate(conn: sqlite3.Connection, inp: Input, start: str, end: str, resolve=None) -> tuple[float | None, str]:
    p = inp.params
    if inp.kind == "logic":
        if resolve is None:
            raise ValueError("logic input requires a resolver")
        sub = resolve(p["ref"])
        if sub is None:
            raise ValueError(f"unknown logic '{p['ref']}'")
        v, _ = compute_value(conn, sub, start, end, resolve=resolve)
        return v, f"-- logic:{p['ref']}"
    if inp.kind == "unique":
        # Trace SQL is human-readable only; the executed query uses ? binds.
        trace_sql = f"SELECT count(DISTINCT user_id) FROM events WHERE name = '{p['event']}' AND ts BETWEEN '{start}' AND '{end}'"
        exec_sql = "SELECT count(DISTINCT user_id) FROM events WHERE name = ? AND ts BETWEEN ? AND ?"
        result = float(conn.execute(exec_sql, (p["event"], start, end)).fetchone()[0])
        return result, trace_sql
    if inp.kind == "count":
        trace_sql = f"SELECT count(*) FROM events WHERE name = '{p['event']}' AND ts BETWEEN '{start}' AND '{end}'"
        exec_sql = "SELECT count(*) FROM events WHERE name = ? AND ts BETWEEN ? AND ?"
        result = float(conn.execute(exec_sql, (p["event"], start, end)).fetchone()[0])
        return result, trace_sql
    if inp.kind == "funnel":
        trace_sql = (
            "SELECT count(DISTINCT a.user_id) FROM "
            f"(SELECT user_id, min(ts) ts FROM events WHERE name='{p['from']}' AND ts BETWEEN '{start}' AND '{end}' GROUP BY user_id) a "
            f"JOIN (SELECT user_id, min(ts) ts FROM events WHERE name='{p['to']}' GROUP BY user_id) b ON a.user_id=b.user_id "
            f"WHERE julianday(b.ts) - julianday(a.ts) BETWEEN 0 AND {p['within_days']}"
        )
        exec_sql = (
            "SELECT count(DISTINCT a.user_id) FROM "
            "(SELECT user_id, min(ts) ts FROM events WHERE name=? AND ts BETWEEN ? AND ? GROUP BY user_id) a "
            "JOIN (SELECT user_id, min(ts) ts FROM events WHERE name=? GROUP BY user_id) b ON a.user_id=b.user_id "
            "WHERE julianday(b.ts) - julianday(a.ts) BETWEEN 0 AND ?"
        )
        result = float(conn.execute(exec_sql, (p["from"], start, end, p["to"], p["within_days"])).fetchone()[0])
        return result, trace_sql
    if inp.kind == "retained":
        after = p["after_days"]
        trace_sql = (
            "SELECT count(DISTINCT a.user_id) FROM "
            f"(SELECT user_id, min(ts) ts FROM events WHERE name='{p['base']}' AND ts BETWEEN '{start}' AND '{end}' GROUP BY user_id) a "
            f"JOIN events b ON a.user_id=b.user_id AND b.name='{p['ret']}' "
            f"WHERE julianday(b.ts) - julianday(a.ts) BETWEEN {after - 1} AND {after + 1.5}"
        )
        exec_sql = (
            "SELECT count(DISTINCT a.user_id) FROM "
            "(SELECT user_id, min(ts) ts FROM events WHERE name=? AND ts BETWEEN ? AND ? GROUP BY user_id) a "
            "JOIN events b ON a.user_id=b.user_id AND b.name=? "
            "WHERE julianday(b.ts) - julianday(a.ts) BETWEEN ? AND ?"
        )
        result = float(conn.execute(exec_sql, (p["base"], start, end, p["ret"], after - 1, after + 1.5)).fetchone()[0])
        return result, trace_sql
    if inp.kind == "mau":
        m_start = (datetime.fromisoformat(end) - timedelta(days=p["days"])).strftime("%Y-%m-%d %H:%M:%S")
        trace_sql = f"SELECT count(DISTINCT user_id) FROM events WHERE ts BETWEEN '{m_start}' AND '{end}'"
        exec_sql = "SELECT count(DISTINCT user_id) FROM events WHERE ts BETWEEN ? AND ?"
        result = float(conn.execute(exec_sql, (m_start, end)).fetchone()[0])
        return result, trace_sql
    if inp.kind == "median_gap_days":
        trace_sql = (
            "SELECT julianday(b.ts) - julianday(a.ts) FROM "
            f"(SELECT user_id, min(ts) ts FROM events WHERE name='{p['from']}' AND ts BETWEEN '{start}' AND '{end}' GROUP BY user_id) a "
            f"JOIN (SELECT user_id, min(ts) ts FROM events WHERE name='{p['to']}' GROUP BY user_id) b ON a.user_id=b.user_id"
        )
        exec_sql = (
            "SELECT julianday(b.ts) - julianday(a.ts) FROM "
            "(SELECT user_id, min(ts) ts FROM events WHERE name=? AND ts BETWEEN ? AND ? GROUP BY user_id) a "
            "JOIN (SELECT user_id, min(ts) ts FROM events WHERE name=? GROUP BY user_id) b ON a.user_id=b.user_id"
        )
        gaps = [r[0] for r in conn.execute(exec_sql, (p["from"], start, end, p["to"])).fetchall() if r[0] is not None]
        return (statistics.median(gaps) if gaps else None), trace_sql
    raise ValueError(f"unknown input kind: {inp.kind}")


def compute_value(conn: sqlite3.Connection, logic: Logic, start: str, end: str, resolve=None):
    # Defense-in-depth: callers must skip a missing logic id (store_db.get_logic -> None).
    # A clear error here beats a cryptic "NoneType has no attribute 'inputs'" if a future
    # caller forgets the guard. Every current caller already filters None.
    if logic is None:
        raise ValueError("compute_value: logic is None — caller must skip a missing logic id")
    env: dict[str, float] = {}
    detail: list[tuple[Input, float | None, str]] = []
    for inp in logic.inputs:
        v, sql = _aggregate(conn, inp, start, end, resolve)
        env[inp.alias] = v  # type: ignore[assignment]
        detail.append((inp, v, sql))
    prev_env = None
    if "prev(" in logic.expression:
        # honest delta: re-run the same inputs over the immediately preceding period
        s = datetime.fromisoformat(start)
        e = datetime.fromisoformat(end)
        length = e - s
        ps = s - length - timedelta(seconds=1)
        pe = s - timedelta(seconds=1)
        prev_env = {}
        for inp in logic.inputs:
            pv, _ = _aggregate(conn, inp, ps.strftime("%Y-%m-%d %H:%M:%S"), pe.strftime("%Y-%m-%d %H:%M:%S"), resolve)
            prev_env[inp.alias] = pv
    value = dsl.evaluate(logic.expression, env, prev_env)
    return value, detail


def _events_summary(detail) -> str:
    parts = []
    for inp, v, _ in detail:
        ev = inp.params.get("event") or inp.params.get("from") or inp.params.get("base")
        if ev:
            parts.append(f"{ev} — {int(v):,}".replace(",", " ") if v is not None else f"{ev} — —")
    return " · ".join(parts) or "—"


def _events_max_ts(conn: sqlite3.Connection) -> str:
    """Return the latest event timestamp in the events table, or 'unknown' if empty."""
    row = conn.execute("SELECT MAX(ts) FROM events").fetchone()
    ts = row[0] if row else None
    return ts if ts else "unknown"


def build_trace(conn: sqlite3.Connection, logic: Logic, start: str, end: str, resolve=None) -> dict:
    value, detail = compute_value(conn, logic, start, end, resolve)
    final_sql = detail[0][2] if detail else "—"
    data_through = _events_max_ts(conn)
    return {
        "formula": _formula_text(logic),
        "steps": [
            {"label": "formula", "value": f"validated {logic.validated} · v{logic.version} · sha {logic.sha[:4]}…{logic.sha[-4:]}", "mono": True},
            {"label": "events", "value": _events_summary(detail), "mono": True},
            {"label": "period", "value": f"{start} → {end} · UTC", "mono": True},
            {"label": "source", "value": f"PostHog export · data through {data_through} UTC", "mono": True},
        ],
        "finalQuery": final_sql,
        "result": fmt_value(value, logic.fmt),
    }


def _formula_text(logic: Logic) -> str:
    if logic.id == "activation":
        return "activation = unique(signup → first_report ≤ 7d) / unique(signup)"
    if logic.id == "d7_retention":
        return "d7 = unique(active on signup+7d) / unique(signup)"
    if logic.id == "ttv":
        return "ttv = median(first_report.ts - signup.ts)"
    if logic.id == "mau":
        return "mau = unique(any_event in trailing 30d)"
    return f"{logic.name} = {logic.expression}"


def _iso_week(d: datetime) -> int:
    return d.isocalendar()[1]


def weekly_series(conn: sqlite3.Connection, logic: Logic, start: str, end: str, resolve=None):
    s = datetime.fromisoformat(start).replace(tzinfo=timezone.utc)
    e = datetime.fromisoformat(end).replace(tzinfo=timezone.utc)
    weeks: list[dict] = []
    raw: list[float | None] = []
    cur = s
    while cur <= e:
        wk_end = min(cur + timedelta(days=6, hours=23, minutes=59, seconds=59), e)
        v, _ = compute_value(conn, logic, cur.strftime("%Y-%m-%d %H:%M:%S"), wk_end.strftime("%Y-%m-%d %H:%M:%S"), resolve)
        raw.append(v)
        weeks.append({"week": f"Week {_iso_week(cur)}", "_v": v})
        cur = wk_end + timedelta(seconds=1)
    out = []
    for i, w in enumerate(weeks):
        v = w["_v"]
        prev = weeks[i - 1]["_v"] if i > 0 else None
        delta = round((v - prev) / prev * 100, 1) if (v is not None and prev) else None
        out.append({"week": w["week"], "value": fmt_value(v, logic.fmt), "deltaPct": delta})
    series = [round(x, 4) for x in raw if x is not None]
    return out, series
