---
name: concept-character
description: >-
  Invent one new character concept from the book and write a concept-art
  prompt file with a filled character reference sheet prompt.
disable-model-invocation: false
---

# Concept Character

The full book is already loaded in context. The user provides:

1. A book root path, usually `books/<book-id>`.
2. An exact output path under `<book-root>/.concept-scratch/<file-key>.md`.
3. Runner context with the **File key** (must match the `##` heading and filename stem), plus existing concept slugs and characters already covered.

Invent **one** new character concept that fits the book's world — a minor figure, background role, or extrapolated inhabitant consistent with the story. Do **not** duplicate anyone in the existing character list or existing concept-art slugs.

The runner owns the output filename. Use the provided **File key** exactly as the `##` heading slug.

## Delivery

Use the **`write` tool** to save exactly the provided output path.

Create `<book-root>/.concept-scratch/` if needed.

After writing, reply with exactly `Wrote <output-path>.` and nothing else.

## Written File Format

Plain markdown only. No YAML frontmatter, JSON, tables, or code fences.

```markdown
## file-key
subject: character
mode: new-image
style_ref:

Character reference sheet
[essential visual traits — species, age, build, colors, clothing, distinctive features]
Layout: top row — front full-body, three-quarter full-body, back full-body, same neutral standing pose, consistent scale. Bottom row — head close-ups for each expression. White background. No text, no labels, no watermarks.
Expressions: [e1], [e2], [e3], [e4].
```

## Prompt Rules

- Replace every bracket placeholder with concrete, book-consistent details.
- Start the prompt body with the line `Character reference sheet` on its own line, then the visual description paragraph.
- Include the layout block **verbatim** (same wording as above).
- Choose exactly four expressions that fit this character's temperament and story role.
- Keep `style_ref:` empty. Visual style is applied later during image generation.
- Do not paste source line numbers, quotes, or metadata labels into the prompt body.
- Do not invent major plot spoilers unless needed for a visible design choice.

## Forbidden In Assistant Reply

- Pasting the file after `write`
- Summaries, explanations, bullets, or code fences

# User Request

Read the runner context and write one new concept-art character file to the exact provided output path.

**User:** `@$`
