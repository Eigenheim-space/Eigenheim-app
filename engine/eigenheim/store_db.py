"""Thin re-export shim for eigenheim.store_db.

The implementation has been split into the store/ package. This module re-exports
every public name so all existing call sites (app.py, mcp_server.py, service.py,
scheduler.py, goals.py, rice.py, graph.py, task_adapters.py, cli.py, and every
test) continue to work with zero changes.

_AUDIT_JSONL_PATH lives here (not in store/audit.py) so that tests which
monkeypatch `eigenheim.store_db._AUDIT_JSONL_PATH` affect the value that
store/audit.py._append_audit reads via its deferred `import eigenheim.store_db`.

Migrations:
  Run `run_migrations(conn)` in the lifespan before the app serves requests.
  Each migration fn in _MIGRATIONS bumps PRAGMA user_version by 1.
  The list is append-only: add to the end, never reorder or edit existing entries.

Backups:
  `backup(conn, backup_dir, keep_n)` writes an SQLite online backup to a
  timestamped file in backup_dir, then prunes the oldest copies over keep_n.

Bundled-catalog sync:
  `sync_bundled_catalog(conn)` runs after migrations (lifespan). It walks the
  bundled SEED_LOGIC and UPSERTs any row whose content_hash differs AND whose
  source is not 'user'. User edits always win. Errors are logged but never raised.

Draft/promote protocol (Vector 3):
  Agent proposals arrive via MCP create_logic / update_logic with scope
  logic:write. They are stored as logic_versions rows with status='draft' and
  source='agent-draft'. A draft is INERT: get_logic / _row_to_logic / compute all
  resolve the latest LIVE version only. Promote/reject happen via REST (session
  auth). Every write event appends a hash-chained row to the logic_audit table
  and mirrors it to data/logic_audit.jsonl."""
from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger(__name__)

# ---- Mutable audit-path global (lives here so test monkeypatching works) ----

_AUDIT_JSONL_PATH: Path | None = None  # set by _init_audit_path() at startup


def _init_audit_path(db_path: str | Path | None = None) -> None:
    """Wire the JSONL mirror path from the DB path (or a default)."""
    global _AUDIT_JSONL_PATH
    if db_path:
        _AUDIT_JSONL_PATH = Path(db_path).parent / "logic_audit.jsonl"
    else:
        # Default: engine/data/logic_audit.jsonl (same dir as eigenheim.db).
        _AUDIT_JSONL_PATH = Path(__file__).parent.parent / "data" / "logic_audit.jsonl"


# ---- Re-exports from store/ submodules ----------------------------------------

from .catalog import LOGIC as SEED_LOGIC, REPORTS as SEED_REPORTS  # noqa: E402

from .store.schema import (  # noqa: E402
    SCHEMA,
    ensure_schema,
    seed_defaults,
)

from .store._helpers import (  # noqa: E402
    _now,
    _inputs_to_json,
    _inputs_from_json,
)

from .store.catalog_sync import (  # noqa: E402
    _catalog_content_hash,
    _sync_bundled_catalog,
    sync_bundled_catalog,
)

from .store.migrations import (  # noqa: E402
    _has_column,
    _migration_3_add_catalog_cols,
    _migration_6_draft_audit,
    _MIGRATIONS,
    run_migrations,
)

from .store.backup import backup  # noqa: E402

from .store.logic_repo import (  # noqa: E402
    _row_to_logic,
    get_logic,
    list_logic,
    logic_deps,
    would_cycle,
    upsert_logic,
    get_logic_definition,
    list_logic_definitions,
    _logic_version_history,
)

from .store.audit import (  # noqa: E402
    _spec_hash,
    _prev_audit_hash,
    _compute_audit_hash,
    _append_audit,
    _draft_version_id,
    create_draft_version,
    promote_version,
    reject_version,
    list_drafts,
    get_audit_trail,
)

from .store.reports_repo import (  # noqa: E402
    list_report_defs,
    get_report_def,
    create_report,
    update_report,
    delete_report,
    duplicate_report,
    save_snapshot,
    latest_snapshot,
)

from .store.tasks_repo import (  # noqa: E402
    _conn_id,
    _link_id,
    _task_row_to_dict,
    create_task_connection,
    list_task_connections,
    get_task_connection,
    delete_task_connection,
    mark_connection_status,
    upsert_tasks,
    list_tasks,
    get_task,
    link_task,
    unlink_task,
    get_task_facets,
    list_task_links,
    count_tasks_for_logic,
)

from .store.okr_repo import (  # noqa: E402
    _VALID_COMPARISONS,
    _obj_id,
    _kr_id,
    create_objective,
    list_objectives,
    get_objective,
    update_objective,
    delete_objective,
    create_key_result,
    list_key_results,
    get_key_result,
    update_key_result,
    delete_key_result,
)

from .store.command_center import (  # noqa: E402
    _VALID_HYPOTHESIS_STATUSES,
    _VALID_HYPOTHESIS_SOURCES,
    _hyp_id,
    _dec_id,
    _rice_id,
    _rice_row_to_dict,
    create_hypothesis,
    list_hypotheses,
    get_hypothesis,
    update_hypothesis_status,
    delete_hypothesis,
    create_decision,
    list_decisions,
    get_decision,
    update_decision,
    delete_decision,
    create_rice_item,
    list_rice_items,
    get_rice_item,
    update_rice_item,
    delete_rice_item,
)
