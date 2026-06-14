"""Tests for /graph/build and /graph/{run_id}/json endpoints.

Gates:
  - auth required on both endpoints
  - build → fetch happy path (mocked graphify subprocess)
  - node cap: graphs > 500 nodes are truncated
  - egress default: infer=False (no LLM flag) by default
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from eigenheim import db, store_db
from eigenheim.app import app
import eigenheim.app as appmod


# ─── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def client(tmp_path, monkeypatch):
    """Open-auth TestClient with isolated tmp DB."""
    db_path = str(tmp_path / "test.db")
    monkeypatch.setenv("EIGENHEIM_DB", db_path)
    monkeypatch.delenv("EIGENHEIM_TOKEN", raising=False)
    monkeypatch.delenv("EIGENHEIM_TOKEN_FILE", raising=False)
    appmod._auth_state["token"] = None
    with TestClient(app) as c:
        yield c


@pytest.fixture
def auth_client(tmp_path, monkeypatch):
    """TestClient with a session token set."""
    db_path = str(tmp_path / "test.db")
    monkeypatch.setenv("EIGENHEIM_DB", db_path)
    monkeypatch.delenv("EIGENHEIM_TOKEN", raising=False)
    monkeypatch.delenv("EIGENHEIM_TOKEN_FILE", raising=False)
    appmod._auth_state["token"] = "test-secret"
    with TestClient(app) as c:
        yield c
    appmod._auth_state["token"] = None


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _make_fake_graph(n_nodes: int = 5) -> dict:
    nodes = [{"id": f"node_{i}", "label": f"Node {i}", "file_type": "document",
               "source_file": f"file_{i}.md", "community": i % 3} for i in range(n_nodes)]
    edges = []
    for i in range(min(n_nodes - 1, 10)):
        edges.append({"source": f"node_{i}", "target": f"node_{i + 1}",
                      "relation": "references", "confidence": "EXTRACTED",
                      "confidence_score": 1.0, "weight": 1.0})
    return {"nodes": nodes, "edges": edges, "communities": {}}


def _write_fake_graph(run_dir: Path, n_nodes: int = 5) -> None:
    out_dir = run_dir / "graphify-out"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "graph.json").write_text(
        json.dumps(_make_fake_graph(n_nodes), ensure_ascii=False), encoding="utf-8"
    )


# ─── Auth tests ───────────────────────────────────────────────────────────────

def test_build_graph_requires_auth(auth_client, tmp_path):
    """POST /graph/build must return 401 when no token provided."""
    resp = auth_client.post("/graph/build", json={"path": str(tmp_path)})
    assert resp.status_code == 401


def test_get_graph_requires_auth(auth_client, tmp_path):
    """GET /graph/{run_id}/json must return 401 when no token provided."""
    resp = auth_client.get("/graph/fake-run-id/json")
    assert resp.status_code == 401


def test_build_graph_accepts_valid_token(client, tmp_path):
    """POST /graph/build with open auth (no token) should reach route logic."""
    # Path exists but graphify isn't actually called (we're just testing auth pass-through).
    # If graphify is missing we get 500, not 401.
    resp = client.post("/graph/build", json={"path": str(tmp_path)})
    assert resp.status_code != 401


# ─── Build → fetch happy path ─────────────────────────────────────────────────

def test_build_and_fetch_happy_path(client, tmp_path):
    """build → fetch complete round-trip with a mocked graphify subprocess."""
    import eigenheim.graph as graphmod

    # We'll capture the run_id by monkeypatching uuid.uuid4
    fake_run_id = "abc123def456"

    async def fake_build(req, conn):
        # Simulate what build_graph does: create the directory and write graph.json.
        run_dir = graphmod._run_dir(fake_run_id)
        _write_fake_graph(run_dir, n_nodes=3)
        graphmod._write_meta(fake_run_id, "done", "2026-01-01T00:00:00+00:00")
        from eigenheim.graph import GraphBuildResponse
        return GraphBuildResponse(run_id=fake_run_id, status="done", started_at="2026-01-01T00:00:00+00:00")

    with patch.object(graphmod, "build_graph", fake_build):
        resp = client.post("/graph/build", json={"path": str(tmp_path)})

    assert resp.status_code == 200
    data = resp.json()
    assert data["run_id"] == fake_run_id
    assert data["status"] == "done"

    # Now fetch the graph.
    resp2 = client.get(f"/graph/{fake_run_id}/json")
    assert resp2.status_code == 200
    gdata = resp2.json()
    assert gdata["run_id"] == fake_run_id
    assert len(gdata["nodes"]) == 3
    assert len(gdata["edges"]) == 2
    assert "built_at" in gdata


# ─── Node cap ────────────────────────────────────────────────────────────────

def test_node_cap_applied(client, tmp_path):
    """Graphs with > 500 nodes are truncated to 500."""
    import eigenheim.graph as graphmod

    fake_run_id = "captest123456"
    run_dir = graphmod._run_dir(fake_run_id)
    _write_fake_graph(run_dir, n_nodes=600)
    graphmod._write_meta(fake_run_id, "done", "2026-01-01T00:00:00+00:00")

    resp = client.get(f"/graph/{fake_run_id}/json")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["nodes"]) <= 500


# ─── Egress default: infer=False ─────────────────────────────────────────────

def test_build_defaults_infer_false(client, tmp_path):
    """POST /graph/build without infer flag defaults to infer=False."""
    resp = client.post("/graph/build", json={"path": str(tmp_path)})
    # We only check the request was valid (not 422); actual infer flag is
    # tested via cmd construction in unit test below.
    assert resp.status_code != 422


def test_build_request_infer_defaults_false():
    """GraphBuildRequest.infer defaults to False."""
    from eigenheim.graph import GraphBuildRequest
    req = GraphBuildRequest(path="/tmp")
    assert req.infer is False


# ─── 404 on missing run ───────────────────────────────────────────────────────

def test_get_graph_missing_run(client):
    resp = client.get("/graph/nonexistent-run-id/json")
    assert resp.status_code == 404
