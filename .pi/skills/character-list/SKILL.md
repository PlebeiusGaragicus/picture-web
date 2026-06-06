---
name: character-list
description: >-
  Generate a strict one-line-per-character list from a full book already loaded
  in context. Use for comic adaptation workflows before creating per-character
  artifacts.
disable-model-invocation: false
---

# Character List

The full book is already loaded in context. Produce a complete character list for the entire story.

## Output Contract

Output only the character list.

Do not include:

- Headings
- Bullets
- Numbering
- Markdown formatting
- Dialogue
- Commentary
- Explanations
- Blank lines
- Text before or after the list

## Line Format

Each line must follow this exact format:

```text
Character Name (optional alias): Short description.
```

Rules:

- Exactly one character per line.
- Exactly one colon separator per line.
- Use the most canonical character name first.
- Put aliases or alternate names in parentheses after the canonical name when useful.
- Include every named character.
- Include important unnamed recurring characters only if they function like characters.
- Do not include locations, factions, companies, props, objects, technologies, abstract concepts, or settings unless they are personified characters in the story.
- Keep each description concise, but include the character's role and most important identifying traits.
- Do not include source line references in this list. Source-backed detail belongs in the character artifact skill.
- One logical character per line. If the same person appears under multiple names or visual states, keep them on one line. Merge alternate identities, disguises, age states, transformed or alternate forms, costumes, and other variants into that single description.
- Do not split one person into separate lines such as `Dr Jekyll` and `Mr Hyde`, or `Anna` and `Anna as a child`.
- Do not emit cross-reference lines such as `See Character Name`.

## Example

```text
Henry Dorsett Case: The protagonist, a legendary console cowboy whose damaged nervous system keeps him from jacking into cyberspace until he is recruited for the Straylight run.
Molly Millions: A street samurai and razorgirl hired as Case's bodyguard, defined by mirrored lenses, retractable blades, professionalism, cynicism, and independence.
Dixie Flatline (McCoy Pauley): A ROM personality construct of a legendary cowboy who guides Case through the run and wants his own stored existence ended.
Dr Jekyll (Mr Hyde): A respectable Victorian doctor whose self-experiments release the violent alter ego Mr Hyde; both forms belong to one character with distinct visual states.
```
