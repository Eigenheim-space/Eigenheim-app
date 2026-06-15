"""Chat conversation persistence routes.

LOCAL ONLY: These routes store and return transcript TEXT only.
The engine never calls a model. Chat generation lives entirely in the renderer.

Privacy (hard constraint): transcripts are LOCAL SQLite only.
They must NEVER be included in any diagnostic/export/log bundle, and must
never be synced or forwarded anywhere. Reports/CSV export code must not
pull from the conversations or messages tables.
"""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from ..store import chat_repo
from .deps import _auth

router = APIRouter()


# ── Request models ────────────────────────────────────────────────────────────

class ConversationIn(BaseModel):
    title: str


class ConversationPatchIn(BaseModel):
    title: str


class MessageIn(BaseModel):
    role: str
    content: str
    meta_json: str | None = None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/chat/conversations")
def list_conversations(
    request: Request,
    authorization: str | None = Header(None),
):
    _auth(authorization)
    conn = request.app.state.conn
    return chat_repo.list_conversations(conn)


@router.post("/chat/conversations", status_code=201)
def create_conversation(
    body: ConversationIn,
    request: Request,
    authorization: str | None = Header(None),
):
    _auth(authorization)
    conn = request.app.state.conn
    return chat_repo.create_conversation(conn, body.title)


@router.get("/chat/conversations/{conversation_id}")
def get_conversation(
    conversation_id: str,
    request: Request,
    authorization: str | None = Header(None),
):
    _auth(authorization)
    conn = request.app.state.conn
    result = chat_repo.get_conversation(conn, conversation_id)
    if result is None:
        raise HTTPException(404, "conversation not found")
    return result


@router.post("/chat/conversations/{conversation_id}/messages", status_code=201)
def append_message(
    conversation_id: str,
    body: MessageIn,
    request: Request,
    authorization: str | None = Header(None),
):
    _auth(authorization)
    conn = request.app.state.conn
    # Verify conversation exists
    if chat_repo.get_conversation(conn, conversation_id) is None:
        raise HTTPException(404, "conversation not found")
    import json as _json
    meta = None
    if body.meta_json:
        try:
            meta = _json.loads(body.meta_json)
        except ValueError:
            raise HTTPException(422, "meta_json is not valid JSON")
    return chat_repo.append_message(conn, conversation_id, body.role, body.content, meta)


@router.patch("/chat/conversations/{conversation_id}")
def rename_conversation(
    conversation_id: str,
    body: ConversationPatchIn,
    request: Request,
    authorization: str | None = Header(None),
):
    _auth(authorization)
    conn = request.app.state.conn
    result = chat_repo.rename_conversation(conn, conversation_id, body.title)
    if result is None:
        raise HTTPException(404, "conversation not found")
    return result


@router.delete("/chat/conversations/{conversation_id}")
def delete_conversation(
    conversation_id: str,
    request: Request,
    authorization: str | None = Header(None),
):
    _auth(authorization)
    conn = request.app.state.conn
    deleted = chat_repo.delete_conversation(conn, conversation_id)
    if not deleted:
        raise HTTPException(404, "conversation not found")
    return {"deleted": conversation_id}
