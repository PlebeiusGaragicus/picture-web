---
name: verify
description: Boot an isolated comic-canvas stack (API + Vite) against a scratch library, seed it via the REST API, and drive the UI with Playwright to verify changes at the real surface.
---

# Verify comic-canvas changes end-to-end

## Boot an isolated stack (never against the real ~/.comic-canvas)

```bash
SCRATCH=$(mktemp -d)
cd api
COMIC_CANVAS_HOME=$SCRATCH/lib COMIC_CANVAS_TRASH_DIR=$SCRATCH/trash API_PORT=8798 \
  ../.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8798 &   # no --reload; restart after backend edits
cd ../webui
API_PORT=8798 npm run dev -- --host 127.0.0.1 --port 5198 --strictPort &
curl -sf http://127.0.0.1:8798/api/health   # readiness
```

Ports 8798/5198 avoid the dev (8787/5173) and e2e (8799/5199) stacks.

## Seed via the REST API only

Storage shapes are declared breakable (AGENTS.md); the HTTP API is the seam.
Crib from `webui/e2e/seed.ts`: create a project (`POST /api/projects`), import
tiny PNGs (`POST /assets/import` multipart, base64 blobs in seed.ts), create a
character (`POST /adaptation/files/characters` — also creates its entity tag),
and shape nodes by GET/PUT of `/canvas` (e.g. merge two assets into one node's
stack to exercise multi-take UI). New projects auto-seed the two style-anchor
draft nodes and style entity tags.

## Drive with Playwright

Run node scripts from `webui/` so `@playwright/test` resolves (ESM ignores
NODE_PATH). Navigation: goto `/` → click project button → click phase button
("Canvas", exact). Gotchas learned the hard way:

- **Click a node's `.node-title` to open the inspector sidebar** — clicking
  the image area opens the full-screen image viewer instead, and **Escape
  closes both the viewer and the sidebar** (global handler clears popover).
- The sidebar is `.details-sidebar`; node cards are `.image-group-node` /
  `.draft-node`.
- Don't PUT `/canvas` from outside while the UI is open on the canvas — its
  debounced save can overwrite your write. Reload the page after external PUTs.
- Generation needs GOOGLE_API_KEY; without it the Generate button surfaces a
  clean `.generation-error-notice` (useful as a failure-path probe).
- Collect `console`/`pageerror` events in every drive script; the smoke suite
  treats any console error as a failure.

## Flows worth driving after canvas changes

Select a multi-take node (takes strip, set-active, per-take archive/restore),
tag editor ★ canonical toggle, node-card ★ badge, Delete on a canonical node
(blocked toast), show-archived browsing, draft sidebar auto-canonical ★ chips.
