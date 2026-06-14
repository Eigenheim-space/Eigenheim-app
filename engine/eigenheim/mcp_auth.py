"""MCP API key management: generation, HMAC-SHA256 storage, scopes, rate limit.

Key lifecycle:
  - generate_key()  returns (raw_key, key_id). Raw key is shown ONCE; only the
    HMAC-SHA256 hash is stored (no way to recover the plaintext from the DB).
  - Each key carries a `scopes` JSON array.  For v1 only `read` is shipped.
    Future write scopes (`logic:write`, `report:write`) slot in without a schema
    change: the column is already TEXT.
  - require_scope(conn, raw_key, scope) is called on every MCP tool dispatch.
    It is default-deny: an unknown key or a scope not in the key's scope list
    raises McpAuthError.
  - A leaky-bucket rate limiter is enforced per key (60 calls / minute by
    default). Excess calls raise McpRateLimitError.

DB table (added as migration 2 in store_db._MIGRATIONS):
  mcp_keys: id, name, scopes_json, key_hash, created_at, last_used_at, revoked

REST helpers (called from app.py):
  create_mcp_key, list_mcp_keys, revoke_mcp_key
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import time
from datetime import datetime, timezone


# ---- Errors ----------------------------------------------------------------

class McpAuthError(Exception):
    """Raised when a key is missing, revoked, or lacks the required scope."""


class McpRateLimitError(Exception):
    """Raised when a key exceeds its rate limit."""


# ---- Key format ------------------------------------------------------------

_PREFIX = "eig_"
_KEY_BYTES = 32  # 256-bit key body; after hex-encoding: 64 chars + 4 prefix = 68 total


def _make_raw_key() -> str:
    return _PREFIX + secrets.token_hex(_KEY_BYTES)


def _hash_key(raw: str) -> str:
    """HMAC-SHA256 of the raw key using the static domain separator as the key.
    Using HMAC rather than plain SHA256 prevents length-extension attacks on the
    hash if it ever leaks, and makes the derivation greppable in code."""
    return hmac.new(b"eigenheim-mcp-key-v1", raw.encode(), hashlib.sha256).hexdigest()


# ---- In-process leaky-bucket rate limiter ----------------------------------
# Stored per-process (not in SQLite), so a restart resets counters.
# For a local desktop app this is the right trade-off: zero lock contention, no
# persistent state to migrate, and the window persists across tool calls within
# a session.

_RATE_WINDOW = 60.0  # seconds
_RATE_LIMIT = 60     # calls per window

# {key_hash: {"tokens": int, "window_start": float}}
_rate_buckets: dict[str, dict] = {}


def _check_rate(key_hash: str) -> None:
    """Leaky-bucket: allows _RATE_LIMIT calls per _RATE_WINDOW seconds.
    Raises McpRateLimitError when exceeded."""
    now = time.monotonic()
    bucket = _rate_buckets.get(key_hash)
    if bucket is None or now - bucket["window_start"] >= _RATE_WINDOW:
        _rate_buckets[key_hash] = {"tokens": 1, "window_start": now}
        return
    bucket["tokens"] += 1
    if bucket["tokens"] > _RATE_LIMIT:
        raise McpRateLimitError(
            f"rate limit exceeded: {_RATE_LIMIT} calls/{int(_RATE_WINDOW)}s per key"
        )


# ---- DB helpers ------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def create_mcp_key(
    conn: sqlite3.Connection,
    name: str,
    scopes: list[str] | None = None,
) -> tuple[str, str]:
    """Create a new MCP key.

    Returns (raw_key, key_id). The caller MUST show raw_key to the user exactly
    once; it is not stored and cannot be recovered from the DB.

    scopes defaults to ["read"] for v1.  Pass additional values to grant broader
    access when write scopes ship.
    """
    if scopes is None:
        scopes = ["read"]
    raw = _make_raw_key()
    key_hash = _hash_key(raw)
    key_id = "kig_" + secrets.token_hex(8)  # key ID is safe to store/expose
    conn.execute(
        "INSERT INTO mcp_keys(id, name, scopes_json, key_hash, created_at, last_used_at, revoked)"
        " VALUES (?,?,?,?,?,NULL,0)",
        (key_id, name, json.dumps(scopes), key_hash, _now()),
    )
    conn.commit()
    return raw, key_id


def list_mcp_keys(conn: sqlite3.Connection) -> list[dict]:
    """Return metadata for all non-revoked keys (never returns hashes or raw keys)."""
    rows = conn.execute(
        "SELECT id, name, scopes_json, created_at, last_used_at"
        " FROM mcp_keys WHERE revoked=0 ORDER BY rowid"
    ).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "scopes": json.loads(r["scopes_json"]),
            "created_at": r["created_at"],
            "last_used_at": r["last_used_at"],
        }
        for r in rows
    ]


def revoke_mcp_key(conn: sqlite3.Connection, key_id: str) -> bool:
    """Mark a key as revoked. Returns True if the key existed and was not already revoked."""
    cur = conn.execute(
        "UPDATE mcp_keys SET revoked=1 WHERE id=? AND revoked=0", (key_id,)
    )
    conn.commit()
    return cur.rowcount == 1


# ---- Scope enforcement -----------------------------------------------------

# V1 scope hierarchy: `read` grants access to all read-only tools.
# Future: `logic:write`, `report:write` will each be required individually.
_SCOPE_MAP: dict[str, list[str]] = {
    # scope_required -> list of grants that satisfy it
    # `read` is the umbrella scope: a key that holds `read` satisfies every
    # read-only scope (tasks:read, goals:read, etc.) in the current v1 scheme.
    "read": ["read"],
    "tasks:read": ["read", "tasks:read"],
    "goals:read": ["read", "goals:read"],
    "hypotheses:read": ["read", "hypotheses:read"],
    "decisions:read": ["read", "decisions:read"],
    "rice:read": ["read", "rice:read"],
    "logic:write": ["logic:write"],
    "report:write": ["report:write"],
    # hypotheses:write is default-deny: NOT satisfied by the `read` umbrella.
    # An agent must hold this scope explicitly to call propose_hypothesis.
    # The read umbrella intentionally does NOT grant write access so a key issued
    # for analytics queries cannot silently propose hypotheses.
    "hypotheses:write": ["hypotheses:write"],
}


def require_scope(conn: sqlite3.Connection, raw_key: str, scope: str) -> str:
    """Validate raw_key + enforce scope + rate-limit.

    Returns the key_id on success.
    Raises McpAuthError or McpRateLimitError on failure.

    Callers must treat this as default-deny: any exception means the call
    should be rejected.
    """
    key_hash = _hash_key(raw_key)

    row = conn.execute(
        "SELECT id, scopes_json, revoked FROM mcp_keys WHERE key_hash=?",
        (key_hash,),
    ).fetchone()

    if row is None or row["revoked"]:
        raise McpAuthError("invalid or revoked MCP key")

    key_scopes: list[str] = json.loads(row["scopes_json"])
    satisfying = _SCOPE_MAP.get(scope, [scope])
    if not any(s in key_scopes for s in satisfying):
        raise McpAuthError(f"key lacks required scope '{scope}'")

    # Rate limit check (per key hash, not per key_id, to prevent ID-spoofing).
    _check_rate(key_hash)

    # Update last_used_at (best-effort; do not let a DB error block the call).
    try:
        conn.execute(
            "UPDATE mcp_keys SET last_used_at=? WHERE id=?", (_now(), row["id"])
        )
        conn.commit()
    except sqlite3.Error:
        pass

    return row["id"]
