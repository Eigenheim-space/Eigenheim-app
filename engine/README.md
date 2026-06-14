# eigenheim engine

The deterministic compute sidecar. FastAPI + SQLite + a safe formula DSL, plus an
MCP server. Same Python computes every number for the UI and for agents, so there
is exactly one definition of each metric.

## Run

```bash
cd engine
uv sync                         # pins Python 3.12 + installs deps + the eigenheim binary

uv run eigenheim serve          # REST API on 127.0.0.1:8765
uv run eigenheim mcp serve      # MCP server (stdio)
uv run eigenheim version        # print the version
uv run pytest                   # golden + determinism tests
```

## What is real

- `db.py` seeds **60,835 deterministic events** for 12,418 users, derived from the
  user index by fixed integer math (no RNG), so the database, and therefore every
  metric, is byte-identical on every run. The golden test pins the results.
- `dsl.py` is a safe expression evaluator: `ast.parse` + a hard node whitelist, no
  `eval`. A bad formula fails validation with its position instead of executing.
- `compute.py` runs one SQL aggregate per Logic input, composes them with the DSL
  expression, and emits the trace (`how it was computed`): formula → events →
  period → source → final SQL → result.

## REST surface

`GET /health · /reports · /reports/{id} · /events · /logic · /syncs`. The report
detail computes each metric live with its weekly series, delta-vs-previous and full
trace. Optional bearer auth via `EIGENHEIM_TOKEN` (set by the Electron main).

## MCP tools

`list_reports · get_report · get_trace · list_events` — read-only; agents see the
same numbers the user sees.

## Not done yet (honest)

Logic-on-Logic DAG, `prev()` period shift, multiple data-source adapters, the
scheduler, and per-formula versioned snapshots are specified in the plan bundle but
not implemented here. This is the deterministic core + trace + MCP, computing real numbers.
