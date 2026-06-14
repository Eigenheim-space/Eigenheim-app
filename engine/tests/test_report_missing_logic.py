"""Regression: report_detail must not 500 when a report tile references a logic id
that no longer exists in the DB (e.g. the logic was deleted but the report still lists it).

Original failure: reports.py -> _metric(conn, None, …) -> compute.py `for inp in logic.inputs`
raised AttributeError: 'NoneType' object has no attribute 'inputs', surfacing as HTTP 500.
"""
from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from eigenheim import store_db
from eigenheim.app import app


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


def test_report_detail_survives_missing_logic(client):
    conn: sqlite3.Connection = client.app.state.conn
    # A report whose tile points at a logic row that does not exist.
    store_db.create_report(conn, "rmissing", "Missing logic report", 7, ["does_not_exist"])

    resp = client.get("/reports/rmissing")
    assert resp.status_code == 200, f"expected 200, got {resp.status_code}: {resp.text[:300]}"

    body = resp.json()
    assert body["id"] == "rmissing"
    # The dangling tile must not appear (and must not have crashed the whole report).
    assert all(m["id"] != "does_not_exist" for m in body["metrics"])


def test_report_detail_mixed_valid_and_missing_logic(client):
    """A report with one real logic + one dangling id returns the real metric, drops the dangling."""
    conn: sqlite3.Connection = client.app.state.conn
    # `activation` is a default seeded logic id; pair it with a missing one.
    store_db.create_report(conn, "rmixed", "Mixed", 7, ["activation", "ghost_logic"])

    resp = client.get("/reports/rmixed")
    assert resp.status_code == 200, f"expected 200, got {resp.status_code}: {resp.text[:300]}"

    ids = [m["id"] for m in resp.json()["metrics"]]
    assert "ghost_logic" not in ids
    assert "activation" in ids


def test_seeded_reports_have_no_dangling_logic(client):
    """A fresh install's default reports must not reference a non-existent logic id
    (a seed-data bug would otherwise silently drop tiles)."""
    conn: sqlite3.Connection = client.app.state.conn
    report_ids = [row[0] for row in conn.execute("SELECT id FROM reports").fetchall()]
    assert report_ids, "expected seeded default report definitions"
    for rid in report_ids:
        r = store_db.get_report_def(conn, rid)
        for lid in r.logic_ids:
            assert store_db.get_logic(conn, lid) is not None, \
                f"seeded report '{rid}' references missing logic '{lid}'"
