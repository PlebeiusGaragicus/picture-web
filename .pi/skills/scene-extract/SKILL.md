---
name: scene-extract
description: >-
  Extract one scene planning artifact and staging location index fragments from a
  single scene list line for comic adaptation.
disable-model-invocation: false
---

# Scene Extract

The full book is already loaded in context. The user provides:

1. A book root path, usually `photo-library/projects/<project-slug>/adaptation`.
2. An exact output path for the scene artifact under `<book-root>/scenes/artifacts/`.
3. A staging directory under `<book-root>/locations/staging/<scene-slug>/` for new location index fragments.
4. One line from `<book-root>/scenes/list.txt`.
5. Optionally, the existing character list, entity registry, and location index for reference.

Create one scene planning artifact and any **new** illustratable environments this scene needs.

## Delivery

Use the **`write` tool** to save:

1. Exactly the scene artifact at the provided artifact output path.
2. Zero or more location index fragments at `<staging-dir>/<location-slug>.md`.

Create parent directories if needed.

Do **not** write to `<book-root>/locations/index.md` directly.

After writing, reply with exactly `Wrote <artifact-output-path>.` and nothing else.

## Scene Artifact Format

Plain markdown only. No YAML frontmatter, JSON, tables, or code fences.

```markdown
# Scene Title

Scene Id: 001-scene-title
Source Lines: L000-L000
Primary Location: location-slug

## Story Function

[What this scene accomplishes in the adaptation.]

## Visual Continuity

- Characters: character-a, character-b
- Locations: location-a, location-b
- Props And Visual Assets: prop-a, prop-b
- Character States: visual state notes needed later.
- Location State: visual state notes needed later.

## Dramatic Beats

- `L000-L000`: [Beat summary.] "Short exact supporting quote."
- `L000-L000`: [Beat summary.] "Short exact supporting quote."

## Staging Notes

[Spatial, action, mood, camera, or readability notes useful for later page/panel planning.]

## Text Candidates

- Narration: [Candidate narration or `None`.]
- Dialogue: [Important dialogue that may become speech bubbles, or `None`.]
- Caption: [Caption idea or `None`.]

## Adaptation Notes

[Compression, expansion, continuity risk, or page/panel opportunities.]
```

## Location Fragment Format

For each distinct illustratable environment needed in this scene, write one file in the staging directory using the location index section format:

```markdown
## location-slug

Name: Human Readable Name
Type: location
Base Location: parent-slug-or-none
Source References:
- `L000-L000`: "Short exact quote." Brief note.
Visual Traits:
- Source-supported environmental details.
Spatial Composition:
- Layout notes when source-supported.
Prompt-Critical Details:
- Details that must appear in an image prompt.
Variant Notes: None.
Prompt Status: needs-prompt
```

Location rules:

- Split sub-areas that need separate reference images (kitchen, garden, porch) into sibling `Type: location` entries.
- Do not collapse them into one generic `house` entry.
- Use `Type: location-variant` only for a visible state change of the same place.
- Skip writing a staging fragment when the location slug already exists in the provided location index.
- Use stable lowercase hyphenated ids.

## Character Rules

- Use **exact character entity keys** from the provided entity registry in **Visual Continuity**.
- Base characters use the character stem (for example `rainbow-dash`); variants use `{stem}-{variant}` (for example `rainbow-dash-injured`).
- When **Character States** requires a non-base look, list the matching variant key, not the base stem.
- Do not invent slugs or shorten names from the character list.

## Source Rules

- Preserve source line ranges and short supporting quotes.
- Do not fabricate line numbers.

## Forbidden In Assistant Reply

- Pasting artifacts after `write`
- Summaries, explanations, bullets, or code fences
