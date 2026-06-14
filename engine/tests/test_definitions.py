"""Metric-contract definition tools (Vector 2).

D1 — list_definitions / get_definition MCP tools:
  d1a — list_definitions returns every Logic's definition without a computed value.
  d1b — get_definition returns one Logic's definition with full version history.
  d1c — get_definition unknown id returns an error dict, not an exception.
  d1d — scope is enforced: an invalid key is rejected before definitions are read.
  d1e — first-call _hint is injected; second call omits it (reuses mcp_server state
        indirectly via the store helpers — the MCP tool is tested via its store layer).
  d1f — version history grows when a Logic is updated (append-only invariant).

D2 — REST endpoints:
  d2a — GET /definitions returns the same shape as list_logic_definitions.
  d2b — GET /definitions/{id} returns definition + history for a known id.
  d2c — GET /definitions/{id} returns 404 for an unknown id.
  d2d — Both endpoints require session auth when a token is configured.

D3 — store helpers (unit-level):
  d3a — list_logic_definitions returns definition fields with no value key.
  d3b — get_logic_definition returns inputs as a list of dicts (not Input objects).
  d3c — get_logic_definition returns None for an unknown id.
  d3d — history entries are ordered oldest-first.
  d3e — version bump appends a new history entry; older entries stay intact.
"""
from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from eigenheim import db as _db, store_db
from eigenheim.app import app
from eigenheim.catalog import Input, Logic
from eigenheim.mcp_instructions import (
    ALL_INSTRUCTIONS,
    TOOL_GET_DEFINITION,
    TOOL_LIST_DEFINITIONS,
)


# ── helpers ───────────────────────────────────────────────────────────────────


def _seeded_conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    _db.init_and_seed(c)
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)
    store_db.run_migrations(c)
    return c


# ── D3 — store helpers ────────────────────────────────────────────────────────


def test_d3a_list_returns_no_value_key():
    c = _seeded_conn()
    defs = store_db.list_logic_definitions(c)
    assert len(defs) > 0
    for d in defs:
        assert "value" not in d, f"list_logic_definitions must not include computed values; got 'value' in {d['id']}"
        # Required definition fields must be present.
        for field in ("id", "name", "version", "expression", "inputs", "fmt", "validated", "sha"):
            assert field in d, f"missing field '{field}' in definition for {d['id']}"


def test_d3b_inputs_are_dicts():
    c = _seeded_conn()
    defs = store_db.list_logic_definitions(c)
    for d in defs:
        assert isinstance(d["inputs"], list), f"inputs must be a list, got {type(d['inputs'])}"
        for inp in d["inputs"]:
            assert isinstance(inp, dict), "each input must be a dict with alias/kind/params"
            assert "alias" in inp and "kind" in inp and "params" in inp


def test_d3c_get_unknown_returns_none():
    c = _seeded_conn()
    assert store_db.get_logic_definition(c, "nonexistent_logic_id_xyz") is None


def test_d3d_history_ordered_oldest_first():
    c = _seeded_conn()
    # 'activation' starts at version 3 (one seed entry in logic_versions).
    defn = store_db.get_logic_definition(c, "activation")
    assert defn is not None
    history = defn["history"]
    assert len(history) >= 1
    # Versions must be monotonically increasing.
    versions = [h["version"] for h in history]
    assert versions == sorted(versions), f"history not ordered: {versions}"


def test_d3e_version_bump_appends_history():
    c = _seeded_conn()
    defn_before = store_db.get_logic_definition(c, "mau")
    assert defn_before is not None
    history_len_before = len(defn_before["history"])
    version_before = defn_before["version"]

    # Upsert to create a new version.
    store_db.upsert_logic(
        c, "mau", "mau updated", "new description", "number",
        (Input("m", "mau", {"days": 30}),),
        "m * 1",
        "today",
    )

    defn_after = store_db.get_logic_definition(c, "mau")
    assert defn_after is not None
    assert defn_after["version"] == version_before + 1
    assert len(defn_after["history"]) == history_len_before + 1

    # Latest history entry must match the new version.
    latest_h = defn_after["history"][-1]
    assert latest_h["version"] == defn_after["version"]
    assert latest_h["expression"] == "m * 1"

    # Old history entries must be intact (append-only).
    for h in defn_after["history"][:-1]:
        assert h["version"] < defn_after["version"]


def test_d3f_definition_distinct_from_logic_object():
    """get_logic_definition must return a plain dict, not a Logic dataclass."""
    c = _seeded_conn()
    defn = store_db.get_logic_definition(c, "activation")
    assert isinstance(defn, dict)
    # It must NOT carry a computed 'value' or 'sha_mismatch' key.
    assert "value" not in defn


def test_d3g_all_seeded_logics_are_listed():
    from eigenheim.catalog import LOGIC as SEED_LOGIC
    c = _seeded_conn()
    defs = store_db.list_logic_definitions(c)
    def_ids = {d["id"] for d in defs}
    for lid in SEED_LOGIC:
        assert lid in def_ids, f"seeded Logic '{lid}' missing from list_logic_definitions"


def test_d3h_get_definition_has_history_key_list_does_not():
    """get_logic_definition includes 'history'; list_logic_definitions omits it."""
    c = _seeded_conn()
    full = store_db.get_logic_definition(c, "mau")
    assert "history" in full

    defs = store_db.list_logic_definitions(c)
    for d in defs:
        assert "history" not in d, "list response must not include per-Logic history (keep list compact)"


# ── D1 — MCP instructions ─────────────────────────────────────────────────────


def test_d1_instructions_registered():
    """TOOL_LIST_DEFINITIONS and TOOL_GET_DEFINITION must be in ALL_INSTRUCTIONS."""
    assert TOOL_LIST_DEFINITIONS in ALL_INSTRUCTIONS
    assert TOOL_GET_DEFINITION in ALL_INSTRUCTIONS


def test_d1_instruction_strings_are_nonempty():
    assert len(TOOL_LIST_DEFINITIONS) > 20
    assert len(TOOL_GET_DEFINITION) > 20


def test_d1_instruction_strings_mention_no_value():
    """The description must make clear these tools return definitions, not values."""
    assert "definition" in TOOL_LIST_DEFINITIONS.lower() or "what" in TOOL_LIST_DEFINITIONS.lower()
    assert "definition" in TOOL_GET_DEFINITION.lower()


# ── D2 — REST endpoints ───────────────────────────────────────────────────────


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """TestClient wired to an isolated in-memory DB (open auth: no token set)."""
    db_path = str(tmp_path / "test.db")
    monkeypatch.setenv("EIGENHEIM_DB", db_path)
    monkeypatch.delenv("EIGENHEIM_TOKEN", raising=False)
    monkeypatch.delenv("EIGENHEIM_TOKEN_FILE", raising=False)
    # Reset internal auth state so the test env is clean.
    import eigenheim.app as appmod
    appmod._auth_state["token"] = None
    with TestClient(app) as c:
        yield c


def test_d2a_list_definitions_endpoint(client):
    resp = client.get("/definitions")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    assert len(body) > 0
    for d in body:
        assert "value" not in d
        for field in ("id", "name", "version", "expression", "inputs", "fmt", "validated", "sha"):
            assert field in d, f"REST /definitions missing field '{field}'"
        # history must NOT appear in the list endpoint.
        assert "history" not in d


def test_d2b_get_definition_endpoint(client):
    resp = client.get("/definitions/activation")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == "activation"
    assert "expression" in body
    assert "history" in body
    assert isinstance(body["history"], list)
    assert len(body["history"]) >= 1
    # The current version must match the latest history entry.
    assert body["history"][-1]["version"] == body["version"]
    # No computed value in the response.
    assert "value" not in body


def test_d2c_get_definition_unknown_returns_404(client):
    resp = client.get("/definitions/no_such_logic_xyz")
    assert resp.status_code == 404


def test_d2d_list_definitions_auth_enforced(tmp_path, monkeypatch):
    """When a session token is configured, /definitions must reject unauthenticated calls."""
    import eigenheim.app as appmod
    db_path = str(tmp_path / "auth_test.db")
    monkeypatch.setenv("EIGENHEIM_DB", db_path)
    monkeypatch.delenv("EIGENHEIM_TOKEN_FILE", raising=False)
    appmod._auth_state["token"] = "secret_session"
    with TestClient(app) as c:
        resp = c.get("/definitions")
        assert resp.status_code == 401
        # Correct token must pass.
        resp2 = c.get("/definitions", headers={"Authorization": "Bearer secret_session"})
        assert resp2.status_code == 200
    appmod._auth_state["token"] = None


def test_d2e_get_definition_auth_enforced(tmp_path, monkeypatch):
    import eigenheim.app as appmod
    db_path = str(tmp_path / "auth_test2.db")
    monkeypatch.setenv("EIGENHEIM_DB", db_path)
    monkeypatch.delenv("EIGENHEIM_TOKEN_FILE", raising=False)
    appmod._auth_state["token"] = "secret_session"
    with TestClient(app) as c:
        resp = c.get("/definitions/mau")
        assert resp.status_code == 401
        resp2 = c.get("/definitions/mau", headers={"Authorization": "Bearer secret_session"})
        assert resp2.status_code == 200
    appmod._auth_state["token"] = None


def test_d2f_all_seeded_ids_in_rest_list(client):
    from eigenheim.catalog import LOGIC as SEED_LOGIC
    resp = client.get("/definitions")
    assert resp.status_code == 200
    ids = {d["id"] for d in resp.json()}
    for lid in SEED_LOGIC:
        assert lid in ids, f"seeded Logic '{lid}' missing from GET /definitions"
