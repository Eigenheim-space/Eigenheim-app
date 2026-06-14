# eigenheim

One definite state of product truth. A local-first desktop app that computes your
product metrics **deterministically**: you validate a formula once, eigenheim recomputes
it from your analytics sources with **zero LLM calls in the core**, and your AI agents
read the same numbers over MCP.

> Status: **pre-release**. Source available now under PolyForm Noncommercial. There is no
> signed installer yet, but you can build a working app from source on macOS, Windows, or
> Linux, see [BUILD.md](BUILD.md). The build is unsigned, so your OS will warn that it is
> from an unidentified developer; BUILD.md covers how to open it anyway. Follow
> [eigenheim.space](https://eigenheim.space) for the signed-installer launch.

## Why

- AI analytics is opaque, you re-check everything it produces.
- Two analysts compute one metric two ways; the metric has no single source of truth.
- Every LLM recount costs tokens and can drift between runs.

eigenheim pins the formula once, computes it deterministically, and a recount costs zero.

## Stack

- Desktop: Electron + React 19 + TypeScript + Tailwind v4 + shadcn/ui (`apps/desktop`)
- Engine: Python 3.12 + FastAPI + pydantic v2 + SQLite + FastMCP (`engine/`)

## Develop

```bash
# 1. the engine (deterministic compute sidecar)
cd engine && uv sync

uv run eigenheim serve          # FastAPI REST on 127.0.0.1:8765
uv run eigenheim mcp serve      # MCP server on stdio (for agent config)
uv run eigenheim version        # print the version

# 2. the desktop app (Electron window + the renderer, spawns the sidecar)
cd apps/desktop && npm install && npm run app

# or just the renderer in a browser
cd apps/desktop && npm run dev          # http://localhost:3020
```

Engine tests: `cd engine && uv run pytest`.

## Build from source

To package a runnable (unsigned) app for your OS, see **[BUILD.md](BUILD.md)**. Short
version, run on the OS you want to ship for:

```bash
cd apps/desktop
npm install
npm run build          # the renderer
npm run bundle-engine  # standalone CPython + locked engine deps -> engine/runtime/
npm run dist           # installer in apps/desktop/release/
```

## Agent (MCP) config

After creating an MCP key in Settings > API keys, paste this into your agent
config (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "eigenheim": {
      "command": "eigenheim",
      "args": ["mcp", "serve"],
      "env": {
        "EIGENHEIM_MCP_KEY": "<your-eig_…-key>"
      }
    }
  }
}
```

The `eigenheim` binary is installed by `uv sync` in the `engine/` directory.
Run it via `uv run eigenheim mcp serve` in dev, or use the bundled interpreter
in the packaged app. Scopes are enforced per tool call (set when creating the key
via the app); there are no startup flags for them.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free for noncommercial use with attribution.
Commercial use needs a paid license, contact commercial@eigenheim.space.
See [COMMERCIAL.md](COMMERCIAL.md) for attribution requirements and commercial terms.
