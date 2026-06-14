"""SQLite online backup and pruning."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def backup(conn: sqlite3.Connection, backup_dir: Path | str, keep_n: int = 5) -> Path:
    """Write an online SQLite backup to backup_dir and prune old copies.

    Uses sqlite3.Connection.backup() (same as `.backup` in the sqlite3 CLI),
    which is safe to call while the DB is live, does not block readers, and
    produces a consistent snapshot even in WAL mode.

    Returns the path of the new backup file."""
    d = Path(backup_dir)
    d.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
    dest = d / f"eigenheim_{stamp}.db"
    dst_conn = sqlite3.connect(str(dest))
    try:
        conn.backup(dst_conn)
    finally:
        dst_conn.close()
    # Prune: keep the N most recent backups, delete the rest.
    existing = sorted(d.glob("eigenheim_*.db"), key=lambda p: p.name)
    for old in existing[: max(0, len(existing) - keep_n)]:
        old.unlink(missing_ok=True)
    return dest
