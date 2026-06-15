"""Chat conversation persistence (LOCAL ONLY).

Transcripts are stored in the local SQLite database and are never included in
any diagnostic export, log bundle, sync operation, or external API response.
Reports / CSV export code must not pull from these tables.
"""
from __future__ import annotations

import json
import sqlite3
import uuid

from ._helpers import _now


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _conv_id() -> str:
    return str(uuid.uuid4())


# ─── Conversations ────────────────────────────────────────────────────────────

def list_conversations(conn: sqlite3.Connection) -> list[dict]:
    """Return all conversations, most-recently-updated first.
    Secondary sort by rowid DESC so ties are deterministic (newer insert wins)."""
    rows = conn.execute(
        "SELECT id, title, created_at, updated_at FROM conversations"
        " ORDER BY updated_at DESC, rowid DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def get_conversation(conn: sqlite3.Connection, conversation_id: str) -> dict | None:
    """Return a conversation row with its messages, or None if not found."""
    row = conn.execute(
        "SELECT id, title, created_at, updated_at FROM conversations WHERE id=?",
        (conversation_id,),
    ).fetchone()
    if not row:
        return None
    messages = conn.execute(
        "SELECT id, conversation_id, role, content, meta_json, created_at"
        " FROM messages WHERE conversation_id=? ORDER BY id ASC",
        (conversation_id,),
    ).fetchall()
    return {
        "id": row["id"],
        "title": row["title"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "messages": [dict(m) for m in messages],
    }


def create_conversation(conn: sqlite3.Connection, title: str) -> dict:
    """Insert a new conversation and return it."""
    cid = _conv_id()
    now = _now()
    conn.execute(
        "INSERT INTO conversations(id, title, created_at, updated_at) VALUES (?,?,?,?)",
        (cid, title, now, now),
    )
    conn.commit()
    return {"id": cid, "title": title, "created_at": now, "updated_at": now}


def append_message(
    conn: sqlite3.Connection,
    conversation_id: str,
    role: str,
    content: str,
    meta: dict | None = None,
) -> dict:
    """Append a message to a conversation and touch updated_at. Returns the new row."""
    now = _now()
    meta_json = json.dumps(meta) if meta else None
    cursor = conn.execute(
        "INSERT INTO messages(conversation_id, role, content, meta_json, created_at)"
        " VALUES (?,?,?,?,?)",
        (conversation_id, role, content, meta_json, now),
    )
    msg_id = cursor.lastrowid
    conn.execute(
        "UPDATE conversations SET updated_at=? WHERE id=?", (now, conversation_id)
    )
    conn.commit()
    return {
        "id": msg_id,
        "conversation_id": conversation_id,
        "role": role,
        "content": content,
        "meta_json": meta_json,
        "created_at": now,
    }


def rename_conversation(
    conn: sqlite3.Connection, conversation_id: str, title: str
) -> dict | None:
    """Rename a conversation. Returns the updated row, or None if not found."""
    row = conn.execute(
        "SELECT id FROM conversations WHERE id=?", (conversation_id,)
    ).fetchone()
    if not row:
        return None
    now = _now()
    conn.execute(
        "UPDATE conversations SET title=?, updated_at=? WHERE id=?",
        (title, now, conversation_id),
    )
    conn.commit()
    row2 = conn.execute(
        "SELECT id, title, created_at, updated_at FROM conversations WHERE id=?",
        (conversation_id,),
    ).fetchone()
    return dict(row2)


def delete_conversation(conn: sqlite3.Connection, conversation_id: str) -> bool:
    """Delete a conversation and cascade-delete its messages. Returns True if deleted."""
    row = conn.execute(
        "SELECT id FROM conversations WHERE id=?", (conversation_id,)
    ).fetchone()
    if not row:
        return False
    # Cascade manually — no FK cascade in SQLite without PRAGMA foreign_keys = ON.
    conn.execute("DELETE FROM messages WHERE conversation_id=?", (conversation_id,))
    conn.execute("DELETE FROM conversations WHERE id=?", (conversation_id,))
    conn.commit()
    return True
