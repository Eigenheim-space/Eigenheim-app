"""MCP key management."""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from .. import mcp_auth
from .deps import _auth
from .models import McpKeyCreateOut, McpKeyOut, McpKeyRevokeOut

router = APIRouter()


class McpKeyIn(BaseModel):
    name: str
    scopes: list[str] | None = None


@router.post("/mcp-keys", response_model=McpKeyCreateOut)
def create_key(body: McpKeyIn, request: Request, authorization: str | None = Header(None)):
    """Create an MCP key. Returns the raw key ONCE; only the HMAC hash is stored."""
    _auth(authorization)
    raw, key_id = mcp_auth.create_mcp_key(request.app.state.conn, body.name, body.scopes)
    return {
        "key_id": key_id,
        "raw_key": raw,
        "warning": "Store this key now. It will not be shown again.",
    }


@router.get("/mcp-keys", response_model=list[McpKeyOut])
def list_keys(request: Request, authorization: str | None = Header(None)):
    """List non-revoked MCP keys (metadata only, no hashes or raw keys)."""
    _auth(authorization)
    return mcp_auth.list_mcp_keys(request.app.state.conn)


@router.delete("/mcp-keys/{key_id}", response_model=McpKeyRevokeOut)
def revoke_key(key_id: str, request: Request, authorization: str | None = Header(None)):
    """Revoke an MCP key by key_id."""
    _auth(authorization)
    ok = mcp_auth.revoke_mcp_key(request.app.state.conn, key_id)
    if not ok:
        raise HTTPException(404, "key not found or already revoked")
    return {"revoked": key_id}
