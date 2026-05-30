# photo-web — Image lineage canvas (spec)

Personal tool for organizing AI-generated and reference images on an infinite canvas, inspecting generation metadata, and running new generations. The user works only in the UI; disk layout is an implementation detail.

**Repo:** [photo-web](.) — application code only. All photos and library JSON live under `./photo-library/` (not in source packages).

## Goals

- Visualize **lineage**: parent images + prompt + generation settings → child outputs and refinements.
- **Single unit of storage:** each saved image is `(metadata, pixels)`; no separate “prompt files” or persistent draft assets.
- **React Flow** canvas: drag, arrange, link; panel for generation form + read-only asset metadata.
- **Two app packages:** `webui/` (React) and `api/` (FastAPI, including Gemini generation).
- Assets live in `./photo-library/`.
- **Local web app** (Vite + FastAPI on localhost). No desktop binary, no app store, single machine, no users except the developer.

## Non-goals (v1)

- Multi-user / sync / cloud.
- In-canvas image editing (crop, inpaint).
- App Store packaging or code signing.
- Standalone generation CLI or batch scripts.
- Cross-project lineage edges.
- Auto-layout, collaboration, real-time multi-tab sync.

---

## Repo layout

```text
photo-web/
  README.md
  docs/
    resolutions.md              # aspectRatio / imageSize allowed values
  api/                          # FastAPI: REST, library CRUD, Gemini generation
    main.py                     # app entry (uvicorn main:app)
    gemini.py                   # Nano Banana calls for library assets
    requirements.txt
  webui/                        # Vite + React + React Flow
  photo-library/                # User data (see Library layout)
    .env                        # GOOGLE_API_KEY (gitignored)
    projects/ ...
```

| Directory | Role |
|-----------|------|
| `api/` | **FastAPI** server: validate JSON, read/write `./photo-library/`, generate images via `gemini.py`, serve thumbnails. |
| `webui/` | Browser UI; talks to `api/` over REST (`/api` proxied in dev). |
| `photo-library/` | All pixels and per-image metadata. Not mixed with app source. |

### Current status

| Piece | Status |
|-------|--------|
| `api/main.py` | FastAPI scaffold (`/api/health`) |
| `api/gemini.py` | Gemini generate helper (library-oriented) |
| `api/` routes | Library CRUD + generate endpoints planned |
| `webui/` | Scaffolded |
| `photo-library/` | `.env` + empty `projects/` until first project is created |
| JSON Schema | Planned under `api/` |

---

## Architecture

```text
┌─────────────────────┐     HTTP localhost      ┌──────────────────────────────┐
│  webui/             │ ◄──────────────────────►│  api/ (FastAPI)              │
│  Vite + React       │      REST /api          │  library CRUD, validation    │
│  React Flow canvas  │                         │  gemini.generate_image(...)  │
│  Schema-driven panel│                         │  thumbnails                  │
└─────────────────────┘                         └──────────────┬───────────────┘
                                                               │
                                                               ▼
                                                    ./photo-library/
```

| Layer | Responsibility |
|-------|----------------|
| **Library** (`photo-library/`) | Opaque storage: per-image JSON + PNG, per-project `canvas.json`, config. |
| **API** (`api/`) | Single backend: HTTP, filesystem, validation, and Gemini generation. |
| **UI** (`webui/`) | Canvas, panel, triggers generate; **derives lineage edges** from metadata. |

**Stack:** **FastAPI** in `api/` + **React** in `webui/`. Generation stays in Python inside the API (`api/gemini.py`); the UI only calls REST. One venv, one `requirements.txt`, no duplicate Gemini code.

**Security:** API binds `127.0.0.1` only. `GOOGLE_API_KEY` in `photo-library/.env` (gitignored), not committed.

See [docs/resolutions.md](docs/resolutions.md) for model aspect ratio / `image_size` tiers.

---

## Library layout

```text
./photo-library/
  .env                          # GOOGLE_API_KEY, optional NANO_BANANA_* defaults
  library.json                  # optional: version, last-opened project
  projects/
    <project-slug>/
      project.json              # display name, createdAt, settings
      canvas.json               # layout + viewport only (see below)
      assets/
        <id>.json               # metadata (required for every asset)
        <id>.png                # pixels (required for saved image assets)
```

- **Flat `assets/`** per project. Filenames are program ids: **ULIDs** (`01H...`), not human titles.
- **Projects** scope the canvas and asset set so large libraries are not one infinite graph.
- No `prompts/` vs `scenes/` semantics on disk; grouping is **tags**, **title**, and graph position.

---

## Core model: Image

```text
Image = { id, metadata, pixels }
```

| Part | On disk | Notes |
|------|---------|--------|
| `id` | stem of `{id}.json` / `{id}.png` | Stable forever; ULID; UI shows `title` + thumbnail. |
| `metadata` | `{id}.json` | Tags, kind, prompt, generation params, parent refs, run grouping. |
| `pixels` | `{id}.png` | Required for every saved asset. Unsaved prompt edits live only in UI state. |

### Kinds (`metadata.kind`)

| Kind | Pixels | Purpose |
|------|--------|---------|
| `imported` | yes | External file brought into library (e.g. sketch, photo ref). |
| `generated` | yes | Successful model output; metadata records parents + prompt/settings used. |

**Lineage (parents → child):** The Nano Banana API accepts zero or more **input images** plus a **text prompt** and generation settings, then returns one or more new images. Canvas links show only that relationship: parent image → generated child.

- **Parents** = `generation.refs` on the **child** (ordered list of image ids in the same project).
- **N parents** = any combination the user needs (one image edited with language, two images merged, five characters on a white background, etc.). The prompt describes intent; the graph only records which images were inputs.
- **Canvas edges** = directed **parent → child**, one edge per parent id in `generation.refs`, derived at render time (not stored in `canvas.json`).
- **Every saved output has a unique id.** A generate action never overwrites an existing PNG by default.
- **Batches / stacks:** one generate request may create multiple sibling images. Each sibling gets its own ULID and shares `generation.runId`; the UI can collapse those siblings into a stack because they came from the same input image(s), prompt, settings, and seed policy.

**Generate workflow:** User selects parent images and edits prompt/settings in the UI → Generate → API writes one or more `{child}.json` + `{child}.png` assets → generated images appear on the canvas immediately. There are no persistent draft assets in v1; in-progress prompt edits are UI state until generation succeeds.

**Immutability rule:** Generated asset metadata is a historical receipt. Do not edit a generated asset’s prompt, parent refs, model, seed, or generation settings in place. To iterate, select any image(s), open **Generate / Refine**, adjust prompt/settings/inputs in the form, and save the result as new child asset(s). Editable fields after save are limited to display-only organization such as `title` and `tags`.

---

## Per-image JSON (v1)

Validate in `api/` and `webui/` (JSON Schema / Zod).

```json
{
  "id": "01HXYZ...",
  "kind": "generated",
  "title": "Tom chases hen — panel 1",
  "tags": ["scene", "tom", "dusk"],
  "createdAt": "2026-05-30T12:00:00Z",
  "updatedAt": "2026-05-30T12:05:00Z",

  "prompt": {
    "text": "Comic panel, dynamic action shot at dusk..."
  },

  "generation": {
    "refs": ["01HAAA...", "01HBBB..."],
    "runId": "01HRUN...",
    "runIndex": 0,
    "model": "gemini-3.1-flash-image",
    "aspectRatio": "4:3",
    "imageSize": "1K",
    "seed": 123456789
  },

  "provider": {
    "name": "google-genai",
    "response": {
      "...": "full serialized Gemini response metadata, excluding duplicated image bytes"
    }
  }
}
```

### Field rules

| Field | Rules |
|-------|--------|
| `tags` | Slugs only: `^[a-z0-9]+(-[a-z0-9]+)*$`. |
| `prompt` | Object with `text` (string). Required for `generated`; absent or null for `imported`. |
| `generation` | Absent for `imported`. For `generated`: immutable receipt with `refs` (parent ids, same project), `runId`, `runIndex`, `model`, `aspectRatio`, `imageSize`, optional `seed`. |
| `provider` | Absent for `imported`. For `generated`: raw provider capture. Store the full serializable Gemini response metadata for the call/candidate that produced the image, but do not duplicate large inline image bytes already saved as `{id}.png`. |

**Defaults** (API or `library.json`): model `gemini-3.1-flash-image`, `aspectRatio` `16:9`, `imageSize` `1K` — overridable via `NANO_BANANA_*` in `photo-library/.env`.

**Seed policy:** Gemini `GenerateContentConfig.seed` is supported as an optional integer and provides best-effort reproducibility, not a hard guarantee. If the user provides a seed, store it. If the user leaves seed blank, the API should generate its own integer seed before calling Gemini, pass that seed explicitly, and store it. Do not rely on Gemini returning an auto-selected seed; the docs describe random defaults but do not expose a reliable returned seed to capture.

**Provider metadata policy:** Keep normalized app fields (`prompt`, `generation`, `refs`) for stable behavior, and also persist the raw Gemini response metadata under `provider.response`. This should include candidates, finish reasons, safety ratings, usage metadata, grounding/search metadata, response ids, model version fields, and any other SDK-provided metadata that is JSON-serializable. Strip or replace inline image bytes with references to `{id}.png` so the JSON stays metadata-only.

### What we are not using

- `prompt.md` / YAML front matter in the library.
- Separate edge or parent fields on `canvas.json` (parents live in `generation.refs` only).
- Standalone CLI or batch generation scripts.

---

## Canvas / graph (`canvas.json`)

**Layout only.** Do not store parent refs, tags, or prompts here (avoids drift vs `{id}.json`).

```json
{
  "version": 1,
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "nodes": {
    "01HXYZ...": { "x": 400, "y": 120, "width": 280 }
  },
  "stacks": []
}
```

`stacks` is optional layout state for collapsed generation batches. The semantic grouping still comes from shared `generation.runId`; `canvas.json` only remembers whether/how the UI displays the stack.

### React Flow edges (derived, not stored)

One edge kind: **lineage** — **parent → child** (parent id ∈ child’s `generation.refs`).

| Parents | Typical use (examples only) |
|---------|------------------------------|
| 0 | Text-only generation (if model allows) |
| 1 | Edit or vary a single image via prompt |
| 2+ | Combine any set of references—the prompt defines how |

**UI rule:** Drawing or choosing parent links for a generate action sets `generation.refs` on the newly generated child assets. Existing generated asset refs are read-only; changing inputs means generating a new child. Invalid targets are rejected (e.g. child cannot be a parent of itself).

**Node rule:** Every asset with `{id}.json` and `{id}.png` can appear on the canvas. Generated images remain visible by default. Removing a node from `canvas.json` only hides it from the current layout and never deletes files or changes lineage.

---

## Project metadata (`project.json`)

```json
{
  "slug": "farm-comic",
  "name": "Farm Comic",
  "createdAt": "2026-05-30T00:00:00Z",
  "settings": {}
}
```

---

## API (minimal REST)

Implemented in `api/` (FastAPI). Base: `http://127.0.0.1:<port>/api`

| Method | Path | Action |
|--------|------|--------|
| GET | `/projects` | List projects |
| POST | `/projects` | Create project (slug + name) |
| GET | `/projects/:slug` | Project meta + asset index |
| GET | `/projects/:slug/assets` | List metadata (+ hasPixels flag) |
| GET | `/projects/:slug/assets/:id` | One metadata + thumbnail URL |
| PATCH | `/projects/:slug/assets/:id/display` | Update display metadata only (`title`, `tags`) |
| POST | `/projects/:slug/assets/import` | Multipart PNG → `imported` + file |
| POST | `/projects/:slug/generate` | Generate one or more new `generated` assets from prompt/settings/parent refs |
| GET | `/projects/:slug/canvas` | Load `canvas.json` |
| PUT | `/projects/:slug/canvas` | Save layout |
| GET | `/projects/:slug/assets/:id/thumb` | Resized image for canvas |

**Generate:** Accept prompt text, same-project parent refs, settings, optional seed, and optional batch count. Create a `runId`, allocate one ULID per output, choose/pass/store explicit seeds, resolve `assets/{parent}.png` paths, call the Gemini SDK through a rewritten `api/gemini.py`, then write each `assets/{id}.json` + `assets/{id}.png`. Persist the full serializable response metadata for each output under `provider.response`, excluding duplicated inline image bytes. Return created assets in the response body.

**Errors:** Return API message + error detail; node shows failed state, no partial PNG.

---

## UI (`webui/`)

### Canvas (React Flow)

- Pan/zoom, drag nodes, save positions to `canvas.json`.
- Custom node: thumbnail + title + kind badge.
- Link gesture: **parent → Generate / Refine form** selects image inputs for the next child; saved generated nodes are immutable.
- Filters: tags (multi), kind, text search on `title` + `prompt.text`.
- Project switcher: load one project at a time.

### Side panel (schema-driven)

| Control | Applies to |
|---------|------------|
| Title, tags (validated slugs) | all saved assets |
| Prompt textarea | generation form; read-only for `generated` metadata |
| Parents list (linked nodes + picker) | generation form; read-only for `generated` metadata |
| model, aspectRatio, imageSize, seed, batch count | generation form; read-only for `generated` metadata |
| Import info (read-only path/date) | `imported` |

Actions: **Import**, **Generate**, **Refine** (open generation form with selected image as a parent), **Open folder in Finder** (optional).

### Dev workflow

```bash
# Terminal 1 — API
cd api && pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8787

# Terminal 2 — UI (proxies /api → FastAPI)
cd webui && npm run dev
```

`webui` Vite config proxies `/api` to `http://127.0.0.1:8787`.

---

## Generation (inside `api/`)

The current [api/gemini.py](api/gemini.py) is proof-of-concept code and should be rewritten against the current Gemini SDK/docs:

- Receive `prompt.text`, `generation.refs`, seed, and output paths from the API route.
- Resolve `generation.refs` → `photo-library/projects/<slug>/assets/{parent}.png`.
- `GenerateContentConfig`: `response_modalities=["IMAGE"]`, optional `seed`, and `ImageConfig` with `aspectRatio`, `imageSize` (uppercase `K`; see [docs/resolutions.md](docs/resolutions.md)).
- Write `{id}.png` next to `{id}.json`.
- Return both saved image part(s) and raw serializable response metadata so route code can persist everything useful without coupling the UI to SDK object shapes.

Route handlers stay thin; keep Gemini and PIL in `gemini.py`, library I/O in separate modules as the API grows.

---

## Scale and performance

- **Hundreds** of nodes per project: OK for MVP with thumbnails via API.
- **Thousands:** plan for virtualization, lazy thumbnails, stricter filters.
- **Many projects:** only mount current project’s assets on canvas.

---

## Migration from legacy markdown layout

Optional one-off importer (not planned as a maintained CLI):

| Legacy | Library |
|--------|---------|
| Any `.png` | `imported` or `generated` by context |
| `prompt.md` body | `prompt.text` |
| Front matter `refs` | `generation.refs` (new ids) |
| Folder (`prompts/x`, `scenes/NNN`) | tags + project slug |

Timestamped outputs `*-YYYYMMDD-HHMMSS.png` → one `generated` child per file; parents from resolved refs.

---

## MVP checklist

1. Library paths + create/open project under `photo-library/`.
2. FastAPI CRUD assets + JSON Schema validation.
3. Import PNG → `imported` node on canvas.
4. Generation form: prompt, parent picker, model, aspect ratio, image size, batch count.
5. Generate → one or more unique immutable `generated` assets; batch siblings share `generation.runId` and can render as a stack.
6. React Flow: derived parent→child edges, layout persist.
7. Tag filter + search.
8. Localhost-only API + `photo-library/.env` for API key.

## Deferred

- Cross-project refs and global asset pool.
- Auto-layout, minimap polish, WebSocket vs poll.
- Export/import project zip for sharing.
- Cached thumbnails / lazy thumbnail pipeline if on-the-fly resizing becomes slow.
- Collections / group nodes beyond tags.

---

## Decisions

| Topic | Decision |
|-------|----------|
| Repo name | **photo-web** (this repository) |
| Library path | `./photo-library/` for all pixels + JSON |
| Backend layout | **`api/` only** — REST + Gemini; no top-level `generation/` or CLI |
| Source of truth for lineage | Child’s `generation.refs` only, not `canvas.json` |
| Canvas edges | Single meaning: **parent → child** lineage (derived) |
| N parents | Any count; prompt defines semantics, not the graph |
| API | **FastAPI** in `api/`; React REST client in `webui/` |
| User vs program filesystem | User uses UI only; paths are opaque ids |
| Desktop binary | Not required; Vite + local API |
| Markdown + YAML | Not used for library assets |
| ID format | **ULID** for every saved asset and generate run |
| Overwrite on regenerate | **Never by default**; every saved output gets a new image id |
| Generation batches | Multiple outputs from one generate action share `generation.runId` and display as a stack |
| Drafts | No persistent draft assets in v1; prompt edits are UI state until generation succeeds |
| Generated metadata | Immutable receipt; prompt, refs, model, seed, and hyperparameters are never edited in place |
| Seed handling | Pass and store an explicit integer seed for every generated output; user may provide it, otherwise API chooses it |
| Provider metadata | Persist the full serializable Gemini response metadata for generated assets, excluding duplicated image bytes |
| Link drawing | Selects inputs for Generate / Refine; saved lineage comes from immutable child `generation.refs` |

---

## Pushback / risks (acknowledged)

| Risk | Mitigation |
|------|------------|
| Opaque folders in Finder | `title`, tags, export zip later |
| Graph vs metadata drift | Derive edges only from `generation.refs` |
| Large canvas clutter | Projects, filters, stack collapsed batch outputs |
| Lost work without git | Back up `./photo-library/` (Time Machine, etc.) |
| API key on disk | `photo-library/.env` gitignored; chmod user-only |
| Multiple browser tabs | Last-write-wins on JSON unless locking added later |

---

## Resolved implementation direction

These choices are now part of the v1 shape:

1. **Unique ids:** Every saved image asset has a unique ULID. Generate never overwrites an existing PNG by default.
2. **Generation stacks:** A generate action can produce multiple images. Each output gets its own id, and siblings share `generation.runId` so the UI can show them as a stack.
3. **No persistent drafts:** A prompt/settings form is UI state. Once generation succeeds, the image is saved and visible on the canvas.
4. **FastAPI backend:** Python FastAPI is the only backend; Gemini integration stays in `api/gemini.py`.
5. **Thumbnails:** Start with on-the-fly API resizing. Add cached `thumb.webp` only if performance suffers.
6. **Project boundary:** Parent refs are same-project only in v1.
7. **Visibility:** Generated images stay visible by default. Keep visibility simple; no archive or automatic `superseded` tagging.
8. **Repo boundary:** App code and `photo-library/` live in this repo. Legacy migration remains optional and deferred.

---

## Glossary

| Term | Meaning |
|------|---------|
| Asset | Pair `{id}.json` + `{id}.png` under a project |
| Project | Scoped collection under `photo-library/projects/<slug>/` |
| Parent | Input image id in a child’s `generation.refs` |
| Child | Image produced using parents + `prompt.text` via the API |
| Library | `./photo-library/` |

---

## Related files

| File | Relevance |
|------|-----------|
| [api/main.py](api/main.py) | FastAPI app entry |
| [api/gemini.py](api/gemini.py) | Gemini generation for library assets |
| [api/requirements.txt](api/requirements.txt) | Python dependencies |
| [docs/resolutions.md](docs/resolutions.md) | `aspectRatio` / `imageSize` allowed values |
| [photo-library/](photo-library/) | Library root (data + `.env`) |
