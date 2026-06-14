"""Decision log backend tests (D1–D3).

D1  — Migration 8: decisions + decision_metrics tables created; user_version
       bumped; migration idempotent.
D2  — Store helpers: create / list / get / update / delete; metric snapshot
       captured at creation time is immutable (a later metric recompute does NOT
       alter the stored captured_value); delete cascades to decision_metrics.
D2R — REST CRUD: POST /decisions (with and without metric_logic_ids);
       GET /decisions (list); GET /decisions/{id} (with snapshot);
       PATCH /decisions/{id} (partial update, snapshot unchanged);
       DELETE /decisions/{id}.
D3  — MCP read tools: list_decisions / get_decision; scope enforcement
       (decisions:read or umbrella read); payload shape; unknown id returns error.
       No MCP write tool for decisions (decisions are human-only in v1).
"""
from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from eigenheim import db as _db
from eigenheim import store_db
from eigenheim.mcp_auth import create_mcp_key
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
# D1 — Migration 8: schema
# ─────────────────────────────────────────────────────────────────────────────

def test_migration8_creates_decisions_table():
    c = _conn()
    tables = {r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert "decisions" in tables, "decisions table missing after migration 8"


def test_migration8_creates_decision_metrics_table():
    c = _conn()
    tables = {r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert "decision_metrics" in tables, "decision_metrics table missing after migration 8"


def test_migration8_bumps_user_version():
    c = _conn()
    (v,) = c.execute("PRAGMA user_version").fetchone()
    assert v == len(store_db._MIGRATIONS), (
        f"user_version should be {len(store_db._MIGRATIONS)}, got {v}"
    )


def test_migration8_idempotent():
    c = _conn()
    v1 = store_db.run_migrations(c)
    v2 = store_db.run_migrations(c)
    assert v1 == v2


def test_decisions_columns():
    c = _conn()
    cols = {r[1] for r in c.execute("PRAGMA table_info(decisions)").fetchall()}
    required = {"id", "title", "rationale", "status", "created_at"}
    assert required <= cols, f"missing columns: {required - cols}"


def test_decision_metrics_columns():
    c = _conn()
    cols = {r[1] for r in c.execute("PRAGMA table_info(decision_metrics)").fetchall()}
    required = {"id", "decision_id", "logic_id", "captured_value", "trace_ref", "captured_at"}
    assert required <= cols, f"missing columns: {required - cols}"


def test_decision_metrics_index_on_decision_id():
    c = _conn()
    indexes = {r[1] for r in c.execute(
        "SELECT type, name FROM sqlite_master WHERE type='index'"
    ).fetchall()}
    assert "ix_decision_metrics_decision" in indexes


# ─────────────────────────────────────────────────────────────────────────────
# D2 — Store helpers
# ─────────────────────────────────────────────────────────────────────────────

def test_create_decision_minimal():
    c = _conn()
    d = store_db.create_decision(c, "Ship the new onboarding flow")
    assert d["id"].startswith("dec_")
    assert d["title"] == "Ship the new onboarding flow"
    assert d["rationale"] == ""
    assert d["status"] == ""
    assert d["metrics"] == []


def test_create_decision_with_snapshot():
    c = _conn()
    snaps = [
        {"logic_id": "activation", "captured_value": 0.12, "trace_ref": "activated / signed_up"},
    ]
    d = store_db.create_decision(
        c, "Activate the experiment",
        rationale="Activation is below target",
        metric_snapshots=snaps,
    )
    assert len(d["metrics"]) == 1
    m = d["metrics"][0]
    assert m["logic_id"] == "activation"
    assert m["captured_value"] == pytest.approx(0.12)
    assert m["trace_ref"] == "activated / signed_up"
    assert m["captured_at"] == d["created_at"]


def test_create_decision_snapshot_is_immutable():
    """Fetching a decision later must return the same captured_value as at creation."""
    c = _conn()
    snaps = [{"logic_id": "activation", "captured_value": 0.42, "trace_ref": "activated / signed_up"}]
    d = store_db.create_decision(c, "Decision at v0.42", metric_snapshots=snaps)

    fetched = store_db.get_decision(c, d["id"])
    assert fetched["metrics"][0]["captured_value"] == pytest.approx(0.42), (
        "Snapshot captured_value must not change after creation"
    )


def test_list_decisions_empty():
    c = _conn()
    assert store_db.list_decisions(c) == []


def test_list_decisions_returns_all():
    c = _conn()
    store_db.create_decision(c, "D1")
    store_db.create_decision(c, "D2")
    decisions = store_db.list_decisions(c)
    assert len(decisions) == 2


def test_list_decisions_no_metrics_in_list():
    """list_decisions omits the metrics field — only get_decision returns it."""
    c = _conn()
    snaps = [{"logic_id": "activation", "captured_value": 0.1, "trace_ref": ""}]
    store_db.create_decision(c, "D with snap", metric_snapshots=snaps)
    rows = store_db.list_decisions(c)
    assert "metrics" not in rows[0], "list_decisions must NOT include metrics field"


def test_get_decision_found_with_metrics():
    c = _conn()
    snaps = [
        {"logic_id": "activation", "captured_value": 0.55, "trace_ref": "activated / signed_up"},
        {"logic_id": "mau", "captured_value": 1234.0, "trace_ref": "count(distinct user_id)"},
    ]
    d = store_db.create_decision(c, "Multi-metric decision", metric_snapshots=snaps)
    fetched = store_db.get_decision(c, d["id"])
    assert fetched is not None
    assert fetched["title"] == "Multi-metric decision"
    assert len(fetched["metrics"]) == 2
    logic_ids = {m["logic_id"] for m in fetched["metrics"]}
    assert logic_ids == {"activation", "mau"}


def test_get_decision_not_found():
    c = _conn()
    assert store_db.get_decision(c, "dec_missing") is None


def test_update_decision_title():
    c = _conn()
    d = store_db.create_decision(c, "Old Title")
    updated = store_db.update_decision(c, d["id"], title="New Title")
    assert updated["title"] == "New Title"


def test_update_decision_rationale():
    c = _conn()
    d = store_db.create_decision(c, "D")
    updated = store_db.update_decision(c, d["id"], rationale="Added rationale")
    assert updated["rationale"] == "Added rationale"


def test_update_decision_status():
    c = _conn()
    d = store_db.create_decision(c, "D")
    updated = store_db.update_decision(c, d["id"], status="superseded")
    assert updated["status"] == "superseded"


def test_update_decision_preserves_metrics():
    """update_decision must NOT touch the captured metric snapshots."""
    c = _conn()
    snaps = [{"logic_id": "activation", "captured_value": 0.77, "trace_ref": ""}]
    d = store_db.create_decision(c, "D with snap", metric_snapshots=snaps)
    updated = store_db.update_decision(c, d["id"], title="New Title")
    assert len(updated["metrics"]) == 1
    assert updated["metrics"][0]["captured_value"] == pytest.approx(0.77), (
        "update_decision must not alter the captured metric snapshot"
    )


def test_update_decision_not_found():
    c = _conn()
    assert store_db.update_decision(c, "dec_missing", title="X") is None


def test_delete_decision_removes_row():
    c = _conn()
    d = store_db.create_decision(c, "To Delete")
    ok = store_db.delete_decision(c, d["id"])
    assert ok is True
    assert store_db.get_decision(c, d["id"]) is None


def test_delete_decision_cascades_metrics():
    """delete_decision must also remove the decision_metrics rows."""
    c = _conn()
    snaps = [{"logic_id": "activation", "captured_value": 0.1, "trace_ref": ""}]
    d = store_db.create_decision(c, "With snap", metric_snapshots=snaps)
    dec_id = d["id"]
    store_db.delete_decision(c, dec_id)
    rows = c.execute(
        "SELECT * FROM decision_metrics WHERE decision_id=?", (dec_id,)
    ).fetchall()
    assert rows == [], "decision_metrics rows must be deleted with the decision"


def test_delete_decision_not_found():
    c = _conn()
    assert store_db.delete_decision(c, "dec_missing") is False


# ─────────────────────────────────────────────────────────────────────────────
# D2R — REST CRUD
# ─────────────────────────────────────────────────────────────────────────────

def test_rest_create_decision_minimal(client):
    resp = client.post("/decisions", json={"title": "Launch feature X"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["title"] == "Launch feature X"
    assert data["metrics"] == []


def test_rest_create_decision_with_metrics(client):
    resp = client.post(
        "/decisions",
        json={
            "title": "Prioritise activation",
            "rationale": "Activation is below target",
            "metric_logic_ids": ["activation"],
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["metrics"]) == 1
    m = data["metrics"][0]
    assert m["logic_id"] == "activation"
    assert "captured_value" in m
    assert "trace_ref" in m
    assert "captured_at" in m


def test_rest_create_decision_unknown_logic_id_skipped(client):
    """An unknown logic_id in metric_logic_ids is silently skipped."""
    resp = client.post(
        "/decisions",
        json={
            "title": "Decision",
            "metric_logic_ids": ["nonexistent_xyz"],
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["metrics"] == []


def test_rest_list_decisions_empty(client):
    resp = client.get("/decisions")
    assert resp.status_code == 200
    assert resp.json() == []


def test_rest_list_decisions(client):
    client.post("/decisions", json={"title": "D1"})
    client.post("/decisions", json={"title": "D2"})
    resp = client.get("/decisions")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2


def test_rest_get_decision(client):
    created = client.post(
        "/decisions",
        json={"title": "My Decision", "metric_logic_ids": ["activation"]},
    ).json()
    fetched = client.get(f"/decisions/{created['id']}").json()
    assert fetched["title"] == "My Decision"
    assert "metrics" in fetched
    assert len(fetched["metrics"]) == 1


def test_rest_get_decision_not_found(client):
    resp = client.get("/decisions/dec_missing")
    assert resp.status_code == 404


def test_rest_snapshot_immutable_after_recompute(client):
    """The captured_value in the REST response must not change between requests."""
    resp = client.post(
        "/decisions",
        json={"title": "Snapshot immutability", "metric_logic_ids": ["activation"]},
    )
    assert resp.status_code == 200
    created = resp.json()
    first_value = created["metrics"][0]["captured_value"]

    fetched = client.get(f"/decisions/{created['id']}").json()
    assert fetched["metrics"][0]["captured_value"] == first_value, (
        "GET /decisions/{id} must return the same captured_value as at creation"
    )


def test_rest_patch_decision(client):
    created = client.post("/decisions", json={"title": "Old Title"}).json()
    patched = client.patch(
        f"/decisions/{created['id']}",
        json={"title": "New Title", "status": "superseded"},
    ).json()
    assert patched["title"] == "New Title"
    assert patched["status"] == "superseded"


def test_rest_patch_decision_not_found(client):
    resp = client.patch("/decisions/dec_missing", json={"title": "X"})
    assert resp.status_code == 404


def test_rest_patch_preserves_metrics(client):
    """PATCH /decisions/{id} must not alter the captured metric snapshot."""
    created = client.post(
        "/decisions",
        json={"title": "D", "metric_logic_ids": ["activation"]},
    ).json()
    original_value = created["metrics"][0]["captured_value"]

    patched = client.patch(
        f"/decisions/{created['id']}",
        json={"title": "Updated Title"},
    ).json()
    assert len(patched["metrics"]) == 1
    assert patched["metrics"][0]["captured_value"] == original_value


def test_rest_delete_decision(client):
    created = client.post("/decisions", json={"title": "Delete me"}).json()
    resp = client.delete(f"/decisions/{created['id']}")
    assert resp.status_code == 200
    assert client.get(f"/decisions/{created['id']}").status_code == 404


def test_rest_delete_decision_not_found(client):
    resp = client.delete("/decisions/dec_missing")
    assert resp.status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
# D3 — MCP read tools
# ─────────────────────────────────────────────────────────────────────────────

def test_mcp_list_decisions_read_scope_ok():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read-key", scopes=["read"])
    store_db.create_decision(c, "D1")
    store_db.create_decision(c, "D2")

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_decisions(key=raw)
        assert "decisions" in result
        assert result["count"] == 2
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_list_decisions_decisions_read_scope_ok():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "dec-read", scopes=["decisions:read"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_decisions(key=raw)
        assert "decisions" in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_list_decisions_bad_key_returns_error():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_decisions(key="eig_" + "z" * 64)
        assert "error" in result
        assert result["error"] == "auth_error"
        assert "_hint" not in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_get_decision_found_with_snapshot():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read-key", scopes=["read"])
    d = store_db.create_decision(
        c, "Captured",
        metric_snapshots=[
            {"logic_id": "activation", "captured_value": 0.33, "trace_ref": "activated / signed_up"},
        ],
    )

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.get_decision(key=raw, decision_id=d["id"])
        assert "title" in result
        assert result["title"] == "Captured"
        assert "metrics" in result
        assert len(result["metrics"]) == 1
        assert result["metrics"][0]["captured_value"] == pytest.approx(0.33)
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_get_decision_not_found():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read-key", scopes=["read"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.get_decision(key=raw, decision_id="dec_missing")
        assert "error" in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_no_write_tool_for_decisions():
    """Decisions are human-only in v1: no MCP write tool must exist."""
    import eigenheim.mcp_server as ms

    assert not hasattr(ms, "create_decision"), (
        "mcp_server must NOT expose create_decision — decisions are human-only in v1"
    )
    assert not hasattr(ms, "update_decision"), (
        "mcp_server must NOT expose update_decision — decisions are human-only in v1"
    )
    assert not hasattr(ms, "delete_decision"), (
        "mcp_server must NOT expose delete_decision — decisions are human-only in v1"
    )


def test_scope_map_decisions_read_satisfied_by_read():
    from eigenheim.mcp_auth import require_scope

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "umbrella", scopes=["read"])
    require_scope(c, raw, "decisions:read")


def test_scope_map_decisions_read_satisfied_by_decisions_read():
    from eigenheim.mcp_auth import require_scope

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "dec-key", scopes=["decisions:read"])
    require_scope(c, raw, "decisions:read")


def test_scope_map_decisions_read_denied_for_tasks_read_key():
    from eigenheim.mcp_auth import require_scope, McpAuthError

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "tasks-only", scopes=["tasks:read"])
    with pytest.raises(McpAuthError, match="scope"):
        require_scope(c, raw, "decisions:read")
