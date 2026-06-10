---
name: visual-style
description: >-
  After the full book is loaded, write a blank visual style template plus
  book-scoped archetype character and scene image prompts. The human fills in
  the style template for later image generation.
disable-model-invocation: false
---

# Visual Style Template And Style Anchors

The full book is already loaded in context. Create a user-fillable visual style template and two archetype prompts that help the user generate and refine style anchor images.

Examples: a children's story may call for bright scenes and friendly forms; cyberpunk may call for dark neon, grime, hard shadows, and dense future tech.

## Input

The user provides a book root path, usually `books/<book-id>`, and may add optional steering notes for the archetype prompts.

## Delivery

Use the **`write` tool** to save exactly these three files under the provided book root:

1. `<book-root>/style-refs/visual-style.md` — blank template for the user to fill in.
2. `<book-root>/style-refs/archetype-character.md` — one image prompt only.
3. `<book-root>/style-refs/archetype-scene.md` — one image prompt only.

Create `<book-root>/style-refs/` if needed.

Do **not** paste file bodies in the assistant reply. After writing, reply with exactly `Wrote <book-root>/style-refs/.` and nothing else.

## `<book-root>/style-refs/visual-style.md`

Terse **labeled lines only**. No headings, bullets, code fences, or summary paragraph.

Write exactly this template, with blank values:

```text
Style:
Color palette:
Realism:
Lighting:
```

Do not fill in the values. This is the only user-edited input file. Later image-generation code can append these lines to generated prompt files.

## Archetype Character Prompt

Write `<book-root>/style-refs/archetype-character.md` containing **only** the image prompt string (no metadata, no headings, no `mode:` line).

Invent **one original character** who could plausibly exist in this story's world — the kind of person or creature a reader might expect to meet there. Give them a short descriptive label, visible design details, and an implied personality you invent for them (e.g. "a Canterlot cafe pony, cheerful barista, mint coat, apron, warm smile").

Take **creative liberty** on this character — they are not from the book. Design someone vivid enough to lock rendering style; do not leave expression choices vague.

Rules:

- **Do not** use named protagonists, antagonists, or major cast from the book.
- **Do not** copy a specific character's unique marks, costumes, or plot-linked props.
- **Do** match species, era, tech level, and social context implied by the story.
- The generated PNG from this prompt can become the **style anchor** for later character sheet image generation. Character sheet prompt files can still be drafted before the PNG exists.

Include this **layout block** verbatim in the prompt:

```text
Layout: top row — front full-body, three-quarter full-body, back full-body, same neutral standing pose, consistent scale. Bottom row — four head close-ups. White background. No text, no labels, no watermarks.
```

Then add **exactly four named expressions** you invent for this archetype:

`Expressions: [e1], [e2], [e3], [e4].`

Expression rules:

- Name each expression concretely (e.g. `mild curiosity`, `startled blink`, `dry amusement`, `quiet concern`) — not meta phrases like "appropriate to temperament" or "various emotions".
- Choose a set that fits the character **you** designed; avoid a generic happy/sad/surprise/anger quartet unless it genuinely fits.
- Use neutral-to-warm everyday range only — not plot-specific beats or spoilers from the book.

## Archetype Scene Prompt

Write `<book-root>/style-refs/archetype-scene.md` containing **only** the image prompt string.

Describe **one representative environment type** from this world — a place tone that captures how backgrounds should look. No named characters. No specific plot moment or spoiler beat.

The generated PNG from this prompt can become the style anchor for later location image generation. Location prompt files can still be drafted before the PNG exists.

End with: `No characters, no text, no labels, no watermarks.`

## Forbidden In Written Files

- Commentary, rationale, or "production decision" notes in prompt files
- Pasting all of `<book-root>/style-refs/visual-style.md` into the archetype prompts
- Vague expression placeholders (`appropriate expressions`, `various moods`, `fitting temperament`)
- Code fences around prompt files

## Forbidden In Assistant Reply

- Pasting file contents after `write`
- "Done!", multi-paragraph explanations, or markdown fences in chat

# User Request

Extract visual style from the book and write all three files under the provided book root. Optional user notes:

**User:** `@$`
