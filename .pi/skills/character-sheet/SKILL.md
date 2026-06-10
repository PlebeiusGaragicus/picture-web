---
name: character-sheet
description: >-
  Write character-sheets/<slug>.md with short image-generation prompts from a
  character artifact. Assumes style-refs/archetype-character.png exists. Agent
  uses write tool; do not dump prompts in chat.
disable-model-invocation: false
---

# Character Sheet Prompts

The full book is already loaded in context. The user will provide one approved character artifact from `characters/<slug>.md`.

Read **Visual Description**, **Visual Variants**, **Personality And Performance Notes**, and **Continuity Notes**. Decide how many reference sheets this character needs.

Style rendering comes from the **style anchor image** `style-refs/archetype-character.png` attached at generation time — **not** from prose in the prompt.

## Delivery

Use the **`write` tool** to save exactly:

```text
character-sheets/<slug>.md
```

where `<slug>` matches the character artifact basename.

Do **not** paste sheet prompts in the assistant reply. After writing, reply with at most one short line such as `Wrote character-sheets/butterscotch.md.`

## When To Use Multiple Sheets

Create **multiple `##` sections** only when variants differ in **visible** design enough to need a separate reference image:

- Different species, age band, or body silhouette.
- Different costume era or major outfit.
- Disguise vs revealed identity.
- Injury or transformation that changes appearance.
- Human vs alternate form.

Do **not** create sheets for narrative-only differences (conscious vs simulated, mood, backstory).

## File Format

Plain markdown only. No YAML frontmatter, JSON, tables, or code fences.

```markdown
## variant-slug
mode: new-image
style_ref: style-refs/archetype-character.png

[prompt]

## other-variant-slug
mode: edit-reference
style_ref: character-sheets/images/<base-variant-slug>.png

[prompt]
```

Do not add a `# Character Sheets: …` title line.

Use variant slugs from **Visual Variants** when present; otherwise `character-slug-base`.

For `edit-reference`, `style_ref` is the **approved base character sheet image** for this character (user saves generated PNGs under `character-sheets/images/`).

## Layout Block

Include this block **verbatim** in every prompt:

```text
Layout: top row — front full-body, three-quarter full-body, back full-body, same neutral standing pose, consistent scale. Bottom row — four head close-ups. White background. No text, no labels, no watermarks.
```

## Expressions (required)

From **Personality And Performance Notes**, choose **exactly four** expressions that fit this character's temperament and story role.

Add a line in the prompt: `Expressions: [e1], [e2], [e3], [e4].`

Rules:

- Do not use a generic happy/sad/surprise/anger set unless it fits.
- Omit expressions that contradict personality (e.g. no broad smile for a grim character).
- Use story-supported emotional range, not ad-hoc comedy faces.

## Prompt Rules

Short strings for Nano Banana — **2–3 sentences** per section.

### `mode: new-image`

1. `Character reference sheet for [name],` then essential visual facts (species, colors, mane/hair, clothing, cutie mark, silhouette).
2. `Match the reference image's rendering, palette, line weight, shadows, and sheet layout exactly.`
3. The layout block and `Expressions:` line.

Do **not** describe watercolor, palette, or mood from `style-refs/visual-style.md` — the reference image carries style.

### `mode: edit-reference`

1. `Character sheet for this character. Same design as the reference image.`
2. State only the **visual delta** from the base variant.
3. Layout block and updated `Expressions:` if the variant warrants different faces.

Do **not** repeat full character description or style prose.

## Grounding Rules

- Visual facts from the artifact and book context only.
- Pick concrete options for open design choices inline; no analyst notes in the file.
- No source line numbers in sheet prompts.

## Forbidden In The Written File

- Preamble, style paragraphs, pasted `style-refs/visual-style.md`
- Repeating "match reference" more than once per prompt
- Trailing commentary after the last prompt

## Forbidden In Assistant Reply

- Pasting prompts after `write`, "Done!", bullet summaries, code fences in chat

## Example

```markdown
## jekyll-base
mode: new-image
style_ref: style-refs/archetype-character.png

Character reference sheet for Dr Jekyll, respectable middle-aged Victorian doctor, neat beard, tired eyes, conservative dark clothing. Match the reference image's rendering, palette, line weight, shadows, and sheet layout exactly. Layout: top row — front full-body, three-quarter full-body, back full-body, same neutral standing pose, consistent scale. Bottom row — four head close-ups. White background. No text, no labels, no watermarks. Expressions: calm neutral, tired concern, restrained unease, quiet determination.

## hyde-variant
mode: edit-reference
style_ref: character-sheets/images/jekyll-base.png

Character sheet for this character. Same design as reference. Transform into Mr Hyde: bulkier frame, cruel expression, disheveled hair, more violent posture. Layout: top row — front full-body, three-quarter full-body, back full-body, same neutral standing pose, consistent scale. Bottom row — four head close-ups. White background. No text, no labels, no watermarks. Expressions: neutral, cruel sneer, rage, contempt.
```

# User Request

Read the attached character artifact, then write `character-sheets/<slug>.md`.

**User:** `@$`
