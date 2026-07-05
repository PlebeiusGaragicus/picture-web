# Architecture

Local single-user app: FastAPI backend (`api/`), React + Vite UI (`webui/`),
all user data under gitignored `photo-library/`. The backend is the only layer
that touches the filesystem, validation, Gemini, and the pi agent.

```text
webui (React, React Flow)  ── REST /api ──  api (FastAPI)
                                              ├─ gemini.py            → Google GenAI image generation
                                              ├─ adaptation_jobs.py   → detached pi agent jobs
                                              │    └─ python -m adaptation_workflow …
                                              │         └─ pi --mode rpc (JSON-RPC subprocess)
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
| `adaptation_jobs.py` | Detached pi job launch + status-JSON contract (see below). |
| `canvas_nodes.py` | Canvas node factories (image groups, character/location spawns). |
| `chat_sessions.py` | Gemini image-refinement chats (thought signatures preserved, archive-first). |
| `agent_sessions.py` / `book_chat_sessions.py` / `book_session_load.py` / `pi_session_trace.py` | Pi agent session registry, book chats, read-book loading, session-file trace parsing. |
| `story_panels.py` / `story_panels_print.py` | Panel chunks, page layout, booklet PDF (reportlab). |
| `adaptation_workflow/` | Subprocess-side pi orchestration: `config.py` (context, pi/node discovery), `runner.py` (per-job entry points), `steps.py` (`StepRunner`), `pi_rpc.py` (`PiRpcClient`), `character_file.py`, `concept_art.py`, `validate.py`, `events.py`, `diagnostics.py`. |

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

Two invocation paths, both ultimately speaking JSON-RPC to a `pi --mode rpc`
subprocess via `adaptation_workflow/pi_rpc.py` (`PiRpcClient.run_task`):

1. **Async jobs** (read-book, character list/extract, concept generate):
   endpoint → `adaptation_jobs.start_logged_process` spawns a detached
   `bash -lc "cd api && python -m adaptation_workflow <cmd> …"` with a status
   JSON (`running`, `pid`, `processStartTime`, `returnCode`) next to the job
   logs. Liveness checks require both the PID *and* its kernel start time to
   match, so PID reuse can't report a dead job as running.
2. **Sync book-chat turns**: `book_chat_sessions.append_turn` runs `PiRpcClient`
   inside the request (blocks a worker for the duration of the pi turn).

`pi_session_trace.py` parses pi's on-disk session `.jsonl` files for the trace
view and is transport-independent.

### Planned direction (design, not yet implemented)

See [pi-idea.md](pi-idea.md) for the full verified design (pi SDK/RPC/extension findings, PiSessionManager, narrow single-purpose task profiles, domain tools). The product direction is button-driven AI augmentation — many narrow pi agents (character/scene/prop extraction, panel image-prompt drafting/refinement), no general chat agent; book chat is slated for removal.

Replace the detached-bash layer with an in-process **PiSessionManager** (threads,
event ring buffers + SSE streaming, cancellation via the RPC `abort` command,
status snapshots so an API restart reports "interrupted" instead of a stale
"running"). The `pi --mode rpc` transport stays: pi-idea.md records the verified
answers to the former unknowns (pi ships a Node SDK; the RPC schema is a typed
published contract with abort/new_session/steer; one process hosts sequential
sessions; extensions can register LLM-callable tools).

## Frontend map

- `main.tsx` — app root: project landing, workspace shell, the canvas view, and
  cross-view state (assets, canvas, adaptation status). Still the largest file;
  extract further views as they grow.
- `projectNavigation.ts` — the six workspace views; navigation is a
  `projectPhase` string, no router.
- `canvas/` — node data types, edge derivation, node sidebars, tag editing.
- `storyPanels/` — Story + Layout views and their pure layout/print logic.
- `sessions/` — Agent view: book chats, pi trace timeline.
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
