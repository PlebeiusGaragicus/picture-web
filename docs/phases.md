# Adaptation Phases

This workflow turns story source material into reusable visual references, scene plans, and final panel/page images.

## Phase 0: Ingest

Optional. Upload `book.txt` and run the read-book workflow to create a project-local Pi session.

Projects may skip this phase and manually author story files in later phases.

## Phase 1: Story Assets

Owns editable character and location files.

- Characters live in `adaptation/characters/sheets/*.md`.
- Locations live in `adaptation/locations/prompts/*.md`.
- Users can create and edit these files without ingesting a book.
- Pi extraction is optional and only populates these same files from `book.txt`.

## Phase 2: Canonical Canvas

Owns image generation for Phase 1 characters and locations.

- Character sheet and location prompt nodes are image work items.
- Generated candidates attach back to their story asset node.
- The chosen/generated image becomes the canonical reference for that character or location.
- Canonical references are used by later page and panel prompts.

## Phase 3: Scenes

Owns editable scene files.

- Scenes live in `adaptation/scenes/artifacts/*.md`.
- Users can create and edit scene files directly.
- The scene workflow is optional and can populate scene files from an ingested book session.

## Phase 4: Moments

Owns story-kind layout planning.

- Scene artifacts are broken into page plans and/or panel prompts.
- `picture-book`, `illustrated-story`, and `comic-book` should produce different density and layout expectations.
- Output files live in `adaptation/pages/plans/*.md` and `adaptation/panels/prompts/*.md`.

## Phase 5: Moment Canvas

Owns image generation for Phase 4 visual moments.

- Page and panel prompt nodes become image work items.
- Generated images attach back to their page/panel nodes.
- Character and location canonical references should be used as semantic refs where relevant.

## Ownership Rule

Each phase owns its source files or canvas artifacts. Avoid compatibility shims for old local data; this project favors clear breaking changes during active development.
