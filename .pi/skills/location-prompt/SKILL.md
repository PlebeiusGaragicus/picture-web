---
name: location-prompt
description: >-
  Write one reusable scene-location image prompt from a location index entry.
  Prompts reference the planned book-scoped archetype scene image path for later
  image generation and avoid panel or storyboard language.
disable-model-invocation: false
---

# Location Prompt

The full book is already loaded in context. The user provides a book root path, usually `books/<book-id>`, and one location entry from `<book-root>/locations/index.md`.

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
- Variant notes.

Use the slug from the heading as the output filename.

## Delivery

Use the **`write` tool** to save exactly:

```text
<book-root>/locations/prompts/<location-slug>.md
```

Create `<book-root>/locations/prompts/` if needed.

After writing, reply with exactly `Wrote <book-root>/locations/prompts/<location-slug>.md.` and nothing else.

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

- Keep the prompt short: 2-4 sentences.
- Start with `Environment reference for <location-slug>.`
- Describe durable architecture, geography, materials, layout, lighting baseline, scale, mood, and important visible details.
- For variants, state only the visual delta and what must remain consistent with the base image.
- Include this sentence once for `mode: new-image`: `Match the reference image's environmental rendering, palette, lighting, and detail level.`
- End every prompt with `No characters, no text, no labels, no watermarks.`
- Do not paste `<book-root>/style-refs/visual-style.md`; later image-generation tooling may append that file separately, and the style reference image carries the final rendering style.
- Do not include source line numbers or supporting quotes in the prompt file.
- Do not include panel composition, storyboard beats, character action, dialogue, captions, speech bubbles, or plot spoilers unless the location state itself requires the detail.

## Mode Rules

Use `mode: new-image` for base locations and variants that need a substantially different design.

Use `mode: edit-reference` when the entry is a visible state change of a base location and the base image should be preserved: damage, weather, season, lighting state, transformation, or changed decoration.

## Forbidden In Assistant Reply

- Pasting the prompt after `write`
- Summaries, explanations, bullets, or code fences

# User Request

Read the provided location entry and write one reusable location prompt under the provided book root.

**User:** `@$`
