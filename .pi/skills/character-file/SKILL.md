---
name: character-file
description: >-
  Write one unified character markdown file from a character-list line: story
  prose under # {slug}, then # base and optional variant image prompt sections.
disable-model-invocation: false
---

# Character File

The full book is already loaded in context. The user provides:

1. A book root path, usually `books/<book-id>`.
2. An exact output path under `<book-root>/characters/<slug>.md`.
3. Exactly one line from `<book-root>/characters/list.txt`.

Write one unified character file with story-backed prose and image prompt sections.

## Input

The input line should look like:

```text
Character Name (optional alias): Short description.
```

Use the input line to identify the character, then use the full book context to gather source-supported details.

Write the file with the **`write` tool** to the exact output path provided by the user.

Create `<book-root>/characters/` if needed.

Do not derive, shorten, rename, canonicalize, or choose a different output filename. The runner owns the path.

## Output Contract

The written file must be plain markdown only.

Do not use YAML frontmatter, JSON, tables, code fences, or commentary outside the file.

After writing, reply with exactly `Wrote <output-path>.` and nothing else.

## Required Structure

```markdown
# character-slug

## Summary

[Concise prose summary of who the character is and why they matter.]

## Visual Description

[Source-supported physical appearance, clothing, posture, body language, repeated visual traits, and design-relevant details.]

## Behaviour, mannerisms and personality

[Temperament, speech, mannerisms, key relationships with others, posture, expressions, and recurring mannerisms useful for visual acting.]

## Continuity Notes

[Traits that must remain consistent across panels, scenes, and variants.]

## Source References

- `L000-L000`: "[Short exact quote from the book.]" [Brief note about what this quote supports.]

# base
mode: new-image
style_ref: <book-root>/style-refs/archetype-character.png

[prompt with layout block and Expressions line]

# optional-variant-slug
mode: edit-reference
style_ref: <book-root>/characters/character-slug/base.png

[prompt]
```

The first `#` section heading must match the file stem (`character-slug`).

Do **not** include `## Visual Variants`, `## Personality And Performance Notes`, or `## Relationships`.

## Source Reference Rules

- Every important visual claim should be supported by at least one source reference when possible.
- Use line ranges from the single immutable book text.
- Include short exact quotes.
- If you know the quote but not the exact line number, include `LINE-VERIFY` instead of inventing a line number.
- Do not fabricate line numbers.
- Do not invent visual details that are not supported by the book. If a needed design detail is unspecified, record it under `Continuity Notes` as an open design choice.

## Variant Rules

Always add `# base` with `mode: new-image`.

Add extra `# {variant}` sections only for durable visual state changes (age band, transformation, major costume, etc.) — not expressions or momentary poses.

Good reasons to create a variant:

- A different age band or large time jump.
- A major species or body transformation.
- Loss of a limb, prosthetic, cyborg implant, visible scar, or lasting injury.
- Ghost, undead, magical, simulated, or other visibly altered form.
- Disguise, uniform, armor, or major costume state that changes the silhouette or identity.
- A major outfit, occupation, or era change that needs its own reference.

Do **not** create variants for temporary performance states (expressions, poses, dirt, mood, etc.).

If there are no durable major visual changes, include only `# base`.

For `edit-reference`, `style_ref` is `<book-root>/characters/<slug>/base.png`.

## Layout Block

Include this block **verbatim** in every image prompt section:

```text
Layout: top row — front full-body, three-quarter full-body, back full-body, same neutral standing pose, consistent scale. Bottom row — four head close-ups. White background. No text, no labels, no watermarks.
```

## Expressions (required in every prompt section)

From **Behaviour, mannerisms and personality**, choose **exactly four** expressions that fit this character's temperament and story role.

Add a line in each prompt: `Expressions: [e1], [e2], [e3], [e4].`

### `mode: new-image`

1. `Character reference sheet for [name],` then essential visual facts.
2. `Match the reference image's rendering, palette, line weight, shadows, and sheet layout exactly.`
3. The layout block and `Expressions:` line.

### `mode: edit-reference`

1. `Character sheet for this character. Same design as the reference image.`
2. State only the **visual delta** from the base variant.
3. Layout block and updated `Expressions:` if warranted.

Do **not** repeat full character description or style prose in sheet prompts.

## Forbidden In Assistant Reply

- Pasting the file after `write`
- Summaries, explanations, bullets, or code fences
