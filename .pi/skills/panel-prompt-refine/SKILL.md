---
name: panel-prompt-refine
description: >-
  Revise an existing panel image prompt by applying one line of user feedback
  while keeping everything that was not mentioned. Writes the revised prompt
  to an exact output path.
disable-model-invocation: false
---

# Panel Prompt Refine

The user provides:

1. An exact output path (first line of the request).
2. The **current prompt** to revise.
3. **User feedback** to apply.
4. Runner context: panel story text, surrounding panels, canonical character
   looks, and the **imagen prompt guide**.

Rewrite the current prompt applying the feedback. This is a revision, not a
redraft:

- Change only what the feedback asks for (plus anything that must change to
  stay consistent with it).
- Preserve the rest of the prompt's content, characters, and structure.
- The result must still follow the imagen prompt guide's output shape and
  rules, and still describe visible characters with their canonical look
  descriptors.
- Plain prose only: no headings, bullets, brackets, or meta commentary.

## Delivery

Use the **`write` tool** to save the revised prompt text to exactly the
provided output path. The file must contain only the prompt body.

After writing, reply with exactly `Wrote <output-path>.` and nothing else.

## Forbidden In Assistant Reply

- Pasting the prompt after `write`
- Summaries, explanations, bullets, or code fences

# User Request

Read the current prompt and feedback, then write the revised imagen-ready
prompt to the exact provided output path.

**User:** `@$`
