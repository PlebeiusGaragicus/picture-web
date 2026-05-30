# Photo Web — Image lineage canvas (spec)

Personal tool for organizing AI-generated and reference images on an infinite canvas, editing prompts/metadata, and running generation. The user works only in the UI; disk layout is an implementation detail.

## Goals

- Visualize **lineage**: reference images → composed prompt → generated outputs → refinements.
- **Single unit of storage:** each image is `(metadata, pixels)`; no separate “prompt files” the user maintains.
- **React Flow** canvas: drag, arrange, link; panel for prompt (free text) and metadata (schema-driven).
- **Filesystem + generator + UI** as three layers; generation logic stays in Python (reuse/adapt `generate.py`).
- Assets live outside git: `~/imagegen-library/`.
- **Local web app** (Vite + API server on localhost). No desktop binary, no app store, single machine.

## Non-goals (v1)

- Multi-user / sync / cloud.
- In-canvas image editing (crop, inpaint).
- App Store packaging or code signing.
- Storing library assets in the nanonana git repo.
- Cross-project reference edges (see [Open questions](#open-questions)).
- Auto-layout, collaboration, real-time multi-tab sync.

---

## Architecture

```text
┌─────────────────────┐     HTTP localhost      ┌──────────────────────┐
│  Vite + React       │ ◄──────────────────────►│  API server          │
│  React Flow canvas  │                         │  (Node or Python)    │
│  Schema-driven panel│                         │  CRUD library        │
└─────────────────────┘                         │  validate JSON       │
                                                │  spawn / run generate│
                                                │  thumbnails, watch   │
                                                └──────────┬───────────┘
                                                           │
                                                           ▼
                                                ~/imagegen-library/
```

| Layer | Responsibility |
|-------|----------------|
| **Library** | Opaque storage: per-image JSON + PNG, per-project `canvas.json`, config. |
| **Generator** | Read image spec + resolve ref PNGs → call Gemini → write `{id}.png`. Adapt from `generate.py`. |
| **UI** | Only editor users touch; writes JSON, layout, triggers generate, derives graph edges. |

**Repo (`nanonana`):** UI code, JSON Schema, API, generator. Optional one-off **migration** script from legacy `prompts/` / `scenes/`. See [docs/resolutions.md](resolutions.md) for model aspect ratio / `image_size` tiers.

**Security:** API binds `127.0.0.1` only. `GOOGLE_API_KEY` in `~/imagegen-library/.env` (or equivalent), not committed.

---

## Library layout

```text
~/imagegen-library/
  .env                          # GOOGLE_API_KEY, optional defaults
  library.json                  # optional: version, last-opened project
  projects/
    <project-slug>/
      project.json              # display name, createdAt, settings
      canvas.json               # layout + viewport only (see below)
      assets/
        <id>.json               # metadata (required for every asset)
        <id>.png                # pixels (absent for draft until generate)
```

- **Flat `assets/`** per project. Filenames are program ids (`uuid` or `ulid`), not human titles.
- **Projects** scope the canvas and asset set so large libraries are not one infinite graph.
- No `prompts/` vs `scenes/` semantics on disk; grouping is **tags**, **title**, and graph position.

---

## Core model: Image

```text
Image = { id, metadata, pixels? }
```

| Part | On disk | Notes |
|------|---------|--------|
| `id` | stem of `{id}.json` / `{id}.png` | Stable forever; UI shows `title` + thumbnail. |
| `metadata` | `{id}.json` | Tags, kind, prompt, generation params, lineage. |
| `pixels` | `{id}.png` | Missing for `draft` until first successful generate. |

### Kinds (`metadata.kind`)

| Kind | Pixels | Purpose |
|------|--------|---------|
| `imported` | yes | External file brought into library (e.g. sketch, photo ref). |
| `draft` | no | Recipe composed in UI; Generate creates/updates output. |
| `generated` | yes | Successful model output; metadata records recipe used. |
| `archived` | optional | Hidden from default canvas/filters; pixels may remain. |

**Lineage:** Inputs = `generation.refs` (image ids). Optional refinement parent = `derivedFrom` (single id). Each **generate run** that should be kept creates a **new** image id (do not overwrite PNGs by default).

**Draft workflow:** User creates draft → sets prompt + refs on canvas → Generate → server writes PNG, sets `kind` to `generated` (or creates new `generated` node and archives draft—see [Open questions](#open-questions)).

---

## Per-image JSON (v1)

Validate on server and in UI (JSON Schema / Zod).

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
    "model": "gemini-3.1-flash-image",
    "aspectRatio": "4:3",
    "imageSize": "1K"
  },

  "derivedFrom": "01HPREV..."
}
```

### Field rules

| Field | Rules |
|-------|--------|
| `tags` | Slugs only: `^[a-z0-9]+(-[a-z0-9]+)*$`. |
| `prompt` | Object with `text` (string). Required for `draft` / `generated` when generating. Absent or null for `imported`. |
| `generation` | Absent for `imported`. For `draft` / `generated`: `refs` (array of ids, same project), `model`, `aspectRatio`, `imageSize`. |
| `derivedFrom` | Optional one id: “refined from” (UX clarity); **inputs** remain `generation.refs`. |

**Defaults** (server or `library.json`): model `gemini-3.1-flash-image`, `aspectRatio` `16:9`, `imageSize` `1K` — align with current `generate.py` env overrides.

### What we are not using

- `prompt.md` with YAML front matter in the library.
- `refs:` as markdown front matter (refs live in `generation.refs` only).

---

## Canvas / graph (`canvas.json`)

**Layout only.** Do not store `refs`, tags, or prompts here (avoids drift vs `{id}.json`).

```json
{
  "version": 1,
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "nodes": {
    "01HXYZ...": { "x": 400, "y": 120, "width": 280 }
  },
  "groups": []
}
```

Optional later: `groups` for visual frames only (names + member ids), not semantic ownership.

### React Flow edges (derived, not stored)

| Edge type | Meaning | Source |
|-----------|---------|--------|
| `ref` | Image used as **input** to another asset’s recipe | Target’s `generation.refs` |
| `derived` | Optional refinement parent | Target’s `derivedFrom` |
| `generated` | Output produced from a recipe | **Inferred:** `generated` node whose recipe is represented by a `draft` or by metadata on itself; see [Open questions](#open-questions) for draft→output linking |

**UI rule:** Drawing a link **image → draft/generated** updates target `generation.refs` and saves JSON, then re-derives edges. Invalid links rejected (e.g. imported → imported with no prompt node).

**Node rule:** Every **image asset** in the project can appear on the canvas; not every file on disk is a node—only assets with `{id}.json`. User can hide via `archived` or remove from `canvas.json` positions without deleting assets.

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

Base: `http://127.0.0.1:<port>/api`

| Method | Path | Action |
|--------|------|--------|
| GET | `/projects` | List projects |
| POST | `/projects` | Create project (slug + name) |
| GET | `/projects/:slug` | Project meta + asset index |
| GET | `/projects/:slug/assets` | List metadata (+ hasPixels flag) |
| GET | `/projects/:slug/assets/:id` | One metadata + thumbnail URL |
| PUT | `/projects/:slug/assets/:id` | Update metadata (validate) |
| POST | `/projects/:slug/assets/import` | Multipart PNG → `imported` + file |
| POST | `/projects/:slug/assets` | Create `draft` |
| POST | `/projects/:slug/assets/:id/generate` | Run generator; write PNG; update kind |
| GET | `/projects/:slug/canvas` | Load `canvas.json` |
| PUT | `/projects/:slug/canvas` | Save layout |
| GET | `/projects/:slug/assets/:id/thumb` | Resized image for canvas |

**Generate:** Persist `generation.refs` and `prompt.text` before call. Do not rely on CLI-only `--refs` without saving. On success, parse output path; notify UI (response body + optional SSE/file watch).

**Errors:** Return API message + stderr snippet; node shows failed state, no partial PNG.

---

## UI

### Canvas (React Flow)

- Pan/zoom, drag nodes, save positions to `canvas.json`.
- Custom node: thumbnail + title + kind badge.
- Link gesture: image → target with `generation` block updates refs.
- Filters: tags (multi), kind, text search on `title` + `prompt.text`, hide `archived`.
- Project switcher: load one project at a time.

### Side panel (schema-driven)

| Control | Applies to |
|---------|------------|
| Title, tags (validated slugs) | all |
| Prompt textarea | `draft`, `generated` |
| Refs list (linked nodes + picker) | `draft`, `generated` |
| model, aspectRatio, imageSize | `draft`, `generated` |
| Import info (read-only path/date) | `imported` |

Actions: **Import**, **New draft**, **Generate**, **Refine** (new draft with `derivedFrom` + refs prefilled), **Archive**, **Open folder in Finder** (optional escape hatch).

### Dev workflow

```bash
# Example; exact package layout TBD
concurrently "vite" "node server"   # or python -m photo_web_api
```

Vite proxies `/api` to the backend.

---

## Generation (Python)

Reuse logic from `generate.py`:

- Load `prompt.text` + resolve `generation.refs` → absolute paths under `assets/{ref}.png`.
- `ImageConfig`: `aspectRatio`, `imageSize` (uppercase `K`; see [resolutions.md](resolutions.md)).
- Write `{id}.png` next to `{id}.json`.

Interface options (pick one in implementation):

1. Subprocess: `python generate.py --spec ~/.../assets/{id}.json`
2. Shared module imported by FastAPI and CLI.

---

## Scale and performance

- **Hundreds** of nodes per project: OK for MVP with thumbnails via API.
- **Thousands:** plan for virtualization, lazy thumbnails, stricter filters.
- **Many projects:** only mount current project’s assets on canvas.

---

## Migration from legacy nanonana layout

One-off importer (optional):

| Legacy | Library |
|--------|---------|
| Any `.png` | `imported` or `generated` by context |
| `prompt.md` body | `prompt.text` |
| Front matter `refs` | `generation.refs` (resolve to new ids) |
| Folder (`prompts/x`, `scenes/NNN`) | tags + single project or split by top-level folder |

Outputs `prompt-YYYYMMDD-HHMMSS.png` → separate `generated` nodes or one node per file with shared recipe copied from sibling markdown.

---

## MVP checklist

1. Library paths + create/open project.
2. CRUD assets + JSON Schema validation.
3. Import PNG → `imported` node on canvas.
4. Create `draft`, edit panel, link refs, save.
5. Generate → PNG + `generated` (or update draft per decision).
6. React Flow: derived `ref` edges, layout persist.
7. Tag filter + search.
8. Localhost-only server + `.env` for API key.

## Deferred

- Cross-project refs and global asset pool.
- Auto-layout, minimap polish, WebSocket vs poll.
- Export/import project zip for sharing.
- Version history UI (list prior outputs per logical “slot”).
- Collections / group nodes beyond tags.

---

## Decisions (from design discussion)

| Topic | Decision |
|-------|----------|
| Source of truth for refs | `{id}.json` only, not `canvas.json`. |
| User vs program filesystem | User uses UI only; paths are opaque ids. |
| Repo vs library | Code in repo; pixels + library JSON in `~/imagegen-library/`. |
| Desktop binary | Not required; Vite + local API. |
| Markdown + YAML | Dropped for library assets. |
| Overwrite on regenerate | Prefer **new id** per run; keep history in graph. |
| Edge drawing | Constrained; updates `generation.refs`, not freeform whiteboard. |
| `prompts/` / `scenes/` | Not used in new layout; tags + projects replace. |

---

## Pushback / risks (acknowledged)

| Risk | Mitigation |
|------|------------|
| Opaque folders in Finder | `title`, tags, export zip later. |
| Graph vs metadata drift | Derive edges; single write path for refs. |
| Large canvas clutter | Projects, filters, `archived`. |
| Lost work without git | User backs up `~/imagegen-library`; Time Machine. |
| API key on disk | `.env` outside repo; chmod user-only. |
| Multiple browser tabs | Last-write-wins on JSON unless add locking later. |

---

## Open questions

Resolve before or during implementation:

1. **Draft → generated transition:** Mutate same `id` on generate, or create new `generated` id and delete/archive draft?
2. **`generated` edge display:** Show explicit edge from `draft` → output, or only `ref` edges into a single `generated` node that holds full metadata?
3. **API stack:** Node (Fastify) vs Python (FastAPI) — Python minimizes duplicate Gemini code.
4. **ID format:** UUID v4 vs ULID (sortable).
5. **Thumbnail size / cache:** On-the-fly vs `assets/{id}.thumb.webp`.
6. **Regenerate from `generated`:** Clone to new `draft` with copied metadata, or edit in place and “Generate again” as new sibling node only?
7. **Cross-project refs:** Forbidden in v1—confirm?
8. **Superseded outputs:** Tag `superseded` vs `archived` vs leave all visible?
9. **Monorepo location:** New `photo-web/` package in nanonana vs separate repo.
10. **Inference rule for legacy migration:** One `generated` node per timestamped PNG vs merge by folder.

---

## Glossary

| Term | Meaning |
|------|---------|
| Asset | Pair `{id}.json` + optional `{id}.png` |
| Project | Scoped collection under `projects/<slug>/` |
| Ref | Input image id listed in `generation.refs` |
| Library | `~/imagegen-library/` root |

---

## Related files (current repo)

| File | Relevance |
|------|-----------|
| [generate.py](../generate.py) | Generation behavior to adapt |
| [docs/resolutions.md](resolutions.md) | `aspectRatio` / `imageSize` allowed values |
| [README](../README) | Legacy layout documentation (pre–photo-web) |
