---
name: location-prompt
description: >-
  Write one reusable scene-location image prompt from a location index entry.
  Prompts reference the planned book-scoped archetype scene image path for later
  image generation and avoid panel or storyboard language.
disable-model-invocation: false
---

# Location Prompt

The full book is already loaded in context. The user provides:

1. A book root path, usually `books/<book-id>`.
2. An exact output path under `<book-root>/locations/prompts/`.
3. One location entry from `<book-root>/locations/index.md`.

Create one reusable image-generation prompt for that location or location variant.

The style reference PNG paths in the written file are planned image-generation inputs. They do not need to exist when drafting this prompt file.

The user-filled `<book-root>/style-refs/visual-style.md` may be appended by later image-generation tooling. Do not paste it into this file.

## Input

The location entry should include:

- A `## location-slug` heading.
- Name.
- Type.
- Base Location, if any.
- Source references.
- Visual traits.
- Spatial composition, when available.
- Prompt-critical details, when available.
- Variant notes.

Use the slug from the heading inside the written file, but write to the exact output path provided by the user.

## Delivery

Use the **`write` tool** to save exactly:

```text
<output-path>
```

Create `<book-root>/locations/prompts/` if needed.

Do not derive, shorten, rename, canonicalize, or choose a different output filename. The runner owns the path.

After writing, reply with exactly `Wrote <output-path>.` and nothing else.

## Written File Format

Plain markdown only. No YAML frontmatter, JSON, tables, or code fences.

```markdown
## location-slug
mode: new-image
style_ref: <book-root>/style-refs/archetype-scene.png

[prompt]
```

For a variant that should be edited from an approved base location image, use:

```markdown
## location-slug-variant
mode: edit-reference
style_ref: <book-root>/locations/images/<base-location-slug>.png

[prompt]
```

## Prompt Rules

- Write the prompt as direct image-generation instructions, not metadata. Do not start with labels such as `Environment reference for`, `Location prompt for`, or the raw slug.
- Write one focused paragraph of 5-8 sentences for `mode: new-image`.
- For `mode: edit-reference`, write 3-6 sentences focused on the visible delta from the base image and what must remain consistent.
- Use every source-supported visual detail from the location entry when it helps the image.
- Translate the location name into natural prose only when useful, such as `the Canterlot throne room` or `a corporate conference room`.
- Describe architecture or terrain, foreground/midground/background relationships, materials, surfaces, fixed environmental objects, lighting, atmosphere, scale, and color only when supported by the entry.
- Add connective spatial language only when directly implied by the entry or necessary to compose the listed traits into one coherent scene.
- For sparse entries, stay honest: create a clean, usable prompt from the known facts without inventing decorations.
- For variants, state only the source-supported visual delta and what must remain consistent with the base image.
- Include this sentence once for `mode: new-image`: `Match the reference image's environmental rendering, palette, lighting, and detail level.`
- End every prompt with `No characters, no text, no labels, no watermarks.`
- Do not paste `<book-root>/style-refs/visual-style.md`; later image-generation tooling may append that file separately, and the style reference image carries the final rendering style.
- Do not include source line numbers or supporting quotes in the prompt file.
- Do not include storyboard beats, character action, dialogue, captions, speech bubbles, or plot spoilers unless the location state itself requires the detail.
- Do not invent named landmarks, architecture, objects, vegetation, weather, time of day, materials, lighting, or background elements not supported by the location entry.

## Mode Rules

Use `mode: new-image` for base locations and variants that need a substantially different design.

Use `mode: edit-reference` when the entry is a visible state change of a base location and the base image should be preserved: damage, weather, season, lighting state, transformation, or changed decoration.

## Forbidden In Assistant Reply

- Pasting the prompt after `write`
- Summaries, explanations, bullets, or code fences

# User Request

Read the provided location entry and write one reusable location prompt to the exact provided output path.

**User:** `@$`
