"""Golden test: the deterministic engine must produce byte-identical numbers on
every run. The seed has no RNG, so any drift means a real engine change."""
import sqlite3

from eigenheim import db
from eigenheim.catalog import LOGIC, fmt_value
from eigenheim.compute import compute_value

START = db.PERIOD_START.strftime("%Y-%m-%d %H:%M:%S")
END = db.PERIOD_END.strftime("%Y-%m-%d %H:%M:%S")


def _conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    db.init_and_seed(c)
    return c


def test_seed_size_stable():
    c = _conn()
    (n,) = c.execute("SELECT count(*) FROM events").fetchone()
    (u,) = c.execute("SELECT count(DISTINCT user_id) FROM events").fetchone()
    assert u == db.N_SIGNUPS
    assert n == 60835  # GOLDEN: total events


def test_metrics_golden():
    c = _conn()
    got = {lid: fmt_value(compute_value(c, lg, START, END)[0], lg.fmt) for lid, lg in LOGIC.items()}
    assert got == {
        "activation": "29.02%",
        "d7_retention": "36.22%",
        "ttv": "3.1d",
        "mau": "12 372",
    }


def test_determinism_two_runs():
    a = {lid: compute_value(_conn(), lg, START, END)[0] for lid, lg in LOGIC.items()}
    b = {lid: compute_value(_conn(), lg, START, END)[0] for lid, lg in LOGIC.items()}
    assert a == b
