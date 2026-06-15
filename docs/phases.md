# Adaptation Phases

This workflow turns story source material into reusable visual references, scene plans, and final panel/page images.

## Phase 0: Story & Style

Upload `book.txt`, create the project-local Pi read-book session, manage reusable visual styles, and build archetype prompts.

- The `ingest` stage creates the read-book session and runs `visual-style` to produce `style-refs/archetype-character.md` and `style-refs/archetype-scene.md`.
- Visual styles live in `style-refs/visual-styles.json` and are edited on this screen.
- Projects may skip ingestion and manually author story files in later phases.

## Phase 1: Characters

Owns both style archetypes, editable character files, and their canonical images. Toggle between **List** and **Canvas** views.

- Shows both the character archetype (`archetype-character`) and scene archetype (`archetype-scene`) references; each can be generated on the canvas or imported.
- The archetype nodes are auto-published to this canvas once the ingest archetype step has run, so you can go straight to generating them.
- Characters live in `adaptation/characters/sheets/*.md`. List view edits the files; canvas view shows the archetypes plus character-sheet nodes for generating and marking canonical images.
- Pi extraction (`characters` stage) is optional and only populates the character files from the book session.

## Phase 2: Locations

Owns editable location files and their canonical images. Toggle between **List** and **Canvas** views.

- Locations live in `adaptation/locations/prompts/*.md`.
- List view edits the location files and shows the chosen scene style reference (the `archetype-scene` asset).
- Canvas view shows the scene archetype plus location nodes; generate or import the archetype, then generate location images and mark the canonical version.
- Pi extraction (`locations` stage) is optional and only populates these same files from the book session.

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
