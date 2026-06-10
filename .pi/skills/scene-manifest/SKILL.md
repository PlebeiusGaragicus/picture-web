---
name: scene-manifest
description: >-
  Generate a complete numbered scene manifest from a full book already loaded in
  context and write it under a book workspace. Use for location extraction and
  later comic adaptation planning.
disable-model-invocation: false
---

# Scene Manifest

The full book is already loaded in context. Create a complete numbered scene manifest for the entire story as it plays out.

## Input

The user provides a book root path, usually `books/<book-id>`.

## Output Contract

Use the **`write` tool** to save exactly:

```text
<book-root>/scenes/manifest.md
```

Create `<book-root>/scenes/` if needed.

The written file must be plain markdown only.

Do not use YAML frontmatter, JSON, or tables.

Scenes must be:

- Ordered by story sequence.
- Non-overlapping.
- Complete across the story.
- Anchored to source line ranges and short supporting quotes.

After writing, reply with exactly `Wrote <book-root>/scenes/manifest.md.` and nothing else.

## Scene Boundary Rules

Create a new scene when one or more of these changes:

- Location
- Time
- Point of view
- Dramatic objective
- Major action sequence
- Emotional beat
- Flashback or other timeline shift

Do not create a new scene for every paragraph. A scene is a coherent dramatic unit.

## Required Scene Format

Use this format for every scene:

```markdown
## 001-scene-title

Title: Scene Title
Source Lines: L000-L000
Supporting Quote: "Short exact quote from the scene."
Summary: One or two sentences.
Major Act: act-01-title
Primary Location: location-id-or-description
Characters: character-a, character-b
Props And Visual Assets: prop-a, location-variant-b
Continuity Notes: Brief notes, or `None`.
```

## Source Reference Rules

- Use source line ranges from the single immutable book text.
- Include a short exact supporting quote for each scene.
- If you know the quote but not the exact line number, use `LINE-VERIFY` instead of inventing a line number.
- Do not fabricate line numbers.
- Do not include long excerpts.

## Numbering Rules

- Use three-digit scene numbers: `001`, `002`, `003`.
- Use lowercase hyphenated scene ids in headings.
- Keep titles short and descriptive.

## Forbidden In Assistant Reply

- Pasting the scene manifest after `write`
- Summaries, explanations, bullets, or code fences
