"""Report mutation tests: update / delete / duplicate + API routes.

R1  — Repo: update_report (name, period_days, logic_ids).
R2  — Repo: delete_report (cascade to snapshots + snapshot_metrics + report_logic).
R3  — Repo: duplicate_report (no snapshot copy, new id).
R4  — Idempotency guard: deleting a seeded default and re-running seed_defaults
       must NOT re-create the deleted report.
R5  — REST: PATCH /reports/{id}, DELETE /reports/{id}, POST /reports/{id}/duplicate.
"""
from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from eigenheim import db as _db
from eigenheim import store_db
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


def _bare_conn() -> sqlite3.Connection:
    """Schema-only, no seed data."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    store_db.ensure_schema(c)
    return c


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """TestClient with an isolated file DB and no auth."""
    db_path = str(tmp_path / "test.db")
    monkeypatch.setenv("EIGENHEIM_DB", db_path)
    monkeypatch.delenv("EIGENHEIM_TOKEN", raising=False)
    monkeypatch.delenv("EIGENHEIM_TOKEN_FILE", raising=False)
    import eigenheim.app as appmod
    appmod._auth_state["token"] = None
    with TestClient(app) as c:
        yield c


# ─────────────────────────────────────────────────────────────────────────────
# R1 — update_report
# ─────────────────────────────────────────────────────────────────────────────

def test_update_name():
    c = _conn()
    r = store_db.update_report(c, "activation", name="Activation v2")
    assert r is not None
    assert r.name == "Activation v2"
    # persisted
    assert store_db.get_report_def(c, "activation").name == "Activation v2"


def test_update_period_days():
    c = _conn()
    r = store_db.update_report(c, "activation", period_days=7)
    assert r is not None
    assert r.period_days == 7


def test_update_logic_ids_replaces_existing():
    c = _conn()
    original = store_db.get_report_def(c, "activation")
    assert "activation" in original.logic_ids
    r = store_db.update_report(c, "activation", logic_ids=["mau"])
    assert r is not None
    assert r.logic_ids == ("mau",)
    # old rows gone
    rows = c.execute("SELECT count(*) FROM report_logic WHERE report_id='activation'").fetchone()[0]
    assert rows == 1


def test_update_multiple_fields():
    c = _conn()
    r = store_db.update_report(c, "activation", name="New", period_days=14, logic_ids=["mau", "ttv"])
    assert r is not None
    assert r.name == "New"
    assert r.period_days == 14
    assert r.logic_ids == ("mau", "ttv")


def test_update_no_fields_is_noop():
    c = _conn()
    before = store_db.get_report_def(c, "activation")
    r = store_db.update_report(c, "activation")
    assert r is not None
    assert r.name == before.name
    assert r.period_days == before.period_days


def test_update_missing_report_returns_none():
    c = _conn()
    assert store_db.update_report(c, "nonexistent", name="x") is None


# ─────────────────────────────────────────────────────────────────────────────
# R2 — delete_report
# ─────────────────────────────────────────────────────────────────────────────

def test_delete_returns_true():
    c = _conn()
    assert store_db.delete_report(c, "activation") is True


def test_delete_removes_reports_row():
    c = _conn()
    store_db.delete_report(c, "activation")
    assert store_db.get_report_def(c, "activation") is None


def test_delete_cascades_report_logic():
    c = _conn()
    store_db.delete_report(c, "activation")
    n = c.execute("SELECT count(*) FROM report_logic WHERE report_id='activation'").fetchone()[0]
    assert n == 0


def test_delete_cascades_snapshots_and_metrics():
    c = _conn()
    # save a snapshot so there is something to cascade
    store_db.save_snapshot(
        c, "activation", "2026-05-01 00:00:00", "2026-05-31 23:59:59", "24h",
        [{"logic_id": "activation", "logic_version": 1, "value": "10%", "fmt": "pct",
          "trace": {}, "weeks": [], "series": []}],
    )
    snap_id = c.execute("SELECT id FROM snapshots WHERE report_id='activation'").fetchone()[0]
    store_db.delete_report(c, "activation")
    assert c.execute("SELECT count(*) FROM snapshots WHERE report_id='activation'").fetchone()[0] == 0
    assert c.execute("SELECT count(*) FROM snapshot_metrics WHERE snapshot_id=?", (snap_id,)).fetchone()[0] == 0


def test_delete_missing_returns_false():
    c = _conn()
    assert store_db.delete_report(c, "no_such_report") is False


def test_delete_other_reports_unaffected():
    c = _conn()
    store_db.delete_report(c, "activation")
    assert store_db.get_report_def(c, "growth") is not None


# ─────────────────────────────────────────────────────────────────────────────
# R3 — duplicate_report
# ─────────────────────────────────────────────────────────────────────────────

def test_duplicate_creates_new_report():
    c = _conn()
    dup = store_db.duplicate_report(c, "activation", "activation_copy", "Activation copy")
    assert dup is not None
    assert dup.id == "activation_copy"
    assert dup.name == "Activation copy"


def test_duplicate_copies_period_and_logic_ids():
    c = _conn()
    src = store_db.get_report_def(c, "activation")
    dup = store_db.duplicate_report(c, "activation", "activation_copy", "Copy")
    assert dup.period_days == src.period_days
    assert dup.logic_ids == src.logic_ids


def test_duplicate_no_snapshots_copied():
    c = _conn()
    store_db.save_snapshot(
        c, "activation", "2026-05-01 00:00:00", "2026-05-31 23:59:59", "24h",
        [{"logic_id": "activation", "logic_version": 1, "value": "10%", "fmt": "pct",
          "trace": {}, "weeks": [], "series": []}],
    )
    store_db.duplicate_report(c, "activation", "activation_copy", "Copy")
    snap = store_db.latest_snapshot(c, "activation_copy")
    assert snap is None


def test_duplicate_missing_src_returns_none():
    c = _conn()
    assert store_db.duplicate_report(c, "no_such", "new_id", "New") is None


# ─────────────────────────────────────────────────────────────────────────────
# R4 — Idempotency: deleting a seed report does NOT reseed on next boot
# ─────────────────────────────────────────────────────────────────────────────

def test_delete_seeded_report_not_restored_by_seed_defaults():
    """Delete 'activation', re-run seed_defaults (simulates restart), confirm gone."""
    c = _conn()
    store_db.delete_report(c, "activation")
    # seed_defaults guards on count(logic)==0, so logic table is non-empty → it returns early.
    # This test asserts that the report does NOT come back from re-seeding.
    store_db.seed_defaults(c)
    assert store_db.get_report_def(c, "activation") is None


def test_seed_defaults_idempotent_when_logic_exists():
    """seed_defaults called twice must not duplicate logic or reports rows."""
    c = _bare_conn()
    store_db.seed_defaults(c)
    n_logic_before = c.execute("SELECT count(*) FROM logic").fetchone()[0]
    n_reports_before = c.execute("SELECT count(*) FROM reports").fetchone()[0]
    store_db.seed_defaults(c)  # second call — must no-op
    assert c.execute("SELECT count(*) FROM logic").fetchone()[0] == n_logic_before
    assert c.execute("SELECT count(*) FROM reports").fetchone()[0] == n_reports_before


# ─────────────────────────────────────────────────────────────────────────────
# R5 — REST: PATCH / DELETE / duplicate routes
# ─────────────────────────────────────────────────────────────────────────────

def test_api_patch_name(client):
    # Create a report to patch.
    create = client.post("/reports", json={"name": "My report", "period_days": 30, "logic_ids": []})
    assert create.status_code == 200
    rid = create.json()["id"]

    r = client.patch(f"/reports/{rid}", json={"name": "Renamed"})
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Renamed"
    assert body["id"] == rid


def test_api_patch_period(client):
    create = client.post("/reports", json={"name": "r2", "period_days": 30, "logic_ids": []})
    rid = create.json()["id"]
    r = client.patch(f"/reports/{rid}", json={"period_days": 7})
    assert r.status_code == 200
    assert r.json()["period"] == "7d"


def test_api_patch_404(client):
    r = client.patch("/reports/no_such_report", json={"name": "x"})
    assert r.status_code == 404


def test_api_delete(client):
    create = client.post("/reports", json={"name": "to-delete", "period_days": 30, "logic_ids": []})
    rid = create.json()["id"]
    r = client.delete(f"/reports/{rid}")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    # confirm gone
    assert client.get(f"/reports/{rid}").status_code == 404


def test_api_delete_404(client):
    r = client.delete("/reports/no_such_report")
    assert r.status_code == 404


def test_api_duplicate(client):
    create = client.post("/reports", json={"name": "Original", "period_days": 14, "logic_ids": []})
    rid = create.json()["id"]

    r = client.post(f"/reports/{rid}/duplicate", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["id"] != rid
    assert "copy" in body["name"].lower() or "Original" in body["name"]
    assert body["period"] == "14d"


def test_api_duplicate_custom_name(client):
    create = client.post("/reports", json={"name": "Source", "period_days": 30, "logic_ids": []})
    rid = create.json()["id"]
    r = client.post(f"/reports/{rid}/duplicate", json={"name": "My fork"})
    assert r.status_code == 200
    assert r.json()["name"] == "My fork"


def test_api_duplicate_unique_slug_collision(client):
    """Duplicating twice with the same default name must produce distinct ids."""
    create = client.post("/reports", json={"name": "Test", "period_days": 30, "logic_ids": []})
    rid = create.json()["id"]
    r1 = client.post(f"/reports/{rid}/duplicate", json={})
    r2 = client.post(f"/reports/{rid}/duplicate", json={})
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["id"] != r2.json()["id"]


def test_api_duplicate_404(client):
    r = client.post("/reports/no_such/duplicate", json={})
    assert r.status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
# R7 — ReportOut includes logic_ids (needed by the metric-add picker in the
#       renderer so it can avoid double-adds even when report.metrics is empty
#       e.g. status = "collecting").
# ─────────────────────────────────────────────────────────────────────────────

def test_report_detail_includes_logic_ids(client):
    """GET /reports/{id} must include a logic_ids list."""
    create = client.post("/reports", json={"name": "LID test", "period_days": 30, "logic_ids": ["mau", "ttv"]})
    assert create.status_code == 200
    rid = create.json()["id"]

    r = client.get(f"/reports/{rid}")
    assert r.status_code == 200
    body = r.json()
    assert "logic_ids" in body, "ReportOut must include logic_ids"
    assert set(body["logic_ids"]) == {"mau", "ttv"}


def test_report_detail_logic_ids_empty_for_no_formulas(client):
    """logic_ids must be an empty list (not absent) when the report has no formulas."""
    create = client.post("/reports", json={"name": "empty", "period_days": 7, "logic_ids": []})
    assert create.status_code == 200
    rid = create.json()["id"]

    r = client.get(f"/reports/{rid}")
    assert r.status_code == 200
    body = r.json()
    assert body["logic_ids"] == []


def test_report_detail_logic_ids_after_patch(client):
    """After PATCH logic_ids, the detail endpoint reflects the new set."""
    create = client.post("/reports", json={"name": "patch-lid", "period_days": 30, "logic_ids": ["mau"]})
    rid = create.json()["id"]

    client.patch(f"/reports/{rid}", json={"logic_ids": ["mau", "ttv", "activation"]})
    r = client.get(f"/reports/{rid}")
    assert r.status_code == 200
    body = r.json()
    assert set(body["logic_ids"]) == {"mau", "ttv", "activation"}


# ─────────────────────────────────────────────────────────────────────────────
# R6 — CORS preflight must allow mutation verbs (regression: PATCH was missing
#       from allow_methods, which 400'd every rename/update preflight).
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("method", ["PATCH", "DELETE", "POST", "GET"])
def test_cors_preflight_allows_mutation_methods(client, method):
    r = client.options(
        "/reports/activation",
        headers={
            "Origin": "http://localhost:3020",
            "Access-Control-Request-Method": method,
        },
    )
    assert r.status_code == 200, f"{method} preflight rejected: {r.status_code}"
    allowed = r.headers.get("access-control-allow-methods", "")
    assert method in allowed or "*" in allowed
