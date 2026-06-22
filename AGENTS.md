# Project Guidance

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

Tests live under `api/` (`test_api.py`, `test_adaptation_workflow.py`). Run from the **repo root**.

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
