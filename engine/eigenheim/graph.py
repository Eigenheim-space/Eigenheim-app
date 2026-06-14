"""Graph seam — wraps graphify subprocess runs and serves built graph.json.

Routes (wired in app.py):
    POST /graph/build         kick a graphify run over a given directory
    GET  /graph/{run_id}/json serve the capped, metric-enriched graph JSON

Auth: every endpoint requires the session Bearer token (same _auth() call as
all other routes). An endpoint returning 200 without a token is a test failure.

Node cap: top-500 nodes by degree; warn-logged on truncation.
LLM inference: opt-in via `infer` flag; default OFF (code/text extraction only).
Metric cross-link: if a graph node label matches a Logic name in the store, the
node is enriched with `value` (live computed) and `trace_ref` (formula string).
"""
from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException
from pydantic import BaseModel

from .compute import build_trace, compute_value

logger = logging.getLogger(__name__)

NODE_CAP = 500

# Base directory for all graph run artefacts (sibling of eigenheim.db).
# engine/data/graph/<run_id>/graphify-out/graph.json
_GRAPH_BASE = Path(__file__).resolve().parent.parent / "data" / "graph"


# ─── Pydantic models ─────────────────────────────────────────────────────────

class GraphBuildRequest(BaseModel):
    path: str
    infer: bool = False


class GraphBuildResponse(BaseModel):
    run_id: str
    status: str   # "building" | "done" | "failed"
    started_at: str


class GraphNode(BaseModel):
    id: str
    label: str
    source_file: str | None = None
    community: int | None = None
    type: str | None = None
    value: float | None = None
    trace_ref: str | None = None


class GraphEdge(BaseModel):
    source: str
    target: str
    relation: str
    confidence: str


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    run_id: str
    built_at: str


# ─── Internal helpers ─────────────────────────────────────────────────────────

def _run_dir(run_id: str) -> Path:
    return _GRAPH_BASE / run_id


def _graph_json_path(run_id: str) -> Path:
    return _run_dir(run_id) / "graphify-out" / "graph.json"


def _meta_path(run_id: str) -> Path:
    return _run_dir(run_id) / "meta.json"


def _write_meta(run_id: str, status: str, started_at: str, error: str | None = None) -> None:
    meta = {"run_id": run_id, "status": status, "started_at": started_at}
    if error:
        meta["error"] = error
    _meta_path(run_id).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


def _cap_nodes(raw_nodes: list[dict], raw_edges: list[dict]) -> tuple[list[dict], list[dict]]:
    """Return top-NODE_CAP nodes by degree, with edges filtered to that node set."""
    if len(raw_nodes) <= NODE_CAP:
        return raw_nodes, raw_edges
    # Build degree map
    degree: dict[str, int] = {}
    for n in raw_nodes:
        degree.setdefault(n["id"], 0)
    for e in raw_edges:
        degree[e.get("source", "")] = degree.get(e.get("source", ""), 0) + 1
        degree[e.get("target", "")] = degree.get(e.get("target", ""), 0) + 1
    top_ids = {nid for nid, _ in sorted(degree.items(), key=lambda x: -x[1])[:NODE_CAP]}
    logger.warning("graph: node cap hit — truncating %d → %d nodes", len(raw_nodes), NODE_CAP)
    capped = [n for n in raw_nodes if n.get("id") in top_ids]
    filtered_edges = [e for e in raw_edges if e.get("source") in top_ids and e.get("target") in top_ids]
    return capped, filtered_edges


def _enrich_metrics(nodes: list[dict], conn, period: tuple[str, str]) -> list[dict]:
    """Inject live value + trace_ref onto nodes whose label matches a Logic name."""
    from . import store_db
    all_logic = store_db.list_logic(conn)
    name_to_logic = {lg.name: lg for lg in all_logic}
    start, end = period
    enriched = []
    for n in nodes:
        label = n.get("label", "")
        lg = name_to_logic.get(label)
        if lg is not None:
            def _resolve(lid, _conn=conn):
                return store_db.get_logic(_conn, lid)
            try:
                value, _ = compute_value(conn, lg, start, end, _resolve)
                trace = build_trace(conn, lg, start, end, _resolve)
                trace_ref = trace.get("formula", "")
                n = dict(n, value=value, trace_ref=trace_ref)
            except Exception:
                pass
        enriched.append(n)
    return enriched


# ─── Route handlers ───────────────────────────────────────────────────────────

async def build_graph(req: GraphBuildRequest, conn) -> GraphBuildResponse:
    """POST /graph/build — kick a graphify subprocess run."""
    target = Path(req.path).expanduser().resolve()
    if not target.exists() or not target.is_dir():
        raise HTTPException(400, f"path not found or not a directory: {req.path}")

    run_id = uuid.uuid4().hex[:12]
    run_dir = _run_dir(run_id)
    run_dir.mkdir(parents=True, exist_ok=True)
    started_at = datetime.now(timezone.utc).isoformat()
    _write_meta(run_id, "building", started_at)

    # Build the graphify command.
    # --no-viz skips the HTML output (keeps only graph.json + GRAPH_REPORT.md).
    cmd = ["graphify", str(target), "--no-viz"]
    if not req.infer:
        # Without --mode deep, graphify defaults to code/text extraction only —
        # LLM-inferred edges are not emitted unless deep mode is active. This is
        # the correct default behaviour; no extra flag needed.
        pass

    env_override = {"GRAPHIFY_QUERY_LOG_DISABLE": "1"}
    import os
    full_env = {**os.environ, **env_override}

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(run_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=full_env,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            err = stderr.decode(errors="replace")[:500]
            logger.error("graphify run %s failed: %s", run_id, err)
            _write_meta(run_id, "failed", started_at, error=err)
            raise HTTPException(500, f"graphify run failed: {err}")
    except FileNotFoundError:
        _write_meta(run_id, "failed", started_at, error="graphify not installed")
        raise HTTPException(500, "graphify is not installed — run: uv tool install graphifyy")

    graph_json = _graph_json_path(run_id)
    if not graph_json.exists():
        _write_meta(run_id, "failed", started_at, error="graph.json not produced")
        raise HTTPException(500, "graphify ran but produced no graph.json")

    _write_meta(run_id, "done", started_at)
    return GraphBuildResponse(run_id=run_id, status="done", started_at=started_at)


def get_graph_json(run_id: str, conn, period: tuple[str, str]) -> GraphResponse:
    """GET /graph/{run_id}/json — serve the capped, metric-enriched graph JSON."""
    graph_path = _graph_json_path(run_id)
    if not graph_path.exists():
        meta_p = _meta_path(run_id)
        if meta_p.exists():
            meta = json.loads(meta_p.read_text(encoding="utf-8"))
            status = meta.get("status", "unknown")
            if status == "building":
                raise HTTPException(202, "graph is still building")
            raise HTTPException(404, f"graph run {run_id} status: {status}")
        raise HTTPException(404, f"graph run {run_id} not found")

    raw = json.loads(graph_path.read_text(encoding="utf-8"))
    raw_nodes: list[dict] = raw.get("nodes", [])
    raw_edges: list[dict] = raw.get("edges", [])

    capped_nodes, capped_edges = _cap_nodes(raw_nodes, raw_edges)
    enriched_nodes = _enrich_metrics(capped_nodes, conn, period)

    built_at = datetime.now(timezone.utc).isoformat()
    meta_p = _meta_path(run_id)
    if meta_p.exists():
        try:
            built_at = json.loads(meta_p.read_text(encoding="utf-8")).get("started_at", built_at)
        except Exception:
            pass

    nodes = [
        GraphNode(
            id=n.get("id", ""),
            label=n.get("label", ""),
            source_file=n.get("source_file"),
            community=n.get("community"),
            type=n.get("file_type") or n.get("type"),
            value=n.get("value"),
            trace_ref=n.get("trace_ref"),
        )
        for n in enriched_nodes
    ]
    edges = [
        GraphEdge(
            source=e.get("source", ""),
            target=e.get("target", ""),
            relation=e.get("relation", ""),
            confidence=e.get("confidence", "AMBIGUOUS"),
        )
        for e in capped_edges
    ]
    return GraphResponse(nodes=nodes, edges=edges, run_id=run_id, built_at=built_at)
