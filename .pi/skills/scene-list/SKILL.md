---
name: scene-list
description: >-
  Generate a strict one-line-per-scene list from a full book already loaded in
  context and write it under a book workspace. Use before per-scene extraction.
disable-model-invocation: false
---

# Scene List

The full book is already loaded in context. Produce a complete ordered scene list for the entire story.

## Input

The user provides a book root path, usually `photo-library/projects/<project-slug>/adaptation`.

## Output Contract

Use the **`write` tool** to save the scene list exactly here:

```text
<book-root>/scenes/list.txt
```

Create `<book-root>/scenes/` if needed.

The written file contains only the scene list.

Do not include headings, bullets, numbering, markdown, blank lines, or commentary.

After writing, reply with exactly `Wrote <book-root>/scenes/list.txt.` and nothing else.

## Line Format

Each line must follow this exact format:

```text
001-scene-title: Short dramatic summary.
```

Rules:

- Exactly one scene per line.
- Slug is lowercase hyphenated text before the first colon.
- Use three-digit scene numbers when possible: `001`, `002`, `003`.
- Order lines by story sequence.
- Scenes must be non-overlapping dramatic units.
- Keep summaries concise but specific enough to identify the scene.
- You may append `Source Lines: L000-L000` inside the description after the summary when useful.
- Do not include acts, manifests, or location files.

## Scene Boundary Rules

Create a new scene when one or more of these changes:

- Location
- Time
- Point of view
- Dramatic objective
- Major action sequence
- Emotional beat
- Flashback or other timeline shift

Do not create a new scene for every paragraph.

## Forbidden In Assistant Reply

- Pasting the scene list after `write`
- Summaries, explanations, bullets, or code fences
