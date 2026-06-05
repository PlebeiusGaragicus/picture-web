# Comic Book Adaptation Workflow

This document describes a self-contained workflow for adapting a prose story or novel into a comic book using local language models for analysis and a modern image generation service with conversational image editing, such as Google's Nano Banana API.

The goal is to transform a complete written story into a structured set of reusable visual references and final panel prompts while preserving continuity across characters, locations, props, costumes, time periods, and visual style.

## Core Principles

The preferred workflow starts by loading the entire book into model context using a reliable full-book reading skill. In practice, many locally hosted models can fit a full novel while still using only part of the available context window, which makes global extraction more reliable than chapter-by-chapter accumulation.

The process should use fresh context for each major reasoning pass. After the book is loaded, preserve that named Pi session as the clean book-load session. Generate the character list, scene list, play-by-play, reference prompt plan, and storyboard from fresh forks of that session rather than from one long drifting conversation.

The full book context should be used for global reasoning tasks: listing every character, identifying all major scenes in story order, recognizing transformations and time jumps, and building a complete adaptation outline. Smaller focused forks should then handle detailed prompt work for one character, one location, one prop, one scene, or one storyboard segment at a time.

Reference images are first-class production assets. Any recurring character, location, costume, object, creature, vehicle, or visual state should receive its own prompt and generated reference image before final panel generation begins.

Variations should be modeled explicitly. A character, location, or prop may have a base version and multiple variants, each with its own prompt and reference image. Conversational editing can be used to create variants from a base image, but the resulting variant should still be tracked as its own reusable asset.

## Major Outputs

The workflow produces the following major artifacts:

- A named, forkable Pi session created immediately after the book is loaded.
- A complete character roster for the entire story.
- A complete scene manifest in story order.
- A play-by-play outline of the story's major acts and beats.
- A story bible containing characters, locations, props, factions, motifs, timeline notes, and continuity rules.
- A reference asset catalog listing every reusable visual element and its variants.
- Reference image generation prompts for each asset and variant.
- Character sheet prompts generated in separate focused forks for each character.
- Location, prop, costume, and item reference prompts generated from focused forks.
- A storyboard for each scene, panel by panel.
- A master panel prompt list combining each panel prompt with required reference images.
- Optional conversational edit instructions for panels derived from earlier panels.

## Recommended Directory Structure

This workflow is independent from any application code, but a project using it may keep outputs in a structure like this:

```text
comic-adaptation/
  source/
    book.txt
  sessions/
    book-load-session.md
    fork-log.md
  planning/
    character-roster.md
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

Use the Pi coding agent and start a named session for the book load. Pi supports `--name` / `-n` at startup, `/name` inside an interactive session, `--session` to resume a specific saved session, and `--fork` to fork a saved session into a new one.

Example:

```bash
pi --name "comic book load"
```

Then run the `read-book` skill on the single canonical book `.txt` file:

```text
/skill:read-book /path/to/book.txt
```

After the skill completes, stop adding unrelated discussion to that session. Treat it as the clean book-load session. Use `--session` to return to it, or `--fork` to create new focused sessions for each major artifact.

Example:

```bash
pi --fork <book-load-session-id> --name "character roster"
pi --fork <book-load-session-id> --name "scene manifest"
pi --fork <book-load-session-id> --name "play by play"
```

The preferred operating model is:

- Load the full book once with `read-book`.
- Name that loaded session clearly.
- Fork from that loaded session for global artifacts and focused prompt generation.
- Save each fork's output as a durable project artifact.

Only fall back to chapter or chunk processing when the book truly cannot fit in context or when the model becomes unreliable with the full text.

## Step 2: Use Immutable Source Line References

Even when the full book fits in context, every artifact still needs stable source anchors so characters, settings, props, scenes, and panels can be traced back to the prose.

Do not modify the source text to insert paragraph ids. The project assumes one canonical book `.txt` file, so artifacts do not need to repeat the source filename. Instead, cite line ranges from that single immutable file. Every generated artifact should include:

- `source_lines`, such as `L1245-L1268`.
- `supporting_quote`, a short exact quote from the cited line range.
- Optional `source_note`, explaining what the quote supports.

Example:

```text
source_lines: L1245-L1268
supporting_quote: "James stood before the ruined school house, unable to look away from the blackened east wing."
source_note: Supports the fire-damaged school house variant and James's reaction to it.
```

Use shell commands to verify or discover line references outside the model. For example:

```bash
rg -n -F "exact phrase from the book" "book.txt"
rg -n -C 3 -F "exact phrase from the book" "book.txt"
```

The model should not be trusted to count line numbers from memory. It can propose distinctive supporting quotes, then those quotes should be resolved to exact line ranges with `rg -n`. If a quote appears multiple times, use more surrounding text or context until the reference is unambiguous.

## Step 3: Establish Style And Production Rules

Before extracting story elements, define the comic's visual target. This should be short enough to reuse across all prompts.

Include:

- Comic format, such as western comic, manga, bande dessinee, webtoon, or graphic novel.
- Rendering style, such as painterly, cel-shaded, inked, ligne claire, cinematic, or watercolor.
- Aspect ratio and panel conventions.
- Color palette.
- Level of realism.
- Lighting tendencies.
- Rules for character consistency.
- Rules for avoiding unwanted text, logos, watermarks, or speech bubbles in generated images.

Example:

```text
Visual style: cinematic all-ages fantasy graphic novel, clean ink lines, expressive faces, richly painted backgrounds, warm natural lighting, consistent character proportions, no text, no speech bubbles, no captions, no watermarks.
```

This style block should be used in reference prompts and panel prompts unless a specific scene requires a controlled exception.

## Step 4: Create Fresh-Context Extraction Passes

After the named book-load session is created, run separate fresh-context passes by forking from that session. Each pass should ask for one global artifact and should save its output before starting the next pass.

Recommended first passes:

- Complete character roster.
- Complete scene manifest in story order.
- Play-by-play outline of major acts and dramatic beats.
- Complete reusable visual asset inventory.

Do not ask one pass to do all of this at once. The model may have the whole book available, but each output is easier to validate when the task is narrow.

Use a simple fork log:

```text
fork_id: character-roster-pass
started_from: comic book load session
task: List every character and character variant in the full story.
output: planning/character-roster.md
status: complete
```

Each fork should return source-supported observations only. When the text is ambiguous, record the ambiguity rather than inventing design details.

## Step 5: Create The Full Character Roster

The character roster should be generated from the full book context, not accumulated chapter by chapter.

The roster should identify:

- Every named character.
- Important unnamed characters.
- Groups or crowds that need recurring visual treatment.
- Each character's role in the story.
- Physical descriptions stated by the text.
- Personality and posture cues that affect visual design.
- Age ranges and time-period variants.
- Transformations, disguises, injuries, costumes, or species/form changes.
- First and major source appearances.
- Relationships to other characters.

Example:

```text
character_id: james
display_name: James
role: protagonist
variants:
  - james-human
  - james-pony
source_appearances:
  first:
    source_lines: L42-L47
    supporting_quote: "James kept his eyes on the floor as the carriage door opened."
  major:
    - source_lines: L42-L96
      supporting_quote: "The school house rose above him at the end of the path."
    - source_lines: L1840-L1862
      supporting_quote: "The change had left him trembling on four unfamiliar legs."
visual_facts:
  - thin teenage boy
  - unruly brown hair
  - hazel eyes
continuity_notes:
  - Pony form should preserve eye color and nervous expression.
status: ready-for-character-sheet-fork
```

After the roster is approved, fork from the book-load session once per character or per small group of minor characters. Inject the roster entry for that character into the prompt and ask the model to create that character's reference sheet prompt and all needed variation prompts.

## Step 6: Build The Story Bible

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

## Step 7: Create The Scene Manifest And Play-By-Play

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

## Step 8: Create The Reference Asset Catalog

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

## Step 9: Draft Reference Image Prompts

Once the character roster, scene manifest, play-by-play, and asset catalog are stable enough, create prompts for each base asset. Character prompts should usually be generated in focused forks: start from the book-load session, inject one character roster entry, and ask for that character's sheet prompt and all required variation prompts.

Reference prompts should be descriptive, controlled, and reusable. They should avoid scene-specific action unless the asset is specifically a scene state.

For a character reference prompt, include:

- Character id.
- Variant id, when applicable.
- Age and apparent age.
- Body type.
- Face shape.
- Hair.
- Eye color.
- Clothing.
- Posture.
- Personality cues visible in expression.
- Front, side, and three-quarter views if the image service supports character sheets.
- The shared visual style.

Example:

```text
Create a clean character reference sheet for james-human in a cinematic all-ages fantasy graphic novel style. Show front view, side view, and three-quarter view. James is a thin teenage boy with unruly brown hair, hazel eyes, a narrow face, and a guarded expression. He wears a worn gray school jacket, patched trousers, and scuffed brown boots. His posture is slightly tense, with shoulders drawn inward. Use consistent proportions, neutral studio lighting, plain background, no text, no labels, no watermark.
```

The character fork should also identify needed variations:

```text
character_id: james
base_reference_prompt: references/prompts/characters/james-human.md
variation_prompts:
  - asset_id: james-pony
    generation_mode: edit-reference
    base_asset: james-human
    instruction: Preserve James's hazel eyes, guarded expression, and nervous posture while transforming him into his pony form.
  - asset_id: james-human-injured
    generation_mode: edit-reference
    base_asset: james-human
    instruction: Keep the same character design and clothing, but add a bruised cheek, torn sleeve, and exhausted posture.
```

For a location reference prompt, include:

- Location id.
- Architecture or geography.
- Important layout details.
- Materials.
- Lighting baseline.
- Mood.
- Scale references.
- The shared visual style.

Example:

```text
Create an exterior environment reference for school-house in a cinematic all-ages fantasy graphic novel style. A two-story rural school house built from pale stone and dark timber, with tall narrow windows, a steep slate roof, an old bell tower, and a gravel path leading to heavy wooden doors. The building sits at the edge of a wind-bent field with low hills in the background. Warm afternoon light, clear readable architecture, no people, no text, no watermark.
```

## Step 10: Create Variant Images With Conversational Edits

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

## Step 11: Plan Panels For Each Scene

For each scene, generate a storyboard that adapts the prose into a panel-by-panel visual sequence. This should usually happen in a focused scene fork. Start from the book-load session or from a fresh context containing the scene text, then inject the approved scene manifest entry, relevant character entries, relevant asset catalog entries, and the visual style block.

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

## Step 12: Use Conversational Panel Edits When Appropriate

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

## Step 13: Create The Master Panel Prompt List

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

## Step 14: Review And Regenerate

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

- Complete character roster.
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

This avoids context drift. The character roster pass does not need the scene storyboard output in context. The scene storyboard pass should receive only the approved scene entry, relevant asset entries, and any needed source line ranges and quotes.

When a later pass depends on earlier artifacts, inject the saved artifact explicitly rather than relying on conversational memory. For example, the `james` character sheet fork should receive:

- A fork of the book-load session.
- The approved `james` roster entry.
- The shared visual style block.
- The reference prompt output schema.

If the book cannot fit reliably in context, use the older fallback approach: split by chapter or chunk, extract structured updates in story order, and merge them into the same artifact set.

## Suggested Pass Order

Use the following order for a full adaptation:

1. Preserve one immutable source text file for the book.
2. Load the full book with the read-book skill.
3. Preserve the named book-load session immediately after the book is loaded.
4. Define visual style and production rules.
5. From a fresh fork of the book-load session, generate the complete character roster.
6. From a fresh fork of the book-load session, generate the complete scene manifest.
7. From a fresh fork of the book-load session, generate the play-by-play act outline.
8. From a fresh fork of the book-load session, generate the reusable visual asset inventory.
9. Merge the approved roster, scene list, play-by-play, and asset inventory into the story bible and asset catalog.
10. Fork once per major character to draft character sheet prompts and variation prompts.
11. Fork once per major location, prop, costume, or object group to draft reference prompts and variation prompts.
12. Generate base reference images.
13. Generate variant reference images with conversational edits where useful.
14. For each scene, create a focused storyboard with panel-by-panel beats and required references.
15. Create the master panel prompt list.
16. Generate panels.
17. Review continuity and regenerate failed images.
18. Assemble pages and perform final comic layout.

## Prompt Templates

### Full Character Roster Prompt

```text
You are adapting a novel into a comic book.

The full book is already loaded in context. Create a complete character roster for the entire story.

Do not invent unsupported details. If the text is ambiguous, record the ambiguity.

Return:
1. Every named character.
2. Important unnamed characters or recurring groups.
3. Character ids.
4. Role in the story.
5. Source-supported visual facts.
6. Personality, posture, and expression cues useful for visual design.
7. Required visual variants, such as age, disguise, injury, outfit, species, or transformation.
8. First appearance and major appearances by source line range and short supporting quote.
9. Relationships and continuity notes.

Use stable lowercase ids. Return the roster in story-relevant order.
```

### Full Scene Manifest Prompt

```text
You are adapting a novel into a comic book.

The full book is already loaded in context. Create a numbered scene manifest for the entire story as it plays out.

Each scene must:
- Have a stable numbered id.
- Have a short descriptive title.
- Include source file, start and end line numbers, and a short supporting quote.
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
- Shared visual style block.
- Approved character, location, or prop entry.
- Required variants for that asset.
- Source-supported visual facts.

Each prompt must:
- Preserve the asset id.
- Be visually specific.
- Avoid unsupported story details.
- Use the shared comic visual style.
- Avoid text, labels, speech bubbles, and watermarks.
- Be suitable for generating reusable reference images.

For variants, specify whether the image should be generated from scratch or as an edit from a base asset.
```

### Character Sheet Fork Prompt

```text
The full book is already loaded in context.

Using only the approved character entry below and source-supported details from the book, create reusable reference image prompts for this character.

Character entry:
[insert one character roster entry]

Return:
1. Base character sheet prompt.
2. One prompt or edit instruction for each required variant.
3. Notes about which traits must remain consistent across variants.
4. Any ambiguity that should be resolved before image generation.
```

### Scene Storyboard Prompt

```text
Adapt the provided scene into comic panels.

Inputs:
- Scene manifest entry.
- Relevant source line ranges and short supporting quotes.
- Relevant character roster entries.
- Relevant reference asset catalog entries.
- Shared visual style block.

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
