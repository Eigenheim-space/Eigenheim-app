"""Stage B: prev() deltas, Logic-on-Logic DAG, cycle detection, snapshot
immutability across edits, and the scheduler."""
import sqlite3
from datetime import datetime, timedelta, timezone

from eigenheim import db, scheduler, service, store_db
from eigenheim.catalog import Input, Logic
from eigenheim.compute import compute_value

START = db.PERIOD_START.strftime("%Y-%m-%d %H:%M:%S")
END = db.PERIOD_END.strftime("%Y-%m-%d %H:%M:%S")
WK2_START = "2026-05-08 00:00:00"
WK2_END = "2026-05-14 23:59:59"


def _events_conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    db.init_and_seed(c)
    store_db.ensure_schema(c)
    return c


def test_prev_delta():
    c = _events_conn()
    lg = Logic("wsignups", "weekly signups vs prev", "", 1,
               (Input("s", "unique", {"event": "signup"}),), "ratio(s, prev(s))", "number", "x")
    v, _ = compute_value(c, lg, WK2_START, WK2_END)
    # ratio of this week's signups to last week's; deterministic, finite, positive
    assert v is not None and v > 0
    assert compute_value(c, lg, WK2_START, WK2_END)[0] == v  # determinism


def test_logic_on_logic():
    c = _events_conn()
    base = Logic("base_su", "base", "", 1, (Input("s", "unique", {"event": "signup"}),), "s", "number", "x")
    composed = Logic("twice", "twice", "", 1, (Input("a", "logic", {"ref": "base_su"}),), "a * 2", "number", "x")
    resolve = {"base_su": base}.get
    base_v, _ = compute_value(c, base, START, END)
    comp_v, _ = compute_value(c, composed, START, END, resolve)
    assert comp_v == base_v * 2


def test_cycle_detection():
    c = _events_conn()
    store_db.seed_defaults(c)
    store_db.upsert_logic(c, "a", "a", "", "number", (Input("x", "unique", {"event": "signup"}),), "x", "x")
    store_db.upsert_logic(c, "b", "b", "", "number", (Input("y", "logic", {"ref": "a"}),), "y", "x")
    # making 'a' depend on 'b' would close a cycle a->b->a
    assert store_db.would_cycle(c, "a", (Input("z", "logic", {"ref": "b"}),)) is True
    assert store_db.would_cycle(c, "c", (Input("z", "logic", {"ref": "a"}),)) is False


def test_snapshot_immutable_across_edit():
    c = _events_conn()
    store_db.seed_defaults(c)
    service.collect_report(c, "growth", "24ч")
    snap1 = store_db.latest_snapshot(c, "growth")
    v1 = snap1["metrics"][0]["value"]
    ver1 = snap1["metrics"][0]["logic_version"]
    # edit the mau formula -> new immutable version
    mau = store_db.get_logic(c, "mau")
    store_db.upsert_logic(c, "mau", mau.name, mau.description, mau.fmt, mau.inputs, "m + 100", "x")
    assert store_db.get_logic(c, "mau").version == ver1 + 1
    # the already-collected snapshot is unchanged (its version + value frozen)
    again = store_db.latest_snapshot(c, "growth")
    assert again["metrics"][0]["value"] == v1
    assert again["metrics"][0]["logic_version"] == ver1


def test_scheduler_recomputes_due():
    c = _events_conn()
    store_db.seed_defaults(c)
    service.collect_report(c, "growth", "24ч")
    before = c.execute("SELECT count(*) FROM snapshots WHERE report_id='growth'").fetchone()[0]
    # nothing due right now
    assert scheduler.tick(c, datetime.now(timezone.utc)) == 0
    # two days later the 24h report is due
    n = scheduler.tick(c, datetime.now(timezone.utc) + timedelta(days=2))
    assert n == 1
    after = c.execute("SELECT count(*) FROM snapshots WHERE report_id='growth'").fetchone()[0]
    assert after == before + 1
