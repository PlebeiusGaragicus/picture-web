# Project Guidance

## Branching & releases

- **Day-to-day development happens on `dev`**, not `main`. Commit and iterate
  there freely.
- **`main` is stable-only.** Merge `dev` → `main` when a set of improvements
  is coherent and verified (tests + frontend gate green, app boots). Pushing
  `main` deploys the docs site (`.github/workflows/docs.yml`); it does NOT
  build a release.
- **Releases are tag-only.** A release builds only when a `vX.Y.Z` tag is
  pushed (`.github/workflows/release.yml`), and the tag must match
  `api/version.py`. Follow `docs/release-checklist.md`. Never tag from `dev`;
  tag the merge commit on `main`.
- CI (`.github/workflows/ci.yml`) runs on pushes to `dev`/`main` and on PRs.

## Data isolation

Four data homes; never cross them:

- Installed app (`comic-canvas`): `~/.comic-canvas` — the user's real
  projects. Dev tooling must NEVER write here.
- `./run` dev stack: repo-local `dev-library/` (gitignored; `./run` exports
  `COMIC_CANVAS_HOME` unless already set).
- pytest: throwaway tmpdir (`api/conftest.py` sets the default; tests
  additionally monkeypatch the per-module `LIBRARY_ROOT` constants).
- Playwright e2e: `webui/e2e/.library` (wiped per run).

## Breaking Changes Preferred

This project is in active local development and does not preserve backwards compatibility for internal schemas, storage formats, API shapes, or UI state.

- Do not add `v1`, `v2`, `v3` compatibility layers or migrations unless explicitly requested for a one-off data rescue.
- When changing `canvas.json`, asset metadata, API payloads, or TypeScript/Pydantic models, update the current shape directly.
- Remove obsolete schema branches, compatibility validators, and upgrade code instead of carrying them forward.
- Prefer clear breaking changes over shims. Existing local data can be regenerated or manually adjusted during development.

## Python environment

All Python work uses a single repo-root venv at `.venv/`. Dependencies live in `api/requirements.txt` (includes pytest).

**Setup once** (or run `./run`, which creates the venv automatically):

```bash
python3 -m venv .venv
.venv/bin/pip install -r api/requirements.txt
```

**Never use** system `python3`, bare `pytest`, or `pip install pytest` globally. Cursor's "targeted pytest" and agent shell commands both require `.venv/bin/python`.

Workspace settings in `.vscode/settings.json` point the editor at `.venv/bin/python`. If targeted pytest fails in the IDE, reload the window or run **Python: Select Interpreter** → `.venv/bin/python`.

## Python tests

Tests live under `api/` (`test_api.py`, `test_pi_profiles.py`, `test_pi_env.py`, ...). Run from the **repo root**.

**Preferred — one test or small scope** (fast, minimal output):

```bash
.venv/bin/python -m pytest api/test_api.py::test_function_name -q
.venv/bin/python -m pytest api/test_api.py -k "partial_name" -q
```

**When a file changed** — run that file only, not the full suite:

```bash
.venv/bin/python -m pytest api/test_api.py -q
```

**Avoid** running all tests unless the user asks or the change is cross-cutting. The API test file alone has 60+ tests.

After code changes, run the smallest pytest command that covers the behavior you touched. Do not re-probe the environment (`which python`, `pip list`, etc.) if `.venv/bin/python -m pytest --version` succeeds.

## Frontend gate

After any webui change, run `cd webui && npm run build` (tsc + vite) **and** `npm run test:e2e` (Playwright smoke: boots API+UI against an isolated fixture library, walks all six views, asserts no console errors, compares screenshots against `webui/e2e/baselines/`). Use `npm run typecheck` for a faster tsc-only pass while iterating.

Screenshot baselines are committed. A commit that intentionally changes pixels must refresh them (`npm run test:e2e:update`) in the same commit and say so in the message; every other commit must pass on the existing baselines.

## Backend conventions

- **Routers hold no logic.** `api/routes/*` are thin FastAPI routers (one per feature area); domain logic lives in the top-level service modules (`library.py`, `adaptation.py`, `visual_styles.py`, `pi_runtime.py`, `chat_sessions.py`, ...). Service modules never import `routes`.
- **Models** stay in the single `api/models.py`.
- **One of each:** `common.utc_now()`, `common.slugify(value, fallback)`, and `library.read_json`/`write_json` for persistent JSON. Do not add new local copies.
- **Import cycles:** the lazy `import adaptation` pattern inside functions is the sanctioned way to break the documented `adaptation ↔ library/visual_styles` cycles. Do not introduce new cycles.
- **API shape:** camelCase query params and JSON fields. Raise `HTTPException` with a human-readable `detail` in service code. Detached jobs never raise across the process boundary — they write status JSON + logs and the status endpoint reports `returnCode`/`error`.
- **Logging:** level comes from the `LOG_LEVEL` env var (default INFO); no hardcoded DEBUG.

## Frontend conventions

- **File naming:** PascalCase when the main export is a component (`CharactersHubView.tsx`); camelCase for hooks/utils (`useBookSessionLoad.ts`). Apply when creating or moving files; no mass renames.
- **Directory per feature:** `canvas/`, `storyPanels/`, `sessions/`, `conceptArt/`, `characters/`, `visualStyles/`; cross-feature helpers in `shared/` and `ui.tsx`.
- **Errors:** use `formatRequestError` and surface a view-local error banner; no empty `catch {}` — at minimum `console.error` plus a user-visible state.
- **Debug logging** follows `import.meta.env.DEV`.
- **CSS:** per-area files under `webui/src/styles/` loaded in the order declared by `styles/index.css` (reset → tokens → base → features). New rules go in the owning area file and use the tokens in `styles/tokens.css` (`--bg-*`, `--text-*`, `--border*`, `--accent*`, spacing/radius/type scales) instead of raw values.
- **Buttons:** the `button` element style in `styles/base.css` is the base; variants and one-off button families override the `--btn-*` custom-property hooks (`--btn-bg/--btn-fg/--btn-border/--btn-radius/--btn-pad/--btn-font/--btn-weight`) rather than restating the visual. Active/selected state class is `is-active` (never `active`).
- **classNames:** use `clsx` for conditional classes in new or touched code.
