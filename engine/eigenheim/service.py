"""Shared business-logic layer.

Contains:
  - collect_report: compute every metric for a report, persist a snapshot.
    Used by the REST collect endpoint AND the scheduler (one path, not two).
  - period / _period: window helpers used by reports and tasks.
  - _snap_status / _metric: report-metric helpers shared by multiple routers.
  - snapshot_metric_for_decision: extract a metric snapshot at decision time.
    Extracted from the inline logic in app.py create_decision (app.py:1092-1120).
  - partition_tasks_by_goal: partition + sort task groups for the by-goal view.
    Extracted from the inline logic in app.py tasks_by_goal (app.py:691-730).
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

from . import db, store_db
from .catalog import fmt_value
from .compute import build_trace, compute_value, weekly_series

# ---- Display-name map shared across the reports and tasks routers ----

_NAMES: dict[str, str] = {
    "activation": "Activation rate",
    "d7_retention": "D7 retention",
    "ttv": "Time to first report",
    "mau": "MAU",
}

# ---- Frequency string → hours mapping ----

_FREQ_HOURS: dict[str, float] = {
    "1h": 1, "4h": 4, "6h": 6, "12h": 12, "24h": 24, "7d": 168,
}


# ---- Period helpers ----

def period(days: int) -> tuple[str, str]:
    """Return (start, end) ISO strings for a rolling `days`-day window."""
    end = db.PERIOD_END
    start = max(end - timedelta(days=days) + timedelta(seconds=1), db.PERIOD_START)
    return start.strftime("%Y-%m-%d %H:%M:%S"), end.strftime("%Y-%m-%d %H:%M:%S")


# Alias used by app.py (imported as `_period` there for back-compat).
_period = period


# ---- Snapshot status ----

def _snap_status(snap: dict | None) -> str:
    """Return 'live', 'stale', or 'collecting' for a report based on its latest snapshot."""
    if snap is None:
        return "collecting"
    freq_hours = _FREQ_HOURS.get(snap.get("frequency") or "", 24)
    try:
        collected_at = datetime.fromisoformat(snap["collected_at"]).replace(tzinfo=timezone.utc)
    except (ValueError, KeyError):
        return "stale"
    age_hours = (datetime.now(timezone.utc) - collected_at).total_seconds() / 3600
    return "stale" if age_hours > freq_hours * 2 else "live"


# ---- Live metric helper ----

def _metric(conn: sqlite3.Connection, lg, days: int) -> dict:
    """Compute a single metric dict (value, delta, spark, series, trace) for `lg`."""
    start, end = period(days)

    def resolve(lid):
        return store_db.get_logic(conn, lid)

    value, _ = compute_value(conn, lg, start, end, resolve)
    pend = datetime.fromisoformat(start) - timedelta(seconds=1)
    pstart = max(pend - timedelta(days=days), db.PERIOD_START.replace(tzinfo=None))
    prev, _ = compute_value(
        conn, lg,
        pstart.strftime("%Y-%m-%d %H:%M:%S"),
        pend.strftime("%Y-%m-%d %H:%M:%S"),
        resolve,
    )
    delta = round((value - prev) / prev * 100, 1) if (value is not None and prev) else None
    weeks, series = weekly_series(conn, lg, start, end, resolve)
    return {
        "id": lg.id, "name": _NAMES.get(lg.id, lg.name),
        "value": fmt_value(value, lg.fmt), "delta": delta,
        "spark": (series[-7:] or [value or 0]), "series": series or [0],
        "status": "live",
        "weeks": weeks, "trace": build_trace(conn, lg, start, end, resolve),
        "_raw": value, "_version": lg.version,
    }


# ---- Hypothesis metric-trend helper ----

def hypothesis_spark(
    conn: sqlite3.Connection,
    logic_id: str,
    n_weeks: int = 8,
) -> list[float]:
    """Return up to `n_weeks` recent weekly values for a logic_id.

    Uses the same weekly_series compute the reports use — pure deterministic
    compute over the event store, no LLM calls. Returns [] when logic_id is
    missing or the period produces no data.
    """
    if not logic_id:
        return []
    lg = store_db.get_logic(conn, logic_id)
    if lg is None:
        return []
    try:
        end_dt = db.PERIOD_END
        start_dt = max(end_dt - timedelta(days=n_weeks * 7), db.PERIOD_START)
        start = start_dt.strftime("%Y-%m-%d %H:%M:%S")
        end = end_dt.strftime("%Y-%m-%d %H:%M:%S")

        def resolve(lid):
            return store_db.get_logic(conn, lid)

        _, series = weekly_series(conn, lg, start, end, resolve)
        return series[-n_weeks:]
    except Exception:
        return []


# ---- Collect report ----

def collect_report(conn: sqlite3.Connection, report_id: str, frequency: str) -> int | None:
    """Compute every metric of a report and persist an immutable snapshot."""
    r = store_db.get_report_def(conn, report_id)
    if not r:
        return None
    start, end = period(r.period_days)

    def resolve(lid):
        return store_db.get_logic(conn, lid)

    metrics = []
    for lid in r.logic_ids:
        lg = store_db.get_logic(conn, lid)
        if not lg:
            continue
        v, _ = compute_value(conn, lg, start, end, resolve)
        weeks, series = weekly_series(conn, lg, start, end, resolve)
        metrics.append({
            "logic_id": lg.id, "logic_version": lg.version,
            "value": fmt_value(v, lg.fmt), "fmt": lg.fmt,
            "trace": build_trace(conn, lg, start, end, resolve),
            "weeks": weeks, "series": series,
        })
    return store_db.save_snapshot(conn, report_id, start, end, frequency, metrics)


# ---- Business logic extracted from create_decision (app.py:1092-1120) ----

def snapshot_metric_for_decision(
    conn: sqlite3.Connection,
    logic_id: str,
) -> dict:
    """Compute the current value of one Logic and return a decision-snapshot dict.

    Returns {"logic_id": ..., "captured_value": ..., "trace_ref": ...}.
    On any compute failure captured_value is None and trace_ref is "".
    """
    lg = store_db.get_logic(conn, logic_id)
    if lg is None:
        return {"logic_id": logic_id, "captured_value": None, "trace_ref": ""}
    try:
        start, end = period(30)

        def _resolve(l):
            return store_db.get_logic(conn, l)

        value, _ = compute_value(conn, lg, start, end, _resolve)
        trace = build_trace(conn, lg, start, end, _resolve)
        trace_ref = trace.get("formula", "")
    except Exception:
        value = None
        trace_ref = ""
    return {"logic_id": logic_id, "captured_value": value, "trace_ref": trace_ref}


# ---- Business logic extracted from tasks_by_goal (app.py:691-730) ----

def partition_tasks_by_goal(
    conn: sqlite3.Connection,
    all_tasks: list[dict],
) -> dict:
    """Partition tasks into metric-linked groups and an unlinked bucket.

    Each group carries a live metric value (same helper as /reports/{id}).
    Groups are sorted: metrics with a value first, then by Logic name.

    Returns {"groups": [...], "unlinked": [...]}.
    """
    linked: dict[str, list[dict]] = {}
    unlinked: list[dict] = []

    for t in all_tasks:
        if t["link"] and t["link"]["logic_id"]:
            lid = t["link"]["logic_id"]
            linked.setdefault(lid, []).append(t)
        else:
            unlinked.append(t)

    groups = []
    for lid, tasks in linked.items():
        lg = store_db.get_logic(conn, lid)
        if lg is None:
            unlinked.extend(tasks)
            continue
        try:
            metric_data = _metric(conn, lg, 30)
        except Exception:
            metric_data = {
                "id": lid, "name": lg.name, "value": None,
                "delta": None, "spark": [], "series": [], "status": "error",
                "weeks": [], "trace": {}, "_raw": None, "_version": lg.version,
            }
        groups.append({"metric": metric_data, "tasks": tasks})

    groups.sort(key=lambda g: (g["metric"]["_raw"] is None, g["metric"]["name"]))

    return {"groups": groups, "unlinked": unlinked}
