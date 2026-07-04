"""Unified character markdown files: description + image variant prompts."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from common import slugify as slugify_name

REQUIRED_DESCRIPTION_SECTIONS = (
    "## Summary",
    "## Visual Description",
    "## Behaviour, mannerisms and personality",
    "## Continuity Notes",
    "## Source References",
)

FORBIDDEN_DESCRIPTION_SECTIONS = (
    "## Visual Variants",
    "## Personality And Performance Notes",
    "## Relationships",
)

LAYOUT_SNIPPET = "Layout: top row"

CHARACTER_SHEET_LAYOUT_BLOCK = (
    "Layout: top row — front full-body, three-quarter full-body, back full-body, "
    "same neutral standing pose, consistent scale. Bottom row — head close-ups for each expression. "
    "White background. No text, no labels, no watermarks."
)

def display_name_from_slug(slug: str) -> str:
    return " ".join(part.capitalize() for part in slug.split("-") if part)


def default_character_reference_sheet_prompt(name: str) -> str:
    return (
        f"Character reference sheet\n[describe essential visual traits here]\n"
        f"{CHARACTER_SHEET_LAYOUT_BLOCK}\n"
        f"Expressions: [list expressions here]"
    )


@dataclass
class CharacterFileDocument:
    slug: str
    description: str = ""
    variants: dict[str, dict[str, str]] = field(default_factory=dict)


def split_top_level_sections(text: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, str]] = []
    current_heading: str | None = None
    current_lines: list[str] = []
    for line in text.splitlines():
        if re.match(r"^# [^#]", line):
            if current_heading is not None:
                sections.append((current_heading, "\n".join(current_lines).strip()))
            current_heading = line.removeprefix("# ").strip()
            current_lines = []
        else:
            current_lines.append(line)
    if current_heading is not None:
        sections.append((current_heading, "\n".join(current_lines).strip()))
    return sections


def parse_variant_section(body: str) -> dict[str, str]:
    mode = ""
    style_ref = ""
    prompt_lines: list[str] = []
    in_prompt = False
    saw_style_ref = False
    for raw_line in body.splitlines():
        if raw_line.startswith("mode:"):
            mode = raw_line.split(":", 1)[1].strip()
            continue
        if raw_line.startswith("style_ref:"):
            style_ref = raw_line.split(":", 1)[1].strip()
            saw_style_ref = True
            continue
        if raw_line == "" and saw_style_ref and not in_prompt:
            in_prompt = True
            continue
        if in_prompt:
            prompt_lines.append(raw_line)
    return {
        "mode": mode,
        "style_ref": style_ref,
        "prompt": "\n".join(prompt_lines).strip(),
    }


def parse_character_file(path: Path) -> CharacterFileDocument:
    text = path.read_text()
    sections = split_top_level_sections(text)
    if not sections:
        return CharacterFileDocument(slug=path.stem)
    slug = path.stem
    description = ""
    variants: dict[str, dict[str, str]] = {}
    for index, (heading, body) in enumerate(sections):
        if index == 0:
            if heading != slug:
                raise ValueError(f"First section must be '# {slug}', got '# {heading}': {path}")
            description = body
            continue
        variants[heading] = parse_variant_section(body)
    return CharacterFileDocument(slug=slug, description=description, variants=variants)


def format_character_stub(slug: str, list_line: str) -> str:
    name = list_line.split(":", 1)[0].strip() if ":" in list_line else slug
    description = list_line.split(":", 1)[1].strip() if ":" in list_line else list_line.strip()
    summary = description or name
    return (
        f"# {slug}\n\n"
        f"## Summary\n\n"
        f"{name}: {summary}\n"
    )


def format_character_file(slug: str, description: str, variants: dict[str, dict[str, str]]) -> str:
    parts = [f"# {slug}", "", description.strip(), ""]
    for variant_key, section in variants.items():
        parts.extend(
            [
                f"# {variant_key}",
                f"mode: {section.get('mode', '').strip()}",
                f"style_ref: {section.get('style_ref', '').strip()}",
                "",
                section.get("prompt", "").strip(),
                "",
            ]
        )
    return "\n".join(parts).rstrip() + "\n"


def character_list_lines(list_path: Path) -> list[tuple[str, str]]:
    if not list_path.is_file():
        return []
    entries: list[tuple[str, str]] = []
    for line in list_path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or ": See " in stripped or ":" not in stripped:
            continue
        name = stripped.split(":", 1)[0].strip()
        slug = slugify_name(name)
        entries.append((slug, stripped))
    return entries


def find_character_list_line(list_path: Path, character_slug: str) -> str | None:
    target = character_slug.strip().lower()
    for slug, line in character_list_lines(list_path):
        if slug == target:
            return line
    return None


def sync_character_stubs_from_list(book_root: Path) -> list[Path]:
    list_path = book_root / "characters" / "list.txt"
    characters_dir = book_root / "characters"
    characters_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for slug, list_line in character_list_lines(list_path):
        path = characters_dir / f"{slug}.md"
        if path.is_file():
            continue
        path.write_text(format_character_stub(slug, list_line))
        written.append(path)
    return written


def character_file_has_variants(path: Path) -> bool:
    try:
        parsed = parse_character_file(path)
    except ValueError:
        return False
    return "base" in parsed.variants and bool(parsed.variants["base"].get("prompt", "").strip())


def variant_entity_key(character_slug: str, variant_key: str) -> str:
    if variant_key == "base":
        return character_slug
    return f"{character_slug}-{variant_key}"


def resolve_character_variant_key(character_slug: str, flat_key: str) -> tuple[str, str] | None:
    if flat_key == character_slug:
        return character_slug, "base"
    prefix = f"{character_slug}-"
    if flat_key.startswith(prefix):
        return character_slug, flat_key.removeprefix(prefix)
    return None
