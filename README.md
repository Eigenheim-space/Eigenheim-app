# eigenheim

One definite state of product truth. A local-first desktop app that computes your
product metrics **deterministically**: you validate a formula once, eigenheim recomputes
it from your analytics sources with **zero LLM calls in the core**, and your AI agents
read the same numbers over MCP.

> Status: **pre-release**. Source available under PolyForm Noncommercial. Download an
> unsigned build for your OS from
> [Releases](https://github.com/Eigenheim-space/Eigenheim-app/releases/latest), or build
> from source ([BUILD.md](BUILD.md)). Builds are unsigned, so your OS warns that the app is
> from an unidentified developer; the [Install](#install) section shows how to open it on
> each OS. Signed installers and auto-update come later, follow
> [eigenheim.space](https://eigenheim.space).

## Why

- AI analytics is opaque, you re-check everything it produces.
- Two analysts compute one metric two ways; the metric has no single source of truth.
- Every LLM recount costs tokens and can drift between runs.

eigenheim pins the formula once, computes it deterministically, and a recount costs zero.

## Stack

- Desktop: Electron + React 19 + TypeScript + Tailwind v4 + shadcn/ui (`apps/desktop`)
- Engine: Python 3.12 + FastAPI + pydantic v2 + SQLite + FastMCP (`engine/`)

## Install

Pre-release builds are **unsigned** (no code-signing certificate yet), so your OS will warn
that the app is from an unidentified developer. The per-OS steps below open it anyway.
Prefer to build it yourself? See [BUILD.md](BUILD.md).

Download the file for your OS from the
**[latest release](https://github.com/Eigenheim-space/Eigenheim-app/releases/latest)**.

### macOS

1. Download `eigenheim-<version>-arm64.dmg` (Apple Silicon) or `eigenheim-<version>.dmg` (Intel).
2. Open the `.dmg` and drag **eigenheim** into Applications.
3. In Applications, **right-click** (or Control-click) eigenheim → **Open** → **Open** again.
   macOS remembers the choice after the first launch.

If you see "eigenheim is damaged and can't be opened", clear the download quarantine, then open it normally:

```bash
xattr -dr com.apple.quarantine /Applications/eigenheim.app
```

### Windows

1. Download `eigenheim Setup <version>.exe` and run it.
2. SmartScreen shows "Windows protected your PC": click **More info**, then **Run anyway**.

### Linux

1. Download `eigenheim-<version>.AppImage`.
2. Make it executable and run it:

```bash
chmod +x eigenheim-*.AppImage
./eigenheim-*.AppImage
```

If the AppImage will not start, install FUSE (`sudo apt install libfuse2` on Debian/Ubuntu),
or run it extracted: `./eigenheim-*.AppImage --appimage-extract-and-run`.

On first launch the app creates and seeds its local database. No account or network needed.

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
