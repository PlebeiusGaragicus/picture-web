---
name: story-layout
description: >-
  Create page or panel planning prompt files from scene artifacts using the
  project's selected story kind.
disable-model-invocation: false
---

# Story Layout

The full book is already loaded in context. The user provides:

1. A book root path, usually `photo-library/projects/<project-slug>/adaptation`.
2. A story kind: `picture-book`, `illustrated-story`, or `comic-book`.
3. An exact output path under `<book-root>/pages/plans/` or `<book-root>/panels/prompts/`.
4. One scene artifact from `<book-root>/scenes/artifacts/<scene-slug>.md`.

Create image-generatable layout sections for the supplied scene.

## Delivery

Use the **`write` tool** to save exactly:

```text
<output-path>
```

Create the output directory if needed.

Do not derive, shorten, rename, canonicalize, or choose a different output filename. The runner owns the path.

After writing, reply with exactly `Wrote <output-path>.` and nothing else.

## Written File Format

Plain markdown only. No YAML frontmatter, JSON, tables, code fences, or commentary outside sections.

Each image-generatable section must use this parseable format:

```markdown
## artifact-slug
mode: story-layout
refs: character:character-slug-base, location:location-slug
narration: Candidate narration for this beat, or None.
dialogue: Important dialogue for this beat, or None.
caption: Caption idea for this beat, or None.

[direct image prompt focused on visuals, framing, and bubble placement only]
```

The `refs:` line may be empty if no canonical reference exists yet, but include semantic refs whenever the scene artifact names characters or locations that should be used as visual inputs.

Put readable story text in `narration:`, `dialogue:`, and `caption:` lines. Do not rely on the image prompt as the only copy of the story text.

## Story Kind Rules

For `picture-book`:

- Create one section for the scene as a page or spread illustration.
- Use one larger, readable image with no speech bubbles.
- Put prose in `narration:`; use `dialogue:` and `caption:` as `None` unless essential.

For `illustrated-story`:

- Create one section only when the scene deserves an illustration.
- Favor a single key moment over exhaustive action.
- Put narration in `narration:`; avoid speech bubbles unless dialogue is visually essential.

For `comic-book`:

- Create multiple panel sections when the scene has separable actions, reversals, or dialogue beats.
- Each section should be a direct comic panel image prompt.
- Put spoken lines in `dialogue:`; use `caption:` for narration boxes when needed.
- Include panel action, camera/framing, visible characters, location, mood, speech bubble/caption placement guidance, and continuity constraints in the image prompt.

Seed `narration:`, `dialogue:`, and `caption:` from the scene artifact **Text Candidates** and **Dramatic Beats** when possible.

## Prompt Rules

- Use source-supported facts from the scene artifact.
- Do not invent major events, dialogue, props, or visual designs.
- Use canonical character and location semantic refs where possible.
- End each image prompt with: `No watermarks.`
- If speech bubbles or captions are needed, describe their placement in the image prompt; put the readable text in `dialogue:` or `caption:`.

## Forbidden In Assistant Reply

- Pasting the layout after `write`
- Summaries, explanations, bullets, or code fences
