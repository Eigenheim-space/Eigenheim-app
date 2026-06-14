"""Graph seam: build and serve graphify runs."""
from __future__ import annotations

from fastapi import APIRouter, Header, Request

from .. import graph as graphmod
from ..graph import GraphBuildResponse, GraphResponse
from ..service import _period
from .deps import _auth

router = APIRouter()


@router.post("/graph/build", response_model=GraphBuildResponse)
async def build_graph(
    body: graphmod.GraphBuildRequest,
    request: Request,
    authorization: str | None = Header(None),
):
    """POST /graph/build — run graphify over a directory and return a run_id."""
    _auth(authorization)
    return await graphmod.build_graph(body, request.app.state.conn)


@router.get("/graph/{run_id}/json", response_model=GraphResponse)
def get_graph_json(
    run_id: str,
    request: Request,
    days: int = 30,
    authorization: str | None = Header(None),
):
    """GET /graph/{run_id}/json — serve the capped, metric-enriched graph JSON."""
    _auth(authorization)
    period = _period(days)
    return graphmod.get_graph_json(run_id, request.app.state.conn, period)
