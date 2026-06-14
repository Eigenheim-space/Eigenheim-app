# Contributing to eigenheim

eigenheim is pre-release software. The core is working but not yet packaged for
end-users. Contributions are welcome; expect rough edges in the dev setup.

## Clone

```bash
git clone https://github.com/Eigenheim-space/Eigenheim-app.git
cd Eigenheim-app
```

## Engine setup (Python sidecar)

Requires Python 3.12+ and [uv](https://docs.astral.sh/uv/getting-started/installation/).

```bash
cd engine
uv sync          # installs all dependencies into .venv
uv run pytest    # must be green before submitting a PR
```

The test suite covers the compute layer, DSL parser, store, and API contracts.
Run it after every change to `engine/`.

## Renderer setup (Electron + React)

Requires Node 22+.

```bash
cd apps/desktop
npm install
npm run dev      # launches the renderer at http://localhost:3020 (browser mode)
npm run app      # launches the full Electron window (spawns the engine sidecar)
```

TypeScript is strict. Run `npx tsc --noEmit` before submitting. The CI gate
does the same.

## Pull request expectations

- One logical change per PR. If the change is bigger than a few hundred lines,
  open an issue first so we can agree on scope before you invest the time.
- All engine tests must pass (`uv run pytest`).
- Renderer must typecheck clean (`npx tsc --noEmit`) and build clean (`npm run build`).
- No secrets, API keys, or personal data in the diff. gitleaks runs on every PR.
- Describe what changed and why in the PR description (the template prompts this).

## Maintainer promise

Every pull request and issue filed against this repo gets a maintainer response.
Response time target is within a week; may be faster for critical bugs.
