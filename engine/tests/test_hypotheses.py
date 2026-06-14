"""Hypothesis log backend tests (H1–H3).

H1  — Migration 7: hypotheses table created with required columns; user_version
       bumped; migration idempotent.
H2  — Store helpers: create / list / get / update-status / delete; status workflow;
       filter by status + logic_id; source validation.
H2R — REST CRUD: POST /hypotheses (user path); GET /hypotheses (filters);
       GET /hypotheses/{id}; PATCH /hypotheses/{id}/status (human gate);
       DELETE /hypotheses/{id}; unknown logic_id rejected.
H3  — MCP tools: list_hypotheses / get_hypothesis (hypotheses:read or umbrella read);
       propose_hypothesis (hypotheses:write scope enforced, read scope denied);
       proposed lands as status='proposed', source='agent';
       agent cannot advance status (no advance-status tool exists on MCP);
       unknown logic_id rejected before write.
"""
from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from eigenheim import db as _db
from eigenheim import store_db
from eigenheim.mcp_auth import create_mcp_key, McpAuthError
from eigenheim.app import app


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    _db.init_and_seed(c)
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)
    store_db.run_migrations(c)
    return c


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """TestClient wired to an isolated file DB; open auth for test simplicity."""
    db_path = str(tmp_path / "test.db")
    monkeypatch.setenv("EIGENHEIM_DB", db_path)
    monkeypatch.delenv("EIGENHEIM_TOKEN", raising=False)
    monkeypatch.delenv("EIGENHEIM_TOKEN_FILE", raising=False)
    import eigenheim.app as appmod
    appmod._auth_state["token"] = None
    with TestClient(app) as c:
        yield c


def _mcp_conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:", check_same_thread=False)
    c.row_factory = sqlite3.Row
    _db.init_and_seed(c)
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)
    store_db.run_migrations(c)
    return c


# ─────────────────────────────────────────────────────────────────────────────
# H1 — Migration 7: schema
# ─────────────────────────────────────────────────────────────────────────────

def test_migration7_creates_hypotheses_table():
    c = _conn()
    tables = {r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert "hypotheses" in tables, "hypotheses table missing after migration 7"


def test_migration7_bumps_user_version():
    c = _conn()
    (v,) = c.execute("PRAGMA user_version").fetchone()
    assert v == len(store_db._MIGRATIONS), (
        f"user_version should be {len(store_db._MIGRATIONS)}, got {v}"
    )


def test_migration7_idempotent():
    c = _conn()
    v1 = store_db.run_migrations(c)
    v2 = store_db.run_migrations(c)
    assert v1 == v2


def test_hypotheses_columns():
    c = _conn()
    cols = {r[1] for r in c.execute("PRAGMA table_info(hypotheses)").fetchall()}
    required = {"id", "statement", "logic_id", "evidence", "status", "source", "created_at"}
    assert required <= cols, f"missing columns: {required - cols}"


def test_hypotheses_status_index_exists():
    c = _conn()
    indexes = {r[1] for r in c.execute(
        "SELECT type, name FROM sqlite_master WHERE type='index'"
    ).fetchall()}
    assert "ix_hypotheses_status" in indexes


def test_hypotheses_logic_id_index_exists():
    c = _conn()
    indexes = {r[1] for r in c.execute(
        "SELECT type, name FROM sqlite_master WHERE type='index'"
    ).fetchall()}
    assert "ix_hypotheses_logic_id" in indexes


# ─────────────────────────────────────────────────────────────────────────────
# H2 — Store helpers
# ─────────────────────────────────────────────────────────────────────────────

def test_create_hypothesis_user_source_default():
    c = _conn()
    h = store_db.create_hypothesis(c, "Users churn because onboarding is too long")
    assert h["id"].startswith("hyp_")
    assert h["status"] == "proposed"
    assert h["source"] == "user"
    assert h["logic_id"] == ""
    assert h["evidence"] == ""


def test_create_hypothesis_agent_source():
    c = _conn()
    h = store_db.create_hypothesis(
        c, "Activation drops on mobile", logic_id="activation",
        evidence="activation = 0.12 last week", source="agent",
    )
    assert h["source"] == "agent"
    assert h["logic_id"] == "activation"
    assert h["status"] == "proposed"


def test_create_hypothesis_invalid_source_raises():
    c = _conn()
    with pytest.raises(ValueError, match="source"):
        store_db.create_hypothesis(c, "Bad source", source="bot")


def test_list_hypotheses_empty():
    c = _conn()
    assert store_db.list_hypotheses(c) == []


def test_list_hypotheses_returns_all():
    c = _conn()
    store_db.create_hypothesis(c, "H1")
    store_db.create_hypothesis(c, "H2")
    hyps = store_db.list_hypotheses(c)
    assert len(hyps) == 2


def test_list_hypotheses_filter_by_status():
    c = _conn()
    h = store_db.create_hypothesis(c, "H1")
    store_db.create_hypothesis(c, "H2")
    store_db.update_hypothesis_status(c, h["id"], "testing")
    proposed = store_db.list_hypotheses(c, status="proposed")
    testing = store_db.list_hypotheses(c, status="testing")
    assert len(proposed) == 1
    assert len(testing) == 1
    assert testing[0]["statement"] == "H1"


def test_list_hypotheses_filter_by_logic_id():
    c = _conn()
    store_db.create_hypothesis(c, "H linked", logic_id="activation")
    store_db.create_hypothesis(c, "H unlinked")
    linked = store_db.list_hypotheses(c, logic_id="activation")
    assert len(linked) == 1
    assert linked[0]["logic_id"] == "activation"


def test_list_hypotheses_filter_combined():
    c = _conn()
    h = store_db.create_hypothesis(c, "H proposed linked", logic_id="activation")
    store_db.create_hypothesis(c, "H proposed unlinked")
    store_db.update_hypothesis_status(c, h["id"], "testing")
    # proposed + activation → 0 results (the linked one is now testing)
    result = store_db.list_hypotheses(c, status="proposed", logic_id="activation")
    assert result == []
    # testing + activation → 1 result
    result = store_db.list_hypotheses(c, status="testing", logic_id="activation")
    assert len(result) == 1


def test_get_hypothesis_found():
    c = _conn()
    h = store_db.create_hypothesis(c, "Found hypothesis")
    fetched = store_db.get_hypothesis(c, h["id"])
    assert fetched is not None
    assert fetched["statement"] == "Found hypothesis"


def test_get_hypothesis_not_found():
    c = _conn()
    assert store_db.get_hypothesis(c, "hyp_nonexistent") is None


def test_update_hypothesis_status_proposed_to_testing():
    c = _conn()
    h = store_db.create_hypothesis(c, "Test me")
    updated = store_db.update_hypothesis_status(c, h["id"], "testing")
    assert updated["status"] == "testing"


def test_update_hypothesis_status_to_confirmed():
    c = _conn()
    h = store_db.create_hypothesis(c, "Confirmed hypothesis")
    store_db.update_hypothesis_status(c, h["id"], "testing")
    result = store_db.update_hypothesis_status(c, h["id"], "confirmed")
    assert result["status"] == "confirmed"


def test_update_hypothesis_status_to_rejected():
    c = _conn()
    h = store_db.create_hypothesis(c, "Bad hypothesis")
    result = store_db.update_hypothesis_status(c, h["id"], "rejected")
    assert result["status"] == "rejected"


def test_update_hypothesis_status_invalid_raises():
    c = _conn()
    h = store_db.create_hypothesis(c, "H")
    with pytest.raises(ValueError, match="status"):
        store_db.update_hypothesis_status(c, h["id"], "unknown_status")


def test_update_hypothesis_status_not_found():
    c = _conn()
    assert store_db.update_hypothesis_status(c, "hyp_missing", "testing") is None


def test_delete_hypothesis_removes_row():
    c = _conn()
    h = store_db.create_hypothesis(c, "To delete")
    ok = store_db.delete_hypothesis(c, h["id"])
    assert ok is True
    assert store_db.get_hypothesis(c, h["id"]) is None


def test_delete_hypothesis_not_found():
    c = _conn()
    assert store_db.delete_hypothesis(c, "hyp_missing") is False


def test_hypotheses_ordered_newest_first():
    """list_hypotheses returns newest (largest created_at) first."""
    c = _conn()
    h1 = store_db.create_hypothesis(c, "First")
    h2 = store_db.create_hypothesis(c, "Second")
    hyps = store_db.list_hypotheses(c)
    ids = [h["id"] for h in hyps]
    assert h2["id"] in ids and h1["id"] in ids


# ─────────────────────────────────────────────────────────────────────────────
# H2R — REST CRUD
# ─────────────────────────────────────────────────────────────────────────────

def test_rest_create_hypothesis(client):
    resp = client.post("/hypotheses", json={"statement": "Users drop at step 3"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["statement"] == "Users drop at step 3"
    assert data["status"] == "proposed"
    assert data["source"] == "user"


def test_rest_create_hypothesis_with_logic_id(client):
    resp = client.post(
        "/hypotheses",
        json={"statement": "Low activation", "logic_id": "activation", "evidence": "0.12"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["logic_id"] == "activation"


def test_rest_create_hypothesis_unknown_logic_id(client):
    resp = client.post(
        "/hypotheses",
        json={"statement": "Bad ref", "logic_id": "nonexistent_metric"},
    )
    assert resp.status_code == 422


def test_rest_list_hypotheses_empty(client):
    resp = client.get("/hypotheses")
    assert resp.status_code == 200
    assert resp.json() == []


def test_rest_list_hypotheses_filter_status(client):
    r1 = client.post("/hypotheses", json={"statement": "H1"}).json()
    client.post("/hypotheses", json={"statement": "H2"})
    # Advance H1 to testing
    client.patch(f"/hypotheses/{r1['id']}/status", json={"status": "testing"})
    proposed = client.get("/hypotheses?status=proposed").json()
    testing = client.get("/hypotheses?status=testing").json()
    assert len(proposed) == 1
    assert len(testing) == 1


def test_rest_list_hypotheses_invalid_status(client):
    resp = client.get("/hypotheses?status=invalid_status")
    assert resp.status_code == 422


def test_rest_get_hypothesis(client):
    created = client.post("/hypotheses", json={"statement": "My hyp"}).json()
    fetched = client.get(f"/hypotheses/{created['id']}").json()
    assert fetched["statement"] == "My hyp"


def test_rest_get_hypothesis_not_found(client):
    resp = client.get("/hypotheses/hyp_nothere")
    assert resp.status_code == 404


def test_rest_patch_status(client):
    created = client.post("/hypotheses", json={"statement": "Test hypothesis"}).json()
    patched = client.patch(
        f"/hypotheses/{created['id']}/status",
        json={"status": "testing"},
    ).json()
    assert patched["status"] == "testing"


def test_rest_patch_status_invalid(client):
    created = client.post("/hypotheses", json={"statement": "H"}).json()
    resp = client.patch(
        f"/hypotheses/{created['id']}/status",
        json={"status": "bad_status"},
    )
    assert resp.status_code == 422


def test_rest_patch_status_not_found(client):
    resp = client.patch("/hypotheses/hyp_missing/status", json={"status": "testing"})
    assert resp.status_code == 404


def test_rest_delete_hypothesis(client):
    created = client.post("/hypotheses", json={"statement": "Delete me"}).json()
    resp = client.delete(f"/hypotheses/{created['id']}")
    assert resp.status_code == 200
    assert client.get(f"/hypotheses/{created['id']}").status_code == 404


def test_rest_delete_hypothesis_not_found(client):
    resp = client.delete("/hypotheses/hyp_nothere")
    assert resp.status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
# H3 — MCP tools
# ─────────────────────────────────────────────────────────────────────────────

def test_mcp_list_hypotheses_read_scope_ok():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read-key", scopes=["read"])
    store_db.create_hypothesis(c, "H1", source="agent")

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_hypotheses(key=raw)
        assert "hypotheses" in result
        assert result["count"] == 1
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_list_hypotheses_hypotheses_read_scope_ok():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "hyp-read-key", scopes=["hypotheses:read"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_hypotheses(key=raw)
        assert "hypotheses" in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_list_hypotheses_bad_key_returns_error():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_hypotheses(key="eig_" + "x" * 64)
        assert "error" in result
        assert result["error"] == "auth_error"
        assert "_hint" not in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_get_hypothesis_found():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read-key", scopes=["read"])
    h = store_db.create_hypothesis(c, "My hypothesis", logic_id="activation")

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.get_hypothesis(key=raw, hypothesis_id=h["id"])
        assert "statement" in result
        assert result["statement"] == "My hypothesis"
        assert result["logic_id"] == "activation"
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_get_hypothesis_not_found():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read-key", scopes=["read"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.get_hypothesis(key=raw, hypothesis_id="hyp_missing")
        assert "error" in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_propose_hypothesis_write_scope_required():
    """A key with only 'read' scope must be denied on propose_hypothesis."""
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read-only", scopes=["read"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.propose_hypothesis(
            key=raw,
            statement="read scope should not allow this",
            logic_id="activation",
            rationale="testing scope enforcement",
        )
        assert "error" in result, "read scope must be denied on propose_hypothesis"
        assert result["error"] == "auth_error"
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_propose_hypothesis_write_scope_ok_lands_proposed():
    """hypotheses:write scope allows propose_hypothesis; lands as proposed/agent."""
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "write-key", scopes=["hypotheses:write"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.propose_hypothesis(
            key=raw,
            statement="Activation drops on mobile devices",
            logic_id="activation",
            rationale="Activation = 0.08 on mobile vs 0.18 on desktop last week",
        )
        assert result.get("status") == "proposed", f"unexpected: {result}"
        assert result["source"] == "agent"
        assert result["statement"] == "Activation drops on mobile devices"
        assert result["logic_id"] == "activation"
        # Verify it landed in the DB as proposed
        stored = store_db.get_hypothesis(c, result["id"])
        assert stored["status"] == "proposed"
        assert stored["source"] == "agent"
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_propose_hypothesis_agent_cannot_advance_status():
    """No MCP tool exists to advance status — the agent path stops at proposed.

    After propose_hypothesis, status stays 'proposed'. There is no MCP tool
    that transitions it further. The ONLY path is PATCH /hypotheses/{id}/status.
    """
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw_write, _ = create_mcp_key(c, "write-key", scopes=["hypotheses:write"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.propose_hypothesis(
            key=raw_write,
            statement="Agent-proposed hypothesis",
            logic_id="",
            rationale="Purely agent-proposed",
        )
        hid = result["id"]
        stored = store_db.get_hypothesis(c, hid)
        assert stored["status"] == "proposed"
        # Confirm propose_hypothesis exists but no status-advance tool does.
        assert hasattr(ms, "propose_hypothesis")
        assert not hasattr(ms, "update_hypothesis_status"), (
            "mcp_server must NOT expose update_hypothesis_status — "
            "that is the human-only REST gate"
        )
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_propose_hypothesis_unknown_logic_id_rejected():
    """propose_hypothesis with an unknown logic_id returns a validation error."""
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "write-key", scopes=["hypotheses:write"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.propose_hypothesis(
            key=raw,
            statement="Linked to nonexistent metric",
            logic_id="nonexistent_metric_xyz",
            rationale="Should fail validation",
        )
        assert result.get("error") == "validation_error"
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_propose_hypothesis_empty_logic_id_allowed():
    """propose_hypothesis with logic_id='' (general hypothesis) is valid."""
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "write-key", scopes=["hypotheses:write"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.propose_hypothesis(
            key=raw,
            statement="General product insight",
            logic_id="",
            rationale="Not tied to a specific metric",
        )
        assert result.get("status") == "proposed"
        assert result["logic_id"] == ""
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_scope_map_hypotheses_write_denied_for_read_key():
    """'read' scope does NOT satisfy 'hypotheses:write'."""
    from eigenheim.mcp_auth import require_scope, McpAuthError

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read-key", scopes=["read"])
    with pytest.raises(McpAuthError, match="scope"):
        require_scope(c, raw, "hypotheses:write")


def test_scope_map_hypotheses_write_satisfied_by_write_scope():
    from eigenheim.mcp_auth import require_scope

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "write-key", scopes=["hypotheses:write"])
    # Should not raise
    require_scope(c, raw, "hypotheses:write")


def test_scope_map_hypotheses_read_satisfied_by_umbrella_read():
    from eigenheim.mcp_auth import require_scope

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "umbrella", scopes=["read"])
    require_scope(c, raw, "hypotheses:read")


def test_mcp_list_hypotheses_filter_by_status():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read", scopes=["read"])
    h1 = store_db.create_hypothesis(c, "H proposed")
    h2 = store_db.create_hypothesis(c, "H testing")
    store_db.update_hypothesis_status(c, h2["id"], "testing")

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_hypotheses(key=raw, status="proposed")
        assert result["count"] == 1
        assert result["hypotheses"][0]["id"] == h1["id"]
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_list_hypotheses_filter_by_logic_id():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read", scopes=["read"])
    store_db.create_hypothesis(c, "H linked", logic_id="activation")
    store_db.create_hypothesis(c, "H unlinked")

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_hypotheses(key=raw, logic_id="activation")
        assert result["count"] == 1
        assert result["hypotheses"][0]["logic_id"] == "activation"
    finally:
        ms._conn = orig
        ms._session_hinted = False


# ─────────────────────────────────────────────────────────────────────────────
# No LLM import — determinism guard
# ─────────────────────────────────────────────────────────────────────────────

def test_no_llm_import_in_store_db():
    import eigenheim.store_db as sd_mod
    source_file = sd_mod.__file__ or ""
    with open(source_file, encoding="utf-8") as fh:
        src = fh.read()
    for pkg in ("openai", "anthropic", "ollama", "langchain", "litellm", "openrouter"):
        assert f"import {pkg}" not in src and f"from {pkg}" not in src, (
            f"store_db.py must not import {pkg}"
        )
