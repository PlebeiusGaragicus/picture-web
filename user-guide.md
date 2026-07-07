# User Guide: Adapting a Story into a Comic

The workflow is a pipeline. Each step feeds the next, and some steps are hard-gated
(the app blocks you with an explanation if you skip ahead).

## 1. Import the book — Story view

Upload your manuscript (`book.txt`). Then run **Read book** so pi ingests the text;
the extraction tasks that follow branch off this warm session.

## 2. Set the visual style and style anchors — Canvas view

- Pick or create a **visual style** (a short style snippet appended to every
  generation prompt, e.g. "soft watercolor wash, thick ink outlines").
- Generate on the seeded **Character Style** / **Scene Style** anchor nodes on
  the canvas. The take you keep becomes that style tag's **canonical** image,
  used as a style input for later generations.

## 3. Concept art — Concept Art view

Explore look and feel before committing to canonical designs. Create cards (or let
pi **suggest** character/location concepts), edit them, and generate on the canvas.
Concept art is a *style* input — it does not stand in for canonical references.

## 4. Extract characters and locations — Characters and Locations views

Run **Find characters** to register the cast, then **Extract** each character
(or **Extract all**). This fills each character record: summary, visual
description, performance notes, continuity notes, and reference-sheet prompt
variants (base plus durable looks like young/adult or post-injury, each with a
story context). Review and edit records in the structured editor; use the
**Refine** feedback box to have pi revise a record ("make her scar more
prominent, add a post-duel variant"). These slugs and look descriptors are what
panel prompts are built from.

Locations work exactly the same way on the **Locations** page: **Find
locations** registers the story's recurring settings, **Extract** fills each
record with a visual description and wide establishing-shot prompt variants
(base plus durable states like "after the fire", each with a story context).

**Gate:** panel prompt drafting is blocked until at least one character with look
text exists.

## 5. Generate canonical reference sheets — Canvas view

Generate the character sheets and location establishing shots (per variant —
each variant's **Draft** button creates a tagged canvas node) from their
prompts. Each variant's active asset becomes that look's canonical reference
image.

**Gate:** drafting a panel to the canvas is blocked for any tagged entity that has
no reference asset yet.

## 6. Create panels — Story view

Highlight passages in the book text to carve them into panels. Panels are
human-led; you decide the beats. Place panels onto pages in the **Layout** view.

## 7. Draft panel prompts — Story or Layout view (panel editor)

Open a panel and use **Draft with pi** (or **Draft with input…** to seed an idea).
Pi writes an imagen-ready prompt using the canonical character looks and location
descriptions, and tags the panel with `characterSlugs`/`locationSlug`. Review the
**Who and where** chips and adjust if needed. Iterate with the one-line
**Refine** feedback input.

## 8. Draft to canvas and generate

Per saved prompt, click **Draft to canvas**. This creates a canvas node with the
prompt plus the tagged entities' reference sheets as imagen reference images.
Generate; the resulting asset **auto-attaches back to the panel** and becomes its
active image.

## 9. Layout and export — Layout view

Fine-tune panel placement, captions, and visible text. Export the finished comic
as a booklet PDF.

## Monitoring

The **Agent** view is a dashboard of all pi tasks: live progress for running tasks
and a history with full traces for past ones.

```mermaid
flowchart LR
    book[Import + read book] --> style[Visual style + style anchors]
    style --> concept[Concept art]
    concept --> extract[Extract characters/locations]
    extract --> sheets[Generate reference sheets]
    sheets --> panels[Create panels]
    panels --> prompts[Draft panel prompts]
    prompts --> canvas[Draft to canvas + generate]
    canvas --> layout[Layout + booklet PDF]
```
