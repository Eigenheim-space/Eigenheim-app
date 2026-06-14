"""Shared FastAPI dependencies.

`_auth_state` lives here so routers and the app assembly both reference the
same mutable dict. Tests monkeypatch `eigenheim.app._auth_state`; app.py
re-exports this name so those patches still hit the right object.
"""
from __future__ import annotations

import hmac
import os

from fastapi import Header, HTTPException

# Per-launch session token. Populated once by _resolve_session_token() in the
# lifespan; thereafter immutable for the lifetime of the process.
_auth_state: dict[str, str | None] = {"token": os.environ.get("EIGENHEIM_TOKEN")}


def _auth(authorization: str | None = Header(None)) -> None:
    """Raise 401 when a session token is configured and the header doesn't match."""
    tok = _auth_state["token"]
    if tok and not hmac.compare_digest(authorization or "", f"Bearer {tok}"):
        raise HTTPException(401, "missing or invalid session token")
