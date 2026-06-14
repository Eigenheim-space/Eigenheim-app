"""Regression test: SQL injection via Logic params must not execute injected SQL.

Pins the surface described in the 2026-06-14 code-quality audit (#1 Critical fix):
  - compute.py queries now use bound parameters (? placeholders) instead of
    f-string interpolation.
  - Both create paths (REST app.py + MCP mcp_server.py) validate kind and
    params shape via dsl.validate_inputs before persisting.

Three layers are tested:
  1. dsl.validate_inputs rejects unknown kinds and missing/wrong-typed params.
  2. Creating a Logic via store_db + compute_value with a malicious event name
     treats the value as a literal string (no injection executed).
  3. The REST create_logic endpoint returns 422 for an invalid kind.
"""
from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from eigenheim import db as _db, dsl, store_db
from eigenheim.app import app
from eigenheim.catalog import Input, Logic
from eigenheim.compute import compute_value


# ── helpers ───────────────────────────────────────────────────────────────────


def _full_conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    _db.init_and_seed(c)
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)
    store_db.run_migrations(c)
    return c


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.db")
    monkeypatch.setenv("EIGENHEIM_DB", db_path)
    monkeypatch.delenv("EIGENHEIM_TOKEN", raising=False)
    monkeypatch.delenv("EIGENHEIM_TOKEN_FILE", raising=False)
    import eigenheim.app as appmod
    appmod._auth_state["token"] = None
    with TestClient(app) as c:
        yield c


# ── 1. validate_inputs whitelist ──────────────────────────────────────────────


def test_validate_inputs_rejects_unknown_kind():
    """An unrecognised kind is rejected before any DB write."""
    inp = Input("x", "unknown_evil_kind", {"event": "signup"})
    err = dsl.validate_inputs([inp])
    assert err is not None
    assert "unknown input kind" in err


def test_validate_inputs_rejects_missing_required_param():
    """count kind without 'event' key must be rejected."""
    inp = Input("x", "count", {})
    err = dsl.validate_inputs([inp])
    assert err is not None
    assert "missing required param 'event'" in err


def test_validate_inputs_rejects_wrong_param_type():
    """funnel within_days must be int/float, not a string."""
    inp = Input("x", "funnel", {"from": "a", "to": "b", "within_days": "7"})
    err = dsl.validate_inputs([inp])
    assert err is not None
    assert "within_days" in err


def test_validate_inputs_accepts_all_valid_kinds():
    """All six compute kinds pass validate_inputs with correct params."""
    valid = [
        Input("a", "unique",          {"event": "signup"}),
        Input("b", "count",           {"event": "signup"}),
        Input("c", "funnel",          {"from": "signup", "to": "first_report", "within_days": 7}),
        Input("d", "retained",        {"base": "signup", "ret": "session_start", "after_days": 7}),
        Input("e", "mau",             {"days": 30}),
        Input("f", "median_gap_days", {"from": "signup", "to": "first_report"}),
        Input("g", "logic",           {"ref": "some_logic"}),
    ]
    assert dsl.validate_inputs(valid) is None


# ── 2. Compute-layer: malicious event name treated as literal ─────────────────


def test_compute_malicious_event_name_returns_zero_not_injected():
    """A Logic with a SQL-injection payload in event name must return 0, not run
    injected SQL.  The bind-parameter fix makes the payload a literal string that
    matches no event row — the result is 0.0, not an error and not injected data.
    """
    c = _full_conn()
    # Sentinel: how many users are in the DB (to detect if injection 'worked').
    (total_users,) = c.execute("SELECT count(DISTINCT user_id) FROM events").fetchone()
    assert total_users > 0, "seed must have events"

    # A payload that, if interpolated, would collapse the WHERE to always-true.
    evil_event = "x' OR '1'='1"
    lg = Logic(
        "evil_test", "evil", "", 1,
        (Input("u", "count", {"event": evil_event}),),
        "u", "number", "test",
    )
    START = _db.PERIOD_START.strftime("%Y-%m-%d %H:%M:%S")
    END = _db.PERIOD_END.strftime("%Y-%m-%d %H:%M:%S")
    v, _ = compute_value(c, lg, START, END)

    # With bound params the payload is a literal string; no event is named that,
    # so the count is 0.  An unbound query would return total_users (injection win).
    assert v == 0.0, (
        f"expected 0 (literal no-match), got {v}; "
        "non-zero means the payload matched real rows — possible injection"
    )
    # Confirm we are NOT accidentally getting the full table count.
    assert v != total_users, "result must not equal total event count (injection signature)"


def test_compute_union_payload_returns_zero():
    """A UNION SELECT payload in event name must return 0 via bound params."""
    c = _full_conn()
    evil_event = "x' UNION SELECT count(*) FROM events --"
    lg = Logic(
        "union_test", "union", "", 1,
        (Input("u", "unique", {"event": evil_event}),),
        "u", "number", "test",
    )
    START = _db.PERIOD_START.strftime("%Y-%m-%d %H:%M:%S")
    END = _db.PERIOD_END.strftime("%Y-%m-%d %H:%M:%S")
    v, _ = compute_value(c, lg, START, END)
    assert v == 0.0


# ── 3. REST endpoint: invalid kind → 422 ─────────────────────────────────────


def test_rest_create_logic_rejects_unknown_kind(client):
    """POST /logic with an unknown input kind must return 422."""
    payload = {
        "name": "bad metric",
        "expression": "x",
        "inputs": [{"alias": "x", "kind": "evil_kind", "params": {"event": "signup"}}],
    }
    r = client.post("/logic", json=payload)
    assert r.status_code == 422


def test_rest_create_logic_rejects_missing_param(client):
    """POST /logic with a count input missing 'event' must return 422."""
    payload = {
        "name": "bad metric",
        "expression": "x",
        "inputs": [{"alias": "x", "kind": "count", "params": {}}],
    }
    r = client.post("/logic", json=payload)
    assert r.status_code == 422


def test_rest_create_logic_accepts_valid_input(client):
    """POST /logic with a well-formed count input must succeed (2xx)."""
    payload = {
        "name": "signup count",
        "expression": "x",
        "inputs": [{"alias": "x", "kind": "count", "params": {"event": "signup"}}],
    }
    r = client.post("/logic", json=payload)
    assert r.status_code == 200


def test_rest_create_logic_rejects_logic_kind_without_ref(client):
    """POST /logic with a logic-kind input missing 'ref' must return 422, not 500.

    Guards the store_db.logic_deps / would_cycle path: even if a caller bypassed
    the normal validation, a logic input with no 'ref' key must never KeyError into
    a 500. The create path catches it at dsl.validate_inputs before it reaches the
    store, so the observable contract is a 422.
    """
    payload = {
        "name": "bad logic ref",
        "expression": "x",
        "inputs": [{"alias": "x", "kind": "logic", "params": {}}],
    }
    r = client.post("/logic", json=payload)
    assert r.status_code == 422
    assert r.status_code != 500


def test_validate_inputs_rejects_logic_kind_without_ref():
    """dsl.validate_inputs must reject a logic input with empty params."""
    inp = Input("x", "logic", {})
    err = dsl.validate_inputs([inp])
    assert err is not None
    assert "ref" in err
