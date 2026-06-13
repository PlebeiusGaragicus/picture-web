---
name: scene-artifact
description: >-
  Create one source-grounded scene planning artifact from a scene manifest entry
  for later picture-book or comic adaptation planning.
disable-model-invocation: false
---

# Scene Artifact

The full book is already loaded in context. The user provides:

1. A book root path, usually `photo-library/projects/<project-slug>/adaptation`.
2. An exact output path under `<book-root>/scenes/artifacts/`.
3. One scene entry from `<book-root>/scenes/manifest.md`.

Create one scene planning artifact. This is not an image prompt yet; it is the bridge from story structure to page or panel planning.

## Delivery

Use the **`write` tool** to save exactly:

```text
<output-path>
```

Create `<book-root>/scenes/artifacts/` if needed.

Do not derive, shorten, rename, canonicalize, or choose a different output filename. The runner owns the path.

After writing, reply with exactly `Wrote <output-path>.` and nothing else.

## Output Contract

Write plain markdown only. Do not use YAML frontmatter, JSON, tables, code fences, or commentary outside the artifact.

Use this structure:

```markdown
# Scene Title

Scene Id: 001-scene-title
Source Lines: L000-L000
Major Act: act-01-title
Primary Location: location-id-or-description

## Story Function

[What this scene accomplishes in the adaptation.]

## Visual Continuity

- Characters: character-a, character-b
- Locations: location-a
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

## Rules

- Preserve the scene id and source line range from the manifest entry.
- Use source-supported facts. Do not invent visual details, dialogue, props, costumes, or camera-specific actions.
- Keep it concise but complete enough to support page and panel planning.
- Include every visible character, location, prop, and durable visual state from the manifest entry.
- If an important visual choice is unspecified, record it as an open design choice rather than inventing an answer.

## Forbidden In Assistant Reply

- Pasting the artifact after `write`
- Summaries, explanations, bullets, or code fences
