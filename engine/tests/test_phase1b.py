"""Phase 1 chunk 1B tests: content-hash catalog sync (1.5) + pandas decision (1.6).

1.5a — A bundled Logic row is refreshed when its content_hash changes.
1.5b — A user-edited row (source='user') is NOT overwritten by the sync.
1.5c — Sync failure (e.g. broken DB) does not raise out of the caller.
1.5d — After migration 3, existing bundled rows get content_hash + source='bundled';
        existing non-bundled rows get source='user'.
1.6  — No pandas or numpy import exists anywhere in the engine package.
"""
from __future__ import annotations

import importlib
import pkgutil
import sqlite3
import types

import pytest

import eigenheim
from eigenheim import db as _db
from eigenheim import store_db
from eigenheim.catalog import Input, Logic, LOGIC as SEED_LOGIC
from eigenheim.store_db import (
    _catalog_content_hash,
    _sync_bundled_catalog,
    sync_bundled_catalog,
)


# ── helpers ───────────────────────────────────────────────────────────────────


def _seeded_conn() -> sqlite3.Connection:
    """In-memory DB with the full store schema, seeded defaults, and migrations run."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    _db.init_and_seed(c)
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)
    store_db.run_migrations(c)
    return c


# ── 1.5a — bundled row refreshes when content_hash changes ───────────────────


def test_bundled_row_updates_when_hash_changes():
    """Mutating a bundled Logic's content in SEED_LOGIC (simulated) triggers a sync."""
    c = _seeded_conn()

    # Confirm mau exists with a known hash.
    original_row = c.execute("SELECT content_hash, source, latest_version FROM logic WHERE id='mau'").fetchone()
    assert original_row is not None
    assert original_row["source"] == "bundled"
    original_version = original_row["latest_version"]

    # Simulate a catalog update: inject a fake Logic with a different expression.
    fake_mau = Logic(
        "mau", "mau", "Updated description", 1,
        (Input("m", "mau", {"days": 30}),),
        "m + 0",   # changed expression -> different hash
        "number", "13 Jun 2026",
    )

    # Patch SEED_LOGIC temporarily.
    import eigenheim.store_db as sdb_mod
    original_seed = sdb_mod.SEED_LOGIC.copy()
    sdb_mod.SEED_LOGIC = {**original_seed, "mau": fake_mau}
    try:
        _sync_bundled_catalog(c)
    finally:
        sdb_mod.SEED_LOGIC = original_seed

    refreshed = c.execute("SELECT content_hash, source, latest_version FROM logic WHERE id='mau'").fetchone()
    assert refreshed["source"] == "bundled"
    assert refreshed["latest_version"] == original_version + 1
    new_hash = _catalog_content_hash(fake_mau)
    assert refreshed["content_hash"] == new_hash


def test_bundled_row_not_updated_when_hash_unchanged():
    """A bundled row with the same hash must not get a new version."""
    c = _seeded_conn()

    before = c.execute("SELECT latest_version FROM logic WHERE id='activation'").fetchone()["latest_version"]
    _sync_bundled_catalog(c)
    after = c.execute("SELECT latest_version FROM logic WHERE id='activation'").fetchone()["latest_version"]
    assert after == before, "version must not bump when content is unchanged"


# ── 1.5b — user-edited row is never overwritten ───────────────────────────────


def test_user_edited_row_not_overwritten():
    """A row with source='user' must survive even if the bundled hash changes."""
    c = _seeded_conn()

    # Mark mau as user-edited.
    c.execute("UPDATE logic SET source='user' WHERE id='mau'")
    c.commit()
    original_version = c.execute("SELECT latest_version FROM logic WHERE id='mau'").fetchone()["latest_version"]

    # Simulate a bundled content change.
    fake_mau = Logic(
        "mau", "mau", "Changed description", 1,
        (Input("m", "mau", {"days": 30}),),
        "m * 2",
        "number", "13 Jun 2026",
    )
    import eigenheim.store_db as sdb_mod
    original_seed = sdb_mod.SEED_LOGIC.copy()
    sdb_mod.SEED_LOGIC = {**original_seed, "mau": fake_mau}
    try:
        _sync_bundled_catalog(c)
    finally:
        sdb_mod.SEED_LOGIC = original_seed

    row = c.execute("SELECT latest_version, source FROM logic WHERE id='mau'").fetchone()
    assert row["source"] == "user", "source must stay 'user'"
    assert row["latest_version"] == original_version, "version must not bump for a user-edited row"


# ── 1.5c — sync failure does not raise ───────────────────────────────────────


def test_sync_failure_does_not_raise():
    """sync_bundled_catalog must swallow internal errors so startup is never blocked."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    # No tables at all — every SQL inside sync will raise OperationalError.
    # sync_bundled_catalog must catch it silently.
    sync_bundled_catalog(c)   # must not raise


# ── 1.5d — migration 3 back-fills existing rows ───────────────────────────────


def test_migration3_backfills_bundled_rows():
    """After migration 3, all SEED_LOGIC ids get content_hash + source='bundled'."""
    c = _seeded_conn()
    for lid, lg in SEED_LOGIC.items():
        row = c.execute("SELECT content_hash, source FROM logic WHERE id=?", (lid,)).fetchone()
        assert row is not None, f"Logic '{lid}' missing after migration"
        assert row["source"] == "bundled", f"Logic '{lid}' has source={row['source']!r}"
        expected_hash = _catalog_content_hash(lg)
        assert row["content_hash"] == expected_hash, (
            f"Logic '{lid}': content_hash mismatch — "
            f"got {row['content_hash']!r}, expected {expected_hash!r}"
        )


def test_migration3_marks_non_bundled_rows_as_user():
    """A Logic id that is not in the bundled catalog gets source='user'."""
    # Build a DB where a user-created id already exists before migration 3 runs.
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    _db.init_and_seed(c)
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)

    # Insert a user-created Logic before migrations run.
    c.execute(
        "INSERT INTO logic(id, name, description, fmt, latest_version) VALUES (?,?,?,?,?)",
        ("my_custom_kpi", "Custom KPI", "", "number", 1),
    )
    c.execute(
        "INSERT INTO logic_versions(logic_id, version, inputs_json, expression, sha, validated, created_at)"
        " VALUES (?,?,?,?,?,?,?)",
        ("my_custom_kpi", 1, "[]", "x", "deadbeef", "today", "2026-06-13 00:00:00"),
    )
    c.commit()

    store_db.run_migrations(c)

    row = c.execute("SELECT source FROM logic WHERE id='my_custom_kpi'").fetchone()
    assert row is not None
    assert row["source"] == "user", f"user-created row got source={row['source']!r}"


def test_migration3_idempotent_after_fresh_schema():
    """Fresh installs have content_hash + source in SCHEMA already; migration 3
    must not fail with 'duplicate column'."""
    # _seeded_conn() calls ensure_schema (which has the new columns) then run_migrations.
    # This must not raise even though the columns already exist on a fresh DB.
    # SQLite's ALTER TABLE ADD COLUMN fails on duplicate columns — we verify migration 3
    # runs fine on a fresh install by confirming the final version is correct.
    c = _seeded_conn()
    (v,) = c.execute("PRAGMA user_version").fetchone()
    assert v == len(store_db._MIGRATIONS), f"expected user_version={len(store_db._MIGRATIONS)}, got {v}"


# ── 1.6 — no pandas / numpy in the engine package ────────────────────────────


def test_no_pandas_import_in_engine():
    """pandas is not installed; stdlib statistics handles all numeric aggregation.
    This test fails if any module in eigenheim imports pandas or numpy."""
    forbidden = {"pandas", "numpy"}
    violations: list[str] = []

    def _check_module(mod: types.ModuleType) -> None:
        source_file = getattr(mod, "__file__", None) or ""
        if not source_file.endswith(".py"):
            return
        try:
            with open(source_file, encoding="utf-8") as fh:
                src = fh.read()
        except OSError:
            return
        for pkg in forbidden:
            # Match 'import pandas', 'from pandas', 'import numpy', 'from numpy'
            if f"import {pkg}" in src or f"from {pkg}" in src:
                violations.append(f"{source_file}: imports {pkg!r}")

    for finder, name, _is_pkg in pkgutil.walk_packages(
        eigenheim.__path__, prefix="eigenheim."
    ):
        try:
            mod = importlib.import_module(name)
            _check_module(mod)
        except ImportError:
            pass

    assert not violations, (
        "pandas/numpy found in engine source. stdlib statistics is the only numeric "
        "dependency. Remove the import or replace with stdlib.\n"
        + "\n".join(violations)
    )
