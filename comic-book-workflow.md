# Comic Book Adaptation Workflow

This document describes a self-contained workflow for adapting a prose story or novel into a comic book using local language models for analysis and a modern image generation service with conversational image editing, such as Google's Nano Banana API.

The goal is to transform a complete written story into a structured set of reusable visual references and final panel prompts while preserving continuity across characters, locations, props, costumes, time periods, and visual style.

## Core Principles

The workflow should never require the full book to be loaded into a model context window at once. The book should be processed in ordered chunks, usually chapter by chapter. If a chapter is too long, it should be split into smaller contiguous sections with clear paragraph boundaries.

The process should be cumulative. Each pass extracts structured information from the current chunk, merges it into a growing project bible, and then uses that bible to guide later extraction, scene planning, and panel generation.

Reference images are first-class production assets. Any recurring character, location, costume, object, creature, vehicle, or visual state should receive its own prompt and generated reference image before final panel generation begins.

Variations should be modeled explicitly. A character, location, or prop may have a base version and multiple variants, each with its own prompt and reference image. Conversational editing can be used to create variants from a base image, but the resulting variant should still be tracked as its own reusable asset.

## Major Outputs

The workflow produces the following major artifacts:

- A chunk manifest describing how the book was split for model processing.
- A story bible containing characters, locations, props, factions, motifs, timeline notes, and continuity rules.
- A reference asset catalog listing every reusable visual element and its variants.
- Reference image generation prompts for each asset and variant.
- A scene manifest naming every scene in story order, with start and end paragraph references.
- A panel plan for each scene, describing the visual sequence of the comic.
- A master panel prompt list combining each panel prompt with required reference images.
- Optional conversational edit instructions for panels derived from earlier panels.

## Recommended Directory Structure

This workflow is independent from any application code, but a project using it may keep outputs in a structure like this:

```text
comic-adaptation/
  source/
    book.txt
    chunks/
  planning/
    chunk-manifest.md
    story-bible.md
    scene-manifest.md
  references/
    asset-catalog.md
    prompts/
    images/
  scenes/
    001-scene-title.md
    002-scene-title.md
  panels/
    master-panel-list.md
    prompts/
    images/
```

The exact format is flexible. What matters is that every artifact can be traced back to source paragraphs and every final panel can identify the reference images it depends on.

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

## Step 1: Prepare The Source Text

Begin by converting the book into a clean text form with stable paragraph numbering.

Each paragraph should have an identifier that remains stable throughout the workflow:

```text
ch01-p001
ch01-p002
ch01-p003
```

If chapters are too large for the local model, split them into smaller chunks:

```text
ch01-part01: ch01-p001 through ch01-p055
ch01-part02: ch01-p056 through ch01-p112
```

The chunk manifest should record:

- Chunk id.
- Source chapter.
- Starting paragraph id.
- Ending paragraph id.
- Approximate token count.
- Any notes about continuity dependencies.

The model should only receive the current chunk plus compact summaries and structured data from previous chunks.

## Step 2: Establish Style And Production Rules

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

## Step 3: Extract Story Elements Chunk By Chunk

For each chunk, ask the local model to extract structured story elements without generating panels yet.

The extraction should identify:

- Characters appearing in the chunk.
- Character descriptions, ages, body type, clothing, emotional baseline, and unusual visual traits.
- Character variants, such as child/adult, human/pony, injured/uninjured, disguised, winter clothing, formal clothing, or transformed states.
- Locations and setting variants.
- Props, objects, vehicles, weapons, tools, books, letters, jewelry, or magical items.
- Recurring visual motifs.
- Timeline and continuity facts.
- Important actions that may later become scenes or panels.

Each chunk pass should compare discoveries against the existing story bible:

- Add new assets when a visual element appears for the first time.
- Add variants when an existing element changes in a visually meaningful way.
- Add missing details to existing entries only when supported by the text.
- Record ambiguity instead of guessing when the text is unclear.

The output of each pass should be a patch or update to the story bible and asset catalog, not a full rewrite.

## Step 4: Build The Story Bible

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
  - ch02-p014 through ch02-p022
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
  - ch04-p061 through ch04-p078
related_assets:
  - school-house
status: needs-reference-prompt
```

## Step 5: Create The Reference Asset Catalog

The reference asset catalog is a production checklist for all reusable visual assets.

Each asset should track:

- Asset id.
- Asset type.
- Base entity.
- Variant relationship.
- Source paragraph references.
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
source: ch07-p034 through ch07-p049
prompt_status: drafted
image_status: not-generated
reference_image: none
notes: Must preserve James's eye color and nervous expression from human form.
```

## Step 6: Draft Reference Image Prompts

Once the asset catalog is stable enough, create prompts for each base asset.

Reference prompts should be descriptive, controlled, and reusable. They should avoid scene-specific action unless the asset is specifically a scene state.

For a character reference prompt, include:

- Character id.
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

## Step 7: Create Variant Images With Conversational Edits

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

## Step 8: Segment The Story Into Scenes

After the story bible and asset catalog have been built from all chunks, perform scene segmentation in story order.

A scene is a continuous narrative unit with a coherent location, time, dramatic beat, and character focus. Scene boundaries usually occur when:

- The location changes.
- Time jumps forward or backward.
- The point of view changes.
- A new dramatic objective begins.
- A major action sequence starts or ends.
- The emotional beat changes sharply.

Each scene should be named and anchored to source paragraphs:

```text
scene_id: 001-arrival-at-the-school-house
title: Arrival At The School House
start_paragraph: ch01-p001
end_paragraph: ch01-p038
summary: James arrives at the remote school house and notices signs that the staff are hiding something.
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

## Step 9: Plan Panels For Each Scene

For each scene, generate a panel plan that adapts the prose into a visual sequence.

The panel plan should not attempt to illustrate every sentence. It should select the clearest visual beats needed to preserve:

- Plot movement.
- Character emotion.
- Spatial clarity.
- Important reveals.
- Action continuity.
- Atmosphere.

Each panel should include:

- Panel id.
- Source paragraph range.
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
source: ch01-p018 through ch01-p024
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

## Step 10: Use Conversational Panel Edits When Appropriate

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

## Step 11: Create The Master Panel Prompt List

The master panel prompt list is the final production document for generating comic panels.

Each panel entry should combine:

- Panel id.
- Scene id.
- Source paragraph range.
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
source: ch01-p018 through ch01-p024
generation_mode: new-image
reference_images:
  - references/images/james-human.png
  - references/images/school-house.png
output_image: panels/images/001-003.png
prompt: Wide establishing comic panel in cinematic all-ages fantasy graphic novel style. James, a thin teenage boy with unruly brown hair, hazel eyes, worn gray school jacket, patched trousers, and scuffed brown boots, stands at the foot of a gravel path gripping a suitcase. He stares warily up at a two-story rural school house of pale stone and dark timber with tall windows, steep slate roof, and an old bell tower. Low camera angle, late afternoon sun, long shadows, wind-bent field grass, no text, no speech bubbles, no watermark.
status: ready-to-generate
```

## Step 12: Review And Regenerate

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
- Source paragraph intent is preserved.
- Spatial continuity works across neighboring panels.
- The panel does not include unwanted text, watermarks, or extra characters.
- The panel matches the established visual style.

Failed images should be regenerated with specific correction instructions rather than vague quality requests.

## Local Model Context Strategy

Because local models may have limited context windows, every prompt should be intentionally scoped.

For chunk extraction, provide:

- Current chunk text.
- Compact story bible summary.
- Existing asset ids and short descriptions.
- Instructions to return only additions, corrections, and open questions.

For scene segmentation, provide:

- Chapter or chunk summaries.
- Paragraph id ranges.
- Existing story bible summary.
- Instructions to produce ordered scene boundaries.

For panel planning, provide:

- One scene at a time.
- The scene's source paragraphs.
- Relevant story bible entries.
- Relevant asset catalog entries.
- Visual style block.

For final panel prompting, provide:

- One panel or a small batch of related panels.
- Required reference image list.
- Any previous panel dependency.
- The compact style block.

Avoid prompts that ask the model to reconsider the entire book unless they operate only on summaries and structured artifacts.

## Suggested Pass Order

Use the following order for a full adaptation:

1. Clean source text and assign paragraph ids.
2. Create chunk manifest.
3. Define visual style and production rules.
4. Process chunks in order to build the story bible.
5. Process chunks in order to build the reference asset catalog.
6. Normalize asset ids and variant relationships.
7. Draft base reference image prompts.
8. Generate base reference images.
9. Draft variant edit prompts.
10. Generate variant reference images.
11. Segment the full story into named scenes.
12. Plan panels scene by scene.
13. Create master panel prompt list.
14. Generate panels.
15. Review continuity and regenerate failed images.
16. Assemble pages and perform final comic layout.

## Prompt Templates

### Chunk Extraction Prompt

```text
You are adapting a novel into a comic book.

Process only the provided source chunk. Do not invent details that are not supported by the text.

Inputs:
- Visual style summary
- Existing compact story bible
- Existing asset id list
- Source chunk with paragraph ids

Return:
1. New or updated character entries.
2. New or updated location entries.
3. New or updated prop/object entries.
4. New visual variants.
5. Timeline or continuity notes.
6. Candidate scene beats with paragraph references.
7. Open questions or ambiguities.

Return updates only. Preserve stable ids where possible.
```

### Reference Prompt Drafting Prompt

```text
Create image generation prompts for the following reference assets.

Each prompt must:
- Preserve the asset id.
- Be visually specific.
- Avoid unsupported story details.
- Use the shared comic visual style.
- Avoid text, labels, speech bubbles, and watermarks.
- Be suitable for generating reusable reference images.

For variants, specify whether the image should be generated from scratch or as an edit from a base asset.
```

### Scene Segmentation Prompt

```text
Segment the provided chapter or chunk summaries into comic scenes.

Each scene must:
- Have a stable numbered id.
- Have a short descriptive title.
- Include start and end paragraph ids.
- Include a concise summary.
- List primary characters, locations, and props.
- Note continuity constraints.

Scenes must be ordered, non-overlapping, and cover the full provided range.
```

### Panel Planning Prompt

```text
Adapt the provided scene into comic panels.

Do not illustrate every sentence. Choose the visual beats needed for clear storytelling.

For each panel, provide:
- Panel id.
- Source paragraph range.
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

- Every paragraph belongs to exactly one scene.
- Every scene has a panel plan.
- Every recurring visual element has an asset id.
- Every required asset has a reference prompt.
- Every required asset has a generated reference image.
- Every panel has a prompt or edit instruction.
- Every panel lists its required reference images.
- Every panel can be traced back to source paragraphs.
- Continuity issues have been reviewed and either fixed or recorded.

At that point, the project has a complete production map from prose source to comic panel generation.
