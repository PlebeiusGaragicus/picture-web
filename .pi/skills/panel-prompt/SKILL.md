---
name: panel-prompt
description: >-
  Draft one verbose, imagen-ready image prompt for a single comic panel from
  the panel's story text, surrounding panels, canonical character looks, and
  the injected imagen prompt guide. Writes the prompt to an exact output path.
disable-model-invocation: false
---

# Panel Prompt

The user provides:

1. An exact output path (first line of the request).
2. Runner context containing: optional **user guidance** (an idea, concept,
   or direction for the image), story context for the panels before/after,
   **THIS PANEL's story text** (the moment to draw), canonical character
   looks, an optional project visual style note, and the **imagen prompt
   guide**.

Write **one** image-generation prompt that depicts THIS PANEL's moment.
Surrounding panels are context only — do not depict their events.

When user guidance is present, build the prompt around it: it decides the
angle, focus, mood, or concept. The guidance overrides your own framing
choices but never overrides canonical character looks or the guide's rules.

## Rules

- Follow the imagen prompt guide exactly, including its required output shape
  (subject → action → setting → characters → composition/lighting).
- Any character visible in the panel must be described using their canonical
  look descriptors from the runner context, not just their name.
- Do NOT include the project visual style; it is appended automatically at
  generation time.
- Plain prose only: no headings, bullets, brackets, quotes from the book,
  panel numbers, or meta commentary.

## Delivery

Use the **`write` tool** to save the prompt text to exactly the provided
output path. The file must contain only the prompt body.

After writing, reply with exactly `Wrote <output-path>.` and nothing else.

## Forbidden In Assistant Reply

- Pasting the prompt after `write`
- Summaries, explanations, bullets, or code fences

# User Request

Read the runner context and write one imagen-ready prompt for THIS PANEL to
the exact provided output path.

**User:** `@$`
