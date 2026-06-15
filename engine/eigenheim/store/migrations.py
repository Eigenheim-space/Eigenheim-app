"""Migration ledger: _MIGRATIONS list, run_migrations, and per-migration helpers.

Append-only: add to the end of _MIGRATIONS, never reorder or edit existing entries.
Each callable in _MIGRATIONS receives a sqlite3.Connection and must be idempotent."""
from __future__ import annotations

import sqlite3

from ..catalog import LOGIC as SEED_LOGIC
from .catalog_sync import _catalog_content_hash


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    # PRAGMA table_info returns (cid, name, type, notnull, dflt_value, pk).
    # Use positional index 1 for the column name so this works regardless of
    # whether the connection has row_factory = sqlite3.Row set.
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == column for r in rows)


def _migration_3_add_catalog_cols(conn: sqlite3.Connection) -> None:
    """Add content_hash and source columns to the logic table (migration 3).

    On a fresh install the SCHEMA already contains these columns, so we skip the
    ALTER TABLE when the column already exists (idempotent guard). The back-fill
    always runs: it is a no-op when the columns are correctly populated."""
    if not _has_column(conn, "logic", "content_hash"):
        conn.execute("ALTER TABLE logic ADD COLUMN content_hash TEXT")
    if not _has_column(conn, "logic", "source"):
        conn.execute("ALTER TABLE logic ADD COLUMN source TEXT NOT NULL DEFAULT 'bundled'")
    # Back-fill: rows whose id exists in the bundled catalog get their canonical
    # hash and keep source='bundled'. All other rows (user-created ids) flip to
    # source='user' so the sync loop will not overwrite them.
    bundled_ids = set(SEED_LOGIC.keys())
    for lg in SEED_LOGIC.values():
        conn.execute(
            "UPDATE logic SET content_hash=?, source='bundled' WHERE id=?",
            (_catalog_content_hash(lg), lg.id),
        )
    # Any row not in the bundled catalog was created by the user.
    if bundled_ids:
        placeholders = ",".join("?" * len(bundled_ids))
        conn.execute(
            f"UPDATE logic SET source='user' WHERE id NOT IN ({placeholders})",
            list(bundled_ids),
        )


def _migration_6_draft_audit(conn: sqlite3.Connection) -> None:
    """Add draft/promote columns to logic_versions and create logic_audit.

    Idempotent: ALTER TABLE is skipped when the column already exists (fresh
    install already has the columns from SCHEMA). Back-fill sets all existing
    rows to status='live', source='user' so they behave as before."""
    if not _has_column(conn, "logic_versions", "status"):
        conn.execute("ALTER TABLE logic_versions ADD COLUMN status TEXT NOT NULL DEFAULT 'live'")
    if not _has_column(conn, "logic_versions", "source"):
        conn.execute("ALTER TABLE logic_versions ADD COLUMN source TEXT NOT NULL DEFAULT 'user'")
    if not _has_column(conn, "logic_versions", "rationale"):
        conn.execute("ALTER TABLE logic_versions ADD COLUMN rationale TEXT NOT NULL DEFAULT ''")
    # Back-fill: bundled-seed rows should keep status=live; source set to their
    # existing logic.source value ('bundled' | 'user'). The existing logic table
    # already has a source column. We set logic_versions.source = logic.source
    # so the provenance is consistent.
    conn.executescript("""
        UPDATE logic_versions SET status = 'live' WHERE status = '';
        UPDATE logic_versions SET source = (
            SELECT source FROM logic WHERE logic.id = logic_versions.logic_id
        ) WHERE source = '' OR source = 'user';
    """)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS logic_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event TEXT NOT NULL,
            logic_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            spec_hash TEXT NOT NULL,
            prev_audit_hash TEXT NOT NULL DEFAULT '',
            audit_hash TEXT NOT NULL,
            rationale TEXT NOT NULL DEFAULT '',
            actor TEXT NOT NULL DEFAULT '',
            ts TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_logic_audit_logic ON logic_audit(logic_id, version);
    """)


# Each entry is a callable that receives a sqlite3.Connection.
# Append to the end; never edit or reorder existing entries.
# The list index + 1 is the target user_version after that migration runs.
_MIGRATIONS: list = [
    # Migration 1 (2026-06-13): initial schema is already created by ensure_schema.
    # This is a no-op placeholder so existing installs are stamped at version 1.
    lambda conn: None,
    # Migration 2 (2026-06-13): MCP API key table (1.1).
    # Scopes are stored as a JSON array TEXT so future write scopes slot in without
    # another schema change.  key_hash = HMAC-SHA256(raw_key); the raw key is never
    # persisted.  revoked is an INTEGER flag (0/1) rather than a nullable timestamp
    # so the WHERE clause stays simple.
    lambda conn: conn.executescript("""
        CREATE TABLE IF NOT EXISTS mcp_keys (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            scopes_json  TEXT NOT NULL DEFAULT '["read"]',
            key_hash     TEXT NOT NULL UNIQUE,
            created_at   TEXT NOT NULL,
            last_used_at TEXT,
            revoked      INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS ix_mcp_keys_hash ON mcp_keys(key_hash);
    """),
    # Migration 3 (2026-06-13): content_hash + source columns on logic (1.5).
    lambda conn: _migration_3_add_catalog_cols(conn),
    # Migration 4 (2026-06-14): task-tracker tables.
    lambda conn: conn.executescript("""
        CREATE TABLE IF NOT EXISTS task_connections (
            id          TEXT PRIMARY KEY,
            tracker     TEXT NOT NULL,
            base_url    TEXT NOT NULL DEFAULT '',
            workspace   TEXT NOT NULL DEFAULT '',
            project_key TEXT NOT NULL DEFAULT '',
            status      TEXT NOT NULL DEFAULT 'pending',
            source      TEXT NOT NULL DEFAULT 'user',
            created_at  TEXT NOT NULL,
            last_sync_at TEXT
        );

        CREATE TABLE IF NOT EXISTS tasks (
            external_id   TEXT NOT NULL,
            tracker       TEXT NOT NULL,
            title         TEXT NOT NULL DEFAULT '',
            status        TEXT NOT NULL DEFAULT '',
            assignee      TEXT NOT NULL DEFAULT '',
            url           TEXT NOT NULL DEFAULT '',
            updated_at    TEXT NOT NULL DEFAULT '',
            raw_json      TEXT NOT NULL DEFAULT '{}',
            last_sync_at  TEXT,
            PRIMARY KEY (external_id, tracker)
        );
        CREATE INDEX IF NOT EXISTS ix_tasks_tracker ON tasks(tracker);
        CREATE INDEX IF NOT EXISTS ix_tasks_status  ON tasks(tracker, status);

        CREATE TABLE IF NOT EXISTS task_links (
            id          TEXT PRIMARY KEY,
            external_id TEXT NOT NULL,
            tracker     TEXT NOT NULL,
            logic_id    TEXT NOT NULL,
            okr_ref     TEXT NOT NULL DEFAULT '',
            kr_ref      TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ix_task_links_unique
            ON task_links(external_id, tracker, logic_id);
        CREATE INDEX IF NOT EXISTS ix_task_links_logic ON task_links(logic_id);
    """),
    # Migration 5 (2026-06-14): OKR / Goals tables.
    lambda conn: conn.executescript("""
        CREATE TABLE IF NOT EXISTS objectives (
            id         TEXT PRIMARY KEY,
            title      TEXT NOT NULL,
            period     TEXT NOT NULL DEFAULT '',
            source     TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS key_results (
            id           TEXT PRIMARY KEY,
            objective_id TEXT NOT NULL,
            name         TEXT NOT NULL,
            logic_id     TEXT NOT NULL DEFAULT '',
            target       REAL,
            comparison   TEXT NOT NULL DEFAULT 'gte',
            period       TEXT NOT NULL DEFAULT '',
            created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_kr_objective ON key_results(objective_id);
        CREATE INDEX IF NOT EXISTS ix_kr_logic ON key_results(logic_id);
    """),
    # Migration 6 (2026-06-14): draft/promote gate + hash-chain audit (Vector 3).
    lambda conn: _migration_6_draft_audit(conn),
    # Migration 7 (2026-06-14): Hypothesis log (command-center surface 1).
    lambda conn: conn.executescript("""
        CREATE TABLE IF NOT EXISTS hypotheses (
            id          TEXT PRIMARY KEY,
            statement   TEXT NOT NULL,
            logic_id    TEXT NOT NULL DEFAULT '',
            evidence    TEXT NOT NULL DEFAULT '',
            status      TEXT NOT NULL DEFAULT 'proposed',
            source      TEXT NOT NULL DEFAULT 'user',
            created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_hypotheses_status   ON hypotheses(status);
        CREATE INDEX IF NOT EXISTS ix_hypotheses_logic_id ON hypotheses(logic_id);
    """),
    # Migration 8 (2026-06-14): Decision log (command-center surface 2).
    lambda conn: conn.executescript("""
        CREATE TABLE IF NOT EXISTS decisions (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            rationale   TEXT NOT NULL DEFAULT '',
            status      TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS decision_metrics (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            decision_id     TEXT NOT NULL,
            logic_id        TEXT NOT NULL,
            captured_value  REAL,
            trace_ref       TEXT NOT NULL DEFAULT '',
            captured_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_decision_metrics_decision
            ON decision_metrics(decision_id);
        CREATE INDEX IF NOT EXISTS ix_decision_metrics_logic
            ON decision_metrics(logic_id);
    """),
    # Migration 9 (2026-06-14): RICE prioritization (command-center surface 3).
    lambda conn: conn.executescript("""
        CREATE TABLE IF NOT EXISTS rice_items (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            reach_logic_id  TEXT NOT NULL DEFAULT '',
            reach_manual    REAL,
            impact          REAL NOT NULL DEFAULT 1.0,
            confidence      REAL NOT NULL DEFAULT 1.0,
            effort          REAL NOT NULL DEFAULT 1.0,
            source          TEXT NOT NULL DEFAULT 'user',
            created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_rice_items_logic
            ON rice_items(reach_logic_id);
    """),
    # Migration 10 (2026-06-15): Persisted chat conversation history.
    # LOCAL ONLY — these tables are never included in any export or sync bundle.
    lambda conn: conn.executescript("""
        CREATE TABLE IF NOT EXISTS conversations (
            id         TEXT PRIMARY KEY,
            title      TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_conversations_updated
            ON conversations(updated_at DESC);

        CREATE TABLE IF NOT EXISTS messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            role            TEXT NOT NULL,
            content         TEXT NOT NULL,
            meta_json       TEXT,
            created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_messages_conv
            ON messages(conversation_id, id ASC);
    """),
]


def run_migrations(conn: sqlite3.Connection) -> int:
    """Run any pending migrations and return the final user_version."""
    (current,) = conn.execute("PRAGMA user_version").fetchone()
    for version, migrate in enumerate(_MIGRATIONS, start=1):
        if version <= current:
            continue
        migrate(conn)
        conn.execute(f"PRAGMA user_version = {version}")
        conn.commit()
        current = version
    return current
