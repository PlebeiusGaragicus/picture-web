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
## unique-section-slug
mode: story-layout
refs: character:character-slug, location:location-slug
narration: Candidate narration for this beat, or None.
dialogue: Important dialogue for this beat, or None.
caption: Caption idea for this beat, or None.

[direct image prompt focused on visuals, framing, and bubble placement only]
```

### Section slug rules

- Every `##` heading is a **unique moment key** stored in adaptation metadata and shown as its own panel/page in the UI.
- **Never repeat a heading** in the same file. Duplicate headings cause panels to be lost.
- **Single section:** the heading may equal the scene slug (for example `## 001-opening`).
- **Multiple sections (comic-book):** use `{scene-slug}-panel-01`, `{scene-slug}-panel-02`, and so on with two-digit zero padding.
- **Multiple sections (picture-book / illustrated-story):** use `{scene-slug}-page-01` when more than one section is needed.
- For comics, create **one section per separable beat** in **Dramatic Beats** when the scene has multiple actions or dialogue turns.

Multi-panel comic example (one file, three unique headings):

```markdown
## 001-opening-panel-01
mode: story-layout
refs: character:hero, location:barn
narration: None.
dialogue: None.
caption: None.

Wide establishing panel of the barn at sunrise. No watermarks.

## 001-opening-panel-02
mode: story-layout
refs: character:hero, location:barn
narration: None.
dialogue: "Hello!"
caption: None.

Medium shot of the hero waving from the barn door. Speech bubble on the right. No watermarks.

## 001-opening-panel-03
mode: story-layout
refs: character:hero, location:barn
narration: None.
dialogue: None.
caption: Later that morning.

Close-up reaction panel. Caption box at top. No watermarks.
```

The `refs:` line must include at least one `character:` or `location:` reference per section. Use **exact entity keys** from the entity registry and scene artifact **Visual Continuity** section (for example `character:rainbow-dash`, not shortened story names). Those keys are the tag ids users apply on the canvas (`rainbow-dash` without the `character:` prefix).

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
- Use canonical character and location semantic refs from **Visual Continuity** using exact adaptation keys (for example `character:hero`, `location:barn`).
- End each image prompt with: `No watermarks.`
- If speech bubbles or captions are needed, describe their placement in the image prompt; put the readable text in `dialogue:` or `caption:`.

## Forbidden In Assistant Reply

- Pasting the layout after `write`
- Summaries, explanations, bullets, or code fences
