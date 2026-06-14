"""task_connections + tasks + task_links + facets CRUD."""
from __future__ import annotations

import json
import secrets
import sqlite3

from ._helpers import _now


def _conn_id() -> str:
    return "tc_" + secrets.token_hex(8)


def _link_id() -> str:
    return "tl_" + secrets.token_hex(8)


# ---- Task connections ----

def create_task_connection(
    conn: sqlite3.Connection,
    tracker: str,
    base_url: str = "",
    workspace: str = "",
    project_key: str = "",
) -> dict:
    """Register a tracker connection.  Returns the new connection row."""
    cid = _conn_id()
    conn.execute(
        "INSERT INTO task_connections(id, tracker, base_url, workspace, project_key, status, source, created_at)"
        " VALUES (?,?,?,?,?,'connected','user',?)",
        (cid, tracker, base_url, workspace, project_key, _now()),
    )
    conn.commit()
    return {"id": cid, "tracker": tracker, "base_url": base_url,
            "workspace": workspace, "project_key": project_key, "status": "connected"}


def list_task_connections(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT id, tracker, base_url, workspace, project_key, status, last_sync_at"
        " FROM task_connections ORDER BY rowid"
    ).fetchall()
    return [dict(r) for r in rows]


def get_task_connection(conn: sqlite3.Connection, cid: str) -> dict | None:
    r = conn.execute(
        "SELECT id, tracker, base_url, workspace, project_key, status, last_sync_at"
        " FROM task_connections WHERE id=?",
        (cid,),
    ).fetchone()
    return dict(r) if r else None


def delete_task_connection(conn: sqlite3.Connection, cid: str) -> bool:
    """Remove a connection.  Does NOT wipe cached tasks for the tracker."""
    cur = conn.execute("DELETE FROM task_connections WHERE id=?", (cid,))
    conn.commit()
    return cur.rowcount == 1


def mark_connection_status(
    conn: sqlite3.Connection, cid: str, status: str, *, update_sync_at: bool = False
) -> None:
    if update_sync_at:
        conn.execute(
            "UPDATE task_connections SET status=?, last_sync_at=? WHERE id=?",
            (status, _now(), cid),
        )
    else:
        conn.execute(
            "UPDATE task_connections SET status=? WHERE id=?", (status, cid)
        )
    conn.commit()


# ---- Task cache (stale-safe) ----

def upsert_tasks(conn: sqlite3.Connection, tracker: str, task_rows: list[dict]) -> int:
    """Bulk upsert cached task rows from a tracker pull."""
    if not task_rows:
        raise ValueError("upsert_tasks: refusing to upsert an empty list (stale-gate)")
    now = _now()
    conn.executemany(
        """
        INSERT INTO tasks(external_id, tracker, title, status, assignee, url, updated_at, raw_json, last_sync_at)
        VALUES (:external_id, :tracker, :title, :status, :assignee, :url, :updated_at, :raw_json, :now)
        ON CONFLICT(external_id, tracker) DO UPDATE SET
            title        = excluded.title,
            status       = excluded.status,
            assignee     = excluded.assignee,
            url          = excluded.url,
            updated_at   = excluded.updated_at,
            raw_json     = excluded.raw_json,
            last_sync_at = excluded.last_sync_at
        """,
        [
            {
                "external_id": t["external_id"],
                "tracker": tracker,
                "title": t.get("title", ""),
                "status": t.get("status", ""),
                "assignee": t.get("assignee", ""),
                "url": t.get("url", ""),
                "updated_at": t.get("updated_at", ""),
                "raw_json": json.dumps(t.get("raw_json", {})),
                "now": now,
            }
            for t in task_rows
        ],
    )
    conn.commit()
    return len(task_rows)


def list_tasks(
    conn: sqlite3.Connection,
    *,
    tracker: str | None = None,
    status: str | None = None,
    assignee: str | None = None,
    logic_id: str | None = None,
) -> list[dict]:
    """Return cached tasks with optional filters."""
    if logic_id:
        sql = """
            SELECT t.external_id, t.tracker, t.title, t.status, t.assignee,
                   t.url, t.updated_at, t.last_sync_at,
                   tl.id as link_id, tl.logic_id, tl.okr_ref, tl.kr_ref
            FROM tasks t
            JOIN task_links tl ON tl.external_id = t.external_id AND tl.tracker = t.tracker
            WHERE tl.logic_id = ?
        """
        params: list = [logic_id]
    else:
        sql = """
            SELECT t.external_id, t.tracker, t.title, t.status, t.assignee,
                   t.url, t.updated_at, t.last_sync_at,
                   tl.id as link_id, tl.logic_id, tl.okr_ref, tl.kr_ref
            FROM tasks t
            LEFT JOIN task_links tl ON tl.external_id = t.external_id AND tl.tracker = t.tracker
        """
        params = []
    clauses: list[str] = []
    if tracker:
        clauses.append("t.tracker = ?")
        params.append(tracker)
    if status:
        clauses.append("t.status = ?")
        params.append(status)
    if assignee:
        clauses.append("t.assignee = ?")
        params.append(assignee)
    if clauses:
        joiner = " AND " if logic_id else " WHERE "
        sql += joiner + " AND ".join(clauses)
    sql += " ORDER BY t.updated_at DESC"
    rows = conn.execute(sql, params).fetchall()
    return [_task_row_to_dict(r) for r in rows]


def get_task(conn: sqlite3.Connection, external_id: str, tracker: str) -> dict | None:
    r = conn.execute(
        """
        SELECT t.external_id, t.tracker, t.title, t.status, t.assignee,
               t.url, t.updated_at, t.last_sync_at,
               tl.id as link_id, tl.logic_id, tl.okr_ref, tl.kr_ref
        FROM tasks t
        LEFT JOIN task_links tl ON tl.external_id = t.external_id AND tl.tracker = t.tracker
        WHERE t.external_id = ? AND t.tracker = ?
        """,
        (external_id, tracker),
    ).fetchone()
    return _task_row_to_dict(r) if r else None


def _task_row_to_dict(r) -> dict:
    return {
        "external_id": r["external_id"],
        "tracker":     r["tracker"],
        "title":       r["title"],
        "status":      r["status"],
        "assignee":    r["assignee"],
        "url":         r["url"],
        "updated_at":  r["updated_at"],
        "last_sync_at": r["last_sync_at"],
        "link": {
            "id":       r["link_id"],
            "logic_id": r["logic_id"],
            "okr_ref":  r["okr_ref"],
            "kr_ref":   r["kr_ref"],
        } if r["link_id"] else None,
    }


# ---- Task links ----

def link_task(
    conn: sqlite3.Connection,
    external_id: str,
    tracker: str,
    logic_id: str,
    okr_ref: str = "",
    kr_ref: str = "",
) -> dict:
    """Link a task to a Logic.  Idempotent on (external_id, tracker, logic_id)."""
    existing = conn.execute(
        "SELECT id FROM task_links WHERE external_id=? AND tracker=? AND logic_id=?",
        (external_id, tracker, logic_id),
    ).fetchone()
    if existing:
        conn.execute(
            "UPDATE task_links SET okr_ref=?, kr_ref=? WHERE id=?",
            (okr_ref, kr_ref, existing["id"]),
        )
        conn.commit()
        return {"id": existing["id"], "external_id": external_id, "tracker": tracker,
                "logic_id": logic_id, "okr_ref": okr_ref, "kr_ref": kr_ref}
    lid = _link_id()
    conn.execute(
        "INSERT INTO task_links(id, external_id, tracker, logic_id, okr_ref, kr_ref, created_at)"
        " VALUES (?,?,?,?,?,?,?)",
        (lid, external_id, tracker, logic_id, okr_ref, kr_ref, _now()),
    )
    conn.commit()
    return {"id": lid, "external_id": external_id, "tracker": tracker,
            "logic_id": logic_id, "okr_ref": okr_ref, "kr_ref": kr_ref}


def unlink_task(
    conn: sqlite3.Connection,
    external_id: str,
    tracker: str,
    logic_id: str,
) -> bool:
    """Remove the link between a task and a Logic.  Returns True if a row was deleted."""
    cur = conn.execute(
        "DELETE FROM task_links WHERE external_id=? AND tracker=? AND logic_id=?",
        (external_id, tracker, logic_id),
    )
    conn.commit()
    return cur.rowcount == 1


def get_task_facets(
    conn: sqlite3.Connection,
    *,
    tracker: str | None = None,
    status: str | None = None,
    assignee: str | None = None,
    logic_id: str | None = None,
) -> dict:
    """Return pre-aggregated facet counts for the task right-panel navigator."""
    if logic_id:
        from_clause = (
            "FROM tasks t"
            " JOIN task_links tl ON tl.external_id = t.external_id AND tl.tracker = t.tracker"
            " WHERE tl.logic_id = ?"
        )
        params_base: list = [logic_id]
    else:
        from_clause = (
            "FROM tasks t"
            " LEFT JOIN task_links tl ON tl.external_id = t.external_id AND tl.tracker = t.tracker"
        )
        params_base = []

    extra_clauses: list[str] = []
    extra_params: list = []
    if tracker:
        extra_clauses.append("t.tracker = ?")
        extra_params.append(tracker)
    if status:
        extra_clauses.append("t.status = ?")
        extra_params.append(status)
    if assignee:
        extra_clauses.append("t.assignee = ?")
        extra_params.append(assignee)

    joiner = " AND " if logic_id else " WHERE "
    where_extra = (joiner + " AND ".join(extra_clauses)) if extra_clauses else ""

    full_from = from_clause + where_extra
    p = params_base + extra_params

    rows = conn.execute(
        f"SELECT t.status, count(*) as cnt {full_from} GROUP BY t.status", p
    ).fetchall()
    status_counts: dict[str, int] = {r["status"]: r["cnt"] for r in rows if r["status"]}

    rows = conn.execute(
        f"SELECT t.tracker, count(*) as cnt {full_from} GROUP BY t.tracker", p
    ).fetchall()
    source_counts: dict[str, int] = {r["tracker"]: r["cnt"] for r in rows}

    rows = conn.execute(
        f"SELECT t.assignee, count(*) as cnt {full_from}"
        f" GROUP BY t.assignee", p
    ).fetchall()
    assignee_counts: dict[str, int] = {
        r["assignee"]: r["cnt"] for r in rows if r["assignee"]
    }

    if logic_id:
        linked_rows = conn.execute(
            f"SELECT tl.logic_id, count(*) as cnt {full_from} GROUP BY tl.logic_id", p
        ).fetchall()
        goal_counts: dict[str, int] = {r["logic_id"]: r["cnt"] for r in linked_rows if r["logic_id"]}
        goal_counts["unlinked"] = 0
    else:
        linked_rows = conn.execute(
            f"SELECT tl.logic_id, count(*) as cnt {full_from}"
            f" AND tl.logic_id IS NOT NULL GROUP BY tl.logic_id"
            if extra_clauses else
            f"SELECT tl.logic_id, count(*) as cnt {full_from}"
            f" WHERE tl.logic_id IS NOT NULL GROUP BY tl.logic_id",
            p,
        ).fetchall()
        goal_counts = {r["logic_id"]: r["cnt"] for r in linked_rows if r["logic_id"]}

        (unlinked_count,) = conn.execute(
            f"SELECT count(*) {full_from}"
            + (" AND tl.id IS NULL" if extra_clauses else " WHERE tl.id IS NULL"),
            p,
        ).fetchone()
        goal_counts["unlinked"] = unlinked_count

    return {
        "status": status_counts,
        "source": source_counts,
        "assignee": assignee_counts,
        "goal": goal_counts,
    }


def list_task_links(conn: sqlite3.Connection, logic_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM task_links WHERE logic_id=? ORDER BY rowid",
        (logic_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def count_tasks_for_logic(conn: sqlite3.Connection, logic_id: str) -> int:
    """Count distinct tasks linked to a given Logic."""
    (n,) = conn.execute(
        "SELECT count(*) FROM task_links WHERE logic_id=?", (logic_id,)
    ).fetchone()
    return n
