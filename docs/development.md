# Development & Release Model

How development, the installed app, and releases stay separate — on the same
machine, without mixing data or code.

## The two installations

A development laptop typically has **both** of these at once:

| | Code | Data |
|---|---|---|
| **Installed app** (`comic-canvas`) | Frozen snapshot in `~/.comic-canvas/app/<version>` — does not see the repo at all | `~/.comic-canvas/projects` — your real comics |
| **Dev stack** (`./run` in the repo) | Live repo code (uvicorn `--reload` + Vite) | `dev-library/` inside the repo, gitignored |

Editing code never changes the installed app's behavior, and running the dev
stack never touches your real projects. The two also don't fight over ports:
if the dev API holds 8787, the installed app auto-increments.

Every way the code runs owns a distinct data home:

| Mode | Data home |
|---|---|
| Installed `comic-canvas` | `~/.comic-canvas` |
| `./run` dev stack | `<repo>/dev-library/` |
| pytest | throwaway tmpdir per run |
| Playwright e2e | `webui/e2e/.library`, wiped per run |

To work on realistic data in dev, copy a project in and mangle the copy:

```bash
cp -r ~/.comic-canvas/projects/<slug> dev-library/projects/
```

To deliberately point dev code at real data (e.g. a pre-release sanity check),
opt in explicitly and accept the risk:

```bash
COMIC_CANVAS_HOME=~/.comic-canvas ./run
```

## Branches

- **`dev`** is the working branch — commit and iterate freely.
- **`main`** is stable-only. Merge `dev` → `main` when a set of improvements
  is coherent and verified (tests + frontend gate green, app boots).
- Pushing `main` publishes this documentation site. It does **not** build a
  release.

## Releases

Releases are **tag-only**: pushing a `vX.Y.Z` tag (on `main`, matching
`api/version.py`) triggers the release workflow, which builds the frozen
binaries for macOS arm64 + Linux x86_64, checksums them, and opens a *draft*
GitHub release. Ordinary pushes never build anything.

The full pipeline from code to your real comics:

```text
hack on dev  →  merge to main  →  tag vX.Y.Z  →  CI builds draft release
             →  fill in release notes ("Schema changes:" line)  →  publish
             →  comic-canvas update   (prompts + warns before touching
                                       the version your projects run on)
```

See the [release checklist](release-checklist.md) for the step-by-step.

## Why the ceremony (pre-1.0 schema contract)

Pre-1.0, on-disk project schemas may change between releases **without
migration**. The pipeline above is what gives that policy teeth: your real
projects in `~/.comic-canvas` only ever meet code that went through a tagged,
release-noted upgrade with an explicit warning prompt — never a random state
of the working tree. Dev experiments break disposable copies in
`dev-library/`, not your comics.
