"""PostHog datasource: test and sync."""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from .. import adapters
from .deps import _auth
from .models import PosthogSyncOut, PosthogTestOut

router = APIRouter()


class PosthogIn(BaseModel):
    host: str = "eu"
    project_id: str
    api_key: str
    days: int = 30


@router.post("/datasources/posthog/test", response_model=PosthogTestOut)
def posthog_test(body: PosthogIn, authorization: str | None = Header(None)):
    _auth(authorization)
    try:
        return adapters.posthog_test(body.host, body.project_id, body.api_key)
    except adapters.AdapterError as e:
        raise HTTPException(400, str(e))


@router.post("/datasources/posthog/sync", response_model=PosthogSyncOut)
def posthog_sync(body: PosthogIn, request: Request, authorization: str | None = Header(None)):
    _auth(authorization)
    try:
        n = adapters.posthog_sync(
            request.app.state.conn, body.host, body.project_id, body.api_key, body.days
        )
    except adapters.AdapterError as e:
        raise HTTPException(400, str(e))
    return {"ingested": n}
