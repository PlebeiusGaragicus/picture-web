---
name: character-artifact
description: >-
  Create a plain markdown character artifact from one character-list line using
  a full book already loaded in context. Write the artifact under a book
  workspace with visual details, variants, source line references, and quotes.
disable-model-invocation: false
---

# Character Artifact

The full book is already loaded in context. The user provides:

1. A book root path, usually `books/<book-id>`.
2. An exact output path under `<book-root>/characters/artifacts/`.
3. Exactly one line from `<book-root>/characters/list.txt`.

Create a plain markdown character artifact for that character.

## Input

The input line should look like:

```text
Character Name (optional alias): Short description.
```

Use the input line to identify the character, then use the full book context to gather source-supported details.

Write the artifact with the **`write` tool** to the exact output path provided by the user:

```text
<output-path>
```

Create `<book-root>/characters/artifacts/` if needed.

Do not derive, shorten, rename, canonicalize, or choose a different output filename. The runner owns the path.

## Output Contract

The written artifact must be plain markdown only.

Do not use:

- YAML frontmatter
- JSON
- Tables
- Code fences
- Commentary outside the artifact

After writing, reply with exactly `Wrote <output-path>.` and nothing else.

## Required Structure

Use this structure:

```markdown
# Character Name

## Summary

[Concise prose summary of who the character is and why they matter.]

## Visual Description

[Source-supported physical appearance, clothing, posture, body language, repeated visual traits, and design-relevant details.]

## Personality And Performance Notes

[Temperament, emotional baseline, speech or behavioral style when useful for visual acting, posture, expressions, and recurring mannerisms.]

## Relationships

[Important relationships to other characters, groups, or entities.]

## Visual Variants

- `character-slug`: [Baseline design.]
- `character-slug-variant`: [Variant description and when it appears.]

## Continuity Notes

[Traits that must remain consistent across panels, scenes, and variants.]

## Source References

- `L000-L000`: "[Short exact quote from the book.]" [Brief note about what this quote supports.]
```

## Source Reference Rules

- Every important visual claim should be supported by at least one source reference when possible.
- Use line ranges from the single immutable book text.
- Include short exact quotes.
- If you know the quote but not the exact line number, include `LINE-VERIFY` instead of inventing a line number.
- Do not fabricate line numbers.
- Do not invent visual details that are not supported by the book. If a needed design detail is unspecified, record it under `Continuity Notes` as an open design choice.

## Visual Variant Rules

Create variants only for durable, major visual state changes that require a separate reference sheet.

Good reasons to create a variant:

- A different age band or large time jump.
- A major species or body transformation.
- Loss of a limb, prosthetic, cyborg implant, visible scar, or lasting injury.
- Ghost, undead, magical, simulated, or other visibly altered form.
- Disguise, uniform, armor, or major costume state that changes the silhouette or identity.
- A major outfit, occupation, or era change that needs its own reference.
- A form that differs in body shape, anatomy, scale, material, or permanent markings.

Do **not** create variants for temporary performance states:

- Blushing, crying, smiling, frowning, anger, fear, surprise, embarrassment, affection, or other expressions.
- Poses, gestures, eye direction, posture changes, nuzzling, levitating an object, or momentary action.
- Dirt, sweat, tears, minor lighting, mood, or scene-specific emotional state.
- Narrative-only differences such as conscious vs simulated unless the body visibly changes.

Temporary performance states belong in `Personality And Performance Notes`, not `Visual Variants`.

If there are no durable major visual changes, include only the base variant keyed by the character stem (the artifact filename without `.md`).

## Variant Slug Rules

Use lowercase asset ids with hyphens:

- `molly-millions` (base — matches artifact stem)
- `molly-millions-mission-gear`
- `henry-dorsett-case` (base)

Variant slugs should describe durable visual forms, not emotions or momentary actions.

## Forbidden In Assistant Reply

- Pasting the artifact after `write`
- Summaries, explanations, bullets, or code fences
