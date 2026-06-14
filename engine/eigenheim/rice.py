"""RICE score computation.

Eigenheim differentiator: Reach is pulled from a LIVE Logic value (with its
trace ref as provenance), not a PM's guess.  When a Logic is bound, the score
inherits the same deterministic, versioned compute chain that every report uses.

Score formula:
    score = (Reach × Impact × Confidence) / Effort

Reach resolution:
    If reach_logic_id is non-empty and the Logic exists and computes successfully,
    Reach = that Logic's live value and reach_trace_ref carries the formula string.
    Otherwise (no Logic bound, Logic deleted, or compute failure):
      - If reach_logic_id is empty: Reach = reach_manual (may be None).
      - If reach_logic_id is set but compute fails: status = 'stale', score = None.

Effort-zero guard:
    Effort == 0 → score = None, status = 'stale' (division by zero blocked).

Engine never imports an LLM client.  This module is deterministic.
"""
from __future__ import annotations

import sqlite3
from datetime import timedelta

from . import db, store_db
from .catalog import Logic
from .compute import build_trace, compute_value


_DEFAULT_DAYS = 30


def _period_days(days: int = _DEFAULT_DAYS) -> tuple[str, str]:
    end = db.PERIOD_END
    start = max(end - timedelta(days=days), db.PERIOD_START)
    return start.strftime("%Y-%m-%d %H:%M:%S"), end.strftime("%Y-%m-%d %H:%M:%S")


def _resolve(conn: sqlite3.Connection):
    def _r(lid: str) -> Logic | None:
        return store_db.get_logic(conn, lid)
    return _r


def compute_rice_item(
    conn: sqlite3.Connection,
    item: dict,
    days: int = _DEFAULT_DAYS,
) -> dict:
    """Compute the RICE score for one item dict (from store_db.get_rice_item).

    Returned dict adds:
      - reach_value:     float or None — the resolved Reach
      - reach_trace_ref: str or None — formula from the bound Logic's trace
                         (the trust identity); None when reach is manual or stale
      - score:           float or None — (Reach × Impact × Confidence) / Effort
                         None when Effort == 0 or Reach cannot be resolved
      - status:          'live'  — score was computed with a metric-backed Reach
                         'manual' — score was computed with reach_manual
                         'stale' — compute failed (Logic missing, compute error,
                                   Effort == 0, or Reach is None)
    """
    effort: float = item.get("effort") or 0.0
    impact: float = item.get("impact") or 0.0
    confidence: float = item.get("confidence") or 0.0
    reach_logic_id: str = item.get("reach_logic_id") or ""
    reach_manual = item.get("reach_manual")

    # Effort-zero guard: score is undefined when Effort == 0.
    if effort == 0.0:
        return {
            **item,
            "reach_value":     None,
            "reach_trace_ref": None,
            "score":           None,
            "status":          "stale",
        }

    # --- Reach resolution ---
    if reach_logic_id:
        lg = store_db.get_logic(conn, reach_logic_id)
        if lg is None:
            # Logic was deleted after the item was created → stale.
            return {
                **item,
                "reach_value":     None,
                "reach_trace_ref": None,
                "score":           None,
                "status":          "stale",
            }
        start, end = _period_days(days)
        resolve = _resolve(conn)
        try:
            reach_value, _ = compute_value(conn, lg, start, end, resolve)
            trace = build_trace(conn, lg, start, end, resolve)
            reach_trace_ref: str | None = trace.get("formula")
        except Exception:
            # Compute failure → stale, not raised.
            return {
                **item,
                "reach_value":     None,
                "reach_trace_ref": None,
                "score":           None,
                "status":          "stale",
            }

        if reach_value is None:
            return {
                **item,
                "reach_value":     None,
                "reach_trace_ref": reach_trace_ref,
                "score":           None,
                "status":          "stale",
            }

        score = (reach_value * impact * confidence) / effort
        return {
            **item,
            "reach_value":     reach_value,
            "reach_trace_ref": reach_trace_ref,
            "score":           score,
            "status":          "live",
        }

    # No Logic bound: use reach_manual.
    if reach_manual is None:
        return {
            **item,
            "reach_value":     None,
            "reach_trace_ref": None,
            "score":           None,
            "status":          "stale",
        }

    score = (reach_manual * impact * confidence) / effort
    return {
        **item,
        "reach_value":     reach_manual,
        "reach_trace_ref": None,
        "score":           score,
        "status":          "manual",
    }


def compute_rice_list(
    conn: sqlite3.Connection,
    days: int = _DEFAULT_DAYS,
) -> list[dict]:
    """Return all RICE items sorted by computed score descending.

    Items with no score (stale) sort to the bottom.
    """
    items = store_db.list_rice_items(conn)
    computed = [compute_rice_item(conn, item, days=days) for item in items]
    # Sort: scored items first (highest score first), then stale/manual-None items.
    computed.sort(
        key=lambda x: (x["score"] is None, -(x["score"] or 0.0))
    )
    return computed
