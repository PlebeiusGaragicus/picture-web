---
name: location-index
description: >-
  Extract reusable scene locations and environment variants from a full book and
  its scene manifest, then write a book-scoped location index for image prompt
  generation.
disable-model-invocation: false
---

# Location Index

The full book is already loaded in context. The user provides a book root path, usually `books/<book-id>`.

Read `<book-root>/scenes/manifest.md`, then use the loaded book context to extract reusable scene locations and environment variants for reference image generation.

The index must preserve enough source-grounded visual detail for high-quality image prompts. Do not summarize locations down to generic labels if the book gives concrete environmental facts.

## Delivery

Use the **`write` tool** to save exactly:

```text
<book-root>/locations/index.md
```

Create `<book-root>/locations/` if needed.

After writing, reply with exactly `Wrote <book-root>/locations/index.md.` and nothing else.

## Output Contract

Write plain markdown only. Do not use YAML frontmatter, JSON, tables, or code fences.

Include only reusable visual environments. A location belongs here if it may need a reference image for later panel generation.

Do not include:

- Characters
- Props by themselves
- Abstract concepts
- One-off camera angles
- Panel actions
- Pure emotional beats

## Required Format

Use one `##` section per location or location variant:

```markdown
## location-slug

Name: Human Readable Name
Type: location
Base Location: none
Scenes: 001-scene-title, 004-other-scene
Source References:
- `L000-L000`: "Short exact quote." Brief note about what this supports.
Visual Traits:
- Architecture, geography, terrain, or room layout.
- Materials, surfaces, vegetation, objects fixed in the environment, or visible technology.
- Lighting, weather, time-of-day impression, scale, color, or atmosphere if source-supported.
Spatial Composition:
- How the scene elements relate to each other spatially, if the source implies it.
Prompt-Critical Details:
- Specific details that must appear in an image prompt.
Variant Notes: None.
Prompt Status: needs-prompt
```

For meaningful visual state changes, create a separate section:

```markdown
## location-slug-variant

Name: Human Readable Variant Name
Type: location-variant
Base Location: location-slug
Scenes: 008-scene-title
Source References:
- `L000-L000`: "Short exact quote." Brief note about what this supports.
Visual Traits:
- Visible delta from the base location.
Spatial Composition:
- How the changed state affects layout, depth, foreground, background, or silhouette.
Prompt-Critical Details:
- Specific details that must appear in an image prompt.
Variant Notes: Describe what must remain consistent with the base location.
Prompt Status: needs-prompt
```

## Location Rules

- Prefer stable lowercase hyphenated ids.
- Merge repeated mentions of the same visual place into one base location.
- Split variants only when the environment visibly changes: damage, season, time period, weather state, magical/technological transformation, major lighting state, or layout change.
- Include enough visual traits to support a rich image prompt later: layout, foreground/background elements, architecture or terrain, materials, lighting, color, atmosphere, scale, and fixed set dressing when the source supports them.
- If the book gives a location a name, use it. If not, use a clear descriptive id.
- Anchor important claims to source line ranges and short quotes.
- If you know the quote but not the exact line number, use `LINE-VERIFY` instead of inventing a line number.
- Do not fabricate line numbers.
- Do not invent named landmarks, props, buildings, weather, time of day, materials, or decorative details that are not supported by the book or scene manifest.
- If the source is sparse, explicitly preserve that sparsity with traits such as `unspecified modern apartment details` rather than inventing decoration.

## Forbidden In Assistant Reply

- Pasting the location index after `write`
- Summaries, explanations, bullets, or code fences

# User Request

Read the scene manifest and write the reusable location index under the provided book root.

**User:** `@$`
