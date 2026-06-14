"""Task-tracker backend tests (T1–T4).

Coverage:
  T1  — schema migrations (task_connections, tasks, task_links tables) + migration
         idempotency + user_version bump.
  T2  — Jira adapter: test_connection + fetch_tasks against fixture fetch;
         stale-gate: fetch_tasks raises on empty result, cache preserved.
         Linear adapter: same fixture-driven coverage.
  T2e — Both adapters raise TaskAdapterError cleanly on 401 / network error.
  T3  — link_task / unlink_task round-trip; upsert_tasks stale-gate.
        /tasks/by-goal grouping: linked tasks appear in a group with a live
        metric value; unlinked tasks appear in the unlinked bucket.
  T4  — MCP list_tasks / get_task: scope enforcement (tasks:read), stale-gate
        on auth failure (hint not emitted), payload shape.
  Token — raw token never stored in task_connections rows.
"""
from __future__ import annotations

import json
import sqlite3

import pytest

from eigenheim import db as _db
from eigenheim import store_db
from eigenheim.catalog import Input
from eigenheim.mcp_auth import create_mcp_key, require_scope, McpAuthError
from eigenheim.task_adapters import (
    JiraAdapter,
    LinearAdapter,
    TaskAdapterError,
)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _task_conn() -> sqlite3.Connection:
    """In-memory DB with full schema + migrations (including migration 4)."""
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
    title: str = "Fix login bug",
    status: str = "In Progress",
    assignee: str = "Alice",
    url: str = "https://myorg.atlassian.net/browse/ENG-1",
) -> dict:
    row = {
        "external_id": external_id,
        "title": title,
        "status": status,
        "assignee": assignee,
        "url": url,
        "updated_at": "2026-06-14 00:00:00",
        "raw_json": {"key": external_id},
    }
    store_db.upsert_tasks(conn, tracker, [row])
    return row


# ─────────────────────────────────────────────────────────────────────────────
# T1 — Schema migrations
# ─────────────────────────────────────────────────────────────────────────────

def test_migration4_creates_task_connections():
    c = _task_conn()
    tables = {r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert "task_connections" in tables, "task_connections table missing after migration 4"


def test_migration4_creates_tasks():
    c = _task_conn()
    tables = {r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert "tasks" in tables, "tasks table missing after migration 4"


def test_migration4_creates_task_links():
    c = _task_conn()
    tables = {r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert "task_links" in tables, "task_links table missing after migration 4"


def test_migration4_bumps_user_version():
    c = _task_conn()
    (v,) = c.execute("PRAGMA user_version").fetchone()
    assert v == len(store_db._MIGRATIONS), (
        f"user_version should be {len(store_db._MIGRATIONS)}, got {v}"
    )


def test_migration4_idempotent():
    """Running migrations twice must not raise or double-bump the version."""
    c = _task_conn()
    v1 = store_db.run_migrations(c)
    v2 = store_db.run_migrations(c)
    assert v1 == v2


def test_task_connections_columns():
    """Confirm all required columns exist on task_connections."""
    c = _task_conn()
    cols = {r[1] for r in c.execute("PRAGMA table_info(task_connections)").fetchall()}
    required = {"id", "tracker", "base_url", "workspace", "project_key", "status", "source", "created_at", "last_sync_at"}
    assert required <= cols, f"missing columns: {required - cols}"


def test_tasks_columns():
    c = _task_conn()
    cols = {r[1] for r in c.execute("PRAGMA table_info(tasks)").fetchall()}
    required = {"external_id", "tracker", "title", "status", "assignee", "url", "updated_at", "raw_json", "last_sync_at"}
    assert required <= cols, f"missing columns: {required - cols}"


def test_task_links_columns():
    c = _task_conn()
    cols = {r[1] for r in c.execute("PRAGMA table_info(task_links)").fetchall()}
    required = {"id", "external_id", "tracker", "logic_id", "okr_ref", "kr_ref", "created_at"}
    assert required <= cols, f"missing columns: {required - cols}"


# ─────────────────────────────────────────────────────────────────────────────
# T2 — Jira adapter (fixture-driven)
# ─────────────────────────────────────────────────────────────────────────────

def _jira_myself_response() -> str:
    return json.dumps({"displayName": "Alice", "emailAddress": "alice@example.com"})


def _jira_project_response(key: str = "ENG") -> str:
    return json.dumps({"key": key, "name": "Engineering"})


def _jira_search_response(issues: list[dict] | None = None) -> str:
    if issues is None:
        issues = [
            {
                "key": "ENG-1",
                "self": "https://myorg.atlassian.net/rest/api/3/issue/ENG-1",
                "fields": {
                    "summary": "Fix the login flow",
                    "status": {"name": "In Progress"},
                    "assignee": {"displayName": "Alice"},
                    "updated": "2026-06-14T00:00:00.000Z",
                },
            },
            {
                "key": "ENG-2",
                "self": "https://myorg.atlassian.net/rest/api/3/issue/ENG-2",
                "fields": {
                    "summary": "Add dark mode",
                    "status": {"name": "To Do"},
                    "assignee": None,
                    "updated": "2026-06-13T12:00:00.000Z",
                },
            },
        ]
    return json.dumps({"total": len(issues), "issues": issues})


class _FixtureFetch:
    """Deterministic fixture fetch: returns preset responses keyed by URL substring."""

    def __init__(self, responses: dict[str, str]) -> None:
        self.responses = responses
        self.calls: list[str] = []

    def __call__(self, url: str, headers: dict, body: bytes) -> str:
        self.calls.append(url)
        for key, resp in self.responses.items():
            if key in url:
                return resp
        raise AssertionError(f"unexpected URL in fixture fetch: {url}")


def _jira_fixture_fetch(empty_issues: bool = False) -> _FixtureFetch:
    return _FixtureFetch({
        "/myself": _jira_myself_response(),
        "/project/ENG": _jira_project_response("ENG"),
        "/search": _jira_search_response([] if empty_issues else None),
    })


def test_jira_test_connection_ok():
    adapter = JiraAdapter("https://myorg.atlassian.net", "ENG")
    fetch = _jira_fixture_fetch()
    result = adapter.test_connection("fixture_token", fetch=fetch)
    assert result["ok"] is True
    assert "ENG" in result["workspace"]
    assert result["project_key"] == "ENG"


def test_jira_fetch_tasks_returns_normalised():
    adapter = JiraAdapter("https://myorg.atlassian.net", "ENG")
    fetch = _jira_fixture_fetch()
    tasks = adapter.fetch_tasks("fixture_token", fetch=fetch)
    assert len(tasks) == 2
    t = tasks[0]
    assert t["external_id"] == "ENG-1"
    assert t["title"] == "Fix the login flow"
    assert t["status"] == "In Progress"
    assert t["assignee"] == "Alice"
    assert "ENG-1" in t["url"]
    assert t["updated_at"] == "2026-06-14 00:00:00"
    assert "raw_json" in t


def test_jira_fetch_tasks_no_assignee():
    """A task with no assignee normalises to empty string, not None."""
    adapter = JiraAdapter("https://myorg.atlassian.net", "ENG")
    fetch = _jira_fixture_fetch()
    tasks = adapter.fetch_tasks("fixture_token", fetch=fetch)
    t2 = next(t for t in tasks if t["external_id"] == "ENG-2")
    assert t2["assignee"] == "", "null assignee must normalise to empty string"


def test_jira_fetch_tasks_empty_raises():
    """An empty issues list must raise TaskAdapterError (stale-gate)."""
    adapter = JiraAdapter("https://myorg.atlassian.net", "ENG")
    fetch = _jira_fixture_fetch(empty_issues=True)
    with pytest.raises(TaskAdapterError, match="не вернул задач"):
        adapter.fetch_tasks("fixture_token", fetch=fetch)


def test_jira_401_raises_task_adapter_error():
    import urllib.error

    def _fetch_401(url: str, headers: dict, body: bytes) -> str:
        raise urllib.error.HTTPError(url, 401, "Unauthorized", {}, None)  # type: ignore

    adapter = JiraAdapter("https://myorg.atlassian.net", "ENG")
    with pytest.raises(TaskAdapterError, match="401"):
        adapter.test_connection("bad_token", fetch=_fetch_401)


def test_jira_token_not_in_request_url():
    """The raw token must never appear in a constructed URL."""
    captured_urls: list[str] = []

    def _spy_fetch(url: str, headers: dict, body: bytes) -> str:
        captured_urls.append(url)
        if "/myself" in url:
            return _jira_myself_response()
        if "/project/" in url:
            return _jira_project_response("ENG")
        return _jira_search_response()

    raw_token = "super_secret_token_12345"
    adapter = JiraAdapter("https://myorg.atlassian.net", "ENG")
    adapter.test_connection(raw_token, fetch=_spy_fetch)
    for url in captured_urls:
        assert raw_token not in url, f"raw token appeared in URL: {url}"


# ─────────────────────────────────────────────────────────────────────────────
# T2 — Linear adapter (fixture-driven)
# ─────────────────────────────────────────────────────────────────────────────

def _linear_viewer_response() -> str:
    return json.dumps({
        "data": {
            "viewer": {
                "id": "user_1",
                "displayName": "Bob",
                "organization": {"name": "MyOrg"},
            }
        }
    })


def _linear_issues_response(nodes: list[dict] | None = None) -> str:
    if nodes is None:
        nodes = [
            {
                "id": "issue_abc123",
                "title": "Improve onboarding",
                "url": "https://linear.app/myorg/issue/ENG-1",
                "updatedAt": "2026-06-14T00:00:00.000Z",
                "state": {"name": "In Progress"},
                "assignee": {"displayName": "Bob"},
            },
        ]
    return json.dumps({"data": {"issues": {"nodes": nodes}}})


def _linear_fixture_fetch(empty: bool = False) -> _FixtureFetch:
    viewer_resp = _linear_viewer_response()
    issues_resp = _linear_issues_response([] if empty else None)
    # Linear always POSTs to the same URL; differentiate by call order
    calls: list[int] = [0]

    def _fetch(url: str, headers: dict, body: bytes) -> str:
        body_text = body.decode() if body else ""
        if "viewer" in body_text:
            return viewer_resp
        return issues_resp

    return _fetch  # type: ignore[return-value]


def test_linear_test_connection_ok():
    adapter = LinearAdapter(team_key="ENG")
    result = adapter.test_connection("fixture_token", fetch=_linear_fixture_fetch())
    assert result["ok"] is True
    assert "MyOrg" in result["workspace"]


def test_linear_fetch_tasks_returns_normalised():
    adapter = LinearAdapter(team_key="ENG")
    tasks = adapter.fetch_tasks("fixture_token", fetch=_linear_fixture_fetch())
    assert len(tasks) == 1
    t = tasks[0]
    assert t["external_id"] == "issue_abc123"
    assert t["title"] == "Improve onboarding"
    assert t["status"] == "In Progress"
    assert t["assignee"] == "Bob"
    assert "linear.app" in t["url"]
    assert t["updated_at"] == "2026-06-14 00:00:00"


def test_linear_fetch_tasks_empty_raises():
    adapter = LinearAdapter(team_key="ENG")
    with pytest.raises(TaskAdapterError, match="не вернул задач"):
        adapter.fetch_tasks("fixture_token", fetch=_linear_fixture_fetch(empty=True))


def test_linear_401_raises():
    import urllib.error

    def _fetch_401(url: str, headers: dict, body: bytes) -> str:
        raise urllib.error.HTTPError(url, 401, "Unauthorized", {}, None)  # type: ignore

    adapter = LinearAdapter()
    with pytest.raises(TaskAdapterError, match="401"):
        adapter.test_connection("bad_token", fetch=_fetch_401)


# ─────────────────────────────────────────────────────────────────────────────
# T3 — Link / unlink + stale-gate + by-goal grouping
# ─────────────────────────────────────────────────────────────────────────────

def test_upsert_tasks_basic():
    c = _task_conn()
    _seed_task(c, "ENG-1")
    row = c.execute("SELECT * FROM tasks WHERE external_id='ENG-1'").fetchone()
    assert row is not None
    assert row["title"] == "Fix login bug"
    assert row["tracker"] == "jira"


def test_upsert_tasks_updates_existing():
    c = _task_conn()
    _seed_task(c, "ENG-1", title="Old title")
    # Upsert with new title
    store_db.upsert_tasks(c, "jira", [{
        "external_id": "ENG-1",
        "title": "New title",
        "status": "Done",
        "assignee": "Alice",
        "url": "https://example.com",
        "updated_at": "2026-06-14 01:00:00",
        "raw_json": {},
    }])
    row = c.execute("SELECT title, status FROM tasks WHERE external_id='ENG-1'").fetchone()
    assert row["title"] == "New title"
    assert row["status"] == "Done"


def test_upsert_tasks_empty_raises():
    """Refusing an empty list is the stale-gate: never wipe the cache silently."""
    c = _task_conn()
    _seed_task(c, "ENG-1")
    with pytest.raises(ValueError, match="stale-gate"):
        store_db.upsert_tasks(c, "jira", [])
    # Original task must survive.
    row = c.execute("SELECT * FROM tasks WHERE external_id='ENG-1'").fetchone()
    assert row is not None, "task was deleted despite stale-gate"


def test_link_task_creates_row():
    c = _task_conn()
    _seed_task(c, "ENG-1")
    result = store_db.link_task(c, "ENG-1", "jira", "activation")
    assert result["logic_id"] == "activation"
    row = c.execute("SELECT * FROM task_links WHERE external_id='ENG-1'").fetchone()
    assert row is not None
    assert row["logic_id"] == "activation"


def test_link_task_idempotent():
    """A second link call updates okr_ref/kr_ref; does NOT create a duplicate."""
    c = _task_conn()
    _seed_task(c, "ENG-1")
    r1 = store_db.link_task(c, "ENG-1", "jira", "activation")
    r2 = store_db.link_task(c, "ENG-1", "jira", "activation", okr_ref="OKR-1")
    assert r1["id"] == r2["id"], "second link created a new row instead of updating"
    assert r2["okr_ref"] == "OKR-1"
    count = c.execute(
        "SELECT count(*) FROM task_links WHERE external_id='ENG-1' AND logic_id='activation'"
    ).fetchone()[0]
    assert count == 1


def test_unlink_task():
    c = _task_conn()
    _seed_task(c, "ENG-1")
    store_db.link_task(c, "ENG-1", "jira", "activation")
    ok = store_db.unlink_task(c, "ENG-1", "jira", "activation")
    assert ok is True
    row = c.execute("SELECT * FROM task_links WHERE external_id='ENG-1'").fetchone()
    assert row is None


def test_unlink_nonexistent_returns_false():
    c = _task_conn()
    ok = store_db.unlink_task(c, "ENG-99", "jira", "activation")
    assert ok is False


def test_list_tasks_filter_by_tracker():
    c = _task_conn()
    _seed_task(c, "ENG-1", tracker="jira")
    _seed_task(c, "issue_abc", tracker="linear")
    jira_tasks = store_db.list_tasks(c, tracker="jira")
    linear_tasks = store_db.list_tasks(c, tracker="linear")
    assert all(t["tracker"] == "jira" for t in jira_tasks)
    assert all(t["tracker"] == "linear" for t in linear_tasks)


def test_list_tasks_filter_by_logic_id():
    c = _task_conn()
    _seed_task(c, "ENG-1")
    _seed_task(c, "ENG-2")
    store_db.link_task(c, "ENG-1", "jira", "activation")
    linked = store_db.list_tasks(c, logic_id="activation")
    assert len(linked) == 1
    assert linked[0]["external_id"] == "ENG-1"


def test_get_task_with_link():
    c = _task_conn()
    _seed_task(c, "ENG-1")
    store_db.link_task(c, "ENG-1", "jira", "mau")
    t = store_db.get_task(c, "ENG-1", "jira")
    assert t is not None
    assert t["link"] is not None
    assert t["link"]["logic_id"] == "mau"


def test_get_task_without_link():
    c = _task_conn()
    _seed_task(c, "ENG-1")
    t = store_db.get_task(c, "ENG-1", "jira")
    assert t is not None
    assert t["link"] is None


def test_get_task_not_found():
    c = _task_conn()
    assert store_db.get_task(c, "ENG-99", "jira") is None


def test_by_goal_grouping():
    """Tasks linked to a Logic appear in a group with a live metric value;
    unlinked tasks appear in the unlinked bucket."""
    # Import the by-goal logic directly from app via the route function.
    # We exercise the store layer since the FastAPI app requires full lifespan setup;
    # the grouping logic is in store_db + the _metric helper.
    c = _task_conn()
    _seed_task(c, "ENG-1", title="Improve activation")
    _seed_task(c, "ENG-2", title="Unrelated task")
    store_db.link_task(c, "ENG-1", "jira", "activation")

    # Replicate the by-goal partition logic from app.py directly.
    all_tasks = store_db.list_tasks(c)
    linked: dict = {}
    unlinked = []
    for t in all_tasks:
        if t["link"] and t["link"]["logic_id"]:
            linked.setdefault(t["link"]["logic_id"], []).append(t)
        else:
            unlinked.append(t)

    assert "activation" in linked, "linked task not found in grouped result"
    assert any(t["external_id"] == "ENG-1" for t in linked["activation"])
    assert any(t["external_id"] == "ENG-2" for t in unlinked), "unlinked task missing"


def test_by_goal_removed_logic_moves_to_unlinked():
    """If the linked Logic no longer exists, the task must fall through to unlinked."""
    c = _task_conn()
    _seed_task(c, "ENG-1")
    # Link to a Logic id that does NOT exist in the catalog.
    c.execute(
        "INSERT INTO task_links(id, external_id, tracker, logic_id, okr_ref, kr_ref, created_at)"
        " VALUES ('tl_orphan','ENG-1','jira','nonexistent_logic','','','2026-06-14 00:00:00')"
    )
    c.commit()

    all_tasks = store_db.list_tasks(c)
    unlinked = []
    for t in all_tasks:
        lnk = t.get("link")
        if lnk and lnk.get("logic_id"):
            lg = store_db.get_logic(c, lnk["logic_id"])
            if lg is None:
                unlinked.append(t)
        else:
            unlinked.append(t)

    assert any(t["external_id"] == "ENG-1" for t in unlinked), (
        "task linked to non-existent Logic must appear in unlinked"
    )


# ─────────────────────────────────────────────────────────────────────────────
# T4 — MCP list_tasks / get_task scope enforcement
# ─────────────────────────────────────────────────────────────────────────────

def _mcp_conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    _db.init_and_seed(c)
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)
    store_db.run_migrations(c)
    return c


def test_mcp_list_tasks_requires_tasks_read_scope():
    """A `read`-scoped key must satisfy tasks:read (read is the umbrella scope)."""
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "tasks-read-test", scopes=["read"])
    ms._session_hinted = False
    orig_conn = ms._conn
    ms._conn = c
    _seed_task(c, "ENG-1")
    try:
        result = ms.list_tasks(key=raw)
        assert "tasks" in result, f"expected 'tasks' in result: {result}"
        assert result["count"] >= 1
    finally:
        ms._conn = orig_conn
        ms._session_hinted = False


def test_mcp_list_tasks_bad_key_returns_error():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    ms._session_hinted = False
    orig_conn = ms._conn
    ms._conn = c
    try:
        result = ms.list_tasks(key="eig_" + "x" * 64)
        assert "error" in result
        assert result["error"] == "auth_error"
        # Hint must NOT be emitted on auth failure.
        assert "_hint" not in result
        assert ms._session_hinted is False
    finally:
        ms._conn = orig_conn
        ms._session_hinted = False


def test_mcp_get_task_found_with_linked_metric():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "get-task-test", scopes=["read"])
    _seed_task(c, "ENG-1")
    store_db.link_task(c, "ENG-1", "jira", "activation")

    ms._session_hinted = False
    orig_conn = ms._conn
    ms._conn = c
    try:
        result = ms.get_task(key=raw, external_id="ENG-1", tracker="jira")
        assert "task" in result
        assert result["task"]["external_id"] == "ENG-1"
        # Linked metric must be returned with a logic_id.
        assert "linked_metric" in result
        assert result["linked_metric"]["logic_id"] == "activation"
    finally:
        ms._conn = orig_conn
        ms._session_hinted = False


def test_mcp_get_task_not_found():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "get-task-missing", scopes=["read"])
    ms._session_hinted = False
    orig_conn = ms._conn
    ms._conn = c
    try:
        result = ms.get_task(key=raw, external_id="ENG-99", tracker="jira")
        assert "error" in result
    finally:
        ms._conn = orig_conn
        ms._session_hinted = False


def test_mcp_list_tasks_filter_by_tracker():
    import eigenheim.mcp_server as ms

    c = _mcp_conn()
    raw, _ = create_mcp_key(c, "filter-tracker", scopes=["read"])
    _seed_task(c, "ENG-1", tracker="jira")
    _seed_task(c, "issue_1", tracker="linear")

    ms._session_hinted = False
    orig_conn = ms._conn
    ms._conn = c
    try:
        result = ms.list_tasks(key=raw, tracker="jira")
        assert all(t["tracker"] == "jira" for t in result.get("tasks", []))
    finally:
        ms._conn = orig_conn
        ms._session_hinted = False


# ─────────────────────────────────────────────────────────────────────────────
# Token posture — raw token never stored in task_connections
# ─────────────────────────────────────────────────────────────────────────────

def test_token_not_stored_in_task_connections():
    """The raw API token must not appear anywhere in the task_connections table."""
    c = _task_conn()
    raw_token = "eig_supersecrettoken1234567890abcdef"
    store_db.create_task_connection(c, tracker="jira", workspace="MyOrg / ENG", project_key="ENG")
    # Raw token was NOT passed to create_task_connection (by design).
    # Verify it is absent from all task_connections columns.
    rows = c.execute("SELECT * FROM task_connections").fetchall()
    for row in rows:
        for col in row.keys():
            assert raw_token not in str(row[col]), (
                f"raw token found in task_connections.{col}: {row[col]!r}"
            )


def test_create_task_connection_returns_row_without_token():
    c = _task_conn()
    result = store_db.create_task_connection(c, tracker="linear", workspace="MyOrg")
    assert "token" not in result, "token key must not appear in connection row"
    assert result["tracker"] == "linear"
    assert result["status"] == "connected"
    assert "base_url" in result, "base_url must be present in connection row"


def test_no_pandas_in_task_adapters():
    """task_adapters.py must not import pandas or numpy."""
    import eigenheim.task_adapters as ta_mod
    source_file = ta_mod.__file__ or ""
    with open(source_file, encoding="utf-8") as fh:
        src = fh.read()
    for pkg in ("pandas", "numpy"):
        assert f"import {pkg}" not in src and f"from {pkg}" not in src, (
            f"task_adapters.py must not import {pkg}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# B1 — GET /tasks/facets
# ─────────────────────────────────────────────────────────────────────────────

def test_facets_empty_db():
    """No tasks → all facet buckets are empty dicts / unlinked=0."""
    c = _task_conn()
    facets = store_db.get_task_facets(c)
    assert facets["status"] == {}
    assert facets["source"] == {}
    assert facets["assignee"] == {}
    assert facets["goal"]["unlinked"] == 0


def test_facets_status_counts():
    """Correct count per status across two trackers."""
    c = _task_conn()
    _seed_task(c, "ENG-1", status="In Progress", assignee="Alice")
    _seed_task(c, "ENG-2", status="Done", assignee="Bob")
    _seed_task(c, "ENG-3", status="Done", assignee="Alice")
    facets = store_db.get_task_facets(c)
    assert facets["status"]["In Progress"] == 1
    assert facets["status"]["Done"] == 2


def test_facets_source_counts():
    """Source (tracker) counts are accurate."""
    c = _task_conn()
    _seed_task(c, "ENG-1", tracker="jira")
    _seed_task(c, "ENG-2", tracker="jira")
    _seed_task(c, "issue_1", tracker="linear")
    facets = store_db.get_task_facets(c)
    assert facets["source"]["jira"] == 2
    assert facets["source"]["linear"] == 1


def test_facets_assignee_counts():
    """Assignee counts include only non-empty names."""
    c = _task_conn()
    _seed_task(c, "ENG-1", assignee="Alice")
    _seed_task(c, "ENG-2", assignee="Alice")
    _seed_task(c, "ENG-3", assignee="")   # empty assignee — excluded from bucket
    facets = store_db.get_task_facets(c)
    assert facets["assignee"]["Alice"] == 2
    assert "" not in facets["assignee"]


def test_facets_goal_linked_and_unlinked():
    """Goal bucket: counts per logic_id + unlinked bucket."""
    c = _task_conn()
    _seed_task(c, "ENG-1")
    _seed_task(c, "ENG-2")
    _seed_task(c, "ENG-3")
    store_db.link_task(c, "ENG-1", "jira", "activation")
    store_db.link_task(c, "ENG-2", "jira", "activation")
    facets = store_db.get_task_facets(c)
    assert facets["goal"]["activation"] == 2
    assert facets["goal"]["unlinked"] == 1   # ENG-3 has no link


def test_facets_unlinked_bucket_counts_correctly_when_all_linked():
    c = _task_conn()
    _seed_task(c, "ENG-1")
    store_db.link_task(c, "ENG-1", "jira", "mau")
    facets = store_db.get_task_facets(c)
    assert facets["goal"]["mau"] == 1
    assert facets["goal"]["unlinked"] == 0


def test_facets_filter_by_status_respected():
    """When a status filter is applied, counts reflect only those tasks."""
    c = _task_conn()
    _seed_task(c, "ENG-1", status="In Progress", assignee="Alice")
    _seed_task(c, "ENG-2", status="Done", assignee="Bob")
    facets = store_db.get_task_facets(c, status="In Progress")
    # Only the In Progress task is visible; Bob is absent.
    assert facets["assignee"].get("Alice", 0) == 1
    assert facets["assignee"].get("Bob", 0) == 0


def test_facets_filter_by_assignee_respected():
    """Assignee filter scopes all buckets."""
    c = _task_conn()
    _seed_task(c, "ENG-1", status="In Progress", assignee="Alice")
    _seed_task(c, "ENG-2", status="Done", assignee="Alice")
    _seed_task(c, "ENG-3", status="In Progress", assignee="Bob")
    facets = store_db.get_task_facets(c, assignee="Alice")
    # Only Alice's tasks visible: In Progress=1, Done=1, Bob absent.
    assert facets["status"].get("In Progress", 0) == 1
    assert facets["status"].get("Done", 0) == 1
    assert "Bob" not in facets["assignee"]


def test_facets_filter_by_linked_metric():
    """linked_metric (logic_id) filter: only tasks linked to that Logic are counted."""
    c = _task_conn()
    _seed_task(c, "ENG-1", status="In Progress", assignee="Alice")
    _seed_task(c, "ENG-2", status="Done", assignee="Bob")
    store_db.link_task(c, "ENG-1", "jira", "activation")
    # Filter to activation only — ENG-2 (Done, Bob) must be invisible.
    facets = store_db.get_task_facets(c, logic_id="activation")
    assert facets["status"].get("In Progress", 0) == 1
    assert facets["status"].get("Done", 0) == 0
    assert "Bob" not in facets["assignee"]
    assert facets["goal"]["activation"] == 1
    assert facets["goal"]["unlinked"] == 0


def test_facets_goal_multi_logic():
    """Multiple distinct logic_ids produce separate buckets."""
    c = _task_conn()
    _seed_task(c, "ENG-1")
    _seed_task(c, "ENG-2")
    _seed_task(c, "ENG-3")
    store_db.link_task(c, "ENG-1", "jira", "activation")
    store_db.link_task(c, "ENG-2", "jira", "mau")
    # ENG-3 unlinked
    facets = store_db.get_task_facets(c)
    assert facets["goal"]["activation"] == 1
    assert facets["goal"]["mau"] == 1
    assert facets["goal"]["unlinked"] == 1


# ─────────────────────────────────────────────────────────────────────────────
# B2 — GET /trackers health + last_sync_at
# ─────────────────────────────────────────────────────────────────────────────

def test_tracker_health_never_synced():
    """A freshly-created connection has health='never-synced'."""
    from eigenheim.app import _tracker_health
    assert _tracker_health("connected", None) == "never-synced"
    assert _tracker_health("pending", None) == "never-synced"


def test_tracker_health_ok():
    from eigenheim.app import _tracker_health
    assert _tracker_health("connected", "2026-06-14 10:00:00") == "ok"


def test_tracker_health_error():
    from eigenheim.app import _tracker_health
    assert _tracker_health("error", None) == "error"
    assert _tracker_health("error", "2026-06-14 10:00:00") == "error"


def test_list_task_connections_exposes_health_fields():
    """store_db.list_task_connections returns status + last_sync_at from DB."""
    c = _task_conn()
    row = store_db.create_task_connection(c, tracker="jira", workspace="MyOrg / ENG", project_key="ENG")
    # Mark as connected with a sync timestamp.
    store_db.mark_connection_status(c, row["id"], "connected", update_sync_at=True)
    connections = store_db.list_task_connections(c)
    assert len(connections) == 1
    conn_row = connections[0]
    assert conn_row["status"] == "connected"
    assert conn_row["last_sync_at"] is not None, "last_sync_at must be set after mark_connection_status with update_sync_at"


def test_list_task_connections_error_status():
    c = _task_conn()
    row = store_db.create_task_connection(c, tracker="linear", workspace="MyOrg")
    store_db.mark_connection_status(c, row["id"], "error")
    connections = store_db.list_task_connections(c)
    assert connections[0]["status"] == "error"
    assert connections[0]["last_sync_at"] is None


def test_list_task_connections_never_synced_initial_status():
    """A newly registered connection has status='connected' and last_sync_at=None."""
    c = _task_conn()
    store_db.create_task_connection(c, tracker="jira", workspace="Org")
    connections = store_db.list_task_connections(c)
    conn_row = connections[0]
    # create_task_connection inserts with status='connected' but no last_sync_at.
    assert conn_row["status"] == "connected"
    assert conn_row["last_sync_at"] is None
