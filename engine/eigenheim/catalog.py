"""Definitions: events, Logic (validated formulas), reports, syncs.

Logic is versioned and immutable (the sha is a content hash). The starter
templates ship with `needs_validation` per the plan; once accepted they become
ordinary Logic.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Input:
    alias: str
    kind: str          # unique | count | funnel | retained | mau | median_gap_days
    params: dict


@dataclass(frozen=True)
class Logic:
    id: str
    name: str
    description: str
    version: int
    inputs: tuple[Input, ...]
    expression: str
    fmt: str           # percent | number | days
    validated: str     # human date
    template: bool = False

    @property
    def sha(self) -> str:
        payload = f"{self.name}|{self.version}|{self.expression}|" + "|".join(
            f"{i.alias}:{i.kind}:{sorted(i.params.items())}" for i in self.inputs
        )
        return hashlib.sha256(payload.encode()).hexdigest()


@dataclass(frozen=True)
class Report:
    id: str
    name: str
    period_days: int
    logic_ids: tuple[str, ...]


EVENTS = [
    {"name": "signup", "origin": "synced", "source": "PostHog", "description": "User completed signup"},
    {"name": "first_report", "origin": "synced", "source": "PostHog", "description": "First report created"},
    {"name": "page_view", "origin": "synced", "source": "PostHog", "description": "Page view"},
    {"name": "session_start", "origin": "synced", "source": "PostHog", "description": "Session start"},
]

LOGIC: dict[str, Logic] = {
    "activation": Logic(
        "activation", "activation", "Share of users activated within 7 days", 3,
        (Input("signups", "unique", {"event": "signup"}),
         Input("activated", "funnel", {"from": "signup", "to": "first_report", "within_days": 7})),
        "ratio(activated, signups)", "percent", "12 Mar 2026",
    ),
    "d7_retention": Logic(
        "d7_retention", "d7_retention", "Share of users returning on day 7", 4,
        (Input("signups", "unique", {"event": "signup"}),
         Input("retained", "retained", {"base": "signup", "ret": "session_start", "after_days": 7})),
        "ratio(retained, signups)", "percent", "28 May 2026",
    ),
    "ttv": Logic(
        "ttv", "ttv", "Median time to first report", 2,
        (Input("gap", "median_gap_days", {"from": "signup", "to": "first_report"}),),
        "gap", "days", "12 Mar 2026",
    ),
    "mau": Logic(
        "mau", "mau", "Unique users over a rolling 30 days", 1,
        (Input("m", "mau", {"days": 30}),),
        "m", "number", "02 Apr 2026",
    ),
}

# starter templates (needs_validation)
TEMPLATES = [
    {"id": "dau", "name": "DAU", "description": "Unique active users per day", "expression": "unique(any_event in day)"},
    {"id": "stickiness", "name": "Stickiness", "description": "DAU / MAU", "expression": "ratio(dau, mau)"},
    {"id": "conversion", "name": "Conversion", "description": "Share completing the step", "expression": "ratio(step_b, step_a)"},
]

REPORTS: dict[str, Report] = {
    "activation": Report("activation", "Activation", 30, ("activation", "d7_retention", "ttv")),
    "growth": Report("growth", "Growth", 7, ("mau",)),
}

SYNCS = [
    {"id": "s1", "target": "event catalog", "frequency": "every 6h", "next_run": "01 Jun 15:00", "last_status": "ok", "last_run": "01 Jun 09:00"},
    {"id": "s2", "target": "Activation", "frequency": "every 24h", "next_run": "02 Jun 09:00", "last_status": "ok", "last_run": "01 Jun 09:14"},
    {"id": "s3", "target": "Data quality", "frequency": "every 12h", "next_run": "01 Jun 15:11", "last_status": "error", "last_run": "01 Jun 03:11"},
]


def fmt_value(v: float | None, fmt: str) -> str:
    if v is None:
        return "—"
    if fmt == "percent":
        return f"{v * 100:.2f}%"
    if fmt == "days":
        return f"{v:.1f}d"
    return f"{v:,.0f}".replace(",", " ")
