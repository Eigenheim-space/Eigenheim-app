"""Draft / promote / reject gate + hash-chain audit tests (Vector 3, W1-W5).

W1 — logic:write scope is distinct and default-deny.
W2 — draft/live distinction in logic_versions.
W3 — MCP create_logic / update_logic tools (agent path).
W4 — REST promote / reject gate (human-only path).
W5 — Hash-chain audit JSONL.

Invariants checked:
  - DSL-invalid proposal is rejected and NOT stored.
  - A valid proposal creates an inert draft that is NOT live and does NOT affect compute.
  - promote() makes the version live; compute now reflects it.
  - reject() marks it rejected; it remains inert.
  - Hash chain links correctly across create → promote.
  - logic:write scope is enforced on MCP tools (a read-only key is denied).
  - No MCP promote path exists (the tool is absent from the mcp instance).
"""
from __future__ import annotations

import hashlib
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from eigenheim import db as _db, store_db
from eigenheim.app import app
from eigenheim.catalog import Input, Logic
from eigenheim.mcp_auth import McpAuthError, create_mcp_key, require_scope
from eigenheim.mcp_instructions import ALL_INSTRUCTIONS, _FORBIDDEN_FRAGMENTS


# ── helpers ───────────────────────────────────────────────────────────────────


def _seeded_conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    _db.init_and_seed(c)
    store_db.ensure_schema(c)
    store_db.seed_defaults(c)
    store_db.run_migrations(c)
    return c


@pytest.fixture()
def conn():
    return _seeded_conn()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.db")
    monkeypatch.setenv("EIGENHEIM_DB", db_path)
    monkeypatch.delenv("EIGENHEIM_TOKEN", raising=False)
    monkeypatch.delenv("EIGENHEIM_TOKEN_FILE", raising=False)
    import eigenheim.app as appmod
    appmod._auth_state["token"] = None
    with TestClient(app) as c:
        yield c


# ── W1: logic:write scope default-deny ───────────────────────────────────────


def test_w1_read_only_key_denied_for_logic_write(conn):
    """A key with only 'read' scope must be denied for logic:write."""
    raw, _kid = create_mcp_key(conn, "read-only", scopes=["read"])
    with pytest.raises(McpAuthError, match="scope"):
        require_scope(conn, raw, "logic:write")


def test_w1_logic_write_scope_key_passes(conn):
    """A key explicitly granted logic:write satisfies the scope check."""
    raw, kid = create_mcp_key(conn, "writer", scopes=["logic:write"])
    result = require_scope(conn, raw, "logic:write")
    assert result == kid


def test_w1_logic_write_not_satisfied_by_read_umbrella(conn):
    """logic:write is NOT granted by the read umbrella scope."""
    raw, _kid = create_mcp_key(conn, "read-umbrella", scopes=["read"])
    with pytest.raises(McpAuthError):
        require_scope(conn, raw, "logic:write")


# ── W2: draft/live schema ────────────────────────────────────────────────────


def test_w2_seeded_versions_are_live(conn):
    """All seed logic_versions rows must have status='live'."""
    rows = conn.execute(
        "SELECT logic_id, version, status FROM logic_versions"
    ).fetchall()
    assert len(rows) > 0
    for r in rows:
        assert r["status"] == "live", (
            f"seeded version {r['version']} of '{r['logic_id']}' has unexpected status '{r['status']}'"
        )


def test_w2_seeded_versions_have_source(conn):
    """All seed logic_versions must have a non-empty source."""
    rows = conn.execute(
        "SELECT logic_id, version, source FROM logic_versions"
    ).fetchall()
    for r in rows:
        assert r["source"] in ("bundled", "user"), (
            f"unexpected source '{r['source']}' for '{r['logic_id']}' v{r['version']}"
        )


def test_w2_create_draft_creates_inert_version(conn):
    """create_draft_version stores a status='draft' row, not 'live'."""
    result = store_db.create_draft_version(
        conn, "new_metric", "New Metric", "", "number",
        (Input("u", "unique", {"event": "signup"}),),
        "u * 2",
        rationale="test proposal",
    )
    row = conn.execute(
        "SELECT status, source FROM logic_versions WHERE logic_id=? AND version=?",
        (result["logic_id"], result["version"]),
    ).fetchone()
    assert row is not None
    assert row["status"] == "draft"
    assert row["source"] == "agent-draft"


def test_w2_draft_does_not_appear_as_live_in_get_logic(conn):
    """get_logic must return the latest LIVE version, ignoring drafts."""
    # Use an existing live logic.
    live_before = store_db.get_logic(conn, "mau")
    assert live_before is not None
    live_expr_before = live_before.expression

    # Create a draft with a different expression.
    store_db.create_draft_version(
        conn, "mau", live_before.name, "", live_before.fmt,
        live_before.inputs,
        "u * 999",
        rationale="sneaky draft",
    )

    # get_logic must still return the original live expression.
    live_after = store_db.get_logic(conn, "mau")
    assert live_after is not None
    assert live_after.expression == live_expr_before, (
        "get_logic returned the draft expression instead of the live version"
    )


def test_w2_promote_makes_version_live(conn):
    """promote_version flips the draft to live; get_logic reflects it."""
    live_before = store_db.get_logic(conn, "mau")
    new_expr = "u * 42"
    result = store_db.create_draft_version(
        conn, "mau", live_before.name, "", live_before.fmt,
        live_before.inputs, new_expr, rationale="test promote",
    )
    draft_ver = result["version"]

    # Confirm still inert.
    assert store_db.get_logic(conn, "mau").expression != new_expr

    # Promote.
    store_db.promote_version(conn, "mau", draft_ver)

    # Now the live version must return the new expression.
    live_after = store_db.get_logic(conn, "mau")
    assert live_after is not None
    assert live_after.expression == new_expr
    assert live_after.version == draft_ver


def test_w2_reject_marks_rejected_and_remains_inert(conn):
    """reject_version marks the draft rejected; get_logic is unchanged."""
    live_before = store_db.get_logic(conn, "mau")
    orig_expr = live_before.expression
    result = store_db.create_draft_version(
        conn, "mau", live_before.name, "", live_before.fmt,
        live_before.inputs, "u * 0", rationale="to be rejected",
    )
    draft_ver = result["version"]

    store_db.reject_version(conn, "mau", draft_ver)

    # Status in DB.
    row = conn.execute(
        "SELECT status FROM logic_versions WHERE logic_id='mau' AND version=?",
        (draft_ver,),
    ).fetchone()
    assert row["status"] == "rejected"

    # get_logic unchanged.
    live_after = store_db.get_logic(conn, "mau")
    assert live_after.expression == orig_expr


def test_w2_cannot_promote_after_reject(conn):
    """A rejected version cannot be promoted."""
    live_before = store_db.get_logic(conn, "mau")
    result = store_db.create_draft_version(
        conn, "mau", live_before.name, "", live_before.fmt,
        live_before.inputs, "u * 7", rationale="reject-then-try-promote",
    )
    draft_ver = result["version"]
    store_db.reject_version(conn, "mau", draft_ver)
    with pytest.raises(ValueError, match="rejected"):
        store_db.promote_version(conn, "mau", draft_ver)


def test_w2_cannot_reject_live_version(conn):
    """A live version cannot be rejected."""
    live = store_db.get_logic(conn, "mau")
    with pytest.raises(ValueError, match="live"):
        store_db.reject_version(conn, "mau", live.version)


def test_w2_list_drafts_returns_only_drafts(conn):
    """list_drafts must return only status='draft' rows."""
    # Promote one, reject one, leave one pending.
    live = store_db.get_logic(conn, "mau")
    d1 = store_db.create_draft_version(
        conn, "mau", live.name, "", live.fmt, live.inputs, "u * 1", rationale="d1"
    )
    d2 = store_db.create_draft_version(
        conn, "mau", live.name, "", live.fmt, live.inputs, "u * 2", rationale="d2"
    )
    d3 = store_db.create_draft_version(
        conn, "mau", live.name, "", live.fmt, live.inputs, "u * 3", rationale="d3"
    )
    store_db.promote_version(conn, "mau", d1["version"])
    store_db.reject_version(conn, "mau", d2["version"])
    # d3 is still pending.

    drafts = store_db.list_drafts(conn, "mau")
    draft_versions = {d["version"] for d in drafts}
    assert d3["version"] in draft_versions
    assert d1["version"] not in draft_versions
    assert d2["version"] not in draft_versions


# ── W3: MCP write tools ───────────────────────────────────────────────────────


def test_w3_mcp_create_logic_requires_logic_write_scope():
    """create_logic tool must reject a read-only MCP key."""
    import eigenheim.mcp_server as ms
    c = _seeded_conn()
    raw, _kid = create_mcp_key(c, "ro-key", scopes=["read"])
    original_conn = ms._conn
    ms._conn = c
    try:
        result = ms.create_logic(
            key=raw, logic_id="x", name="X", expression="u", inputs=[{"alias": "u", "kind": "unique", "params": {"event": "signup"}}],
            rationale="should be denied",
        )
        assert "error" in result
        assert result["error"] == "auth_error"
    finally:
        ms._conn = original_conn


def test_w3_mcp_create_logic_invalid_expression_not_stored():
    """An invalid expression must be rejected before any DB write."""
    import eigenheim.mcp_server as ms
    c = _seeded_conn()
    raw, _kid = create_mcp_key(c, "write-key", scopes=["logic:write"])
    original_conn = ms._conn
    ms._conn = c
    try:
        result = ms.create_logic(
            key=raw, logic_id="bad_logic", name="Bad", expression="eval('drop table logic')",
            inputs=[{"alias": "u", "kind": "unique", "params": {"event": "signup"}}],
            rationale="attack attempt",
        )
        assert "error" in result, "expected validation_error for invalid expression"
        assert result["error"] == "validation_error"
        # Must not have been stored.
        row = c.execute("SELECT id FROM logic WHERE id='bad_logic'").fetchone()
        assert row is None, "invalid proposal was stored in DB — guardrail failed"
    finally:
        ms._conn = original_conn


def test_w3_mcp_create_logic_valid_creates_inert_draft():
    """A valid create_logic call creates a draft that is NOT live."""
    import eigenheim.mcp_server as ms
    c = _seeded_conn()
    raw, _kid = create_mcp_key(c, "write-key2", scopes=["logic:write"])
    ms._session_hinted = False
    original_conn = ms._conn
    ms._conn = c
    try:
        result = ms.create_logic(
            key=raw, logic_id="agent_metric", name="Agent Metric",
            expression="u",
            inputs=[{"alias": "u", "kind": "unique", "params": {"event": "signup"}}],
            rationale="because it makes sense",
        )
        assert "error" not in result, f"unexpected error: {result}"
        assert result["status"] == "draft_created"
        assert "draft_id" in result
        assert "audit_hash" in result
        assert "note" in result and "DRAFT" in result["note"]

        # The draft must NOT appear as the live logic.
        live = store_db.get_logic(c, "agent_metric")
        assert live is None, "agent draft appeared as live logic"

        # The draft version row must exist with status='draft'.
        version = result["version"]
        row = c.execute(
            "SELECT status, source FROM logic_versions WHERE logic_id='agent_metric' AND version=?",
            (version,),
        ).fetchone()
        assert row is not None
        assert row["status"] == "draft"
        assert row["source"] == "agent-draft"
    finally:
        ms._conn = original_conn
        ms._session_hinted = False


def test_w3_mcp_update_logic_rejected_for_unknown_id():
    """update_logic on an unknown logic_id returns not_found, not creates."""
    import eigenheim.mcp_server as ms
    c = _seeded_conn()
    raw, _kid = create_mcp_key(c, "write-key3", scopes=["logic:write"])
    original_conn = ms._conn
    ms._conn = c
    try:
        result = ms.update_logic(
            key=raw, logic_id="ghost_metric", expression="u",
            inputs=[{"alias": "u", "kind": "unique", "params": {"event": "signup"}}],
            rationale="update unknown",
        )
        assert result["error"] == "not_found"
    finally:
        ms._conn = original_conn


def test_w3_mcp_update_logic_creates_inert_draft():
    """update_logic on an existing Logic creates a draft; live version unchanged."""
    import eigenheim.mcp_server as ms
    c = _seeded_conn()
    raw, _kid = create_mcp_key(c, "write-key4", scopes=["logic:write"])
    ms._session_hinted = False
    original_conn = ms._conn
    ms._conn = c
    live_before = store_db.get_logic(c, "mau")
    orig_expr = live_before.expression
    try:
        result = ms.update_logic(
            key=raw, logic_id="mau", expression="u * 999",
            inputs=[{"alias": "u", "kind": "mau", "params": {"days": 30}}],
            rationale="update mau",
        )
        assert result["status"] == "draft_created"
        # Live must not have changed.
        live_after = store_db.get_logic(c, "mau")
        assert live_after.expression == orig_expr
    finally:
        ms._conn = original_conn
        ms._session_hinted = False


def test_w3_no_mcp_promote_tool():
    """The MCP server must NOT expose a promote tool — no agent self-promotion path."""
    import eigenheim.mcp_server as ms
    # FastMCP stores tools in a dict keyed by tool name.
    tool_names = set(ms.mcp._tool_manager._tools.keys())
    assert "promote_version" not in tool_names, "promote_version tool found on MCP — security violation"
    assert "promote" not in tool_names, "promote tool found on MCP — security violation"


def test_w3_draft_does_not_affect_compute():
    """A draft version must not change compute results."""
    import eigenheim.mcp_server as ms
    from eigenheim.compute import compute_value

    c = _seeded_conn()
    live_before = store_db.get_logic(c, "mau")
    v_before, _ = compute_value(c, live_before, "2026-01-01", "2026-12-31", lambda lid: store_db.get_logic(c, lid))

    # Create a draft with a different expression.
    store_db.create_draft_version(
        c, "mau", live_before.name, "", live_before.fmt,
        live_before.inputs, "u * 99999",
        rationale="should not affect compute",
    )

    # Compute must use the live version (same result as before).
    live_check = store_db.get_logic(c, "mau")
    v_after, _ = compute_value(c, live_check, "2026-01-01", "2026-12-31", lambda lid: store_db.get_logic(c, lid))
    assert v_before == v_after, "draft version leaked into compute result"


# ── W4: REST promote / reject gate ───────────────────────────────────────────


def test_w4_rest_promote_makes_version_live(client):
    """POST /logic/{id}/versions/{v}/promote makes the draft live."""
    # Create a Logic via the human REST path (live immediately).
    resp = client.post("/logic", json={
        "id": "my_metric",
        "name": "My Metric",
        "inputs": [{"alias": "u", "kind": "unique", "params": {"event": "signup"}}],
        "expression": "u",
        "fmt": "number",
    })
    assert resp.status_code == 200, resp.text

    # Reach into the DB to create a draft (simulating agent proposal).
    from eigenheim import db as _db2, store_db as sdb2
    import os
    db_path = os.environ.get("EIGENHEIM_DB")
    c = _db2.connect(db_path)
    c.row_factory = sqlite3.Row
    draft_result = sdb2.create_draft_version(
        c, "my_metric", "My Metric", "", "number",
        (Input("u", "unique", {"event": "signup"}),),
        "u * 10",
        rationale="draft via test",
    )
    c.commit()
    c.close()

    version = draft_result["version"]

    # Confirm still inert via definitions endpoint.
    defn_resp = client.get("/definitions/my_metric")
    assert defn_resp.status_code == 200
    defn = defn_resp.json()
    assert defn["expression"] == "u", "draft leaked into definition before promotion"
    assert defn["pending_drafts"] == 1

    # Promote via REST.
    promo_resp = client.post(f"/logic/my_metric/versions/{version}/promote")
    assert promo_resp.status_code == 200, promo_resp.text
    promo = promo_resp.json()
    assert promo["status"] == "live"
    assert promo["version"] == version

    # Definition endpoint now reflects the promoted expression.
    defn_after = client.get("/definitions/my_metric").json()
    assert defn_after["expression"] == "u * 10"
    assert defn_after["pending_drafts"] == 0


def test_w4_rest_reject_marks_rejected(client):
    """POST /logic/{id}/versions/{v}/reject marks the draft rejected."""
    resp = client.post("/logic", json={
        "id": "my_metric2",
        "name": "My Metric 2",
        "inputs": [{"alias": "u", "kind": "unique", "params": {"event": "signup"}}],
        "expression": "u",
        "fmt": "number",
    })
    assert resp.status_code == 200, resp.text

    from eigenheim import db as _db2, store_db as sdb2
    import os
    db_path = os.environ.get("EIGENHEIM_DB")
    c = _db2.connect(db_path)
    c.row_factory = sqlite3.Row
    draft_result = sdb2.create_draft_version(
        c, "my_metric2", "My Metric 2", "", "number",
        (Input("u", "unique", {"event": "signup"}),),
        "u * 999",
        rationale="to be rejected",
    )
    c.commit()
    c.close()

    version = draft_result["version"]
    rej_resp = client.post(f"/logic/my_metric2/versions/{version}/reject")
    assert rej_resp.status_code == 200, rej_resp.text
    rej = rej_resp.json()
    assert rej["status"] == "rejected"

    # Pending drafts drops to 0.
    defn_after = client.get("/definitions/my_metric2").json()
    assert defn_after["expression"] == "u"
    assert defn_after["pending_drafts"] == 0


def test_w4_promote_unknown_version_returns_422(client):
    """Promoting a non-existent version returns 422, not 500."""
    resp = client.post("/logic", json={
        "id": "met3",
        "name": "Met 3",
        "inputs": [{"alias": "u", "kind": "unique", "params": {"event": "signup"}}],
        "expression": "u",
        "fmt": "number",
    })
    assert resp.status_code == 200
    promo = client.post("/logic/met3/versions/999/promote")
    assert promo.status_code == 422


def test_w4_cannot_promote_live_version_via_rest(client):
    """Trying to promote an already-live version returns 422."""
    client.post("/logic", json={
        "id": "met4",
        "name": "Met 4",
        "inputs": [{"alias": "u", "kind": "unique", "params": {"event": "signup"}}],
        "expression": "u",
        "fmt": "number",
    })
    defn = client.get("/definitions/met4").json()
    live_ver = defn["version"]
    promo = client.post(f"/logic/met4/versions/{live_ver}/promote")
    assert promo.status_code == 422


def test_w4_list_drafts_endpoint(client):
    """GET /logic/{id}/drafts returns pending drafts."""
    client.post("/logic", json={
        "id": "met5", "name": "Met 5",
        "inputs": [{"alias": "u", "kind": "unique", "params": {"event": "signup"}}],
        "expression": "u", "fmt": "number",
    })
    # Initially no drafts.
    resp = client.get("/logic/met5/drafts")
    assert resp.status_code == 200
    assert resp.json() == []


def test_w4_session_auth_enforced_on_promote(tmp_path, monkeypatch):
    """Promote endpoint requires session auth when a token is configured."""
    import eigenheim.app as appmod
    db_path = str(tmp_path / "auth_promote.db")
    monkeypatch.setenv("EIGENHEIM_DB", db_path)
    monkeypatch.delenv("EIGENHEIM_TOKEN_FILE", raising=False)
    appmod._auth_state["token"] = "secret"
    with TestClient(app) as c:
        resp = c.post("/logic/any_id/versions/1/promote")
        assert resp.status_code == 401
    appmod._auth_state["token"] = None


def test_w4_session_auth_enforced_on_reject(tmp_path, monkeypatch):
    import eigenheim.app as appmod
    db_path = str(tmp_path / "auth_reject.db")
    monkeypatch.setenv("EIGENHEIM_DB", db_path)
    monkeypatch.delenv("EIGENHEIM_TOKEN_FILE", raising=False)
    appmod._auth_state["token"] = "secret"
    with TestClient(app) as c:
        resp = c.post("/logic/any_id/versions/1/reject")
        assert resp.status_code == 401
    appmod._auth_state["token"] = None


# ── W5: hash-chain audit ──────────────────────────────────────────────────────


def _recompute_audit_hash(event: str, logic_id: str, version: int,
                          spec_hash: str, prev_audit_hash: str) -> str:
    payload = f"{event}|{logic_id}|{version}|{spec_hash}|{prev_audit_hash}"
    return hashlib.sha256(payload.encode()).hexdigest()


def test_w5_audit_row_created_on_draft(conn):
    """Creating a draft appends an audit row with event='draft-created'."""
    result = store_db.create_draft_version(
        conn, "mau", "mau", "", "number",
        store_db.get_logic(conn, "mau").inputs,
        "u * 5", rationale="audit test draft",
    )
    audit = store_db.get_audit_trail(conn, "mau")
    assert any(a["event"] == "draft-created" and a["version"] == result["version"] for a in audit), (
        "no draft-created audit row found"
    )


def test_w5_audit_row_created_on_promote(conn):
    """Promoting a draft appends an audit row with event='promoted'."""
    live = store_db.get_logic(conn, "mau")
    result = store_db.create_draft_version(
        conn, "mau", live.name, "", live.fmt, live.inputs,
        "u * 6", rationale="promote audit",
    )
    store_db.promote_version(conn, "mau", result["version"])
    audit = store_db.get_audit_trail(conn, "mau")
    assert any(a["event"] == "promoted" and a["version"] == result["version"] for a in audit)


def test_w5_audit_row_created_on_reject(conn):
    """Rejecting a draft appends an audit row with event='rejected'."""
    live = store_db.get_logic(conn, "mau")
    result = store_db.create_draft_version(
        conn, "mau", live.name, "", live.fmt, live.inputs,
        "u * 7", rationale="reject audit",
    )
    store_db.reject_version(conn, "mau", result["version"])
    audit = store_db.get_audit_trail(conn, "mau")
    assert any(a["event"] == "rejected" and a["version"] == result["version"] for a in audit)


def test_w5_hash_chain_links_correctly(conn):
    """Each audit row's audit_hash matches the recomputed value, and
    prev_audit_hash matches the previous row's audit_hash."""
    live = store_db.get_logic(conn, "mau")
    d1 = store_db.create_draft_version(
        conn, "mau", live.name, "", live.fmt, live.inputs,
        "u * 8", rationale="chain test d1",
    )
    store_db.promote_version(conn, "mau", d1["version"])

    live2 = store_db.get_logic(conn, "mau")
    d2 = store_db.create_draft_version(
        conn, "mau", live2.name, "", live2.fmt, live2.inputs,
        "u * 9", rationale="chain test d2",
    )
    store_db.reject_version(conn, "mau", d2["version"])

    audit = store_db.get_audit_trail(conn, "mau")
    assert len(audit) >= 3

    prev_hash = ""
    for row in audit:
        expected = _recompute_audit_hash(
            row["event"], row["logic_id"], row["version"],
            row["spec_hash"], row["prev_audit_hash"],
        )
        assert row["audit_hash"] == expected, (
            f"audit_hash mismatch for event '{row['event']}' version {row['version']}"
        )
        assert row["prev_audit_hash"] == prev_hash, (
            f"chain break: expected prev_audit_hash={prev_hash!r}, got {row['prev_audit_hash']!r}"
        )
        prev_hash = row["audit_hash"]


def test_w5_jsonl_mirror_written(tmp_path, monkeypatch):
    """Audit events must be mirrored to the JSONL file."""
    import eigenheim.store_db as sdb
    jsonl_path = tmp_path / "logic_audit.jsonl"
    original_path = sdb._AUDIT_JSONL_PATH
    sdb._AUDIT_JSONL_PATH = jsonl_path

    c = _seeded_conn()
    try:
        live = store_db.get_logic(c, "mau")
        store_db.create_draft_version(
            c, "mau", live.name, "", live.fmt, live.inputs,
            "u * 10", rationale="jsonl test",
        )
    finally:
        sdb._AUDIT_JSONL_PATH = original_path

    assert jsonl_path.exists(), "JSONL file not created"
    lines = jsonl_path.read_text().strip().splitlines()
    assert len(lines) >= 1
    row = json.loads(lines[-1])
    assert row["event"] == "draft-created"
    assert row["logic_id"] == "mau"
    assert "audit_hash" in row
    assert "prev_audit_hash" in row


def test_w5_audit_endpoint_requires_known_logic(client):
    """GET /logic/{id}/audit returns 404 for unknown ids."""
    resp = client.get("/logic/ghost_id/audit")
    assert resp.status_code == 404


# ── Forbidden-fragment guard covers the new tool descriptions ─────────────────


def test_new_tool_descriptions_pass_forbidden_fragment_check():
    """TOOL_CREATE_LOGIC and TOOL_UPDATE_LOGIC must be in ALL_INSTRUCTIONS and
    must not contain any forbidden fragments."""
    from eigenheim.mcp_instructions import TOOL_CREATE_LOGIC, TOOL_UPDATE_LOGIC

    assert TOOL_CREATE_LOGIC in ALL_INSTRUCTIONS
    assert TOOL_UPDATE_LOGIC in ALL_INSTRUCTIONS

    violations: list[str] = []
    for fragment in _FORBIDDEN_FRAGMENTS:
        for text in (TOOL_CREATE_LOGIC, TOOL_UPDATE_LOGIC):
            if fragment.lower() in text.lower():
                violations.append(f"Fragment {fragment!r} in write-tool description")
    assert not violations, "\n".join(violations)
