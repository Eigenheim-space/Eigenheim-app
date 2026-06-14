"""Shared utility functions used across store/ submodules.

Leaf-level: no imports from other store/ submodules."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from ..catalog import Input


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _inputs_to_json(inputs: tuple[Input, ...]) -> str:
    return json.dumps([{"alias": i.alias, "kind": i.kind, "params": i.params} for i in inputs])


def _inputs_from_json(s: str) -> tuple[Input, ...]:
    return tuple(Input(d["alias"], d["kind"], d["params"]) for d in json.loads(s))
