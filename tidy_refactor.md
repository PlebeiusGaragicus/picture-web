# Tidy Refactor Plan

This document captures the intended comic-adaptation workflow and the code conventions we should refactor toward. The current implementation works in many places, but it has accumulated patch-by-patch behavior around phases, validation, canvas nodes, and style references. The goal of this refactor is to make the product flow explicit and make the code match that flow.

## Intended Workflow

### Phase 0: Ingest

Purpose: prepare source context and global style inputs.

Deliverables:

- `book.txt` exists.
- `sessions/book-load.env` exists and points to project-local Pi session JSONL records.
- `style-refs/visual-style.md` exists and is editable.
- `style-refs/archetype-character.md` exists.
- `style-refs/archetype-scene.md` exists.

UI responsibilities:

- Upload or view the source book.
- Run or re-run ingest.
- Edit the shared visual style.
- Do not generate images here.

### Phase 1: Characters

Purpose: create character prompts and canonical character reference images.

Deliverables:

- `characters/list.txt`
- `characters/artifacts/*.md`
- `characters/sheets/*.md`
- canonical character archetype image asset
- generated character sheet images

UI responsibilities:

- List mode:
  - Show the character archetype prompt/image card.
  - Extract characters from the book session.
  - Validate only the character phase.
  - Show character files as a single-column editable list.
  - Publish or generate character canvas nodes.
- Canvas mode:
  - Show the character archetype draft node.
  - Show the canonical character archetype image node.
  - Show character sheet artifact nodes.
  - Support generated image nodes and canonical asset selection.

### Phase 2: Locations

Purpose: create location prompts and canonical scene/location reference images.

Deliverables:

- `locations/index.md`
- `locations/prompts/*.md`
- canonical scene archetype image asset
- generated location reference images

UI responsibilities:

- List mode:
  - Show the scene archetype prompt/image card.
  - Extract locations from the book session.
  - Validate only the location phase.
  - Show location files as a single-column editable list.
  - Publish or generate location canvas nodes.
- Canvas mode:
  - Show the scene archetype draft node.
  - Show the canonical scene archetype image node.
  - Show location artifact nodes.
  - Support generated image nodes and canonical asset selection.

### Phase 3: Scenes

Purpose: create scene planning artifacts.

Deliverables:

- `acts/play-by-play.md`
- `scenes/manifest.md`
- `scenes/artifacts/*.md`

UI responsibilities:

- Choose or edit story kind here.
- Extract/generate scene artifacts.
- Validate only scene-phase files.
- Do not require character/location generation to validate scene structure unless explicitly needed by the scene operation.

### Phase 4: Moments

Purpose: create page and panel layout prompts.

Deliverables:

- `pages/plans/*.md`
- `panels/prompts/*.md`

UI responsibilities:

- Generate page/panel story layouts from scene artifacts.
- Validate only moment-phase files.

### Phase 5: Images

Purpose: generate final page/panel imagery.

Deliverables:

- generated page/panel images
- canonical selected images where applicable

UI responsibilities:

- Canvas-focused image generation and refinement.
- Use canonical character and location references as semantic image references.

## Core Product Convention

Files are the source of truth for prompts. Metadata is the source of truth for canonical asset IDs. Canvas is a repairable projection of both.

Implications:

- Deleting a canvas node should not delete the underlying adaptation artifact.
- Re-entering a phase or publishing to canvas should recreate expected missing nodes.
- Canvas nodes may be rearranged and edited as a work surface, but canonical adaptation state lives in files and metadata.
- Canvas sync should be idempotent and safe to run repeatedly.

## Domain Model Direction

The current code relies too heavily on generic canvas node tags such as `archetype`, `character-style`, `scene-style`, `generated`, and `missing`. These tags are useful for filtering, but they should not be the only way the app understands adaptation semantics.

Introduce explicit domain concepts for style references.

```ts
type StyleRefKind = 'archetype-character' | 'archetype-scene';

interface StyleRefStatus {
  kind: StyleRefKind;
  promptPath: string;
  promptText: string;
  assetId: string | null;
  canvasDraftNodeId: string;
  canvasImageNodeId: string;
}
```

The backend and frontend should use this model directly instead of rediscovering style-ref identity from canvas tags or hardcoded conditionals scattered through the code.

## Backend Refactor

### Centralize Style Reference Logic

Add focused helpers in `api/adaptation.py` and/or a small style-ref module:

- `style_ref_config(kind)`
- `style_ref_status(slug, kind)`
- `sync_style_ref_canvas_nodes(slug, canvas, kind | None)`
- `generate_style_ref(slug, kind)`
- `set_style_ref_asset(slug, kind, asset_id)`
- `clear_stale_style_ref_assets(slug, metadata)`

These helpers should centralize:

- prompt path calculation
- metadata field selection
- canvas draft node ID selection
- canvas image node ID selection
- stale asset cleanup
- prompt assembly with `visual-style.md`
- canonical asset assignment

### Split Canvas Sync by Concern

`default_canvas_for_story_artifacts()` currently handles too many unrelated responsibilities. Split it conceptually:

- `sync_style_ref_nodes(slug, canvas)`
- `sync_character_nodes(slug, canvas)`
- `sync_location_nodes(slug, canvas)`
- `sync_scene_nodes(slug, canvas)`
- `sync_moment_nodes(slug, canvas)`

Each sync function should:

- be idempotent
- recreate missing expected nodes
- repair wrong-type nodes where possible
- avoid creating invalid image nodes for missing asset IDs
- not silently mutate unrelated node groups

### Normalize Style Reference Generation

Style-reference image generation should never go through generic draft generation.

It should:

1. Load `style-refs/archetype-character.md` or `style-refs/archetype-scene.md`.
2. Append `style-refs/visual-style.md`.
3. Generate one image.
4. Save the generated asset ID to metadata:
   - `metadata.styleRefs.archetypeCharacterAssetId`
   - `metadata.styleRefs.archetypeSceneAssetId`
5. Sync canvas.
6. Return updated adaptation status.

Imported style-ref images and generated style-ref images should both end in the same canonical metadata state.

### Stage-Scoped Validation

Validation should stay phase-specific:

- `validate-ingest.log`
- `validate-characters.log`
- `validate-locations.log`
- `validate-scenes.log`
- `validate-moments.log`

No phase should validate future-phase deliverables.

## Frontend Refactor

### Split PhaseAssetType

`PhaseAssetType` currently owns too many UI responsibilities. Split it into smaller components:

- `StyleRefCard`
- `PhaseWorkflowActions`
- `AdaptationFileList`
- `PublishToCanvasCard`

The goal is for each component to have one job and one data contract.

### Make Style Reference UI Explicit

`StyleRefCard` should receive a `StyleRefStatus`, not infer state from separate `asset`, `prompt`, and tags.

It should support:

- viewing prompt preview
- editing prompt in a modal
- importing/replacing the canonical image
- generating the canonical image
- showing whether the image is missing, prompt-ready, or canonical

### Make Canvas Node Roles Explicit

Canvas nodes should carry enough role information that the UI does not need to guess from tags alone.

Potential approach:

```ts
type CanvasRole =
  | { type: 'style-ref-draft'; kind: StyleRefKind }
  | { type: 'style-ref-image'; kind: StyleRefKind }
  | { type: 'story-artifact'; artifactKind: ArtifactKind; artifactKey: string }
  | { type: 'generic' };
```

If changing the canvas schema is too large for one pass, keep tags for filtering but add small helper functions:

- `styleRefKindForNode(node)`
- `isStyleRefDraftNode(node)`
- `isStyleRefImageNode(node)`
- `isCanonicalStyleRefAsset(adaptation, assetId)`

### Separate Generic Draft Generation from Adaptation Generation

Generic drafts should call generic `/generate`.

Adaptation-specific nodes should call adaptation-specific endpoints:

- style reference draft -> `generate-style-ref`
- character sheet artifact -> `generate-artifact`
- location prompt artifact -> `generate-artifact`
- page/panel artifact -> `generate-artifact`

The frontend should not assemble adaptation prompts or canonical metadata updates itself.

### List-to-Canvas Actions

List view actions should perform predictable domain operations:

- "Generate this character reference" should:
  1. ensure the character archetype prompt exists
  2. call the style-ref generation endpoint
  3. switch to the character canvas
  4. select or focus the relevant style-ref image node
  5. show progress while generation runs

- "Publish to canvas" should:
  1. sync expected nodes for the current phase
  2. switch to the relevant canvas
  3. not overwrite unrelated canvas layout

## Testing Targets

Add or update tests for these behaviors:

- Phase 1 validation does not check `acts/play-by-play.md`.
- Phase 2 validation does not check scenes or moments.
- Stale style-ref asset IDs are cleared if the asset JSON/PNG is missing.
- Deleted style-ref draft nodes are recreated by style-ref sync.
- Wrong-type style-ref nodes are repaired.
- Generating a style ref creates a generated asset, records it as canonical, and creates/updates the style-ref image node.
- Setting any existing generated image as the character archetype updates metadata and canvas.
- Importing a style-ref image updates metadata and canvas.
- Re-running canvas sync is idempotent.

## Migration Notes

This project favors clear breaking changes over compatibility shims.

Acceptable cleanup:

- Regenerate local adaptation state where needed.
- Clear stale metadata fields when referenced assets no longer exist.
- Replace old canvas node conventions instead of preserving them indefinitely.

Avoid:

- maintaining `v1`/`v2` canvas compatibility layers
- keeping old node IDs alive through hidden shims
- inferring new semantics from obsolete local data

## Recommended Refactor Order

1. Define style-ref config/status helpers in the backend.
2. Split style-ref canvas sync out of general artifact sync.
3. Normalize generate/import/set style-ref flows around one metadata/canvas contract.
4. Add backend tests for stale assets, deleted nodes, wrong-type nodes, and generation.
5. Refactor frontend `StyleRefCard` to consume the new style-ref status contract.
6. Split `PhaseAssetType` into smaller components.
7. Replace tag-based adaptation decisions with explicit helper functions or node roles.
8. Add UI tests or focused integration checks around phase validation and list-to-canvas actions.

