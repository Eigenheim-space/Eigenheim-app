"""A small in-process scheduler: recompute reports whose last snapshot is older
than its frequency. Asyncio-based (no extra dep); `tick` is testable directly.
Production would swap this for APScheduler per the plan; the due-logic is the same."""
from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone

from . import service, store_db

_FREQ_HOURS = {"1ч": 1, "4ч": 4, "6ч": 6, "12ч": 12, "24ч": 24, "7д": 168}


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)


def due_reports(conn: sqlite3.Connection, now: datetime) -> list[tuple[str, str]]:
    out = []
    for r in store_db.list_report_defs(conn):
        snap = store_db.latest_snapshot(conn, r.id)
        if not snap:
            continue  # never collected -> not on a schedule yet
        freq = snap["frequency"] or "24ч"
        if now - _parse(snap["collected_at"]) >= timedelta(hours=_FREQ_HOURS.get(freq, 24)):
            out.append((r.id, freq))
    return out


def tick(conn: sqlite3.Connection, now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    n = 0
    for rid, freq in due_reports(conn, now):
        service.collect_report(conn, rid, freq)
        n += 1
    return n


async def run(conn: sqlite3.Connection, interval_seconds: int = 300) -> None:
    while True:
        try:
            tick(conn)
        except Exception:  # noqa: BLE001 - the scheduler must never crash the app
            pass
        await asyncio.sleep(interval_seconds)
