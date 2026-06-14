"""Stage A: persistence + data-source adapters. No live network: the PostHog
adapter is exercised against an injected fixture fetch."""
import json
import sqlite3
import urllib.error

import pytest

from eigenheim import adapters, db, dsl, store_db
from eigenheim.catalog import Input


def _conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.executescript("CREATE TABLE events (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, ts TEXT);")
    store_db.ensure_schema(c)
    return c


# ---- adapters ----

def test_csv_ingest():
    c = _conn()
    csv_text = "user_id,event,timestamp\nu1,signup,2026-05-01T10:00:00\nu1,first_report,2026-05-03T10:00:00\nu2,signup,2026-05-02T11:00:00\n"
    n = adapters.ingest_csv(c, csv_text)
    assert n == 3
    assert c.execute("SELECT count(DISTINCT user_id) FROM events").fetchone()[0] == 2
    assert c.execute("SELECT ts FROM events LIMIT 1").fetchone()[0] == "2026-05-01 10:00:00"


def test_posthog_sync_fixture():
    c = _conn()
    def fake_fetch(url, headers, body):
        assert "/api/projects/111/query/" in url
        assert headers["Authorization"] == "Bearer testkey"
        return json.dumps({"results": [["u1", "signup", "2026-05-01T10:00:00"], ["u1", "first_report", "2026-05-03T10:00:00"]]})
    n = adapters.posthog_sync(c, "eu", "111", "testkey", fetch=fake_fetch)
    assert n == 2


def test_posthog_401_message():
    def boom(url, headers, body):
        raise urllib.error.HTTPError(url, 401, "Unauthorized", {}, None)
    with pytest.raises(adapters.AdapterError) as e:
        adapters.posthog_query("eu", "111", "bad", "SELECT 1", fetch=boom)
    assert "401" in str(e.value)


# ---- persistence ----

def test_seed_and_versioning():
    c = _conn()
    store_db.seed_defaults(c)
    assert len(store_db.list_logic(c)) == 4
    assert len(store_db.list_report_defs(c)) == 2
    # editing creates a new immutable version
    lg = store_db.get_logic(c, "ttv")
    v1 = lg.version
    lg2 = store_db.upsert_logic(c, "ttv", lg.name, lg.description, lg.fmt, lg.inputs, "gap + 1", "сегодня")
    assert lg2.version == v1 + 1
    assert c.execute("SELECT count(*) FROM logic_versions WHERE logic_id='ttv'").fetchone()[0] == 2
    # the new latest reflects the edit; the old version row is untouched
    assert store_db.get_logic(c, "ttv").expression == "gap + 1"
    old = c.execute("SELECT expression FROM logic_versions WHERE logic_id='ttv' AND version=?", (v1,)).fetchone()[0]
    assert old != "gap + 1"


def test_create_report_and_snapshot():
    c = _conn()
    store_db.seed_defaults(c)
    store_db.create_report(c, "r2", "Мой отчёт", 7, ["mau"])
    assert store_db.get_report_def(c, "r2").logic_ids == ("mau",)
    sid = store_db.save_snapshot(c, "r2", "2026-05-01 00:00:00", "2026-05-31 23:59:59", "24ч",
                                 [{"logic_id": "mau", "logic_version": 1, "value": "12 372", "fmt": "number",
                                   "trace": {"result": "12 372"}, "weeks": [], "series": [1, 2]}])
    snap = store_db.latest_snapshot(c, "r2")
    assert snap["id"] == sid
    assert snap["metrics"][0]["value"] == "12 372"
    assert snap["metrics"][0]["series"] == [1, 2]


# ---- DSL validation ----

def test_dsl_validate():
    assert dsl.validate("ratio(a, b)", {"a", "b"}) is None
    assert dsl.validate("a + c", {"a", "b"}) is not None       # unknown input
    assert dsl.validate("__import__('os')", {"a"}) is not None  # not a number/whitelisted call
