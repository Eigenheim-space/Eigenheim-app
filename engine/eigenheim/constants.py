"""Shared domain constants used by both the store layer and the API routers.

Centralising these here eliminates the duplication that previously existed
between app.py and store/okr_repo.py / store/command_center.py.
"""
from __future__ import annotations

# Goals / key-results
_VALID_COMPARISONS: frozenset[str] = frozenset({"gte", "lte", "eq"})

# Hypothesis workflow
_VALID_HYPOTHESIS_STATUSES: frozenset[str] = frozenset(
    {"proposed", "testing", "confirmed", "rejected"}
)
