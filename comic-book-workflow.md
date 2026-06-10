# Comic Book Extraction Workflow

This workflow is currently scoped to the first production milestone for adapting a book into comic-ready visual references:

1. Character sheet prompts.
2. Reusable scene-location/environment prompts.

Story bibles, panel storyboards, master panel prompt lists, page layout, and final comic assembly are future phases. Do not build compatibility layers or partial schemas for those later phases until this first milestone is working well.

## Operating Model

Run Pi from the repo root so project-local `.pi/skills/` are available. Keep all book inputs and generated outputs under an ignored `books/<book-id>/` workspace.

The runner loads the full book once, stores the resulting Pi session id, then creates fresh forks for each artifact. Skills write files directly with the write tool; `pi -p` stdout is used only for terse progress replies.

The runner owns deterministic output paths. Skills must write to the exact path passed by the runner and must not choose their own filenames.

```bash
mkdir -p books/my-story
cp /path/to/book.txt books/my-story/book.txt
scripts/comic-adaptation/run books/my-story
```

`books/` is ignored by git because it may contain source texts, generated prompts, images, and session metadata.

## Book Workspace Layout

```text
books/my-story/
  book.txt
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
    images/
      <variant-slug>.png
  scenes/
    manifest.md
  locations/
    index.md
    prompts/
      <location-slug>.md
    images/
      <location-slug>.png
```

Use stable lowercase hyphenated ids. If a visible state matters for image generation, give it its own id, such as `school-house-fire-damage` or `anna-child`.

## Step 1: Load The Book

The runner creates a clean book-load session when `books/<book-id>/sessions/book-load.env` does not exist.

Internally it runs:

```bash
pi --name "read book <book-id>" -p "/skill:read-book ./books/<book-id>/book.txt" < /dev/null
```

The captured `BOOK_LOAD_ID` is saved to:

```text
books/<book-id>/sessions/book-load.env
```

On later runs, the runner reuses that id and forks from it. Do not continue unrelated discussion in the book-load session; it is the clean source context.

## Step 2: Create Style References

The runner forks the book-load session and invokes:

```text
/skill:visual-style books/<book-id>
```

The skill writes:

```text
books/<book-id>/style-refs/visual-style.md
books/<book-id>/style-refs/archetype-character.md
books/<book-id>/style-refs/archetype-scene.md
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
/skill:character-list books/<book-id>
```

The skill writes:

```text
books/<book-id>/characters/list.txt
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
/skill:character-artifact books/<book-id>

Character Name: Short description.
```

Each skill call writes:

```text
books/<book-id>/characters/artifacts/<character-slug>.md
```

Artifacts contain visual description, personality/performance notes, relationships, visible variants, continuity notes, source line references, and supporting quotes.

## Step 5: Create Character Sheet Prompts

The runner invokes:

```text
/skill:character-sheet books/<book-id> @books/<book-id>/characters/artifacts/<character-slug>.md
```

Each skill call writes:

```text
books/<book-id>/characters/sheets/<character-slug>.md
```

Each sheet section is a short image-generation prompt. `mode: new-image` sections reference the planned image-generation input:

```text
books/<book-id>/style-refs/archetype-character.png
```

`mode: edit-reference` sections reference approved base images under:

```text
books/<book-id>/characters/images/
```

The prompts do not paste `visual-style.md`; that user-filled file can be appended later by image-generation tooling. Rendering comes from the approved reference image when images are generated.

## Step 6: Create Scene Manifest

The runner invokes:

```text
/skill:scene-manifest books/<book-id>
```

The skill writes:

```text
books/<book-id>/scenes/manifest.md
```

The scene manifest is used for location extraction in this milestone. It should still cover the full story in order, with no overlaps, and include source line ranges, supporting quotes, primary location, visible characters, and continuity notes.

## Step 7: Create Location Index

The runner invokes:

```text
/skill:location-index books/<book-id>
```

The skill reads `scenes/manifest.md` and writes:

```text
books/<book-id>/locations/index.md
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
/skill:location-prompt books/<book-id>

## location-slug
...
```

Each skill call writes:

```text
books/<book-id>/locations/prompts/<location-slug>.md
```

Base location prompts use the planned image-generation input:

```text
mode: new-image
style_ref: books/<book-id>/style-refs/archetype-scene.png
```

Variant prompts may use:

```text
mode: edit-reference
style_ref: books/<book-id>/locations/images/<base-location-slug>.png
```

Location prompts should be reusable environment prompts, not scene panels. They should be direct image-generation prose, not metadata; do not start them with phrases like `Environment reference for`.

High-quality location prompts should use every source-supported visual detail from the location entry, but should not invent named landmarks, architecture, objects, vegetation, weather, time of day, materials, lighting, or background elements that are not supported by the story. It is acceptable to add minimal connective spatial language when needed to turn source-supported traits into one coherent scene.

They should avoid characters, dialogue, captions, speech bubbles, storyboarding, and panel-specific action. They do not paste `visual-style.md`; that user-filled file can be appended later by image-generation tooling.

## Runner Behavior

The runner is resumable:

- Existing outputs are skipped.
- Missing `book-load.env` triggers a fresh book load.
- Progress is printed before each Pi skill invocation.

Run it again whenever you add or remove generated text artifacts.

The runner validates newly generated files before continuing. If a model writes to the wrong path, emits chat wrapper text, omits required sections, or produces malformed prompt files, the run fails so the missing or bad artifact can be regenerated.

You can validate an existing book workspace without invoking Pi:

```bash
scripts/comic-adaptation/validate books/<book-id>
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
- `scripts/comic-adaptation/validate books/<book-id>` passes.

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
