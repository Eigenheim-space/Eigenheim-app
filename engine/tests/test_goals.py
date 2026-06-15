"""OKR / Goals backend tests (G1–G5).

G1  — Migration 5: objectives + key_results tables created; user_version bumped.
G2  — Objective CRUD: create / list / get / update / delete (cascade KR delete).
G3  — KR CRUD: create / list / get / update / delete + comparison validation.
G4  — KR computation: status/progress/gap for ahead/behind/draft/stale cases;
       task_count cross-ref from task_links; trace_ref present on successful compute.
G5  — GET /goals tree shape: objectives → KRs with live values and task_count tie-in.
G6  — MCP list_goals / get_objective / get_kr: scope enforcement (goals:read),
       stale-gate on auth failure (hint not emitted), payload shape.
"""
from __future__ import annotations

import sqlite3

import pytest

from eigenheim import db as _db
from eigenheim import store_db
from eigenheim import goals as _goals
from eigenheim.mcp_auth import create_mcp_key, McpAuthError


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _conn() -> sqlite3.Connection:
    """In-memory DB with full schema + all migrations (including migration 5)."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    _db.init_and_seed(c)
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)
    store_db.run_migrations(c)
    return c


def _seed_task(
    conn: sqlite3.Connection,
    external_id: str = "ENG-1",
    tracker: str = "jira",
    logic_id: str = "activation",
) -> None:
    store_db.upsert_tasks(conn, tracker, [{
        "external_id": external_id,
        "title": f"Task {external_id}",
        "status": "In Progress",
        "assignee": "Alice",
        "url": f"https://example.com/{external_id}",
        "updated_at": "2026-06-14 00:00:00",
        "raw_json": {},
    }])
    if logic_id:
        store_db.link_task(conn, external_id, tracker, logic_id)


# ─────────────────────────────────────────────────────────────────────────────
# G1 — Migration 5: schema
# ─────────────────────────────────────────────────────────────────────────────

def test_migration5_creates_objectives_table():
    c = _conn()
    tables = {r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert "objectives" in tables, "objectives table missing after migration 5"


def test_migration5_creates_key_results_table():
    c = _conn()
    tables = {r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert "key_results" in tables, "key_results table missing after migration 5"


def test_migration5_bumps_user_version():
    c = _conn()
    (v,) = c.execute("PRAGMA user_version").fetchone()
    assert v == len(store_db._MIGRATIONS), (
        f"user_version should be {len(store_db._MIGRATIONS)}, got {v}"
    )


def test_migration5_idempotent():
    c = _conn()
    v1 = store_db.run_migrations(c)
    v2 = store_db.run_migrations(c)
    assert v1 == v2


def test_objectives_columns():
    c = _conn()
    cols = {r[1] for r in c.execute("PRAGMA table_info(objectives)").fetchall()}
    required = {"id", "title", "period", "source", "created_at"}
    assert required <= cols, f"missing columns: {required - cols}"


def test_key_results_columns():
    c = _conn()
    cols = {r[1] for r in c.execute("PRAGMA table_info(key_results)").fetchall()}
    required = {"id", "objective_id", "name", "logic_id", "target", "comparison", "period", "created_at"}
    assert required <= cols, f"missing columns: {required - cols}"


# ─────────────────────────────────────────────────────────────────────────────
# G2 — Objective CRUD
# ─────────────────────────────────────────────────────────────────────────────

def test_create_objective_returns_row():
    c = _conn()
    obj = store_db.create_objective(c, "Grow activation", period="Q2 2026")
    assert obj["title"] == "Grow activation"
    assert obj["period"] == "Q2 2026"
    assert obj["id"].startswith("obj_")


def test_list_objectives_empty():
    c = _conn()
    assert store_db.list_objectives(c) == []


def test_list_objectives_with_period_filter():
    c = _conn()
    store_db.create_objective(c, "Obj Q2", period="Q2")
    store_db.create_objective(c, "Obj Q3", period="Q3")
    q2 = store_db.list_objectives(c, period="Q2")
    assert len(q2) == 1 and q2[0]["title"] == "Obj Q2"


def test_get_objective_found():
    c = _conn()
    obj = store_db.create_objective(c, "My Obj", period="Q1")
    fetched = store_db.get_objective(c, obj["id"])
    assert fetched is not None
    assert fetched["title"] == "My Obj"


def test_get_objective_not_found():
    c = _conn()
    assert store_db.get_objective(c, "obj_nonexistent") is None


def test_update_objective_title():
    c = _conn()
    obj = store_db.create_objective(c, "Old Title", period="Q1")
    updated = store_db.update_objective(c, obj["id"], title="New Title")
    assert updated["title"] == "New Title"
    assert updated["period"] == "Q1"  # unchanged


def test_update_objective_period():
    c = _conn()
    obj = store_db.create_objective(c, "Obj", period="Q1")
    updated = store_db.update_objective(c, obj["id"], period="Q2")
    assert updated["period"] == "Q2"


def test_update_objective_not_found():
    c = _conn()
    assert store_db.update_objective(c, "obj_missing", title="X") is None


def test_delete_objective_removes_row():
    c = _conn()
    obj = store_db.create_objective(c, "To Delete")
    ok = store_db.delete_objective(c, obj["id"])
    assert ok is True
    assert store_db.get_objective(c, obj["id"]) is None


def test_delete_objective_cascades_krs():
    c = _conn()
    obj = store_db.create_objective(c, "Parent")
    store_db.create_key_result(c, objective_id=obj["id"], name="KR 1", logic_id="activation")
    store_db.delete_objective(c, obj["id"])
    krs = store_db.list_key_results(c, objective_id=obj["id"])
    assert krs == [], "KRs must be deleted when the parent Objective is deleted"


def test_delete_objective_not_found():
    c = _conn()
    assert store_db.delete_objective(c, "obj_missing") is False


# ─────────────────────────────────────────────────────────────────────────────
# G3 — KR CRUD
# ─────────────────────────────────────────────────────────────────────────────

def test_create_key_result_returns_row():
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(
        c, objective_id=obj["id"], name="Activation KR",
        logic_id="activation", target=0.5, comparison="gte", period="Q2",
    )
    assert kr["name"] == "Activation KR"
    assert kr["logic_id"] == "activation"
    assert kr["target"] == 0.5
    assert kr["comparison"] == "gte"
    assert kr["id"].startswith("kr_")


def test_create_key_result_draft_empty_logic_id():
    """A KR without a logic_id is valid (draft state)."""
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(c, objective_id=obj["id"], name="Draft KR")
    assert kr["logic_id"] == ""


def test_create_key_result_invalid_comparison_raises():
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    with pytest.raises(ValueError, match="comparison"):
        store_db.create_key_result(
            c, objective_id=obj["id"], name="Bad KR",
            logic_id="activation", comparison="gt",  # invalid
        )


def test_list_key_results_by_objective():
    c = _conn()
    obj1 = store_db.create_objective(c, "O1")
    obj2 = store_db.create_objective(c, "O2")
    store_db.create_key_result(c, objective_id=obj1["id"], name="KR1")
    store_db.create_key_result(c, objective_id=obj2["id"], name="KR2")
    krs = store_db.list_key_results(c, objective_id=obj1["id"])
    assert len(krs) == 1 and krs[0]["name"] == "KR1"


def test_list_key_results_by_period():
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    store_db.create_key_result(c, objective_id=obj["id"], name="Q2 KR", period="Q2")
    store_db.create_key_result(c, objective_id=obj["id"], name="Q3 KR", period="Q3")
    krs = store_db.list_key_results(c, period="Q2")
    assert len(krs) == 1 and krs[0]["name"] == "Q2 KR"


def test_get_key_result_found():
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(c, objective_id=obj["id"], name="KR")
    fetched = store_db.get_key_result(c, kr["id"])
    assert fetched is not None and fetched["name"] == "KR"


def test_get_key_result_not_found():
    c = _conn()
    assert store_db.get_key_result(c, "kr_missing") is None


def test_update_key_result_name():
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(c, objective_id=obj["id"], name="Old")
    updated = store_db.update_key_result(c, kr["id"], name="New")
    assert updated["name"] == "New"


def test_update_key_result_invalid_comparison_raises():
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(c, objective_id=obj["id"], name="KR")
    with pytest.raises(ValueError, match="comparison"):
        store_db.update_key_result(c, kr["id"], comparison="bad")


def test_update_key_result_not_found():
    c = _conn()
    assert store_db.update_key_result(c, "kr_missing", name="X") is None


def test_delete_key_result():
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(c, objective_id=obj["id"], name="KR")
    ok = store_db.delete_key_result(c, kr["id"])
    assert ok is True
    assert store_db.get_key_result(c, kr["id"]) is None


def test_delete_key_result_not_found():
    c = _conn()
    assert store_db.delete_key_result(c, "kr_missing") is False


def test_count_tasks_for_logic_zero():
    c = _conn()
    assert store_db.count_tasks_for_logic(c, "activation") == 0


def test_count_tasks_for_logic_nonzero():
    c = _conn()
    _seed_task(c, "ENG-1", logic_id="activation")
    _seed_task(c, "ENG-2", logic_id="activation")
    assert store_db.count_tasks_for_logic(c, "activation") == 2


# ─────────────────────────────────────────────────────────────────────────────
# G4 — KR computation (status / progress / gap)
# ─────────────────────────────────────────────────────────────────────────────

def test_kr_compute_ahead_gte():
    """KR with gte comparison where live >= target → status 'ahead'."""
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(
        c, objective_id=obj["id"], name="Activation KR",
        logic_id="activation", target=0.0, comparison="gte",
    )
    result = _goals.compute_kr(c, kr)
    assert result["status"] == "ahead", f"expected ahead, got {result['status']}"
    assert result["live_raw"] is not None
    assert result["progress"] == 1.0  # live >= target=0 clamps to 1.0
    assert result["gap"] is not None


def test_kr_compute_behind_gte():
    """KR with gte comparison where live < target → status 'behind'."""
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(
        c, objective_id=obj["id"], name="Activation KR",
        logic_id="activation", target=999999.0, comparison="gte",
    )
    result = _goals.compute_kr(c, kr)
    assert result["status"] == "behind"
    assert result["gap"] < 0, "gap should be negative when behind on gte"
    assert 0.0 <= result["progress"] < 1.0


def test_kr_compute_ahead_lte():
    """KR with lte comparison where live <= target → status 'ahead'."""
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    # activation is a small ratio; set a generous (large) target
    kr = store_db.create_key_result(
        c, objective_id=obj["id"], name="TTV KR",
        logic_id="activation", target=999999.0, comparison="lte",
    )
    result = _goals.compute_kr(c, kr)
    assert result["status"] == "ahead"
    assert result["progress"] == 1.0


def test_kr_compute_behind_lte():
    """KR with lte comparison where live > target → status 'behind'."""
    c = _conn()
    # Insert enough events so activation > 0
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(
        c, objective_id=obj["id"], name="LTE KR",
        logic_id="activation", target=-999999.0, comparison="lte",
    )
    result = _goals.compute_kr(c, kr)
    # live is a non-negative ratio, so live > -999999 → behind
    assert result["status"] == "behind"


def test_kr_compute_eq_ahead():
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    # Find the actual live value of 'activation' first
    from eigenheim.compute import compute_value
    from eigenheim import db as _db2
    from datetime import timedelta
    start = max(_db2.PERIOD_END - timedelta(days=30), _db2.PERIOD_START)
    start_s = start.strftime("%Y-%m-%d %H:%M:%S")
    end_s = _db2.PERIOD_END.strftime("%Y-%m-%d %H:%M:%S")
    lg = store_db.get_logic(c, "activation")
    live_raw, _ = compute_value(c, lg, start_s, end_s, lambda lid: store_db.get_logic(c, lid))
    kr = store_db.create_key_result(
        c, objective_id=obj["id"], name="EQ KR",
        logic_id="activation", target=live_raw, comparison="eq",
    )
    result = _goals.compute_kr(c, kr)
    assert result["status"] == "ahead"
    assert result["gap"] == 0.0


def test_kr_compute_draft_no_logic():
    """A KR with empty logic_id → status 'draft'."""
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(c, objective_id=obj["id"], name="Draft KR")
    result = _goals.compute_kr(c, kr)
    assert result["status"] == "draft"
    assert result["live_raw"] is None
    assert result["progress"] == 0.0
    assert result["gap"] is None
    assert result["trace_ref"] is None


def test_kr_compute_stale_missing_logic():
    """A KR whose Logic has been deleted → status 'stale'."""
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(
        c, objective_id=obj["id"], name="Stale KR",
        logic_id="nonexistent_logic_id_xyz", target=100.0,
    )
    result = _goals.compute_kr(c, kr)
    assert result["status"] == "stale"
    assert result["live_raw"] is None
    assert result["progress"] == 0.0
    assert result["gap"] is None


def test_kr_compute_trace_ref_present():
    """A successfully computed KR carries a trace_ref string."""
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(
        c, objective_id=obj["id"], name="Activation KR",
        logic_id="activation", target=0.0, comparison="gte",
    )
    result = _goals.compute_kr(c, kr)
    assert result["status"] == "ahead"
    assert result["trace_ref"] is not None
    assert isinstance(result["trace_ref"], str)
    assert len(result["trace_ref"]) > 0


def test_kr_compute_task_count():
    """task_count reflects the count of task_links rows for the same logic_id."""
    c = _conn()
    _seed_task(c, "ENG-1", logic_id="activation")
    _seed_task(c, "ENG-2", logic_id="activation")
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(
        c, objective_id=obj["id"], name="Activation KR",
        logic_id="activation", target=0.0,
    )
    result = _goals.compute_kr(c, kr)
    assert result["task_count"] == 2


def test_kr_compute_task_count_zero_for_draft():
    """Draft KRs (no logic_id) always have task_count == 0."""
    c = _conn()
    _seed_task(c, "ENG-1", logic_id="activation")
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(c, objective_id=obj["id"], name="Draft KR")  # no logic_id
    result = _goals.compute_kr(c, kr)
    assert result["status"] == "draft"
    assert result["task_count"] == 0


# ─────────────────────────────────────────────────────────────────────────────
# G5 — GET /goals tree shape (via compute_objective_tree)
# ─────────────────────────────────────────────────────────────────────────────

def test_goals_tree_empty():
    c = _conn()
    tree = _goals.compute_objective_tree(c)
    assert tree == []


def test_goals_tree_objective_with_krs():
    c = _conn()
    obj = store_db.create_objective(c, "Grow activation", period="Q2")
    store_db.create_key_result(
        c, objective_id=obj["id"], name="KR 1",
        logic_id="activation", target=0.0, comparison="gte", period="Q2",
    )
    store_db.create_key_result(
        c, objective_id=obj["id"], name="KR 2 (draft)", period="Q2",
    )
    tree = _goals.compute_objective_tree(c)
    assert len(tree) == 1
    node = tree[0]
    assert node["title"] == "Grow activation"
    assert node["total_kr_count"] == 2
    assert "krs" in node
    assert len(node["krs"]) == 2
    assert "on_track_count" in node
    assert "aggregate_progress" in node


def test_goals_tree_period_filter_krs():
    """period filter applies to KRs; the Objective still appears (empty krs)."""
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    store_db.create_key_result(c, objective_id=obj["id"], name="Q2 KR", period="Q2")
    store_db.create_key_result(c, objective_id=obj["id"], name="Q3 KR", period="Q3")
    tree = _goals.compute_objective_tree(c, period="Q2")
    assert len(tree) == 1
    krs = tree[0]["krs"]
    assert len(krs) == 1
    assert krs[0]["name"] == "Q2 KR"


def test_goals_tree_kr_shape():
    """Each KR in the tree has all required fields."""
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    store_db.create_key_result(
        c, objective_id=obj["id"], name="KR",
        logic_id="activation", target=0.0,
    )
    tree = _goals.compute_objective_tree(c)
    kr = tree[0]["krs"][0]
    for field in ("id", "name", "logic_id", "target", "comparison", "period",
                  "live_value", "live_raw", "status", "progress", "gap",
                  "trace_ref", "task_count"):
        assert field in kr, f"missing field '{field}' in KR dict"


def test_goals_tree_task_count_tie_in():
    """KR in the tree shows task_count from task_links."""
    c = _conn()
    _seed_task(c, "ENG-1", logic_id="activation")
    obj = store_db.create_objective(c, "O1")
    store_db.create_key_result(
        c, objective_id=obj["id"], name="KR",
        logic_id="activation", target=0.0,
    )
    tree = _goals.compute_objective_tree(c)
    kr = tree[0]["krs"][0]
    assert kr["task_count"] == 1


def test_goals_tree_aggregate_progress_excludes_draft_stale():
    """aggregate_progress is mean of 'ahead'/'behind' KRs only."""
    c = _conn()
    obj = store_db.create_objective(c, "O1")
    store_db.create_key_result(
        c, objective_id=obj["id"], name="KR Ahead",
        logic_id="activation", target=0.0, comparison="gte",
    )
    store_db.create_key_result(
        c, objective_id=obj["id"], name="KR Draft",
    )  # draft; excluded from aggregate
    tree = _goals.compute_objective_tree(c)
    node = tree[0]
    # Only the "ahead" KR contributes; progress=1.0. Draft is excluded.
    assert node["aggregate_progress"] == pytest.approx(1.0, abs=0.01)


def test_goals_tree_multiple_objectives():
    c = _conn()
    obj1 = store_db.create_objective(c, "O1")
    obj2 = store_db.create_objective(c, "O2")
    store_db.create_key_result(c, objective_id=obj1["id"], name="KR1")
    store_db.create_key_result(c, objective_id=obj2["id"], name="KR2")
    tree = _goals.compute_objective_tree(c)
    assert len(tree) == 2
    titles = {n["title"] for n in tree}
    assert titles == {"O1", "O2"}


# ─────────────────────────────────────────────────────────────────────────────
# G6 — MCP list_goals / get_objective / get_kr scope enforcement
# ─────────────────────────────────────────────────────────────────────────────

def _mcp_conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    _db.init_and_seed(c)
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)
    store_db.run_migrations(c)
    return c


def test_mcp_list_goals_read_scope_ok():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "goals-read", scopes=["read"])
    obj = store_db.create_objective(c, "O1")
    store_db.create_key_result(c, objective_id=obj["id"], name="KR1", logic_id="activation", target=0.0)

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_goals(key=raw)
        assert "objectives" in result, f"expected 'objectives': {result}"
        assert len(result["objectives"]) == 1
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_list_goals_goals_read_scope_ok():
    """A key with goals:read (not umbrella read) must also pass."""
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "goals-only", scopes=["goals:read"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_goals(key=raw)
        assert "objectives" in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_list_goals_bad_key_returns_error():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_goals(key="eig_" + "x" * 64)
        assert "error" in result
        assert result["error"] == "auth_error"
        assert "_hint" not in result
        assert ms._session_hinted is False
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_list_goals_period_filter():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "goals-period", scopes=["read"])
    obj = store_db.create_objective(c, "O1")
    store_db.create_key_result(c, objective_id=obj["id"], name="Q2 KR", period="Q2")
    store_db.create_key_result(c, objective_id=obj["id"], name="Q3 KR", period="Q3")

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.list_goals(key=raw, period="Q2")
        assert "objectives" in result
        krs = result["objectives"][0]["krs"]
        assert all(k["period"] == "Q2" for k in krs if k["name"] in ("Q2 KR",))
        assert len(krs) == 1
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_get_objective_found():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "get-obj", scopes=["read"])
    obj = store_db.create_objective(c, "My Obj")
    store_db.create_key_result(c, objective_id=obj["id"], name="KR1", logic_id="activation", target=0.0)

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.get_objective(key=raw, objective_id=obj["id"])
        assert "title" in result
        assert result["title"] == "My Obj"
        assert "krs" in result
        assert len(result["krs"]) == 1
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_get_objective_not_found():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "get-obj-missing", scopes=["read"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.get_objective(key=raw, objective_id="obj_missing")
        assert "error" in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_get_kr_found():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "get-kr", scopes=["read"])
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(
        c, objective_id=obj["id"], name="KR1",
        logic_id="activation", target=0.0,
    )

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.get_kr(key=raw, kr_id=kr["id"])
        assert "status" in result
        assert result["name"] == "KR1"
        assert "trace_ref" in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_get_kr_not_found():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "get-kr-missing", scopes=["read"])

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.get_kr(key=raw, kr_id="kr_missing")
        assert "error" in result
    finally:
        ms._conn = orig
        ms._session_hinted = False


def test_mcp_get_kr_bad_key_no_hint():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    obj = store_db.create_objective(c, "O1")
    kr = store_db.create_key_result(c, objective_id=obj["id"], name="KR1")

    ms._session_hinted = False
    orig = ms._conn
    ms._conn = c
    try:
        result = ms.get_kr(key="eig_" + "z" * 64, kr_id=kr["id"])
        assert "error" in result
        assert "_hint" not in result
        assert ms._session_hinted is False
    finally:
        ms._conn = orig
        ms._session_hinted = False


# ─────────────────────────────────────────────────────────────────────────────
# Scope map — goals:read satisfies the new scope
# ─────────────────────────────────────────────────────────────────────────────

def test_scope_map_goals_read_satisfied_by_read():
    from eigenheim.mcp_auth import require_scope

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "umbrella-key", scopes=["read"])
    # Should not raise
    require_scope(c, raw, "goals:read")


def test_scope_map_goals_read_satisfied_by_goals_read():
    from eigenheim.mcp_auth import require_scope

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "goals-only-key", scopes=["goals:read"])
    require_scope(c, raw, "goals:read")


def test_scope_map_goals_read_denied_for_tasks_read_key():
    """A key with only tasks:read does NOT satisfy goals:read."""
    from eigenheim.mcp_auth import require_scope, McpAuthError

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "tasks-only-key", scopes=["tasks:read"])
    with pytest.raises(McpAuthError, match="scope"):
        require_scope(c, raw, "goals:read")


# ─────────────────────────────────────────────────────────────────────────────
# G7 — POST /key-results returns computed KeyResultOut (regression for 500)
# ─────────────────────────────────────────────────────────────────────────────

def test_post_key_results_returns_computed_fields(tmp_path, monkeypatch):
    """POST /key-results must return a fully computed KeyResultOut — not the raw
    store dict — so FastAPI response validation succeeds (regression for the 500
    caused by missing created_at / status / progress / spark / task_count)."""
    from fastapi.testclient import TestClient
    import eigenheim.app as appmod
    from eigenheim.app import app

    db_path = str(tmp_path / "g7.db")
    monkeypatch.setenv("EIGENHEIM_DB", db_path)
    monkeypatch.delenv("EIGENHEIM_TOKEN", raising=False)
    monkeypatch.delenv("EIGENHEIM_TOKEN_FILE", raising=False)
    appmod._auth_state["token"] = None

    with TestClient(app, raise_server_exceptions=True) as client:
        # Create an objective first.
        obj_resp = client.post("/objectives", json={"title": "G7 Objective", "period": "Q3"})
        assert obj_resp.status_code == 200, f"create objective: {obj_resp.text}"
        obj_id = obj_resp.json()["id"]

        resp = client.post(
            "/key-results",
            json={
                "objective_id": obj_id,
                "name": "G7 Activation KR",
                "logic_id": "activation",
                "target": 0.0,
                "comparison": "gte",
                "period": "Q3",
            },
        )
        # A 422/500 here means the route returned a raw dict without computed fields.
        assert resp.status_code == 200, f"POST /key-results returned {resp.status_code}: {resp.text}"
        body = resp.json()
        for field in ("id", "name", "created_at", "status", "progress", "task_count", "spark"):
            assert field in body, f"computed field '{field}' missing from POST /key-results response"
        assert body["status"] in ("ahead", "behind", "stale", "draft"), (
            f"unexpected status value: {body['status']!r}"
        )
        assert isinstance(body["progress"], float)
        assert isinstance(body["task_count"], int)
        assert isinstance(body["spark"], list)


# ─────────────────────────────────────────────────────────────────────────────
# No LLM import — determinism guard
# ─────────────────────────────────────────────────────────────────────────────

def test_no_llm_import_in_goals():
    """goals.py must not import any LLM client."""
    import eigenheim.goals as g_mod
    source_file = g_mod.__file__ or ""
    with open(source_file, encoding="utf-8") as fh:
        src = fh.read()
    for pkg in ("openai", "anthropic", "ollama", "langchain", "litellm", "openrouter"):
        assert f"import {pkg}" not in src and f"from {pkg}" not in src, (
            f"goals.py must not import {pkg}"
        )
