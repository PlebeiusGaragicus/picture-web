# Comic Book Adaptation Workflow

This document describes a self-contained workflow for adapting a prose story or novel into a comic book using local language models for analysis and a modern image generation service with conversational image editing, such as Google's Nano Banana API.

The goal is to transform a complete written story into a structured set of reusable visual references and final panel prompts while preserving continuity across characters, locations, props, costumes, time periods, and visual style.

## Core Principles

The preferred workflow loads the entire book into model context first using a reliable full-book reading skill, then extracts `style-refs/` (visual-style prose and archetype prompts) from the story. In practice, many locally hosted models can fit a full novel while still using only part of the available context window, which makes global extraction more reliable than chapter-by-chapter accumulation.

The process should use fresh context for each major reasoning pass. After the book is loaded, preserve that named Pi session as the clean book-load session. Generate the character list, scene list, play-by-play, reference prompt plan, and storyboard from fresh forks of that session rather than from one long drifting conversation.

The full book context should be used for global reasoning tasks: listing every character, identifying all major scenes in story order, recognizing transformations and time jumps, and building a complete adaptation outline. Smaller focused forks should then handle detailed prompt work for one character, one location, one prop, one scene, or one storyboard segment at a time.

Reference images are first-class production assets. Any recurring character, location, costume, object, creature, vehicle, or visual state should receive its own prompt and generated reference image before final panel generation begins.

Variations should be modeled explicitly. A character, location, or prop may have a base version and multiple variants, each with its own prompt and reference image. Conversational editing can be used to create variants from a base image, but the resulting variant should still be tracked as its own reusable asset.

## Major Outputs

The workflow produces the following major artifacts:

- A named, forkable Pi session created immediately after the book is loaded.
- A complete `character-list.txt` for the entire story.
- A complete scene manifest in story order.
- A play-by-play outline of the story's major acts and beats.
- A story bible containing characters, locations, props, factions, motifs, timeline notes, and continuity rules.
- A reference asset catalog listing every reusable visual element and its variants.
- Reference image generation prompts for each asset and variant.
- `style-refs/` — `visual-style.md`, archetype prompts, and locked anchor PNGs, derived from the loaded book.
- Locked style-anchor images (`archetype-character.png`, `archetype-scene.png`) used for rendering consistency.
- Character sheet prompts in `character-sheets/`, generated in separate focused forks per character artifact.
- Location, prop, costume, and item reference prompts generated from focused forks.
- A storyboard for each scene, panel by panel.
- A master panel prompt list combining each panel prompt with required reference images.
- Optional conversational edit instructions for panels derived from earlier panels.

## Recommended Directory Structure

This workflow is independent from any application code, but a project using it may keep outputs in a structure like this:

```text
comic-adaptation/
  book.txt
  style-refs/
    visual-style.md
    archetype-character.md
    archetype-character.png
    archetype-scene.md
    archetype-scene.png
  character-list.txt
  scene-manifest.md
  play-by-play.md
  characters/
  character-sheets/
  sessions/
    book-load-session.md
    fork-log.md
  planning/
    character-list.txt
    scene-manifest.md
    play-by-play.md
    story-bible.md
  references/
    asset-catalog.md
    prompts/
      characters/
      locations/
      props/
    images/
  scenes/
    001-scene-title.md
    002-scene-title.md
  panels/
    master-panel-list.md
    prompts/
    images/
```

The exact format is flexible. What matters is that every artifact can be traced back to immutable source line ranges with short supporting quotes, and every final panel can identify the reference images it depends on.

## Naming Conventions

Use stable, descriptive, lowercase identifiers for reusable assets. Prefer names that are readable and durable rather than short.

Examples:

- `james-human`
- `james-pony`
- `anna-adult`
- `anna-child`
- `school-house`
- `school-house-fire-damage`
- `market-square-summer`
- `market-square-winter`

Scenes should be numbered in story order:

- `001-arrival-at-the-school-house`
- `002-the-fire-in-the-east-wing`
- `003-anna-finds-the-locket`

Panels should include the scene number and panel number:

- `001-001`
- `001-002`
- `001-003`
- `002-001`

Do not reuse identifiers for meaningfully different visual states. If a visual difference matters for continuity or generation, give it its own asset id.

## Step 1: Load The Entire Book

Use the Pi coding agent from the command line. Pi supports `--name` / `-n` at startup, `-p` / `--print` for non-interactive runs, `--session` to resume a specific saved session, and `--fork` to fork a saved session into a new one.

Assume a project directory containing `./book.txt`. Run pi from that directory.

Create the clean book-load session, then capture its id while this is still the only session file for the project:

```bash
pi --name "read book" -p '/skill:read-book ./book.txt' < /dev/null
BOOK_LOAD_ID=$(
  jq -r 'select(.type=="session") | .id' \
    ~/.pi/agent/sessions/--$(pwd | sed 's|^/||' | tr '/:' '-')--/*.jsonl
)
```

`jq -r .id` alone prints every tree-entry id in the JSONL, not just the session uuid. `select(.type=="session")` keeps the header line only. Run this before any forks so the glob still matches one file.

To recover the book-load id later (oldest session file for this project):

```bash
BOOK_LOAD_ID=$(
  jq -r 'select(.type=="session") | .id' \
    "$(ls -t ~/.pi/agent/sessions/--$(pwd | sed 's|^/||' | tr '/:' '-')--/*.jsonl | tail -1)"
)
```

After the skill completes, stop adding unrelated discussion to that session. Treat it as the clean book-load session. Use `--session` to return to it, or `--fork` to create new focused sessions for each major artifact.

Example:

```bash
pi --fork "$BOOK_LOAD_ID" --name "character list" -p '/skill:character-list' > character-list.txt
pi --fork "$BOOK_LOAD_ID" --name "scene manifest" -p '/skill:scene-manifest' > scene-manifest.md
pi --fork "$BOOK_LOAD_ID" --name "play by play" -p '/skill:play-by-play' > play-by-play.md
```

The preferred operating model is:

- Load the full book once with `read-book`.
- Name that loaded session clearly.
- Fork from that loaded session for global artifacts and focused prompt generation.
- Redirect `-p` output to durable files whenever an artifact should be saved.
- Save each fork's output as a durable project artifact.

Only fall back to chapter or chunk processing when the book truly cannot fit in context or when the model becomes unreliable with the full text.

Source line references belong in generated artifacts. The `character-artifact` skill defines citation rules. To audit or resolve line numbers manually, use `rg -n -F "exact phrase" book.txt`.

## Step 2: Extract Visual Style And Style Anchor Prompts

Fork from the book-load session and run the `visual-style` skill. The book is already in context. The skill infers how this story should look as a comic and uses the **`write` tool** to save:

- `style-refs/visual-style.md` — terse labeled lines for human editing.
- `style-refs/archetype-character.md` — one image prompt for an original inhabitant of the story world (not a named cast member).
- `style-refs/archetype-scene.md` — one image prompt for a representative environment type.

```bash
mkdir -p style-refs
pi --fork "$BOOK_LOAD_ID" --name "visual style" -p '/skill:visual-style'
```

Optional steering notes:

```bash
pi --fork "$BOOK_LOAD_ID" --name "visual style" -p '/skill:visual-style brighter palette, less grime' < /dev/null
```

Do not redirect `pi -p` stdout to these files.

**Human gate before batch character-sheet work:**

1. Edit `style-refs/visual-style.md` if needed.
2. Generate `style-refs/archetype-character.png` from `archetype-character.md` in Nano Banana; iterate until the rendering, palette, line weight, and sheet layout are locked.
3. Generate `style-refs/archetype-scene.png` from `archetype-scene.md` the same way.

Later character and location prompts attach these anchor images instead of pasting style prose.

## Step 3: Create Fresh-Context Extraction Passes

After the named book-load session is created, run separate fresh-context passes by forking from that session. Each pass should ask for one global artifact and should save its output before starting the next pass.

Recommended first passes:

- Complete character list.
- Complete scene manifest in story order.
- Play-by-play outline of major acts and dramatic beats.
- Complete reusable visual asset inventory.

Do not ask one pass to do all of this at once. The model may have the whole book available, but each output is easier to validate when the task is narrow.

Use a simple fork log:

```text
fork_id: character-list-pass
started_from: comic book load session
task: List every character in the full story, one character per line.
output: planning/character-list.txt
status: complete
```

Each fork should return source-supported observations only. When the text is ambiguous, record the ambiguity rather than inventing design details.

## Step 4: Create The Character List

The character list should be generated from a fresh fork of the book-load session, not accumulated chapter by chapter.

This first pass should be strict and easy to parse. It should produce only one character per line, with a colon separating the character name from a short description.

Rules:

- No heading.
- No bullets.
- No numbering.
- No markdown.
- No dialogue.
- No commentary before or after the list.
- Exactly one character per line.
- Exactly one colon separator per line.
- Use the most canonical name first.
- Put aliases in parentheses after the canonical name when useful.
- Include major recurring unnamed characters only if they function like characters.
- Do not include locations, factions, props, companies, or concepts unless they are personified characters.
- One logical character per line. Merge alternate identities, disguises, age states, transformed or alternate forms, and other visual variants into the same line instead of splitting them.
- Do not split one person into separate lines such as `Dr Jekyll` and `Mr Hyde`, or `Anna` and `Anna as a child`.
- Do not emit cross-reference lines such as `See Character Name`.

Example:

```text
Henry Dorsett Case: The protagonist, a legendary console cowboy whose damaged nervous system keeps him from jacking into cyberspace until he is recruited for the Straylight run.
Molly Millions: A street samurai and razorgirl hired as Case's bodyguard, defined by mirrored lenses, retractable blades, professionalism, cynicism, and independence.
Dixie Flatline (McCoy Pauley): A ROM personality construct of a legendary cowboy who guides Case through the run and wants his own stored existence ended.
Dr Jekyll (Mr Hyde): A respectable Victorian doctor whose self-experiments release the violent alter ego Mr Hyde; both forms belong to one character with distinct visual states.
```

## Step 5: Generate Character Artifacts

Generate one plain markdown character artifact per line of `character-list.txt`. Each artifact should come from a fresh fork of the book-load session, not from the character-list session. The `character-artifact` skill defines structure and source reference rules.

```bash
mkdir -p characters
[ -n "$BOOK_LOAD_ID" ] || { echo "BOOK_LOAD_ID not set"; exit 1; }

total=$(grep -cvE '^[[:space:]]*$|See ' character-list.txt)
n=0

while IFS= read -r character_line; do
  [ -z "$character_line" ] && continue
  case "$character_line" in *": See "*) continue ;; esac

  slug="$(
    printf '%s\n' "$character_line" |
      cut -d: -f1 |
      tr '[:upper:]' '[:lower:]' |
      tr -cs 'a-z0-9' '-' |
      sed 's/^-//; s/-$//'
  )"
  out="characters/${slug}.md"
  n=$((n + 1))

  if [ -f "$out" ]; then
    echo "[$n/$total] → ${slug} (skip)"
    continue
  fi
  echo "[$n/$total] → ${slug}"

  quoted=$(printf '%s' "$character_line" | sed "s/'/'\"'\"'/g")
  pi --fork "$BOOK_LOAD_ID" \
    --name "character ${slug}" \
    -p "/skill:character-artifact '${quoted}'" \
    < /dev/null \
    > "$out"
done < character-list.txt
```

Works on macOS `/bin/bash` 3.2. `pi -p` reads stdin in print mode; `< /dev/null` on each call prevents it from consuming the rest of `character-list.txt`.

## Step 6: Generate Character Sheet Prompts

Requires locked `style-refs/archetype-character.png` from Step 2.

For each file in `characters/`, fork from the book-load session and run the `character-sheet` skill with the character artifact. The skill decides whether one reference sheet is enough or whether multiple variant sections are needed based on **visible** differences in **Visual Variants**.

The skill uses the **`write` tool** to save `character-sheets/<slug>.md` with short image prompts. Each `mode: new-image` section references `style-refs/archetype-character.png`; rendering style comes from that anchor image, not from prose in the prompt. Expressions are chosen from **Personality And Performance Notes**, not a generic happy/sad set.

Do not redirect `pi -p` stdout to those files.

```bash
mkdir -p character-sheets character-sheets/images
[ -n "$BOOK_LOAD_ID" ] || { echo "BOOK_LOAD_ID not set"; exit 1; }
[ -f style-refs/archetype-character.png ] || { echo "style-refs/archetype-character.png not found — complete Step 2 human gate first"; exit 1; }

total=$(ls characters/*.md 2>/dev/null | wc -l | tr -d ' ')
n=0

for artifact in characters/*.md; do
  [ -f "$artifact" ] || continue
  slug=$(basename "$artifact" .md)
  out="character-sheets/${slug}.md"
  n=$((n + 1))

  if [ -f "$out" ]; then
    echo "[$n/$total] → ${slug} (skip)"
    continue
  fi
  echo "[$n/$total] → ${slug}"

  pi --fork "$BOOK_LOAD_ID" \
    --name "character sheet ${slug}" \
    -p "/skill:character-sheet @${artifact}" \
    < /dev/null
done
```

At image generation time, attach `style-refs/archetype-character.png` for every `mode: new-image` prompt. Variant sheets with `mode: edit-reference` attach the character's approved base sheet image from `character-sheets/images/`.

## Step 7: Build The Story Bible

The story bible is the compact source of continuity truth for the adaptation.

It should include:

- Character profiles.
- Character relationships.
- Location descriptions.
- Prop descriptions.
- Timeline notes.
- Costume and appearance changes.
- Continuity constraints.
- Open questions.

Character entries should include:

```text
id: anna-child
base_entity: anna
type: character-variant
description: Young Anna as she appears in childhood flashbacks.
visual_traits:
  - short dark hair
  - oversized school uniform
  - cautious posture
  - large observant eyes
source_references:
  - source_lines: L410-L432
    supporting_quote: "Anna looked impossibly small in the school uniform, sleeves hanging past her wrists."
related_assets:
  - anna-adult
  - school-house
status: needs-reference-prompt
```

Location entries should include:

```text
id: school-house-fire-damage
base_entity: school-house
type: location-variant
description: The school house after the east wing fire.
visual_traits:
  - blackened beams
  - broken windows
  - smoke stains above the entrance
  - collapsed roof section on the east side
source_references:
  - source_lines: L1021-L1044
    supporting_quote: "The east wing was a skeleton of blackened beams and broken glass."
related_assets:
  - school-house
status: needs-reference-prompt
```

## Step 8: Create The Scene Manifest And Play-By-Play

Create the scene manifest from a fresh full-book fork. Models are often good at listing every scene in story order when they have the whole book in context, so use that ability directly.

A scene is a continuous narrative unit with a coherent location, time, dramatic beat, and character focus. Scene boundaries usually occur when:

- The location changes.
- Time jumps forward or backward.
- The point of view changes.
- A new dramatic objective begins.
- A major action sequence starts or ends.
- The emotional beat changes sharply.

Each scene should be named and anchored to immutable source line ranges:

```text
scene_id: 001-arrival-at-the-school-house
title: Arrival At The School House
source_lines: L1-L96
supporting_quote: "The school house rose above him at the end of the path."
summary: James arrives at the remote school house and notices signs that the staff are hiding something.
major_act: act-01-arrival-and-suspicion
primary_location: school-house
characters:
  - james-human
  - headmistress-vale
props:
  - brass-locket-closed
continuity_notes:
  - James has not yet seen the fire-damaged east wing.
```

The scene manifest should cover the entire story with no gaps and no overlaps.

The play-by-play is a higher-level outline of the story's major acts. It should group scenes into larger dramatic movements:

```text
act_id: act-01-arrival-and-suspicion
scene_range: 001 through 006
purpose: Introduce James, the school house, and the first signs of hidden danger.
turning_point: James discovers that the east wing has been sealed.
visual_priorities:
  - Establish the school house as imposing and secretive.
  - Make James appear small and uncertain.
  - Introduce the brass locket as a recurring object.
```

## Step 9: Create The Reference Asset Catalog

The reference asset catalog is a production checklist for all reusable visual assets.

Each asset should track:

- Asset id.
- Asset type.
- Base entity.
- Variant relationship.
- Source line references.
- Short supporting quotes.
- Visual description.
- Prompt status.
- Image status.
- Reference image path or URL.
- Notes about consistency.

Useful asset types include:

- `character`
- `character-variant`
- `location`
- `location-variant`
- `prop`
- `prop-variant`
- `creature`
- `vehicle`
- `costume`
- `symbol`
- `environment-condition`

Example:

```text
asset_id: james-pony
asset_type: character-variant
base_entity: james
variant_of: james-human
source_references:
  - source_lines: L1840-L1862
    supporting_quote: "The change had left him trembling on four unfamiliar legs."
prompt_status: drafted
image_status: not-generated
reference_image: none
notes: Must preserve James's eye color and nervous expression from human form.
```

## Step 10: Draft Location And Prop Reference Prompts

Requires locked `style-refs/archetype-scene.png` from Step 2.

Once the scene manifest, play-by-play, and asset catalog are stable enough, create prompts for each non-character asset. Character sheet prompts are produced in Step 6.

Reference prompts should be descriptive, controlled, and reusable. They should avoid scene-specific action unless the asset is specifically a scene state. Attach `style-refs/archetype-scene.png` at generation time for environmental rendering consistency — do not paste `style-refs/visual-style.md` or long style essays into the prompt.

For a location reference prompt, include:

- Location id.
- Architecture or geography.
- Important layout details.
- Materials.
- Lighting baseline.
- Mood and scale references.
- `Match the reference image's environmental rendering, palette, lighting, and detail level.`

Example:

```text
Exterior environment reference for school-house. A two-story rural school house built from pale stone and dark timber, with tall narrow windows, a steep slate roof, an old bell tower, and a gravel path leading to heavy wooden doors. The building sits at the edge of a wind-bent field with low hills in the background. Warm afternoon light, clear readable architecture. Match the reference image's environmental rendering, palette, lighting, and detail level. No characters, no text, no watermark.
```

## Step 11: Create Variant Images With Conversational Edits

When a variant is closely related to a base asset, generate the base image first and then create the variant through image editing.

Examples:

```text
Base asset: school-house
Variant asset: school-house-fire-damage
Edit instruction: Keep the same building, camera angle, proportions, materials, and surrounding landscape. Change the school house to show recent fire damage on the east wing: blackened beams, broken windows, smoke stains above the entrance, and a partially collapsed roof section. Preserve the graphic novel style. No text, no watermark.
```

```text
Base asset: anna-adult
Variant asset: anna-child
Edit instruction: Create a childhood version of the same person. Preserve the recognizable eye color, hair color, facial family resemblance, and reserved expression. Make her eight years old, shorter, with softer facial features and an oversized school uniform. Neutral character reference sheet, no text, no watermark.
```

Each generated variant should be saved as its own reference image and linked in the asset catalog.

## Step 12: Plan Panels For Each Scene

For each scene, generate a storyboard that adapts the prose into a panel-by-panel visual sequence. This should usually happen in a focused scene fork. Start from the book-load session or from a fresh context containing the scene text, then inject the approved scene manifest entry, relevant character entries, relevant asset catalog entries, and `style-refs/visual-style.md` for planning tone (attach style-anchor images at final image generation, not as pasted prose in panel prompts).

The panel plan should not attempt to illustrate every sentence. It should select the clearest visual beats needed to preserve:

- Plot movement.
- Character emotion.
- Spatial clarity.
- Important reveals.
- Action continuity.
- Atmosphere.

Each panel should include:

- Panel id.
- Page or spread suggestion, if useful.
- Source line range.
- Short supporting quote.
- Shot type.
- Camera angle.
- Characters visible.
- Required reference assets.
- Action.
- Expression and pose.
- Background.
- Lighting and mood.
- Dialogue or caption notes, if lettering will be handled later.
- Whether the image should be generated from scratch or as an edit of a previous panel.

Example:

```text
panel_id: 001-003
scene_id: 001-arrival-at-the-school-house
source_lines: L61-L74
supporting_quote: "The school house rose above him at the end of the path."
generation_mode: new-image
shot_type: wide establishing shot
camera: low angle from the gravel path
references:
  - james-human
  - school-house
action: James stands at the foot of the path, staring up at the school house.
expression_pose: James looks wary and small against the building, one hand gripping his suitcase.
background: The school house fills the upper half of the panel; wind bends the field grass.
lighting: Late afternoon sun with long shadows.
prompt_status: ready
```

## Step 13: Use Conversational Panel Edits When Appropriate

Some panels can be more consistent if created as edits from earlier panels rather than generated from scratch.

Use conversational edits when:

- The camera angle remains nearly identical.
- The same characters stay in the same environment.
- Only expression, pose, weather, lighting, object placement, or a small action changes.
- A sequence needs strong continuity across consecutive panels.

Example:

```text
panel_id: 001-004
scene_id: 001-arrival-at-the-school-house
generation_mode: edit-panel
edit_source_panel: 001-003
references:
  - james-human
  - school-house
edit_instruction: Keep the same camera angle, school house, lighting, and composition. Change James's expression from wary to startled. Move his right foot back slightly and make his stance wider, as if he has just heard a sudden noise from inside the building. No text, no watermark.
```

Use new image generation when the composition, location, or camera angle changes substantially.

## Step 14: Create The Master Panel Prompt List

The master panel prompt list is the final production document for generating comic panels.

Each panel entry should combine:

- Panel id.
- Scene id.
- Source line range.
- Short supporting quote.
- Final image prompt or edit instruction.
- Generation mode.
- Required reference images.
- Optional previous panel dependency.
- Output filename.
- Review status.

Example:

```text
panel_id: 001-003
scene_id: 001-arrival-at-the-school-house
source_lines: L61-L74
supporting_quote: "The school house rose above him at the end of the path."
generation_mode: new-image
reference_images:
  - references/images/james-human.png
  - references/images/school-house.png
output_image: panels/images/001-003.png
prompt: Wide establishing comic panel in cinematic all-ages fantasy graphic novel style. James, a thin teenage boy with unruly brown hair, hazel eyes, worn gray school jacket, patched trousers, and scuffed brown boots, stands at the foot of a gravel path gripping a suitcase. He stares warily up at a two-story rural school house of pale stone and dark timber with tall windows, steep slate roof, and an old bell tower. Low camera angle, late afternoon sun, long shadows, wind-bent field grass, no text, no speech bubbles, no watermark.
status: ready-to-generate
```

## Step 15: Review And Regenerate

After generating reference images and panels, review them for continuity before moving on.

Reference review should check:

- Character identity is recognizable across variants.
- Important traits match the story bible.
- Location layouts remain stable.
- Prop designs are readable and consistent.
- Variants preserve the correct relationship to base assets.

Panel review should check:

- Required characters and objects are present.
- Expressions and poses match the scene beat.
- Source line intent is preserved.
- Spatial continuity works across neighboring panels.
- The panel does not include unwanted text, watermarks, or extra characters.
- The panel matches the established visual style.

Failed images should be regenerated with specific correction instructions rather than vague quality requests.

## Full-Book Context Strategy

The key efficiency gain is to separate full-book reading from artifact generation. The expensive context load happens once. After that, each major output should start from the same clean named book-load session.

Use the book-load session for:

- Complete character list.
- Complete scene manifest.
- Play-by-play major act outline.
- Global asset inventory.
- Consistency checks across the entire story.

Use focused forks or fresh reduced contexts for:

- One character's reference sheet prompt and variations.
- One recurring location and its variants.
- One prop, costume, vehicle, or symbolic object.
- One scene storyboard.
- One page or short sequence of final panel prompts.

This avoids context drift. The character-list pass does not need the scene storyboard output in context. The scene storyboard pass should receive only the approved scene entry, relevant asset entries, and any needed source line ranges and quotes.

When a later pass depends on earlier artifacts, inject the saved artifact explicitly rather than relying on conversational memory. For example, the `james` character sheet fork should receive:

- A fork of the book-load session.
- The approved `james` character artifact or character-list line.
- Locked style-anchor images attached at image generation time (`archetype-character.png` for sheets, `archetype-scene.png` for locations).
- The reference prompt output schema.

If the book cannot fit reliably in context, use the older fallback approach: split by chapter or chunk, extract structured updates in story order, and merge them into the same artifact set.

## Suggested Pass Order

Use the following order for a full adaptation:

1. Preserve one immutable source text file for the book as `book.txt`.
2. Load the full book with the read-book skill and capture `BOOK_LOAD_ID`.
3. Preserve the named book-load session immediately after the book is loaded.
4. Fork visual-style to write `style-refs/`; edit `visual-style.md` and lock `archetype-character.png` and `archetype-scene.png` (Step 2).
5. From fresh forks of the book-load session, generate `character-list.txt`, the scene manifest, and play-by-play.
6. From a fresh fork of the book-load session, generate the reusable visual asset inventory when needed.
7. Generate one plain markdown character artifact per line of `character-list.txt` (Step 5).
8. Generate character sheet prompts in `character-sheets/` (Step 6).
9. Merge the approved character artifacts, scene list, play-by-play, and asset inventory into the story bible and asset catalog.
10. Fork once per major location, prop, costume, or object group to draft reference prompts and variation prompts.
11. Generate base reference images from character sheets and location/prop prompts.
12. Generate variant reference images with conversational edits where useful.
13. For each scene, create a focused storyboard with panel-by-panel beats and required references.
14. Create the master panel prompt list.
15. Generate panels.
16. Review continuity and regenerate failed images.
17. Assemble pages and perform final comic layout.

## Prompt Templates

### Character List Prompt

```text
You are adapting a novel into a comic book.

The full book is already loaded in context. Create a complete character list for the entire story.

Output only the character list. Do not include headings, bullets, numbering, markdown, dialogue, commentary, or extra text.

Format:
Character Name (optional alias): Short description.

Rules:
- Exactly one character per line.
- Exactly one colon separator per line.
- Use the most canonical name first.
- Include aliases in parentheses when useful.
- Include major recurring unnamed characters only if they function like characters.
- Do not include locations, factions, props, companies, or concepts unless they are personified characters.
- One logical character per line. Merge alternate identities, disguises, age states, transformed or alternate forms, and other visual variants into the same line instead of splitting them.
- Do not split one person into separate lines such as `Dr Jekyll` and `Mr Hyde`, or `Anna` and `Anna as a child`.
- Do not emit cross-reference lines such as `See Character Name`.
```

### Full Scene Manifest Prompt

```text
You are adapting a novel into a comic book.

The full book is already loaded in context. Create a numbered scene manifest for the entire story as it plays out.

Each scene must:
- Have a stable numbered id.
- Have a short descriptive title.
- Include start and end line numbers and a short supporting quote.
- Include a concise summary.
- List primary characters, locations, props, and visual assets.
- Identify the major act or story movement it belongs to.
- Note continuity constraints.

Scenes must be ordered, non-overlapping, and cover the full story.
```

### Play-By-Play Prompt

```text
You are adapting a novel into a comic book.

The full book is already loaded in context. Create a play-by-play outline of the major acts and dramatic beats.

Return:
1. Act ids and titles.
2. Scene ranges included in each act.
3. The purpose of each act.
4. Turning points.
5. Emotional arc.
6. Visual priorities for the comic adaptation.
7. Notes about pacing, reveals, and recurring imagery.
```

### Reference Prompt Drafting Prompt

```text
Create image generation prompts for the following reference assets.

Inputs:
- Style-anchor reference images (`archetype-character.png` or `archetype-scene.png`) attached at generation time.
- Approved character, location, or prop entry.
- Required variants for that asset.
- Source-supported visual facts.

Each prompt must:
- Preserve the asset id.
- Be visually specific.
- Avoid unsupported story details.
- Match the attached style-anchor image's rendering; do not paste `style-refs/visual-style.md` prose.
- Avoid text, labels, speech bubbles, and watermarks.
- Be suitable for generating reusable reference images.

For variants, specify whether the image should be generated from scratch or as an edit from a base asset.
```

### Character Sheet Prompt

Handled by the `character-sheet` skill. Fork from the book-load session with:

```text
/skill:character-sheet @characters/<slug>.md
```

The skill **writes** `character-sheets/<slug>.md` via the `write` tool with short prompts per visible variant. Attach `style-refs/archetype-character.png` when generating images. Do not capture `pi -p` stdout to that path.

### Character Artifact Prompt

```text
The full book is already loaded in context.

Using the character-list line below and source-supported details from the book, create a plain markdown character artifact for this character.

Character-list line:
[insert one line from character-list.txt]

Return:
1. Character name and aliases.
2. Role in the story.
3. Full prose description.
4. Visual facts.
5. Personality, posture, and expression cues.
6. Important relationships.
7. Required visual variants, such as age, disguise, injury, outfit, species, or transformation.
8. Source line references and short supporting quotes.
9. Notes about ambiguity that should be resolved before image generation.

Write plain markdown only. Do not use YAML frontmatter.
```

### Scene Storyboard Prompt

```text
Adapt the provided scene into comic panels.

Inputs:
- Scene manifest entry.
- Relevant source line ranges and short supporting quotes.
- Relevant character artifacts or character-list entries.
- Relevant reference asset catalog entries.
- `style-refs/visual-style.md` for adaptation tone.

Do not illustrate every sentence. Choose the visual beats needed for clear storytelling.

For each panel, provide:
- Panel id.
- Source line range.
- Short supporting quote.
- Shot type.
- Camera angle.
- Required reference assets.
- Characters visible.
- Action.
- Expression and pose.
- Background.
- Lighting and mood.
- Generation mode: new-image or edit-panel.
- Edit source panel, if applicable.
- Draft prompt or edit instruction.
```

## Completion Criteria

The workflow is complete when:

- Every source line that contains story content belongs to exactly one scene.
- Every scene has a panel plan.
- Every recurring visual element has an asset id.
- Every required asset has a reference prompt.
- Every required asset has a generated reference image.
- Every panel has a prompt or edit instruction.
- Every panel lists its required reference images.
- Every panel can be traced back to immutable source line ranges and short supporting quotes.
- Continuity issues have been reviewed and either fixed or recorded.

At that point, the project has a complete production map from prose source to comic panel generation.
