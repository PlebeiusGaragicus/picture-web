# Architecture

Local single-user app: FastAPI backend (`api/`), React + Vite UI (`webui/`),
all user data under `~/.comic-canvas/` (override: `COMIC_CANVAS_HOME`, legacy
`PHOTO_WEB_LIBRARY_ROOT`). Dev mode (`./run`) is isolated by default to a
repo-local `dev-library/`; tests and Playwright use throwaway dirs. The
backend is the only layer that touches the filesystem, validation, Gemini,
and the pi agent.

```text
webui (React, React Flow)  ── REST /api ──  api (FastAPI)
                                              ├─ gemini.py            → Google GenAI image generation
                                              ├─ pi_runtime.py        → in-process pi tasks
                                              │    └─ pi --mode rpc (JSON-RPC subprocess)
                                              └─ ~/.comic-canvas/     → all pixels + JSON
```

## Backend module map

| Module | Role |
|--------|------|
| `main.py` | App factory; includes routers + the packaged-mode shutdown lifespan, nothing else. |
| `routes/` | One router per feature: `projects`, `canvas`, `adaptation`, `characters`, `locations`, `concept_art`, `sessions`, `settings`, `story_panels`. Routers hold no logic. |
| `paths.py` | Single source of truth for the home dir (`COMIC_CANVAS_HOME` → `PHOTO_WEB_LIBRARY_ROOT` → `~/.comic-canvas`) and `resource_path()` for bundled read-only assets (web dist, `.pi/skills`, `.pi/extensions`, `prompts/seed-defaults`, `api/prompt_guides`) — resolves identically in a repo checkout and inside the PyInstaller onedir bundle. Modules keep their own patchable constants (`library.LIBRARY_ROOT` etc.) derived from it. |
| `app_config.py` / `version.py` | `config.json` (chmod 600: gemini key, auth token, port, piBinary; env overrides win) + `meta.json` version stamping (warn-only, no migrations pre-1.0) + `APP_VERSION`. |
| `appmain.py` / `cli.py` / `preflight.py` | Packaged entrypoint: static UI mount, cookie-token auth middleware (loopback + Origin checks; active only when a token is configured, so dev/tests are unaffected), port picking, single-instance lock, file logging, programmatic uvicorn; the `comic-canvas` CLI (start/open/doctor/logs/update/uninstall); startup preflight that hard-requires the *system* pi + Node 22 (`COMIC_CANVAS_SKIP_PI_CHECK=1` bypass). See [packaging.md](packaging.md). |
| `library.py` | Projects, assets (`{id}.json` + `{id}.png`, ULID ids), canvas.json, tag registry, generated-asset creation. Canonical JSON IO: `read_json`/`write_json`. |
| `models.py` | All Pydantic models, single file. |
| `common.py` | `utc_now()`, `slugify(value, fallback)` — the only implementations. |
| `gemini.py` | Google GenAI calls; PIL; nothing else imports the SDK. |
| `adaptation.py` | Adaptation core: `adaptation/` dir + `adaptation.json` metadata, book text, structured character and location records (CRUD; adaptation.json is their single store; both share `EntityVariant` per-variant entity tags + canonicals). |
| `visual_styles.py` | Reusable style snippets appended to generation prompts. |
| `canvas_nodes.py` | Canvas node factories (image groups, character/location spawns). |
| `concept_cards.py` | Concept art cards: CRUD, per-card image upload (`POST /concept-cards/{id}/upload` attaches an imported asset to the card), subject-kind retagging, draft-to-canvas. |
| `chat_sessions.py` | Gemini image-refinement chats (thought signatures preserved, archive-first). |
| `agent_sessions.py` / `pi_session_trace.py` | Pi agent session registry and session-file trace parsing. |
| `pi_runtime.py` / `pi_profiles.py` | In-process pi task runtime (one `pi --mode rpc` subprocess per step, `task_progress` between steps, SSE event ring buffer, abort, restart-safe snapshots) and the narrow task profiles it runs (`read-book`, `discover-characters`/`discover-locations`, `extract-character`/`extract-location` (targeted), `extract-all-characters`/`extract-all-locations` (multi-step), `refine-character`/`refine-location` (targeted, feedback-driven), `suggest-concept-character/location`, `draft-panel-prompt`, `refine-panel-prompt`; the character/location record plumbing is one `_EntityKind`-parameterized implementation). Profiles with `tools` get the photo-web extension loaded with a scoped allow-list (see the pi agent seam). |
| `story_panels.py` / `story_panels_print.py` | Panel chunks, page layout, booklet PDF (reportlab). Panels carry entity links (`characterSlugs`/`locationSlug`, validated against `adaptation.status()`, written by the human patch path or the agent's `set_panel_image_prompt` delivery). `draft_panel_to_canvas` turns a saved image prompt into an `imageGroup` node whose `refs` are the tagged entities' canonical assets (409 if any entity has no asset yet) with `sourcePanelId` set; `library.attach_generated_assets_to_canvas` uses `sourcePanelId` to auto-attach generated assets back onto the panel. |
| `pi_env.py` / `pi_events.py` | Pi plumbing for `pi_runtime`: `pi_env.py` (`AdaptationContext`, `BookSession`, pi/node binary discovery), `pi_events.py` (`project_event` RPC-event projection). |

## Canvas model

`canvas.json` stores layout + persistent nodes; lineage is derived, never stored.

- **One node type.** A node is an image made from a prompt: `refs` + `prompt` +
  `params` (the recipe for its next generation) plus an `assetIds` take stack
  with `activeAssetId`. An empty stack **is** the draft state — generating
  fills the stack in place; there is no separate draft node type.
- **No roles.** Special behavior is derived, never stored. A node is protected
  from deletion iff its active image is some entity tag's canonical image;
  legacy generated-child nodes are recognized by the `generated_<sourceId>`
  node-id convention.
- **Canonical pointers live on entity tags.** Each entity tag in `tags.json`
  carries `canonicalAssetId` — the image that keeps that character/location/
  style consistent. `PUT /tags/{id}/canonical` sets one explicitly (the ★ in
  the UI); `adaptation.status()` seeds character/location pointers from their
  records as defaults only — a starred choice always wins. At generation time
  the one generate path auto-attaches each tagged entity's canonical as a
  reference (`canonical_refs_for_tags`), deduped against explicit refs and
  recorded in the take's receipt; drafts show these as ★ chips.
- **Style anchors are ordinary nodes.** New projects seed two draft nodes
  tagged with the `character-style` / `scene-style` entity tags
  (`library.ensure_style_entity_tags` seeds the tags). They generate through
  the one normal path; a style-tagged node's first take becomes that tag's
  canonical by default, and deleting an asset clears any canonical pointers
  that referenced it. There is no separate style-ref projection or endpoint.
- **Lineage edges** are derived at render time from each child asset's immutable
  `generation.refs`; generated asset metadata is a historical receipt and is never
  edited in place.
- **Entity tags** (`character`/`location` kinds in the tag registry) link generated
  assets back to character/location records — the Characters and Locations hubs
  find a record's images by tag, not by stored ids.

## The pi agent seam

One invocation path:

1. **Pi tasks** (read-book, character discover/extract/refine, concept
   suggest, panel prompt draft/refine): endpoint
   → `pi_runtime.PiSessionManager` runs the profile's step plan, one
   `pi --mode rpc` subprocess per step (threads, in-process), emitting a
   `task_progress {index, label}` event before each step. Events stream over
   SSE (`GET /pi-tasks/{id}/events`, `Last-Event-ID` replay); cancellation is
   the RPC `abort` command with a terminate fallback; per-task snapshot JSON
   under `adaptation/sessions/pi-tasks/` (PID + kernel start time, so PID
   reuse can't fake liveness) lets an API restart mark interrupted tasks
   failed. Tasks are registered in `agent_sessions` for trace viewing. The
   manager assumes a single uvicorn worker (`./run` runs one). Targeted
   profiles (extract-character) take a `target`; duplicates are keyed on
   `(profile, target)` and answered with 409.

   **Tools-as-API:** profiles whose output is a domain object
   (`draft-panel-prompt`, `refine-panel-prompt`, `suggest-concept-*`, the
   character profiles) declare `TaskProfile.tools`. The runtime then adds
   `--extension .pi/extensions/photo-web.ts` and sets `PHOTO_WEB_API`
   (origin: `PHOTO_WEB_API` env override, else `http://127.0.0.1:{API_PORT}`),
   `PHOTO_WEB_PROJECT`, `PHOTO_WEB_TASK`, `PHOTO_WEB_ALLOWED_TOOLS`, and
   (when the API enforces token auth, i.e. packaged mode) `PHOTO_WEB_TOKEN`,
   which the extension sends as a Bearer header. The
   extension registers only the allow-listed tools
   (`set_panel_image_prompt`, `replace_panel_image_prompt`,
   `create_concept_card`, `register_character`, `list_characters`,
   `update_character`, `register_location`, `list_locations`,
   `update_location`), each a typed `fetch()` back into the local API
   with server-side validation, so the agent delivers its result with one
   tool call and no scratch files. `on_success` verifies delivery (a new
   prompt/card/record exists, or the record changed) and fails the task if
   the agent never called the tool. Character and location records live in
   `adaptation.json` (`CharacterRecord`/`LocationRecord`: name, summary,
   visualDescription, performanceNotes (characters only), continuityNotes,
   variants keyed by slug with label/storyContext/prompt + asset link state)
   — discovery registers them, extraction fills them, refine patches them
   from user feedback.

`pi_session_trace.py` parses pi's on-disk session `.jsonl` files for the trace
view and is transport-independent.

### Product direction

The product direction is button-driven AI augmentation — many narrow pi
agents (character/location extraction, panel image-prompt drafting/refinement),
no general chat agent. Explicit non-goals (decided 2026-07): no "super" pi
agent with the full tool catalog, no batch drafting/generation (everything is
one-at-a-time, human-reviewed), no agent-led panel creation, and no
`generate_image` tool — spending image credits stays a human click.

The detached-bash layer and the legacy book-chat feature (with its
`PiRpcClient` sync-turn path) are gone; all pi work runs on the in-process
**PiSessionManager**.
The Agent view is a pi task dashboard: it polls `GET /pi-tasks?active=true`,
attaches to each running task's SSE stream, and browses the
`agent_sessions` registry + parsed traces.

## Frontend map

- `main.tsx` — thin app shell (~530 lines): view routing, phase/sidebar state,
  adaptation status, PDF export. Project data and all canvas behavior live in
  `canvas/useCanvasWorkspace.ts` (assets, tags, canvas doc, chat sessions,
  nodes, selection, generation, import, delete/archive); `canvas/CanvasView.tsx`
  renders the React Flow surface and the sidebar/viewer/dialog panels from it.
  `ProjectLanding.tsx` / `ProjectPhaseSidebar.tsx` are the shell's other pieces.
- `projectNavigation.ts` — the six workspace views; navigation is a
  `projectPhase` string, no router.
- `canvas/` — the whole canvas feature: `useCanvasWorkspace` (state + handlers),
  `CanvasView` (surface + panels), `nodes.tsx` (React Flow node types),
  `flowDocument.ts` (canvas.json ⇄ flow-node conversion), `ImageViewer`,
  `ChatRefinementPanel`, edge derivation, node sidebars, tag editing.
- `storyPanels/` — Story + Layout views and their pure layout/print logic.
- `sessions/` — Agent dashboard: live pi task strip, session list, pi trace timeline.
- `conceptArt/`, `characters/` (`EntityHubView` + `EntityEditModal`, parameterized by kind and rendered as both the Characters and Locations pages), `visualStyles/` — the other workspace views.
- `shared/` — cross-feature helpers (`dom.ts`, `canvasDefaults.ts`, `popover.ts`).
- `api.ts` — the single REST client; `types.ts` — the domain/API types.

### Documented warts

- `canvas/nodeTagActions.ts` is a module-level mutable ref that bridges main.tsx
  callbacks into React Flow node components. It bypasses React data flow but is
  the sanctioned pattern here until the canvas gets a real store.
- CSS lives in per-area files under `webui/src/styles/` with tokens in
  `tokens.css`; load order in `styles/index.css` is load-bearing.
- Lazy `import adaptation` inside functions breaks import cycles between
  `adaptation`, `library`, and `visual_styles`. Documented, intentional;
  don't add new cycles.

## Storage layout (per project)

```text
~/.comic-canvas/projects/<slug>/
  project.json                 # name, createdAt, cover
  canvas.json                  # nodes + viewport
  tags.json                    # tag registry (user + entity tags)
  assets/<ulid>.json|.png      # image metadata + pixels
  story-panels/panels.json     # panel chunks + page layout
  chat-sessions/<id>/          # Gemini refinement chats + blobs
  adaptation/
    adaptation.json            # character + location records
    book.txt                   # source text
    style-refs/                # visual-styles.json (dir name is historical)
    sessions/                  # pi session files, job logs, status JSON
```
