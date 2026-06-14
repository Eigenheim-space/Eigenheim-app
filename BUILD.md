# Build eigenheim from source

This produces a working desktop app from source on **macOS**, **Windows**, or **Linux**.
The build is **unsigned**: your OS will warn that it comes from an unidentified developer.
That is expected (there is no code-signing certificate yet). The steps below include how
to open the app past that warning on each OS.

The app is local-first. On first run it creates and deterministically seeds its own
SQLite database in your per-user data directory; the core needs no network and makes no
LLM calls.

## You build on the OS you want to run

The build bundles a Python runtime for the machine it runs on. There is **no
cross-compilation**: to get a Windows app, build on Windows; for Linux, build on Linux;
for macOS, build on a Mac. The commands are otherwise identical.

## Prerequisites (all platforms)

| Tool | Version | Why |
|---|---|---|
| [git](https://git-scm.com/) | any recent | clone the repo |
| [Node.js](https://nodejs.org/) | **22 LTS or newer** | build the renderer + run electron-builder |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | latest | install the engine's locked Python deps into the bundled runtime |

You do **not** need a system Python: `bundle-engine` downloads a standalone CPython
3.12 for you. You do need `uv` on PATH so it can install the locked dependencies into
that runtime.

- macOS: `brew install node uv git`
- Windows: `winget install OpenJS.NodeJS.LTS astral-sh.uv Git.Git` (PowerShell)
- Linux: install Node 22 (e.g. nodesource or your distro), then
  `curl -LsSf https://astral.sh/uv/install.sh | sh`

## Build

```bash
git clone https://github.com/Eigenheim-space/Eigenheim-app.git
cd Eigenheim-app/apps/desktop

npm install            # renderer + electron-builder toolchain
npm run build          # compile the React renderer (dist/)
npm run bundle-engine  # fetch standalone CPython + install locked engine deps into engine/runtime/
npm run dist           # package the installer(s) for THIS OS
```

Artifacts land in `apps/desktop/release/`:

- **macOS:** `eigenheim-<version>-<arch>.dmg` (and a `.zip`)
- **Windows:** `eigenheim Setup <version>.exe` (NSIS installer)
- **Linux:** `eigenheim-<version>.AppImage`

Prefer an unpacked app over an installer? Run `npm run pack` instead of `npm run dist`:
it writes the runnable app straight into `release/<platform>/` with no installer wrapper.

## Open the unsigned app

The build is not signed, so each OS guards the first launch. This is the warning you
accept; the app itself is unchanged.

### macOS

The app is ad-hoc signed but not notarized, so Gatekeeper blocks the first launch of a
downloaded build. On Apple Silicon the message can read "eigenheim is damaged and can't be
opened", that only means unsigned + quarantined, the app is fine.

1. Open the `.dmg`, drag **eigenheim** into Applications.
2. Clear the download quarantine, then open it:

   ```bash
   xattr -dr com.apple.quarantine /Applications/eigenheim.app
   open -a eigenheim
   ```

   Alternative (no terminal): try to open it once, then go to System Settings → Privacy &
   Security and click **Open Anyway** next to the eigenheim message.

A locally built app (not downloaded) has no quarantine flag and opens directly.

### Windows

SmartScreen shows **"Windows protected your PC"**.

1. Click **More info**.
2. Click **Run anyway**.

### Linux

```bash
chmod +x eigenheim-*.AppImage
./eigenheim-*.AppImage
```

If the AppImage refuses to mount, install FUSE (`sudo apt install libfuse2` on
Debian/Ubuntu), or run it extracted: `./eigenheim-*.AppImage --appimage-extract-and-run`.

## Run the engine on its own (optional)

The desktop app spawns the engine for you. To run the deterministic compute sidecar
directly (for development or to wire an external MCP client), see the **Develop** section
in [README.md](README.md): `cd engine && uv sync && uv run eigenheim serve`.

## Troubleshooting

- **`bundle-engine` fails to download CPython:** the pinned python-build-standalone
  release in `scripts/bundle-engine.mjs` (`PBS_TAG` / `PYTHON_VERSION`) must have an asset
  for your platform. The four supported targets are macOS arm64/x64, Windows x64, and
  Linux x64.
- **`uv` not found during `bundle-engine`:** install uv (see prerequisites) and reopen
  the terminal so it is on PATH.
- **electron-builder can't find `engine/runtime`:** run `npm run bundle-engine` before
  `npm run dist` / `npm run pack`. The runtime is gitignored and must be produced locally.
- **The app opens but shows no data:** it self-seeds on first run. Delete the per-user DB
  to reseed: macOS `~/Library/Application Support/eigenheim/eigenheim.db`, Linux
  `~/.config/eigenheim/eigenheim.db`, Windows `%APPDATA%\eigenheim\eigenheim.db`.
