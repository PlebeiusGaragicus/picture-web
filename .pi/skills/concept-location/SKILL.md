---
name: concept-location
description: >-
  Invent one new location concept from the book and write a concept-art
  prompt file with a reusable environment image prompt.
disable-model-invocation: false
---

# Concept Location

The full book is already loaded in context. The user provides:

1. A book root path, usually `books/<book-id>`.
2. An exact output path under `<book-root>/concept-art/<file-key>.md`.
3. Runner context with the **File key** (must match the `##` heading and filename stem), plus existing concept slugs and locations already covered.

Invent **one** new location concept that fits the book's world — a minor setting, recurring backdrop, or extrapolated place consistent with the story. Do **not** duplicate any location in the existing location index/prompts or existing concept-art slugs.

The runner owns the output filename. Use the provided **File key** exactly as the `##` heading slug.

## Delivery

Use the **`write` tool** to save exactly the provided output path.

Create `<book-root>/concept-art/` if needed.

After writing, reply with exactly `Wrote <output-path>.` and nothing else.

## Written File Format

Plain markdown only. No YAML frontmatter, JSON, tables, or code fences.

```markdown
## file-key
subject: location
mode: new-image
style_ref:

[5-8 sentences of direct image-generation instructions]
```

## Prompt Rules

- Write the prompt as direct image-generation instructions, not metadata. Do not start with labels such as `Environment reference for`, `Location prompt for`, or the raw slug.
- Write one focused paragraph of 5-8 sentences for `mode: new-image`.
- Use book-supported visual details when available; stay honest when the book is sparse.
- Describe architecture or terrain, spatial relationships, materials, fixed objects, lighting, atmosphere, scale, and color when supported.
- Include this sentence once: `Match the reference image's environmental rendering, palette, lighting, and detail level.`
- End every prompt with `No characters, no text, no labels, no watermarks.`
- Keep `style_ref:` empty. Visual style is applied later during image generation.
- Do not paste source line numbers, quotes, or metadata labels into the prompt body.
- Do not include storyboard beats, character action, dialogue, captions, or speech bubbles unless the location state itself requires the detail.

## Forbidden In Assistant Reply

- Pasting the file after `write`
- Summaries, explanations, bullets, or code fences

# User Request

Read the runner context and write one new concept-art location file to the exact provided output path.

**User:** `@$`
