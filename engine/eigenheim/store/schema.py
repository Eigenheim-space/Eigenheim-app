"""Schema DDL, ensure_schema, and seed_defaults.

Leaf-level: imports from catalog and _helpers only."""
from __future__ import annotations

import sqlite3

from ..catalog import LOGIC as SEED_LOGIC, REPORTS as SEED_REPORTS
from ._helpers import _now, _inputs_to_json, _inputs_from_json


SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  meta_json       TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_messages_conv ON messages(conversation_id, id ASC);

CREATE TABLE IF NOT EXISTS logic (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, fmt TEXT NOT NULL,
  latest_version INTEGER NOT NULL,
  content_hash TEXT,
  source TEXT NOT NULL DEFAULT 'bundled'
);
CREATE TABLE IF NOT EXISTS logic_versions (
  logic_id TEXT NOT NULL, version INTEGER NOT NULL, inputs_json TEXT NOT NULL,
  expression TEXT NOT NULL, sha TEXT NOT NULL, validated TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'live',
  source TEXT NOT NULL DEFAULT 'user',
  rationale TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (logic_id, version)
);
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
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, period_days INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_logic (
  report_id TEXT NOT NULL, logic_id TEXT NOT NULL, ord INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT NOT NULL, collected_at TEXT NOT NULL,
  period_start TEXT NOT NULL, period_end TEXT NOT NULL, frequency TEXT
);
CREATE TABLE IF NOT EXISTS snapshot_metrics (
  snapshot_id INTEGER NOT NULL, logic_id TEXT NOT NULL, logic_version INTEGER NOT NULL,
  value REAL, fmt TEXT NOT NULL, trace_json TEXT NOT NULL, weeks_json TEXT NOT NULL, series_json TEXT NOT NULL
);
"""


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


def seed_defaults(conn: sqlite3.Connection) -> None:
    # Deferred import to avoid circular: catalog_sync -> schema -> catalog_sync.
    from .catalog_sync import _catalog_content_hash
    (n,) = conn.execute("SELECT count(*) FROM logic").fetchone()
    if n:
        return
    for lg in SEED_LOGIC.values():
        conn.execute(
            "INSERT INTO logic(id, name, description, fmt, latest_version, content_hash, source) VALUES (?,?,?,?,?,?,?)",
            (lg.id, lg.name, lg.description, lg.fmt, lg.version, _catalog_content_hash(lg), "bundled"),
        )
        conn.execute(
            "INSERT INTO logic_versions(logic_id, version, inputs_json, expression, sha, validated, created_at, status, source, rationale)"
            " VALUES (?,?,?,?,?,?,?,'live','bundled','')",
            (lg.id, lg.version, _inputs_to_json(lg.inputs), lg.expression, lg.sha, lg.validated, _now()),
        )
    for r in SEED_REPORTS.values():
        conn.execute("INSERT INTO reports(id, name, period_days, created_at) VALUES (?,?,?,?)", (r.id, r.name, r.period_days, _now()))
        for ord_, lid in enumerate(r.logic_ids):
            conn.execute("INSERT INTO report_logic(report_id, logic_id, ord) VALUES (?,?,?)", (r.id, lid, ord_))
    conn.commit()
