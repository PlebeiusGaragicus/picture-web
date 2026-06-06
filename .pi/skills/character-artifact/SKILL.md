---
name: character-artifact
description: >-
  Create a plain markdown character artifact from one character-list line using
  a full book already loaded in context. Includes visual details, variants,
  source line references, and supporting quotes for comic adaptation.
disable-model-invocation: false
---

# Character Artifact

The full book is already loaded in context. The user will provide exactly one line from `character-list.txt`.

Create a plain markdown character artifact for that character.

## Input

The input line should look like:

```text
Character Name (optional alias): Short description.
```

Use the input line to identify the character, then use the full book context to gather source-supported details.

## Output Contract

Write plain markdown only.

Do not use:

- YAML frontmatter
- JSON
- Tables
- Code fences
- Commentary outside the artifact

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

- `character-slug-base`: [Baseline design.]
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

## Slug Rules

Use lowercase asset ids with hyphens:

- `molly-millions-base`
- `molly-millions-mission-gear`
- `henry-dorsett-case-base`

Create variants only when the character has a meaningful visual state change, such as age, disguise, injury, outfit, species, transformation, or major time-period change.
