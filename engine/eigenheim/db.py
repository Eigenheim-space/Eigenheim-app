"""SQLite store (WAL) + a deterministic, procedurally-generated event seed.

The seed uses no RNG: every event is derived from the user index by fixed
integer math, so the database, and therefore every computed metric, is
byte-identical on every machine and every run. That is the whole product
promise (P1: no lies, deterministic), exercised by the golden test.
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Fixed analysis window the seed lives in.
PERIOD_START = datetime(2026, 5, 1, tzinfo=timezone.utc)
PERIOD_END = datetime(2026, 5, 31, 23, 59, 59, tzinfo=timezone.utc)
N_SIGNUPS = 12418

_DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "eigenheim.db"


def _knuth(i: int) -> int:
    """Deterministic 32-bit hash of a user index (Knuth multiplicative)."""
    return (i * 2654435761) & 0xFFFFFFFF


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _gen_events():
    """Yield (user_id, name, ts) rows, fully determined by the user index."""
    window_days = 30
    for i in range(N_SIGNUPS):
        h = _knuth(i)
        uid = f"u{i:06d}"
        signup_day = i % window_days
        signup = PERIOD_START + timedelta(days=signup_day, hours=(i % 24), minutes=(i % 60))
        yield (uid, "signup", _iso(signup))

        # page_view: 1..4 views, most users
        for v in range((h % 4) + 1):
            yield (uid, "page_view", _iso(signup + timedelta(hours=v + 1)))

        # first_report within 0..6 days for ~31% of users (activation)
        if (h % 1000) < 313:
            gap = (h >> 8) % 7  # 0..6 days <= 7d window
            fr = signup + timedelta(days=gap, hours=2)
            if fr <= PERIOD_END:
                yield (uid, "first_report", _iso(fr))

        # session_start at signup+7d for ~41% (D7 retention)
        if ((h >> 12) % 1000) < 415:
            d7 = signup + timedelta(days=7, hours=(h % 10))
            if d7 <= PERIOD_END:
                yield (uid, "session_start", _iso(d7))

        # a late session in the trailing 30d for MAU (~ everyone with index pattern)
        if ((h >> 20) % 100) < 78:
            late = PERIOD_END - timedelta(days=(i % 25), hours=(i % 12))
            yield (uid, "session_start", _iso(late))


def connect(path: str | os.PathLike | None = None) -> sqlite3.Connection:
    p = Path(path) if path else _DEFAULT_DB
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_and_seed(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS events (
            id      INTEGER PRIMARY KEY,
            user_id TEXT NOT NULL,
            name    TEXT NOT NULL,
            ts      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_events_name_ts ON events(name, ts);
        CREATE INDEX IF NOT EXISTS ix_events_user ON events(user_id, name, ts);
        """
    )
    (count,) = conn.execute("SELECT count(*) FROM events").fetchone()
    if count == 0:
        conn.executemany("INSERT INTO events(user_id, name, ts) VALUES (?,?,?)", _gen_events())
        conn.commit()
