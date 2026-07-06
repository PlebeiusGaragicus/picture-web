# Architecture

Local single-user app: FastAPI backend (`api/`), React + Vite UI (`webui/`),
all user data under gitignored `photo-library/`. The backend is the only layer
that touches the filesystem, validation, Gemini, and the pi agent.

```text
webui (React, React Flow)  ── REST /api ──  api (FastAPI)
                                              ├─ gemini.py            → Google GenAI image generation
                                              ├─ pi_runtime.py        → in-process pi tasks
                                              │    └─ pi --mode rpc (JSON-RPC subprocess)
                                              └─ photo-library/       → all pixels + JSON
```

## Backend module map

| Module | Role |
|--------|------|
| `main.py` | App factory; includes routers, nothing else. |
| `routes/` | One router per feature: `projects`, `canvas`, `adaptation`, `characters`, `concept_art`, `sessions`, `story_panels`. Routers hold no logic. |
| `library.py` | Projects, assets (`{id}.json` + `{id}.png`, ULID ids), canvas.json, tag registry, generated-asset creation. Canonical JSON IO: `read_json`/`write_json`. |
| `models.py` | All Pydantic models, single file. |
| `common.py` | `utc_now()`, `slugify(value, fallback)` — the only implementations. |
| `gemini.py` | Google GenAI calls; PIL; nothing else imports the SDK. |
| `adaptation.py` | Adaptation core: `adaptation/` dir + `adaptation.json` metadata, book text, character records, editable character/location files. |
| `visual_styles.py` | Reusable style snippets appended to generation prompts. |
| `style_refs.py` | Archetype style references: prompt files, canonical asset ids, canvas projection (`sync_style_ref_canvas_nodes`). |
| `canvas_nodes.py` | Canvas node factories (image groups, character/location spawns). |
| `concept_cards.py` | Concept art cards: CRUD, per-card image upload (`POST /concept-cards/{id}/upload` attaches an imported asset to the card), subject-kind retagging, draft-to-canvas. |
| `chat_sessions.py` | Gemini image-refinement chats (thought signatures preserved, archive-first). |
| `agent_sessions.py` / `pi_session_trace.py` | Pi agent session registry and session-file trace parsing. |
| `pi_runtime.py` / `pi_profiles.py` | In-process pi task runtime (one `pi --mode rpc` subprocess per step, `task_progress` between steps, SSE event ring buffer, abort, restart-safe snapshots) and the narrow task profiles it runs (`read-book`, `extract-character-list`, `extract-character` (targeted), `extract-all-characters` (multi-step), `suggest-concept-character/location`, `draft-panel-prompt`, `refine-panel-prompt`). Profiles with `tools` get the photo-web extension loaded with a scoped allow-list (see the pi agent seam). |
| `story_panels.py` / `story_panels_print.py` | Panel chunks, page layout, booklet PDF (reportlab). Panels carry entity links (`characterSlugs`/`locationSlug`, validated against `adaptation.status()`, written by the human patch path or the agent's `set_panel_image_prompt` delivery). `draft_panel_to_canvas` turns a saved image prompt into an `imageGroup` node whose `refs` are the tagged entities' canonical assets (409 if any entity has no asset yet) with `sourcePanelId` set; `library.attach_generated_assets_to_canvas` uses `sourcePanelId` to auto-attach generated assets back onto the panel. |
| `adaptation_workflow/` | Pi plumbing for `pi_runtime`: `config.py` (context, pi/node discovery), `character_file.py`, `validate.py`, `events.py` (`project_event`), `diagnostics.py` (`TaskDiagnostics`). |

## Canvas model

`canvas.json` stores layout + persistent nodes; lineage is derived, never stored.

- **Node types:** `draft` (prompt + refs + params, no pixels yet) and `imageGroup`
  (one or more asset ids, variant stack, `activeAssetId`).
- **Roles** (`node.role`): `style-ref-source`, `text-result`, `generated-result`,
  `refinement`. Durable source nodes (style refs) can't be deleted from the UI;
  they are re-projected from files/metadata by `style_refs.sync_style_ref_canvas_nodes`.
- **Lineage edges** are derived at render time from each child asset's immutable
  `generation.refs`; generated asset metadata is a historical receipt and is never
  edited in place.
- **Entity tags** (`character`/`location` kinds in the tag registry) link generated
  assets back to character records — the Characters hub finds a character's images
  by tag, not by stored ids.

## The pi agent seam

One invocation path:

1. **Pi tasks** (read-book, character list/extract, concept suggest, panel
   prompt draft/refine): endpoint
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

   **Tools-as-API (pi-idea §6):** profiles whose output is a domain object
   (`draft-panel-prompt`, `refine-panel-prompt`, `suggest-concept-*`) declare
   `TaskProfile.tools`. The runtime then adds
   `--extension .pi/extensions/photo-web.ts` and sets `PHOTO_WEB_API`
   (origin: `PHOTO_WEB_API` env override, else `http://127.0.0.1:{API_PORT}`),
   `PHOTO_WEB_PROJECT`, `PHOTO_WEB_TASK`, and `PHOTO_WEB_ALLOWED_TOOLS`. The
   extension registers only the allow-listed tools
   (`set_panel_image_prompt`, `replace_panel_image_prompt`,
   `create_concept_card`), each a typed `fetch()` back into the local API
   with server-side validation, so the agent delivers its result with one
   tool call and no scratch files. `on_success` verifies delivery (a new
   prompt/card exists) and fails the task if the agent never called the tool.
   Character extraction stays file-based — `characters/*.md` are the actual
   editable data model.

`pi_session_trace.py` parses pi's on-disk session `.jsonl` files for the trace
view and is transport-independent.

### Planned direction

See [pi-idea.md](pi-idea.md) for the full verified design (pi SDK/RPC/extension findings, PiSessionManager, narrow single-purpose task profiles, domain tools). The product direction is button-driven AI augmentation — many narrow pi agents (character/scene/prop extraction, panel image-prompt drafting/refinement), no general chat agent.

The detached-bash layer and the legacy book-chat feature (with its
`PiRpcClient` sync-turn path) are gone; all pi work runs on the in-process
**PiSessionManager**. Panel prompt drafting/refinement, the imagen prompt
guide injection, and tools-as-API delivery (pi-idea §6) are implemented.
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
- `conceptArt/`, `characters/`, `visualStyles/` — the other workspace views.
- `shared/` — cross-feature helpers (`dom.ts`, `canvasDefaults.ts`, `popover.ts`).
- `api.ts` — the single REST client; `types.ts` — the domain/API types.

### Documented warts

- `canvas/nodeTagActions.ts` is a module-level mutable ref that bridges main.tsx
  callbacks into React Flow node components. It bypasses React data flow but is
  the sanctioned pattern here until the canvas gets a real store.
- CSS lives in per-area files under `webui/src/styles/` with tokens in
  `tokens.css`; load order in `styles/index.css` is load-bearing.
- Lazy `import adaptation` inside functions breaks import cycles between
  `adaptation`, `library`, `style_refs`, and `visual_styles`. Documented,
  intentional; don't add new cycles.

## Storage layout (per project)

```text
photo-library/projects/<slug>/
  project.json                 # name, createdAt, cover
  canvas.json                  # nodes + viewport
  tags.json                    # tag registry (user + entity tags)
  assets/<ulid>.json|.png      # image metadata + pixels
  story-panels/panels.json     # panel chunks + page layout
  chat-sessions/<id>/          # Gemini refinement chats + blobs
  adaptation/
    adaptation.json            # styleRefs + characters + locations metadata
    book.txt                   # source text
    characters/<slug>.md       # unified character file (summary + variants)
    locations/prompts/<slug>.md
    style-refs/                # archetype prompts + visual-styles.json
    sessions/                  # pi session files, job logs, status JSON
```
