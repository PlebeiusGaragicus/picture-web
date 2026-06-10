---
name: visual-style
description: >-
  After the full book is loaded, extract comic visual style from the story and
  write style-refs/visual-style.md plus archetype character and scene image
  prompts. Human refines text and generates anchor images before batch work.
disable-model-invocation: false
---

# Visual Style And Style Anchors

The full book is already loaded in context. Infer how this story should **look** as a comic: mood, palette, rendering, lighting, world texture, and audience-appropriate tone.

Examples: a children's story may call for bright scenes and friendly forms; cyberpunk may call for dark neon, grime, hard shadows, and dense future tech.

The user may add notes in the message. Treat book-derived inference as the default; user notes override when they conflict.

## Delivery

Use the **`write` tool** to save exactly these three files:

1. `style-refs/visual-style.md` — terse labeled lines.
2. `style-refs/archetype-character.md` — one image prompt only.
3. `style-refs/archetype-scene.md` — one image prompt only.

Create `style-refs/` if needed.

Do **not** paste file bodies in the assistant reply. After writing, reply with at most one short line such as `Wrote style-refs/.` No summary or bullet list.

## style-refs/visual-style.md

Terse **labeled lines only**. No headings, bullets, code fences, or summary paragraph.

Target **5 lines**, each `Label: value`. Typical labels:

```text
Mood:
Style:
Color palette:
Realism:
Lighting:
```

Derive values from the book's tone, environments, violence level, humor, technology, and recurring imagery. Keep each value to one short phrase or clause.

The human will edit this file after drafting.

## Archetype Character Prompt

Write `style-refs/archetype-character.md` containing **only** the image prompt string (no metadata, no headings, no `mode:` line).

Invent **one original character** who could plausibly exist in this story's world — the kind of person or creature a reader might expect to meet there. Give them a short descriptive label, visible design details, and an implied personality you invent for them (e.g. "a Canterlot café pony, cheerful barista, mint coat, apron, warm smile").

Take **creative liberty** on this character — they are not from the book. Design someone vivid enough to lock rendering style; do not leave expression choices vague.

Rules:

- **Do not** use named protagonists, antagonists, or major cast from the book.
- **Do not** copy a specific character's unique marks, costumes, or plot-linked props.
- **Do** match species, era, tech level, and social context implied by the story.
- This image becomes the **style anchor** for all later character sheets. Lock rendering, palette, line weight, shadows, and sheet layout.

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

Write `style-refs/archetype-scene.md` containing **only** the image prompt string.

Describe **one representative environment type** from this world — a place tone that captures how backgrounds should look. No named characters. No specific plot moment or spoiler beat.

Lock environmental rendering: depth, lighting, color handling, detail level, and mood. Match `style-refs/visual-style.md`.

End with: `No characters, no text, no labels, no watermarks.`

## Forbidden In Written Files

- Commentary, rationale, or "production decision" notes in prompt files
- Pasting all of `style-refs/visual-style.md` into the archetype prompts
- Vague expression placeholders (`appropriate expressions`, `various moods`, `fitting temperament`)
- Code fences around prompt files

## Forbidden In Assistant Reply

- Pasting file contents after `write`
- "Done!", multi-paragraph explanations, or markdown fences in chat

# User Request

Extract visual style from the book and write all three files. Optional user notes:

**User:** `@$`
