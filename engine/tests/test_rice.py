"""RICE prioritization backend tests (R1–R4).

R1  — Migration 9: rice_items table created with required columns; index on
       reach_logic_id; user_version bumped; migration idempotent.
R2  — Store helpers: create / list / get / update / delete.
R2C — Compute: metric-backed Reach (bound Logic); manual Reach; Effort=0 guarded;
       stale when Logic missing; stale when Logic compute fails (stale-gate);
       GET /rice sorted by score desc; reach_trace_ref carries the formula string.
R3  — REST CRUD: POST /rice; GET /rice (sorted); GET /rice/{id}; PATCH /rice/{id};
       DELETE /rice/{id}; unknown reach_logic_id rejected on create; 404 on unknown id.
R4  — MCP read tools: list_rice / get_rice_item; rice:read and umbrella read
       scopes accepted; bad key returns error dict (no exception to wire);
       unknown item returns error dict; stale-gate in MCP (Logic missing);
       _hint injected on first call; no write tool exists on MCP.
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
# R1 — Migration 9: schema
# ─────────────────────────────────────────────────────────────────────────────

def test_migration9_creates_rice_items_table():
    c = _conn()
    tables = {r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert "rice_items" in tables, "rice_items table missing after migration 9"


def test_migration9_bumps_user_version():
    c = _conn()
    (v,) = c.execute("PRAGMA user_version").fetchone()
    assert v == len(store_db._MIGRATIONS), (
        f"user_version should be {len(store_db._MIGRATIONS)}, got {v}"
    )


def test_migration9_idempotent():
    c = _conn()
    v1 = store_db.run_migrations(c)
    v2 = store_db.run_migrations(c)
    assert v1 == v2


def test_rice_items_columns():
    c = _conn()
    cols = {r[1] for r in c.execute("PRAGMA table_info(rice_items)").fetchall()}
    required = {
        "id", "name", "reach_logic_id", "reach_manual",
        "impact", "confidence", "effort", "source", "created_at",
    }
    assert required <= cols, f"missing columns: {required - cols}"


def test_rice_items_index_on_reach_logic_id():
    c = _conn()
    indexes = {r[1] for r in c.execute(
        "SELECT type, name FROM sqlite_master WHERE type='index'"
    ).fetchall()}
    assert "ix_rice_items_logic" in indexes


# ─────────────────────────────────────────────────────────────────────────────
# R2 — Store helpers
# ─────────────────────────────────────────────────────────────────────────────

def test_create_rice_item_minimal():
    c = _conn()
    item = store_db.create_rice_item(c, "Ship new onboarding", impact=2.0, confidence=0.8, effort=2.0)
    assert item["id"].startswith("rice_")
    assert item["name"] == "Ship new onboarding"
    assert item["impact"] == pytest.approx(2.0)
    assert item["confidence"] == pytest.approx(0.8)
    assert item["effort"] == pytest.approx(2.0)
    assert item["reach_logic_id"] == ""
    assert item["reach_manual"] is None
    assert item["source"] == "user"


def test_create_rice_item_with_reach_logic_id():
    c = _conn()
    item = store_db.create_rice_item(
        c, "Activation experiment",
        impact=1.0, confidence=1.0, effort=1.0,
        reach_logic_id="activation",
    )
    assert item["reach_logic_id"] == "activation"
    assert item["reach_manual"] is None


def test_create_rice_item_with_reach_manual():
    c = _conn()
    item = store_db.create_rice_item(
        c, "Manual Reach item",
        impact=1.0, confidence=0.5, effort=3.0,
        reach_manual=5000.0,
    )
    assert item["reach_manual"] == pytest.approx(5000.0)
    assert item["reach_logic_id"] == ""


def test_list_rice_items_empty():
    c = _conn()
    assert store_db.list_rice_items(c) == []


def test_list_rice_items_returns_all():
    c = _conn()
    store_db.create_rice_item(c, "A", impact=1.0, confidence=1.0, effort=1.0)
    store_db.create_rice_item(c, "B", impact=2.0, confidence=1.0, effort=1.0)
    items = store_db.list_rice_items(c)
    assert len(items) == 2


def test_get_rice_item_found():
    c = _conn()
    item = store_db.create_rice_item(c, "Find me", impact=1.0, confidence=1.0, effort=1.0)
    fetched = store_db.get_rice_item(c, item["id"])
    assert fetched is not None
    assert fetched["name"] == "Find me"


def test_get_rice_item_not_found():
    c = _conn()
    assert store_db.get_rice_item(c, "rice_missing") is None


def test_update_rice_item_name():
    c = _conn()
    item = store_db.create_rice_item(c, "Old Name", impact=1.0, confidence=1.0, effort=1.0)
    updated = store_db.update_rice_item(c, item["id"], name="New Name")
    assert updated["name"] == "New Name"


def test_update_rice_item_effort():
    c = _conn()
    item = store_db.create_rice_item(c, "Item", impact=1.0, confidence=1.0, effort=2.0)
    updated = store_db.update_rice_item(c, item["id"], effort=4.0)
    assert updated["effort"] == pytest.approx(4.0)


def test_update_rice_item_not_found():
    c = _conn()
    assert store_db.update_rice_item(c, "rice_missing", name="X") is None


def test_delete_rice_item_removes_row():
    c = _conn()
    item = store_db.create_rice_item(c, "Delete me", impact=1.0, confidence=1.0, effort=1.0)
    ok = store_db.delete_rice_item(c, item["id"])
    assert ok is True
    assert store_db.get_rice_item(c, item["id"]) is None


def test_delete_rice_item_not_found():
    c = _conn()
    assert store_db.delete_rice_item(c, "rice_missing") is False


# ─────────────────────────────────────────────────────────────────────────────
# R2C — Compute
# ─────────────────────────────────────────────────────────────────────────────

def test_compute_rice_manual_reach():
    """Manual Reach item: score = (reach_manual × impact × confidence) / effort."""
    from eigenheim.rice import compute_rice_item
    c = _conn()
    item = store_db.create_rice_item(
        c, "Manual", impact=2.0, confidence=0.5, effort=4.0, reach_manual=1000.0
    )
    result = compute_rice_item(c, item)
    assert result["status"] == "manual"
    assert result["reach_value"] == pytest.approx(1000.0)
    assert result["reach_trace_ref"] is None
    expected_score = (1000.0 * 2.0 * 0.5) / 4.0
    assert result["score"] == pytest.approx(expected_score)


def test_compute_rice_metric_backed_reach():
    """Metric-backed Reach: Reach comes from the bound Logic's live compute."""
    from eigenheim.rice import compute_rice_item
    c = _conn()
    # "mau" is a bundled Logic that computes from the seeded events DB.
    item = store_db.create_rice_item(
        c, "MAU backed", impact=1.0, confidence=1.0, effort=2.0,
        reach_logic_id="mau",
    )
    result = compute_rice_item(c, item)
    # Status must be 'live' (Logic exists and the seeded DB computes something).
    assert result["status"] == "live"
    # reach_trace_ref must be populated (the formula string from the Logic).
    assert result["reach_trace_ref"] is not None
    assert isinstance(result["reach_trace_ref"], str)
    assert len(result["reach_trace_ref"]) > 0
    # score formula: (reach_value × 1.0 × 1.0) / 2.0
    if result["reach_value"] is not None:
        expected = result["reach_value"] / 2.0
        assert result["score"] == pytest.approx(expected)


def test_compute_rice_effort_zero_guard():
    """Effort == 0 → score = None, status = 'stale'."""
    from eigenheim.rice import compute_rice_item
    c = _conn()
    item = store_db.create_rice_item(
        c, "Zero effort", impact=3.0, confidence=1.0, effort=0.0,
        reach_manual=5000.0,
    )
    result = compute_rice_item(c, item)
    assert result["score"] is None
    assert result["status"] == "stale"


def test_compute_rice_stale_when_logic_missing():
    """When the bound Logic is deleted, status = 'stale'."""
    from eigenheim.rice import compute_rice_item
    c = _conn()
    item = store_db.create_rice_item(
        c, "Orphan", impact=1.0, confidence=1.0, effort=1.0,
        reach_logic_id="nonexistent_logic_xyz",
    )
    result = compute_rice_item(c, item)
    assert result["status"] == "stale"
    assert result["score"] is None
    assert result["reach_value"] is None


def test_compute_rice_manual_reach_none_is_stale():
    """No Logic bound AND reach_manual=None → stale."""
    from eigenheim.rice import compute_rice_item
    c = _conn()
    item = store_db.create_rice_item(
        c, "Incomplete", impact=1.0, confidence=1.0, effort=1.0,
    )
    result = compute_rice_item(c, item)
    assert result["status"] == "stale"
    assert result["score"] is None


def test_compute_rice_list_sorted_by_score_desc():
    """GET /rice items are sorted by score descending; stale items last."""
    from eigenheim.rice import compute_rice_list
    c = _conn()
    # Item with score 10: (100 × 1 × 1) / 10 = 10
    store_db.create_rice_item(c, "Low", impact=1.0, confidence=1.0, effort=10.0, reach_manual=100.0)
    # Item with score 500: (1000 × 1 × 1) / 2 = 500
    store_db.create_rice_item(c, "High", impact=1.0, confidence=1.0, effort=2.0, reach_manual=1000.0)
    # Stale item
    store_db.create_rice_item(c, "Stale", impact=1.0, confidence=1.0, effort=0.0, reach_manual=9999.0)

    results = compute_rice_list(c)
    assert len(results) == 3
    # First must be the highest score.
    assert results[0]["name"] == "High"
    assert results[0]["score"] == pytest.approx(500.0)
    # Second.
    assert results[1]["name"] == "Low"
    assert results[1]["score"] == pytest.approx(10.0)
    # Stale last.
    assert results[2]["name"] == "Stale"
    assert results[2]["score"] is None


def test_compute_rice_score_formula():
    """Explicit formula check: (Reach × Impact × Confidence) / Effort."""
    from eigenheim.rice import compute_rice_item
    c = _conn()
    item = store_db.create_rice_item(
        c, "Formula check",
        impact=3.0, confidence=0.8, effort=4.0, reach_manual=2000.0,
    )
    result = compute_rice_item(c, item)
    expected = (2000.0 * 3.0 * 0.8) / 4.0
    assert result["score"] == pytest.approx(expected)


# ─────────────────────────────────────────────────────────────────────────────
# R3 — REST CRUD
# ─────────────────────────────────────────────────────────────────────────────

def test_rest_create_rice_item_minimal(client):
    resp = client.post("/rice", json={"name": "Feature A", "impact": 1.0, "confidence": 1.0, "effort": 1.0})
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "Feature A"
    assert "score" in data
    assert "status" in data


def test_rest_create_rice_item_with_reach_manual(client):
    resp = client.post(
        "/rice",
        json={"name": "Manual Reach", "impact": 2.0, "confidence": 0.5, "effort": 3.0, "reach_manual": 5000.0},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "manual"
    assert data["reach_value"] == pytest.approx(5000.0)
    expected = (5000.0 * 2.0 * 0.5) / 3.0
    assert data["score"] == pytest.approx(expected)


def test_rest_create_rice_item_with_reach_logic_id(client):
    resp = client.post(
        "/rice",
        json={"name": "Metric backed", "impact": 1.0, "confidence": 1.0, "effort": 2.0,
              "reach_logic_id": "mau"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] in ("live", "stale")  # live if events exist; stale on empty DB
    assert data.get("reach_logic_id") == "mau"


def test_rest_create_rice_item_unknown_reach_logic_id(client):
    resp = client.post(
        "/rice",
        json={"name": "Bad ref", "impact": 1.0, "confidence": 1.0, "effort": 1.0,
              "reach_logic_id": "nonexistent_xyz"},
    )
    assert resp.status_code == 422


def test_rest_list_rice_empty(client):
    resp = client.get("/rice")
    assert resp.status_code == 200
    assert resp.json() == []


def test_rest_list_rice_sorted_by_score_desc(client):
    # High score: (1000 × 1 × 1) / 1 = 1000
    client.post("/rice", json={"name": "High", "impact": 1.0, "confidence": 1.0,
                               "effort": 1.0, "reach_manual": 1000.0})
    # Low score: (10 × 1 × 1) / 1 = 10
    client.post("/rice", json={"name": "Low", "impact": 1.0, "confidence": 1.0,
                               "effort": 1.0, "reach_manual": 10.0})
    resp = client.get("/rice")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    assert data[0]["name"] == "High"
    assert data[1]["name"] == "Low"
    assert data[0]["score"] > data[1]["score"]


def test_rest_get_rice_item(client):
    created = client.post(
        "/rice",
        json={"name": "My item", "impact": 2.0, "confidence": 1.0, "effort": 1.0,
              "reach_manual": 500.0},
    ).json()
    fetched = client.get(f"/rice/{created['id']}").json()
    assert fetched["name"] == "My item"
    assert fetched["score"] == pytest.approx(created["score"])


def test_rest_get_rice_item_not_found(client):
    resp = client.get("/rice/rice_missing")
    assert resp.status_code == 404


def test_rest_patch_rice_item(client):
    created = client.post(
        "/rice",
        json={"name": "Old", "impact": 1.0, "confidence": 1.0, "effort": 1.0},
    ).json()
    patched = client.patch(
        f"/rice/{created['id']}",
        json={"name": "Updated", "effort": 2.0},
    ).json()
    assert patched["name"] == "Updated"
    assert patched["effort"] == pytest.approx(2.0)


def test_rest_patch_rice_item_not_found(client):
    resp = client.patch("/rice/rice_missing", json={"name": "X"})
    assert resp.status_code == 404


def test_rest_delete_rice_item(client):
    created = client.post(
        "/rice", json={"name": "Delete me", "impact": 1.0, "confidence": 1.0, "effort": 1.0}
    ).json()
    resp = client.delete(f"/rice/{created['id']}")
    assert resp.status_code == 200
    assert client.get(f"/rice/{created['id']}").status_code == 404


def test_rest_delete_rice_item_not_found(client):
    resp = client.delete("/rice/rice_missing")
    assert resp.status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
# R4 — MCP read tools
# ─────────────────────────────────────────────────────────────────────────────

def test_mcp_list_rice_read_scope_ok():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read-key", scopes=["read"])
    store_db.create_rice_item(c, "A", impact=1.0, confidence=1.0, effort=1.0, reach_manual=100.0)
    store_db.create_rice_item(c, "B", impact=2.0, confidence=1.0, effort=1.0, reach_manual=200.0)

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_rice(key=raw)
        assert "items" in result
        assert result["count"] == 2
        # First call gets the hint.
        assert "_hint" in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_list_rice_rice_read_scope_ok():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "rice-read", scopes=["rice:read"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_rice(key=raw)
        assert "items" in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_list_rice_bad_key_returns_error():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_rice(key="eig_" + "z" * 64)
        assert "error" in result
        assert result["error"] == "auth_error"
        assert "_hint" not in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_list_rice_sorted_by_score_desc():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read", scopes=["read"])
    store_db.create_rice_item(c, "Low", impact=1.0, confidence=1.0, effort=10.0, reach_manual=100.0)
    store_db.create_rice_item(c, "High", impact=1.0, confidence=1.0, effort=2.0, reach_manual=1000.0)

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_rice(key=raw)
        items = result["items"]
        assert items[0]["name"] == "High"
        assert items[1]["name"] == "Low"
        assert items[0]["score"] > items[1]["score"]
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_get_rice_item_found_with_trace_ref():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read", scopes=["read"])
    item = store_db.create_rice_item(
        c, "Metric item", impact=1.0, confidence=1.0, effort=2.0,
        reach_logic_id="mau",
    )

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.get_rice_item(key=raw, item_id=item["id"])
        assert "name" in result
        assert result["name"] == "Metric item"
        # reach_trace_ref is set when Logic computes (may be None on empty-ish DB
        # but the field must exist).
        assert "reach_trace_ref" in result
        assert "score" in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_get_rice_item_not_found():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read", scopes=["read"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.get_rice_item(key=raw, item_id="rice_missing")
        assert "error" in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_get_rice_item_stale_gate_logic_missing():
    """When the bound Logic is missing, the MCP tool returns stale — no exception."""
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "read", scopes=["read"])
    item = store_db.create_rice_item(
        c, "Orphan", impact=1.0, confidence=1.0, effort=1.0,
        reach_logic_id="nonexistent_logic_xyz",
    )

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.get_rice_item(key=raw, item_id=item["id"])
        assert result["status"] == "stale"
        assert result["score"] is None
        assert "error" not in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_no_write_tool_for_rice():
    """RICE items are human-only in v1: no MCP write tools must exist."""
    import eigenheim.mcp_server as ms

    assert not hasattr(ms, "create_rice_item"), (
        "mcp_server must NOT expose create_rice_item — RICE write is human-only in v1"
    )
    assert not hasattr(ms, "update_rice_item"), (
        "mcp_server must NOT expose update_rice_item — RICE write is human-only in v1"
    )
    assert not hasattr(ms, "delete_rice_item"), (
        "mcp_server must NOT expose delete_rice_item — RICE write is human-only in v1"
    )


def test_scope_map_rice_read_satisfied_by_read():
    from eigenheim.mcp_auth import require_scope

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "umbrella", scopes=["read"])
    require_scope(c, raw, "rice:read")  # must not raise


def test_scope_map_rice_read_satisfied_by_rice_read():
    from eigenheim.mcp_auth import require_scope

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "rice-key", scopes=["rice:read"])
    require_scope(c, raw, "rice:read")  # must not raise


def test_scope_map_rice_read_denied_for_tasks_read_key():
    from eigenheim.mcp_auth import require_scope, McpAuthError

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "tasks-only", scopes=["tasks:read"])
    with pytest.raises(McpAuthError, match="scope"):
        require_scope(c, raw, "rice:read")


# ─────────────────────────────────────────────────────────────────────────────
# No LLM import — determinism guard
# ─────────────────────────────────────────────────────────────────────────────

def test_no_llm_import_in_rice_module():
    import eigenheim.rice as rice_mod
    source_file = rice_mod.__file__ or ""
    with open(source_file, encoding="utf-8") as fh:
        src = fh.read()
    for pkg in ("openai", "anthropic", "ollama", "langchain", "litellm", "openrouter"):
        assert f"import {pkg}" not in src and f"from {pkg}" not in src, (
            f"rice.py must not import {pkg}"
        )
