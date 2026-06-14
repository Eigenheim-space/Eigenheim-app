"""KR computation: derive status, progress, and gap from a bound Logic's live value.

Status derivation rule (v1, documented here as the authoritative spec):

  A KR binds a Logic value (live) to a target and a comparison operator
  (gte / lte / eq).  Two-tier status:

  - "ahead"  — the live value satisfies the comparison vs target.
               gte: live >= target
               lte: live <= target
               eq:  live == target (exact float equality; use for ratio/integer KRs)

  - "behind" — the live value does not satisfy the comparison.

  No "at_risk" tier in v1.  The brief names it as a possibility but qualifies it
  as "if trivially deterministic."  A pace-based at-risk requires the KR start
  date and a percentage-into-period figure, neither of which is stored in v1.
  Adding at_risk without those inputs would require arbitrary thresholds (e.g.
  "within 10% of target") that would produce spurious amber on any KR near a
  natural boundary.  Deferred to Phase 2 when period start is tracked.

  - "stale"  — the Logic does not exist in the store, or compute_value raises.
               Live value is None, progress is 0.0, gap is None.

  - "draft"  — logic_id is empty (KR has no bound Logic).  Same numeric shape as
               stale but the cause is intentional.

Progress (0.0 .. 1.0, clamped):

  Defined as how far the live value has traveled toward the target, expressed
  as a fraction of the target.  Always clamped to [0, 1].

  For gte/eq:  progress = clamp(live / target, 0, 1)  when target > 0
  For lte:     the "good direction" is live going down toward target.
               progress = clamp(1 - (live - target) / target, 0, 1)  when target > 0
               If target == 0, progress = 1.0 when live <= 0, else 0.0.

  When live or target is None/zero in a way that makes the ratio undefined,
  progress defaults to 0.0.

Gap:

  Signed difference (live - target).  Positive means live > target.
  None when status is stale or draft.

Engine never imports an LLM client.  This module is deterministic.
"""
from __future__ import annotations

import sqlite3
from datetime import timedelta

from . import db, store_db
from .catalog import Logic, fmt_value
from .compute import build_trace, compute_value


# Default period for KR computation (mirrors /tasks/by-goal and MCP defaults).
_DEFAULT_DAYS = 30


def _period_days(days: int = _DEFAULT_DAYS) -> tuple[str, str]:
    end = db.PERIOD_END
    start = max(end - timedelta(days=days), db.PERIOD_START)
    return start.strftime("%Y-%m-%d %H:%M:%S"), end.strftime("%Y-%m-%d %H:%M:%S")


def _resolve(conn: sqlite3.Connection):
    def _r(lid: str) -> Logic | None:
        return store_db.get_logic(conn, lid)
    return _r


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def _progress(live: float, target: float, comparison: str) -> float:
    """Compute 0..1 progress toward the target given the comparison direction."""
    if target is None:
        return 0.0
    if comparison in ("gte", "eq"):
        if target == 0:
            return 1.0 if live >= 0 else 0.0
        return _clamp(live / target)
    # lte: good direction is downward
    if target == 0:
        return 1.0 if live <= 0 else 0.0
    # How far has live descended toward target from some implicit "start"?
    # Without a start value, use the ratio of how far below target we are:
    # progress = 1 - excess_above_target / target (clamped)
    excess = live - target
    if excess <= 0:
        return 1.0   # already at or below target
    return _clamp(1.0 - excess / abs(target))


def _meets(live: float, target: float, comparison: str) -> bool:
    if comparison == "gte":
        return live >= target
    if comparison == "lte":
        return live <= target
    # eq: exact float equality (use for integer/ratio KRs only)
    return live == target


def _logic_sub(lg: "Logic", live_raw: "float | None", trace_ref: "str | None") -> dict:
    """Build the embedded logic sub-object for a KR response.

    The sub-object gives the renderer everything it needs to display the
    metric name/version, a live preview value, and a trace link — without
    a separate N+1 request per KR.
    """
    return {
        "id":           lg.id,
        "name":         lg.name,
        "version":      f"v{lg.version}",
        "usage_count":  0,      # per-report aggregation not needed here
        "current_value": live_raw,
        "source_name":  None,   # PostHog / MySQL label; not computed per-KR
        "trace_ref":    trace_ref,
        "computed_at":  None,
    }


def compute_kr(
    conn: sqlite3.Connection,
    kr: dict,
    days: int = _DEFAULT_DAYS,
) -> dict:
    """Compute live value, status, progress, gap, trace_ref, and logic for one KR.

    Returns a dict merging the KR fields with computed fields:
      - live_value:  formatted string (matches Logic fmt) or None
      - live_raw:    raw float or None
      - status:      "ahead" | "behind" | "stale" | "draft"
      - progress:    float 0..1
      - gap:         float or None (live_raw - target)
      - trace_ref:   the formula string from build_trace (the trust identity)
      - task_count:  int — tasks in task_links linked to the same logic_id
      - logic:       embedded BoundLogic sub-object or None (for renderer display)
      - spark:       always [] — per-KR historical series not computed server-side

    The stale-gate: a compute failure NEVER raises out.  It produces status
    "stale" with live_value=None so the UI can render the error state.
    A missing logic_id (empty string) → status "draft".
    """
    logic_id = kr.get("logic_id", "")
    target = kr.get("target")
    comparison = kr.get("comparison", "gte")
    task_count = store_db.count_tasks_for_logic(conn, logic_id) if logic_id else 0

    # Draft: no Logic bound yet.
    if not logic_id:
        return {
            **kr,
            "live_value": None,
            "live_raw": None,
            "status": "draft",
            "progress": 0.0,
            "gap": None,
            "trace_ref": None,
            "task_count": task_count,
            "logic": None,
            "spark": [],
        }

    lg = store_db.get_logic(conn, logic_id)
    if lg is None:
        # Logic was deleted after the KR was created.
        return {
            **kr,
            "live_value": None,
            "live_raw": None,
            "status": "stale",
            "progress": 0.0,
            "gap": None,
            "trace_ref": None,
            "task_count": task_count,
            "logic": None,
            "spark": [],
        }

    start, end = _period_days(days)
    resolve = _resolve(conn)
    try:
        live_raw, _ = compute_value(conn, lg, start, end, resolve)
        trace = build_trace(conn, lg, start, end, resolve)
        trace_ref = trace.get("formula")
        live_value = fmt_value(live_raw, lg.fmt)
    except Exception:
        return {
            **kr,
            "live_value": None,
            "live_raw": None,
            "status": "stale",
            "progress": 0.0,
            "gap": None,
            "trace_ref": None,
            "task_count": task_count,
            "logic": _logic_sub(lg, None, None),
            "spark": [],
        }

    if live_raw is None or target is None:
        return {
            **kr,
            "live_value": live_value,
            "live_raw": live_raw,
            "status": "stale",
            "progress": 0.0,
            "gap": None,
            "trace_ref": trace_ref,
            "task_count": task_count,
            "logic": _logic_sub(lg, live_raw, trace_ref),
            "spark": [],
        }

    meets = _meets(live_raw, target, comparison)
    status = "ahead" if meets else "behind"
    progress = _progress(live_raw, target, comparison)
    gap = live_raw - target

    return {
        **kr,
        "live_value": live_value,
        "live_raw": live_raw,
        "status": status,
        "progress": progress,
        "gap": gap,
        "trace_ref": trace_ref,
        "task_count": task_count,
        "logic": _logic_sub(lg, live_raw, trace_ref),
        "spark": [],
    }


def compute_objective_tree(
    conn: sqlite3.Connection,
    period: str | None = None,
    days: int = _DEFAULT_DAYS,
) -> list[dict]:
    """Return the full OKR tree: objectives → KRs with live values.

    Each objective carries:
      - all its own fields
      - krs: list of computed KR dicts (from compute_kr)
      - on_track_count: KRs with status "ahead"
      - total_kr_count: all KRs (including draft/stale)
      - aggregate_progress: mean progress across KRs with a numeric progress value
        (draft and stale KRs are excluded from the aggregate to avoid diluting it)

    Period filter: when supplied, only KRs whose period == period are included.
    Objectives with no matching KRs are still included (empty krs list).
    """
    objectives = store_db.list_objectives(conn)
    result = []
    for obj in objectives:
        krs_raw = store_db.list_key_results(conn, objective_id=obj["id"])
        # Period filter applies to KRs, not Objectives.
        if period:
            krs_raw = [k for k in krs_raw if k["period"] == period]
        computed_krs = [compute_kr(conn, kr, days=days) for kr in krs_raw]
        on_track = sum(1 for k in computed_krs if k["status"] == "ahead")
        # Aggregate progress: only KRs that produced a numeric progress value.
        numeric_progresses = [
            k["progress"]
            for k in computed_krs
            if k["status"] in ("ahead", "behind")
        ]
        agg_progress = (
            sum(numeric_progresses) / len(numeric_progresses)
            if numeric_progresses
            else 0.0
        )
        result.append({
            **obj,
            "krs": computed_krs,
            "on_track_count": on_track,
            "total_kr_count": len(computed_krs),
            "aggregate_progress": round(agg_progress, 4),
        })
    return result
