"""Chat conversation persistence tests (C1–C6).

Coverage:
  C1  — schema: conversations + messages tables exist after migrations.
  C2  — create_conversation / list_conversations round-trip; list is ordered
         most-recently-updated first.
  C3  — get_conversation returns conversation with messages (empty then populated).
  C4  — append_message: message appears in get_conversation; updated_at is bumped.
  C5  — rename_conversation: title changes; returns None for missing id.
  C6  — delete_conversation: cascades messages; delete of missing id returns False.
"""
from __future__ import annotations

import sqlite3
import time

import pytest

from eigenheim import db as _db
from eigenheim import store_db
from eigenheim.store.chat_repo import (
    append_message,
    create_conversation,
    delete_conversation,
    get_conversation,
    list_conversations,
    rename_conversation,
)


# ─────────────────────────────────────────────────────────────────────────────
# Helper
# ─────────────────────────────────────────────────────────────────────────────

def _chat_conn() -> sqlite3.Connection:
    """In-memory DB with full schema + all migrations (includes migration 10)."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    _db.init_and_seed(c)
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)
    store_db.run_migrations(c)
    return c


# ─────────────────────────────────────────────────────────────────────────────
# C1 — schema
# ─────────────────────────────────────────────────────────────────────────────

def test_c1_tables_exist():
    conn = _chat_conn()
    tables = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    assert "conversations" in tables
    assert "messages" in tables


# ─────────────────────────────────────────────────────────────────────────────
# C2 — create / list
# ─────────────────────────────────────────────────────────────────────────────

def test_c2_create_and_list():
    conn = _chat_conn()
    assert list_conversations(conn) == []

    c1 = create_conversation(conn, "First chat")
    assert c1["title"] == "First chat"
    assert c1["id"]
    assert c1["created_at"] == c1["updated_at"]

    c2 = create_conversation(conn, "Second chat")

    rows = list_conversations(conn)
    assert len(rows) == 2
    # Most recently created (c2) should appear first since updated_at is later.
    assert rows[0]["id"] == c2["id"]
    assert rows[1]["id"] == c1["id"]


# ─────────────────────────────────────────────────────────────────────────────
# C3 — get_conversation
# ─────────────────────────────────────────────────────────────────────────────

def test_c3_get_returns_none_for_missing():
    conn = _chat_conn()
    assert get_conversation(conn, "does-not-exist") is None


def test_c3_get_empty_messages():
    conn = _chat_conn()
    c = create_conversation(conn, "Empty chat")
    detail = get_conversation(conn, c["id"])
    assert detail is not None
    assert detail["id"] == c["id"]
    assert detail["messages"] == []


def test_c3_get_with_messages():
    conn = _chat_conn()
    c = create_conversation(conn, "Chat with messages")
    append_message(conn, c["id"], "user", "Hello?")
    append_message(conn, c["id"], "assistant", "Hi there!")

    detail = get_conversation(conn, c["id"])
    assert len(detail["messages"]) == 2
    assert detail["messages"][0]["role"] == "user"
    assert detail["messages"][0]["content"] == "Hello?"
    assert detail["messages"][1]["role"] == "assistant"
    assert detail["messages"][1]["content"] == "Hi there!"


# ─────────────────────────────────────────────────────────────────────────────
# C4 — append_message bumps updated_at
# ─────────────────────────────────────────────────────────────────────────────

def test_c4_append_bumps_updated_at():
    conn = _chat_conn()
    c = create_conversation(conn, "Timing test")
    original_updated = c["updated_at"]

    # Pause briefly so ISO timestamps differ (they're second-resolution).
    time.sleep(1.05)

    msg = append_message(conn, c["id"], "user", "A message")
    assert msg["conversation_id"] == c["id"]
    assert msg["role"] == "user"
    assert msg["content"] == "A message"
    assert msg["meta_json"] is None

    detail = get_conversation(conn, c["id"])
    assert detail["updated_at"] > original_updated


def test_c4_append_with_meta():
    conn = _chat_conn()
    c = create_conversation(conn, "Meta test")
    msg = append_message(conn, c["id"], "assistant", "Numbers!", meta={"verified": True})
    import json
    assert json.loads(msg["meta_json"]) == {"verified": True}


# ─────────────────────────────────────────────────────────────────────────────
# C5 — rename_conversation
# ─────────────────────────────────────────────────────────────────────────────

def test_c5_rename():
    conn = _chat_conn()
    c = create_conversation(conn, "Old title")
    updated = rename_conversation(conn, c["id"], "New title")
    assert updated is not None
    assert updated["title"] == "New title"


def test_c5_rename_missing_returns_none():
    conn = _chat_conn()
    assert rename_conversation(conn, "ghost-id", "Title") is None


# ─────────────────────────────────────────────────────────────────────────────
# C6 — delete_conversation + cascade
# ─────────────────────────────────────────────────────────────────────────────

def test_c6_delete_cascades_messages():
    conn = _chat_conn()
    c = create_conversation(conn, "To be deleted")
    append_message(conn, c["id"], "user", "First")
    append_message(conn, c["id"], "assistant", "Second")

    deleted = delete_conversation(conn, c["id"])
    assert deleted is True

    # Conversation gone
    assert get_conversation(conn, c["id"]) is None

    # Messages gone
    msgs = conn.execute(
        "SELECT count(*) FROM messages WHERE conversation_id=?", (c["id"],)
    ).fetchone()[0]
    assert msgs == 0

    # Not in list anymore
    assert list_conversations(conn) == []


def test_c6_delete_missing_returns_false():
    conn = _chat_conn()
    assert delete_conversation(conn, "ghost-id") is False


# ─────────────────────────────────────────────────────────────────────────────
# C7 — list ordering is by updated_at DESC
# ─────────────────────────────────────────────────────────────────────────────

def test_c7_list_ordered_by_updated_at():
    """Appending to an older conversation should move it to the top of the list."""
    conn = _chat_conn()
    c1 = create_conversation(conn, "Chat 1")
    time.sleep(1.05)
    c2 = create_conversation(conn, "Chat 2")

    # c2 is currently on top; touch c1 to move it
    time.sleep(1.05)
    append_message(conn, c1["id"], "user", "Wake up, c1")

    rows = list_conversations(conn)
    assert rows[0]["id"] == c1["id"], "c1 should be first after being touched"
    assert rows[1]["id"] == c2["id"]
