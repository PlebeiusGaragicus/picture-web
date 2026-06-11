# Comic Book Extraction Workflow

This workflow is currently scoped to the first production milestone for adapting a book into comic-ready visual references:

1. Character sheet prompts.
2. Reusable scene-location/environment prompts.

Story bibles, panel storyboards, master panel prompt lists, page layout, and final comic assembly are future phases. Do not build compatibility layers or partial schemas for those later phases until this first milestone is working well.

## Operating Model

Run Pi from the repo root so project-local `.pi/skills/` are available. Keep book inputs and generated text artifacts inside the adaptation workspace of a normal `photo-web` project:

```text
photo-library/projects/<project-slug>/adaptation/
```

Every `photo-web` project can open the Story Adaptation screen. New projects do not need a special project type.

The runner loads the full book once, stores the resulting Pi session id, then creates fresh forks for each artifact. Skills write files directly with the write tool; `pi -p` stdout is used only for terse progress replies.

The runner owns deterministic output paths. Skills must write to the exact path passed by the runner and must not choose their own filenames.

```bash
mkdir -p photo-library/projects/my-story/adaptation
cp /path/to/book.txt photo-library/projects/my-story/adaptation/book.txt
scripts/comic-adaptation/run my-story
```

`books/` is deprecated staging storage. The scripts still accept `books/<book-id>` for old workspaces, but new work should use project-backed adaptation directories.

## Project Adaptation Layout

```text
photo-library/projects/my-story/
  project.json
  canvas.json
  assets/
  adaptation/
  book.txt
  adaptation.json
  sessions/
    book-load.env
  style-refs/
    visual-style.md
    archetype-character.md
    archetype-character.png
    archetype-scene.md
    archetype-scene.png
  characters/
    list.txt
    artifacts/
      <character-slug>.md
    sheets/
      <character-slug>.md
  scenes/
    manifest.md
  locations/
    index.md
    prompts/
      <location-slug>.md
```

Generated images are normal project assets under `assets/`. `adaptation/adaptation.json` links prompt ids to generated asset ids. Use stable lowercase hyphenated ids. If a visible state matters for image generation, give it its own id, such as `school-house-fire-damage` or `anna-child`.

## Step 1: Load The Book

The runner creates a clean book-load session when `photo-library/projects/<project-slug>/adaptation/sessions/book-load.env` does not exist.

Internally it runs:

```bash
pi --name "read book <project-slug>" -p "/skill:read-book ./photo-library/projects/<project-slug>/adaptation/book.txt" < /dev/null
```

The captured `BOOK_LOAD_ID` is saved to:

```text
photo-library/projects/<project-slug>/adaptation/sessions/book-load.env
```

On later runs, the runner reuses that id and forks from it. Do not continue unrelated discussion in the book-load session; it is the clean source context.

## Step 2: Create Style References

The runner forks the book-load session and invokes:

```text
/skill:visual-style photo-library/projects/<project-slug>/adaptation
```

The skill writes:

```text
photo-library/projects/<project-slug>/adaptation/style-refs/visual-style.md
photo-library/projects/<project-slug>/adaptation/style-refs/archetype-character.md
photo-library/projects/<project-slug>/adaptation/style-refs/archetype-scene.md
```

`visual-style.md` is the only user-edited input file. It is written as a blank template:

```text
Style:
Color palette:
Realism:
Lighting:
```

Fill it in before image generation. Later image-generation tooling can append this file to each prompt file.

The archetype prompt files are for creating optional reference PNGs:

- Generate `archetype-character.png` from `archetype-character.md` when you are ready to refine the character sheet rendering style.
- Generate `archetype-scene.png` from `archetype-scene.md` when you are ready to refine the location/environment rendering style.

Character sheet and location prompt files can be drafted before these PNGs exist.

## Step 3: Create Character List

The runner invokes:

```text
/skill:character-list photo-library/projects/<project-slug>/adaptation
```

The skill writes:

```text
photo-library/projects/<project-slug>/adaptation/characters/list.txt
```

The file is strict and parseable:

```text
Character Name (optional alias): Short description.
```

Rules:

- Exactly one character per line.
- Exactly one colon separator per line.
- Merge alternate identities, age states, transformations, and visual variants into one logical character line.
- Do not include locations, factions, props, companies, objects, technologies, or concepts unless personified as characters.
- Do not emit cross-reference lines such as `See Character Name`.

## Step 4: Create Character Artifacts

For each line in `characters/list.txt`, the runner forks from the book-load session and invokes:

```text
/skill:character-artifact photo-library/projects/<project-slug>/adaptation

Character Name: Short description.
```

Each skill call writes:

```text
photo-library/projects/<project-slug>/adaptation/characters/artifacts/<character-slug>.md
```

Artifacts contain visual description, personality/performance notes, relationships, durable visual variants, continuity notes, source line references, and supporting quotes.

Character variants are only for major lasting visual changes that need separate reference sheets: age jumps, species or body transformations, lost limbs, prosthetics or cyborg implants, ghost or magical forms, disguises, armor, uniforms, major outfit states, lasting injuries, or other durable changes to silhouette, anatomy, scale, materials, or markings.

Do not create character variants for temporary performance states such as blushing, crying, smiling, anger, fear, poses, gestures, eye direction, posture, nuzzling, levitating an object, dirt, sweat, tears, lighting, mood, or scene-specific emotion. Those belong in `Personality And Performance Notes` and expression choices.

## Step 5: Create Character Sheet Prompts

The runner invokes:

```text
/skill:character-sheet photo-library/projects/<project-slug>/adaptation @photo-library/projects/<project-slug>/adaptation/characters/artifacts/<character-slug>.md
```

Each skill call writes:

```text
photo-library/projects/<project-slug>/adaptation/characters/sheets/<character-slug>.md
```

Each sheet section is a short image-generation prompt. `mode: new-image` sections reference the planned image-generation input:

```text
photo-library/projects/<project-slug>/adaptation/style-refs/archetype-character.png
```

`mode: edit-reference` sections reference approved base images beside the sheet prompt files:

```text
photo-library/projects/<project-slug>/adaptation/characters/sheets/<base-variant-slug>.png
```

The prompts do not paste `visual-style.md`; that user-filled file can be appended later by image-generation tooling. Rendering comes from the approved reference image when images are generated.

The character sheet skill should ignore expression-only or momentary variants even if an older artifact lists them.

## Step 6: Create Scene Manifest

The runner invokes:

```text
/skill:scene-manifest photo-library/projects/<project-slug>/adaptation
```

The skill writes:

```text
photo-library/projects/<project-slug>/adaptation/scenes/manifest.md
```

The scene manifest is used for location extraction in this milestone. It should still cover the full story in order, with no overlaps, and include source line ranges, supporting quotes, primary location, visible characters, and continuity notes.

## Step 7: Create Location Index

The runner invokes:

```text
/skill:location-index photo-library/projects/<project-slug>/adaptation
```

The skill reads `scenes/manifest.md` and writes:

```text
photo-library/projects/<project-slug>/adaptation/locations/index.md
```

The index lists reusable visual environments only. It excludes characters, props by themselves, pure emotional beats, one-off camera angles, and panel action.

Each location or environment variant should include:

- Stable location id.
- Human-readable name.
- Type: `location` or `location-variant`.
- Base location, if any.
- Scenes where it appears.
- Source references and short supporting quotes.
- Durable visual traits: architecture, geography, terrain, room layout, materials, surfaces, vegetation, fixed environmental objects, visible technology, lighting, color, atmosphere, and scale when source-supported.
- Spatial composition: foreground, midground, background, layout, or relationships between major environmental elements when the source implies them.
- Prompt-critical details that must appear in an image prompt.
- Variant notes.
- Prompt status.

## Step 8: Create Location Prompts

The runner splits `locations/index.md` into entries and invokes:

```text
/skill:location-prompt photo-library/projects/<project-slug>/adaptation

## location-slug
...
```

Each skill call writes:

```text
photo-library/projects/<project-slug>/adaptation/locations/prompts/<location-slug>.md
```

Base location prompts use the planned image-generation input:

```text
mode: new-image
style_ref: photo-library/projects/<project-slug>/adaptation/style-refs/archetype-scene.png
```

Variant prompts may use:

```text
mode: edit-reference
style_ref: photo-library/projects/<project-slug>/adaptation/locations/prompts/<base-location-slug>.png
```

Location prompts should be reusable environment prompts, not scene panels. They should be direct image-generation prose, not metadata; do not start them with phrases like `Environment reference for`.

High-quality location prompts should use every source-supported visual detail from the location entry, but should not invent named landmarks, architecture, objects, vegetation, weather, time of day, materials, lighting, or background elements that are not supported by the story. It is acceptable to add minimal connective spatial language when needed to turn source-supported traits into one coherent scene.

They should avoid characters, dialogue, captions, speech bubbles, storyboarding, and panel-specific action. They do not paste `visual-style.md`; that user-filled file can be appended later by image-generation tooling.

## Step 9: Generate One Character Sheet Image

Start image generation small. The first image-generation helper calls the existing photo-web API and generates exactly one missing base character sheet PNG, then exits:

```bash
scripts/comic-adaptation/generate-character-sheet <project-slug>
```

The API server must already be running, usually with:

```bash
./run
```

The script:

- Uses `photo-library/projects/<project-slug>/adaptation/style-refs/archetype-character.png` as the reference image.
- Appends the user-filled `style-refs/visual-style.md` to the sheet prompt.
- Calls `POST /api/projects/{slug}/generate`.
- Skips existing PNGs.
- Generates only `mode: new-image` base sheets.
- Writes the generated PNG beside the source prompt file, for example `characters/sheets/butterscotch-base.png`.
- Stops after one generated image.

## Runner Behavior

The runner is resumable:

- Existing outputs are skipped.
- Missing `book-load.env` triggers a fresh book load.
- Progress is printed before each Pi skill invocation.

Run it again whenever you add or remove generated text artifacts.

The runner validates newly generated files before continuing. If a model writes to the wrong path, emits chat wrapper text, omits required sections, or produces malformed prompt files, the run fails so the missing or bad artifact can be regenerated.

You can validate an existing book workspace without invoking Pi:

```bash
scripts/comic-adaptation/validate <project-slug>
```

## First Milestone Completion Criteria

This milestone is complete when:

- `style-refs/visual-style.md` is filled in.
- Every character line has a character artifact.
- Every character artifact has a character sheet prompt file.
- Every recurring scene location has a location index entry.
- Every location index entry has a location prompt file.
- Character and location prompt files reference the correct book-scoped style images.
- Continuity problems are either fixed in the artifacts or recorded clearly.
- `scripts/comic-adaptation/validate <project-slug>` passes.

Before generating images, also create and approve:

- `style-refs/archetype-character.png` for character sheet image generation.
- `style-refs/archetype-scene.png` for location image generation.

## Future Phases

After character sheets and location prompts are satisfactory, add later phases deliberately:

- Story bible.
- Reference asset catalog for props, costumes, vehicles, symbols, and creatures.
- Scene storyboard and panel plans.
- Master panel prompt list.
- Conversational image edit chains.
- Continuity review and regeneration loops.
- Final comic page layout.
