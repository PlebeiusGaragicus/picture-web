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

## Phase 2: Scenes

Owns the ordered scene list and per-scene planning artifacts.

- Scenes live in `adaptation/scenes/list.txt` (ordered registry) and `adaptation/scenes/artifacts/*.md`.
- Generate the scene list from the book session, reorder rows, then **Extract** one scene at a time.
- Each extract writes the scene artifact and upserts any new locations the scene needs into `locations/index.md` and `locations/prompts/`.

## Phase 3: Locations

Owns location files discovered from scene extraction (plus manual edits) and their canonical images. Toggle between **List** and **Canvas** views.

- Locations live in `adaptation/locations/prompts/*.md` with index metadata in `adaptation/locations/index.md`.
- There is no bulk location extraction step; locations accumulate as scenes are extracted.
- Canvas view shows the scene archetype plus location nodes for generating and marking canonical images.

## Phase 4: Moments

Owns moment planning, illustration, and story text in reading order.

**List mode**

- **Story Kind** (chosen in Phase 2) controls output shape:
  - `picture-book` and `illustrated-story` → `adaptation/pages/plans/<scene-slug>.md`
  - `comic-book` → `adaptation/panels/prompts/<scene-slug>.md`
- Plan moments **one scene at a time** with the per-row **Plan** button (Pi `story-layout` skill).
- Each moment section includes `narration:`, `dialogue:`, `caption:` lines plus an image prompt.
- Panel `refs:` keys must match locked entity tag ids from Visual Continuity (for example `character:rainbow-dash-base` → canvas tag `rainbow-dash-base`). Tag reference images on the canvas; **all** tagged images per ref are sent to generation.
- Archetype scene/character images are style references for character and location generation only — they are **not** panel/page inputs.
- Generation is blocked until every `character:` / `location:` ref has at least one tagged PNG, `refs:` is non-empty, and the total tagged image count is within the model limit (14 for default `gemini-3.1-flash-image`, 3 for `gemini-2.5-flash-image`).
- Use **View** to edit markdown per scene; **Validate** checks moment files.

**View mode**

- Shows an ordered **moment sequence** (scene list order × section order)—not book page layout.
- Per moment: generate image, edit narration/dialogue/caption, pick the active image, mark **Finalized**.
- **Image inputs** show each panel ref, the canvas tag to apply, thumbnails when ready, and block **Generate** until refs are tagged and within the model reference-image limit.
- Metadata stores `activeAssetId` and `finalized` per moment for future page-layout phases.

A future phase will compose finalized moments into proper book pages/spreads.

## Ownership Rule

Each phase owns its source files or canvas artifacts. Avoid compatibility shims for old local data; this project favors clear breaking changes during active development.
