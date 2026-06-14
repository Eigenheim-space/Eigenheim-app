"""Phase 0 correctness tests.

0.1 — MCP parity: a Logic/Report created over the REST path (store_db) must
      be visible to the MCP list_reports tool reading the same DB.

0.2 — Stale gate: adapters._replace_events aborts before DELETE on empty input;
      the reports endpoint emits 'stale' when a snapshot ages past 2× its frequency.

0.3 — Migrations: run_migrations stamps user_version and is idempotent;
      backup writes a readable copy and prunes to keep_n."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile

import pytest

from eigenheim import db, store_db, adapters
from eigenheim.catalog import Input
from eigenheim import app as appmod
from eigenheim.mcp_auth import create_mcp_key, revoke_mcp_key


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def _full_conn() -> sqlite3.Connection:
    """In-memory connection with both the events table and the store schema."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    db.init_and_seed(c)
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)
    return c


# ─────────────────────────────────────────────────────────────
# 0.1 — MCP parity
# ─────────────────────────────────────────────────────────────

def test_mcp_list_reports_sees_rest_created_logic_and_report():
    """REST path creates a Logic + Report in store_db; MCP list_reports returns it."""
    from eigenheim import store_db as sdb
    from eigenheim.mcp_server import list_reports, _conn as mcp_conn

    # Use the real persisted DB that the MCP server has already opened.
    # Create a distinct Logic and Report in that same connection.
    lid = "_parity_test_logic"
    rid = "_parity_test_report"

    # Clean up any leftover from a previous run.
    mcp_conn.execute("DELETE FROM report_logic WHERE report_id=?", (rid,))
    mcp_conn.execute("DELETE FROM reports WHERE id=?", (rid,))
    mcp_conn.execute("DELETE FROM logic_versions WHERE logic_id=?", (lid,))
    mcp_conn.execute("DELETE FROM logic WHERE id=?", (lid,))
    mcp_conn.commit()

    # Create a temporary MCP key against the real mcp_conn for this test.
    test_raw_key, test_key_id = create_mcp_key(mcp_conn, "_parity_test_key", scopes=["read"])

    try:
        sdb.upsert_logic(mcp_conn, lid, "Parity test", "", "number",
                         (Input("m", "mau", {"days": 30}),), "m", "test")
        sdb.create_report(mcp_conn, rid, "Parity Report", 30, [lid])

        result = list_reports(key=test_raw_key)
        reports_list = result.get("reports", result) if isinstance(result, dict) else result
        ids = [r["id"] for r in reports_list]
        assert rid in ids, f"REST-created report '{rid}' not found in MCP list_reports: {ids}"

        # The matching entry must have at least one metric computed.
        entry = next(r for r in reports_list if r["id"] == rid)
        assert entry["metrics"], "MCP list_reports returned no metrics for the parity report"
        assert entry["metrics"][0]["id"] == lid
    finally:
        revoke_mcp_key(mcp_conn, test_key_id)
        mcp_conn.execute("DELETE FROM mcp_keys WHERE id=?", (test_key_id,))
        mcp_conn.execute("DELETE FROM report_logic WHERE report_id=?", (rid,))
        mcp_conn.execute("DELETE FROM reports WHERE id=?", (rid,))
        mcp_conn.execute("DELETE FROM logic_versions WHERE logic_id=?", (lid,))
        mcp_conn.execute("DELETE FROM logic WHERE id=?", (lid,))
        mcp_conn.commit()


# ─────────────────────────────────────────────────────────────
# 0.2 — Stale gate (adapters)
# ─────────────────────────────────────────────────────────────

def test_replace_events_aborts_on_empty():
    """_replace_events must raise AdapterError before touching the events table."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE events (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, ts TEXT)")
    c.execute("INSERT INTO events(user_id, name, ts) VALUES ('u1','signup','2026-05-01 10:00:00')")
    c.commit()

    with pytest.raises(adapters.AdapterError):
        adapters._replace_events(c, [])

    # The existing row must still be there.
    count = c.execute("SELECT count(*) FROM events").fetchone()[0]
    assert count == 1, "existing events were deleted despite an empty-rows abort"


def test_snap_status_live_when_fresh():
    snap = {"collected_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"), "frequency": "24h"}
    assert appmod._snap_status(snap) == "live"


def test_snap_status_stale_when_old():
    old = (datetime.now(timezone.utc) - timedelta(hours=50)).strftime("%Y-%m-%d %H:%M:%S")
    snap = {"collected_at": old, "frequency": "24h"}
    assert appmod._snap_status(snap) == "stale"


def test_snap_status_collecting_when_no_snap():
    assert appmod._snap_status(None) == "collecting"


# ─────────────────────────────────────────────────────────────
# 0.3 — Migrations + backups
# ─────────────────────────────────────────────────────────────

def test_run_migrations_stamps_user_version():
    c = _full_conn()
    (v_before,) = c.execute("PRAGMA user_version").fetchone()
    final = store_db.run_migrations(c)
    (v_after,) = c.execute("PRAGMA user_version").fetchone()
    assert v_after == len(store_db._MIGRATIONS)
    assert final == v_after


def test_run_migrations_is_idempotent():
    c = _full_conn()
    v1 = store_db.run_migrations(c)
    v2 = store_db.run_migrations(c)
    assert v1 == v2


def test_backup_creates_readable_copy():
    c = _full_conn()
    with tempfile.TemporaryDirectory() as d:
        dest = store_db.backup(c, d, keep_n=5)
        assert dest.exists()
        # The backup must be a valid SQLite file with the same tables.
        bconn = sqlite3.connect(str(dest))
        tables = {r[0] for r in bconn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        bconn.close()
        assert "logic" in tables
        assert "reports" in tables


def test_backup_prunes_to_keep_n():
    c = _full_conn()
    with tempfile.TemporaryDirectory() as d:
        for _ in range(7):
            store_db.backup(c, d, keep_n=3)
        remaining = list(Path(d).glob("eigenheim_*.db"))
        assert len(remaining) == 3, f"expected 3 backups, found {len(remaining)}"
