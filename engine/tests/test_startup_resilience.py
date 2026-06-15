"""Startup resilience: best-effort lifespan steps must not kill the engine.

SR1 — sync_bundled_catalog raises → engine still starts and /health returns 200.
SR2 — backup raises → engine still starts and /health returns 200.
SR3 — run_migrations raises → engine still starts and /health returns 200.
SR4 — _init_audit_path raises → engine still starts and /health returns 200.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from eigenheim.app import app


def _open_client(tmp_path, monkeypatch):
    """Return a context-managed TestClient with an isolated DB and no auth."""
    db_path = str(tmp_path / "test.db")
    monkeypatch.setenv("EIGENHEIM_DB", db_path)
    monkeypatch.delenv("EIGENHEIM_TOKEN", raising=False)
    monkeypatch.delenv("EIGENHEIM_TOKEN_FILE", raising=False)
    import eigenheim.app as appmod
    appmod._auth_state["token"] = None
    return TestClient(app)


# SR1 — sync_bundled_catalog explodes
def test_startup_survives_sync_bundled_catalog_failure(tmp_path, monkeypatch):
    import eigenheim.store_db as sdb
    monkeypatch.setattr(sdb, "sync_bundled_catalog", lambda conn: (_ for _ in ()).throw(RuntimeError("catalog boom")))
    with _open_client(tmp_path, monkeypatch) as c:
        resp = c.get("/health")
    assert resp.status_code == 200


# SR2 — backup explodes
def test_startup_survives_backup_failure(tmp_path, monkeypatch):
    import eigenheim.store_db as sdb
    monkeypatch.setattr(sdb, "backup", lambda conn, backup_dir, keep_n: (_ for _ in ()).throw(OSError("backup dir read-only")))
    with _open_client(tmp_path, monkeypatch) as c:
        resp = c.get("/health")
    assert resp.status_code == 200


# SR3 — run_migrations explodes
def test_startup_survives_run_migrations_failure(tmp_path, monkeypatch):
    import eigenheim.store_db as sdb
    monkeypatch.setattr(sdb, "run_migrations", lambda conn: (_ for _ in ()).throw(RuntimeError("migration failed")))
    with _open_client(tmp_path, monkeypatch) as c:
        resp = c.get("/health")
    assert resp.status_code == 200


# SR4 — _init_audit_path explodes
def test_startup_survives_init_audit_path_failure(tmp_path, monkeypatch):
    import eigenheim.store_db as sdb
    monkeypatch.setattr(sdb, "_init_audit_path", lambda db_path: (_ for _ in ()).throw(PermissionError("no write access")))
    with _open_client(tmp_path, monkeypatch) as c:
        resp = c.get("/health")
    assert resp.status_code == 200
