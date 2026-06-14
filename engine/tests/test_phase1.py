"""Phase 1 chunk 1A tests: MCP auth + instructions surface.

1.1 — key gen + HMAC store, scope default-deny, rate-limit rejection.
1.2 — (renderer; not a Python unit test — covered by tsc + vite build).
1.3 — forbidden-fragments deny-list on all instructions strings.
1.4 — first-call _hint in structured envelope; subsequent calls omit it.
"""
from __future__ import annotations

import sqlite3
import time

import pytest

from eigenheim import store_db
from eigenheim.mcp_auth import (
    McpAuthError,
    McpRateLimitError,
    _RATE_LIMIT,
    _RATE_WINDOW,
    _hash_key,
    _make_raw_key,
    _rate_buckets,
    create_mcp_key,
    list_mcp_keys,
    require_scope,
    revoke_mcp_key,
)
from eigenheim.mcp_instructions import ALL_INSTRUCTIONS, _FORBIDDEN_FRAGMENTS


# ── helpers ──────────────────────────────────────────────────────────────────

from eigenheim import db as _db


def _auth_conn() -> sqlite3.Connection:
    """In-memory DB with the MCP keys table (migration 2).
    Keys-only: no events table. Suitable for auth/scope/rate-limit tests.
    """
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)
    store_db.run_migrations(c)
    return c


def _full_auth_conn() -> sqlite3.Connection:
    """In-memory DB with events + store schema + migrations.
    Required for hint tests that call list_reports (which runs compute_value)."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    _db.init_and_seed(c)
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)
    store_db.run_migrations(c)
    return c


# ── 1.1 key generation + HMAC store ──────────────────────────────────────────


def test_raw_key_has_eig_prefix():
    raw = _make_raw_key()
    assert raw.startswith("eig_"), f"expected eig_ prefix, got: {raw[:10]}"


def test_key_hash_is_deterministic():
    raw = "eig_testkey"
    assert _hash_key(raw) == _hash_key(raw)


def test_key_hash_differs_from_raw():
    raw = _make_raw_key()
    assert _hash_key(raw) != raw


def test_create_key_returns_raw_and_id():
    c = _auth_conn()
    raw, kid = create_mcp_key(c, "test-key")
    assert raw.startswith("eig_")
    assert kid.startswith("kig_")


def test_created_key_not_stored_as_plaintext():
    """The raw key must NOT appear in the DB anywhere."""
    c = _auth_conn()
    raw, _kid = create_mcp_key(c, "secret-key")
    # Dump the entire mcp_keys table and confirm the raw key is absent.
    rows = c.execute("SELECT * FROM mcp_keys").fetchall()
    for row in rows:
        for col in row.keys():
            assert raw not in str(row[col]), (
                f"raw key found in column '{col}': {row[col]!r}"
            )


def test_key_hash_stored_in_db():
    c = _auth_conn()
    raw, _kid = create_mcp_key(c, "hash-check")
    expected_hash = _hash_key(raw)
    row = c.execute("SELECT key_hash FROM mcp_keys WHERE key_hash=?", (expected_hash,)).fetchone()
    assert row is not None, "HMAC hash not found in DB"


def test_list_keys_returns_metadata_only():
    c = _auth_conn()
    raw, kid = create_mcp_key(c, "list-test")
    keys = list_mcp_keys(c)
    assert any(k["id"] == kid for k in keys)
    # Confirm no hash or raw key is exposed.
    for k in keys:
        for v in k.values():
            if isinstance(v, str):
                assert not v.startswith("eig_"), "raw key leaked in list_mcp_keys"
                assert len(v) != 64 or not all(c in "0123456789abcdef" for c in v), \
                    "suspiciously hash-shaped value in list_mcp_keys"


def test_revoke_key():
    c = _auth_conn()
    raw, kid = create_mcp_key(c, "revoke-test")
    assert revoke_mcp_key(c, kid) is True
    # Revoked key must fail auth.
    with pytest.raises(McpAuthError):
        require_scope(c, raw, "read")
    # List must not include revoked keys.
    assert not any(k["id"] == kid for k in list_mcp_keys(c))


def test_revoke_nonexistent_key_returns_false():
    c = _auth_conn()
    assert revoke_mcp_key(c, "kig_doesnotexist") is False


# ── 1.1 scope enforcement (default-deny) ─────────────────────────────────────


def test_valid_key_read_scope_passes():
    c = _auth_conn()
    raw, kid = create_mcp_key(c, "read-ok", scopes=["read"])
    result = require_scope(c, raw, "read")
    assert result == kid


def test_unknown_key_denied():
    c = _auth_conn()
    with pytest.raises(McpAuthError):
        require_scope(c, "eig_" + "x" * 64, "read")


def test_missing_scope_denied():
    """A key with only `read` must be denied for `logic:write`."""
    c = _auth_conn()
    raw, _kid = create_mcp_key(c, "read-only", scopes=["read"])
    with pytest.raises(McpAuthError, match="scope"):
        require_scope(c, raw, "logic:write")


def test_write_scope_key_can_satisfy_write():
    """A key explicitly granted `logic:write` passes that scope check."""
    c = _auth_conn()
    raw, kid = create_mcp_key(c, "writer", scopes=["read", "logic:write"])
    result = require_scope(c, raw, "logic:write")
    assert result == kid


def test_revoked_key_denied():
    c = _auth_conn()
    raw, kid = create_mcp_key(c, "to-revoke", scopes=["read"])
    revoke_mcp_key(c, kid)
    with pytest.raises(McpAuthError):
        require_scope(c, raw, "read")


# ── 1.1 rate-limit rejection ──────────────────────────────────────────────────


def test_rate_limit_rejects_on_excess(monkeypatch):
    """Calls beyond _RATE_LIMIT within a window must raise McpRateLimitError."""
    c = _auth_conn()
    raw, _kid = create_mcp_key(c, "rate-test", scopes=["read"])

    # Pin time.monotonic so all calls land in the same window.
    fixed_time = time.monotonic()
    monkeypatch.setattr("eigenheim.mcp_auth.time.monotonic", lambda: fixed_time)

    # Clear any leftover bucket state for this key.
    key_hash = _hash_key(raw)
    _rate_buckets.pop(key_hash, None)

    # First _RATE_LIMIT calls must succeed.
    for _ in range(_RATE_LIMIT):
        require_scope(c, raw, "read")

    # The very next call must be rejected.
    with pytest.raises(McpRateLimitError):
        require_scope(c, raw, "read")


def test_rate_limit_resets_after_window(monkeypatch):
    """A new window resets the counter."""
    c = _auth_conn()
    raw, _kid = create_mcp_key(c, "rate-reset", scopes=["read"])

    start = time.monotonic()
    calls = [start]
    monkeypatch.setattr("eigenheim.mcp_auth.time.monotonic", lambda: calls[0])

    key_hash = _hash_key(raw)
    _rate_buckets.pop(key_hash, None)

    for _ in range(_RATE_LIMIT):
        require_scope(c, raw, "read")

    # Advance time past the window.
    calls[0] = start + _RATE_WINDOW + 1.0

    # Must succeed again (new window, counter reset).
    require_scope(c, raw, "read")


# ── 1.3 forbidden-fragment guard ─────────────────────────────────────────────


def test_no_forbidden_fragments_in_instructions():
    """MUST PASS before any commit. Fails the build if a forbidden fragment
    appears in any ALL_INSTRUCTIONS string (case-insensitive)."""
    violations: list[str] = []
    for fragment in _FORBIDDEN_FRAGMENTS:
        for i, text in enumerate(ALL_INSTRUCTIONS):
            if fragment.lower() in text.lower():
                violations.append(
                    f"Fragment {fragment!r} found in ALL_INSTRUCTIONS[{i}]: {text[:80]!r}"
                )
    assert not violations, "\n".join(violations)


def test_all_instructions_are_strings():
    for i, text in enumerate(ALL_INSTRUCTIONS):
        assert isinstance(text, str), f"ALL_INSTRUCTIONS[{i}] is not a str"
        assert len(text) > 0, f"ALL_INSTRUCTIONS[{i}] is empty"


# ── 1.4 first-call _hint ─────────────────────────────────────────────────────


def test_hint_injected_on_first_call():
    """The _hint field must appear in the first tool result of a session."""
    import eigenheim.mcp_server as ms

    c = _full_auth_conn()
    raw, _kid = create_mcp_key(c, "hint-test", scopes=["read"])

    # Reset the session flag and patch the module's DB connection.
    ms._session_hinted = False
    original_conn = ms._conn
    ms._conn = c

    try:
        result = ms.list_reports(key=raw)
        assert "_hint" in result, f"_hint missing from first tool result: {result}"
        assert "eigenheim.space/docs" in result["_hint"]
        assert "deterministic" in result["_hint"]
    finally:
        ms._conn = original_conn
        ms._session_hinted = False  # always reset, even on error


def test_hint_not_injected_on_subsequent_calls():
    """After the first call, _hint must NOT appear in subsequent results."""
    import eigenheim.mcp_server as ms

    c = _full_auth_conn()
    raw, _kid = create_mcp_key(c, "hint-test2", scopes=["read"])

    ms._session_hinted = False
    original_conn = ms._conn
    ms._conn = c

    try:
        # First call — consumes the hint.
        ms.list_reports(key=raw)
        # Second call — must not re-inject.
        result2 = ms.list_reports(key=raw)
        assert "_hint" not in result2, f"_hint appeared again on second call: {result2}"
    finally:
        ms._conn = original_conn
        ms._session_hinted = False


def test_hint_is_in_dedicated_field_not_data():
    """_hint must be a top-level field, never inside the reports/events data."""
    import eigenheim.mcp_server as ms

    c = _full_auth_conn()
    raw, _kid = create_mcp_key(c, "hint-struct", scopes=["read"])

    ms._session_hinted = False
    original_conn = ms._conn
    ms._conn = c

    try:
        result2_struct = ms.list_reports(key=raw)
        assert "_hint" in result2_struct
        # The hint must not bleed into the reports list.
        for r in result2_struct.get("reports", []):
            assert "_hint" not in r, "hint bled into a report entry"
    finally:
        ms._conn = original_conn
        ms._session_hinted = False


def test_auth_failure_does_not_emit_hint():
    """An auth failure short-circuits before the hint is injected."""
    import eigenheim.mcp_server as ms

    c = _auth_conn()
    ms._session_hinted = False
    original_conn = ms._conn
    ms._conn = c

    try:
        result = ms.list_reports(key="eig_badkey000000000000000000000000000000000000000000000000000000000000")
        assert "error" in result
        assert "_hint" not in result
        # Flag must remain False (the hint was not consumed by a failed call).
        assert ms._session_hinted is False
    finally:
        ms._conn = original_conn
        ms._session_hinted = False
