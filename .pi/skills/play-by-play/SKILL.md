---
name: play-by-play
description: >-
  Create a major-act play-by-play outline from a full book already loaded in
  context. Use for comic adaptation planning after or alongside a scene manifest.
disable-model-invocation: false
---

# Play By Play

The full book is already loaded in context. Create a play-by-play outline of the story's major acts and dramatic beats for comic adaptation.

## Output Contract

Write plain markdown only.

Do not use YAML frontmatter, JSON, or tables.

The output should be a high-level adaptation map, not a scene-by-scene manifest. Group scenes into major dramatic movements.

## Required Structure

Use this structure:

```markdown
# Play By Play

## act-01-title

Scene Range: 001-006
Purpose: [What this act accomplishes in the story.]
Turning Point: [The major change or reveal.]
Emotional Arc: [How the central emotional state changes.]
Visual Priorities:
- [Important recurring image, location, contrast, or staging concern.]
- [Another visual priority.]
Key Beats:
- `L000-L000`: [Beat summary.] "Short exact supporting quote."
- `L000-L000`: [Beat summary.] "Short exact supporting quote."
Continuity Notes: [Important setup/payoff, visual motif, or character state.]
```

## Act Rules

- Use lowercase hyphenated act ids.
- Keep acts broad enough to help page and scene planning.
- Do not duplicate the full scene manifest.
- Include major reveals, reversals, action sequences, emotional turns, and visual motifs.
- Preserve story order.

## Source Reference Rules

- Use source line ranges from the single immutable book text.
- Include short exact supporting quotes for major beats.
- If you know the quote but not the exact line number, use `LINE-VERIFY` instead of inventing a line number.
- Do not fabricate line numbers.
- Do not include long excerpts.
