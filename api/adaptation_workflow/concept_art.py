"""Concept-art file helpers."""

from __future__ import annotations

from pathlib import Path


def parse_concept_art_sections(path: Path) -> dict[str, dict[str, str]]:
    sections: dict[str, dict[str, str]] = {}
    current: str | None = None
    mode = ""
    style_ref = ""
    subject = ""
    prompt_lines: list[str] = []
    in_prompt = False
    for raw_line in path.read_text().splitlines():
        if raw_line.startswith("## "):
            if current is not None:
                sections[current] = {
                    "mode": mode,
                    "style_ref": style_ref,
                    "subject": subject,
                    "prompt": "\n".join(prompt_lines).strip(),
                }
            current = raw_line.removeprefix("## ").strip()
            mode = ""
            style_ref = ""
            subject = ""
            prompt_lines = []
            in_prompt = False
            continue
        if current is None:
            continue
        if raw_line.startswith("mode:"):
            mode = raw_line.split(":", 1)[1].strip()
            continue
        if raw_line.startswith("style_ref:"):
            style_ref = raw_line.split(":", 1)[1].strip()
            continue
        if raw_line.startswith("subject:"):
            subject = raw_line.split(":", 1)[1].strip()
            continue
        if raw_line == "" and not in_prompt:
            in_prompt = True
            continue
        if in_prompt:
            prompt_lines.append(raw_line)
    if current is not None:
        sections[current] = {
            "mode": mode,
            "style_ref": style_ref,
            "subject": subject,
            "prompt": "\n".join(prompt_lines).strip(),
        }
    return sections


def next_character_concept_key(book_root: Path) -> str:
    concept_dir = book_root / "concept-art"
    concept_dir.mkdir(parents=True, exist_ok=True)
    existing = {path.stem for path in concept_dir.glob("*.md")}
    index = 1
    while True:
        key = f"character-concept-{index}"
        if key not in existing:
            return key
        index += 1


def next_location_concept_key(book_root: Path) -> str:
    concept_dir = book_root / "concept-art"
    concept_dir.mkdir(parents=True, exist_ok=True)
    existing = {path.stem for path in concept_dir.glob("*.md")}
    index = 1
    while True:
        key = f"location-concept-{index}"
        if key not in existing:
            return key
        index += 1


def next_uploaded_concept_key(book_root: Path) -> str:
    concept_dir = book_root / "concept-art"
    concept_dir.mkdir(parents=True, exist_ok=True)
    existing = {path.stem for path in concept_dir.glob("*.md")}
    index = 1
    while True:
        key = f"uploaded-concept-{index}"
        if key not in existing:
            return key
        index += 1


def existing_concept_art_slugs(book_root: Path) -> list[str]:
    concept_dir = book_root / "concept-art"
    if not concept_dir.is_dir():
        return []
    return sorted(path.stem for path in concept_dir.glob("*.md"))


def existing_character_concept_slugs(book_root: Path) -> list[str]:
    return existing_concept_art_slugs(book_root)


def validate_concept_character_art(path: Path, expected_key: str) -> None:
    from adaptation_workflow.character_file import LAYOUT_SNIPPET
    from adaptation_workflow.validate import ValidationError, validate_no_chat_wrappers, validate_nonempty_file

    validate_nonempty_file(path)
    validate_no_chat_wrappers(path)
    sections = parse_concept_art_sections(path)
    section = sections.get(expected_key)
    if section is None:
        raise ValidationError(f"Missing ## {expected_key} section: {path}")
    if section.get("subject") != "character":
        raise ValidationError(f"subject must be character: {path}")
    if section.get("mode") != "new-image":
        raise ValidationError(f"mode must be new-image: {path}")
    prompt = section.get("prompt", "").strip()
    if not prompt:
        raise ValidationError(f"Prompt body is empty: {path}")
    if LAYOUT_SNIPPET not in prompt:
        raise ValidationError(f"Prompt missing layout block: {path}")
    if "Expressions:" not in prompt:
        raise ValidationError(f"Prompt missing Expressions line: {path}")
    if "[describe essential visual traits here]" in prompt:
        raise ValidationError(f"Prompt still contains placeholder traits: {path}")
    if "[list expressions here]" in prompt:
        raise ValidationError(f"Prompt still contains placeholder expressions: {path}")


def validate_concept_location_art(path: Path, expected_key: str) -> None:
    from adaptation_workflow.validate import (
        ValidationError,
        _LOCATION_METADATA_OPENER_RE,
        _LOCATION_SOURCE_CITATION_RE,
        validate_no_chat_wrappers,
        validate_nonempty_file,
    )

    validate_nonempty_file(path)
    validate_no_chat_wrappers(path)
    sections = parse_concept_art_sections(path)
    section = sections.get(expected_key)
    if section is None:
        raise ValidationError(f"Missing ## {expected_key} section: {path}")
    if section.get("subject") != "location":
        raise ValidationError(f"subject must be location: {path}")
    if section.get("mode") != "new-image":
        raise ValidationError(f"mode must be new-image: {path}")
    prompt = section.get("prompt", "").strip()
    if not prompt:
        raise ValidationError(f"Prompt body is empty: {path}")
    if _LOCATION_METADATA_OPENER_RE.search(prompt):
        raise ValidationError(f"Prompt contains metadata-style opener: {path}")
    if _LOCATION_SOURCE_CITATION_RE.search(prompt):
        raise ValidationError(f"Prompt contains source citation text: {path}")
    if "Match the reference image's environmental rendering, palette, lighting, and detail level." not in prompt:
        raise ValidationError(f"Prompt missing environmental match sentence: {path}")
    if "No characters, no text, no labels, no watermarks." not in prompt:
        raise ValidationError(f"Prompt missing closing constraint line: {path}")
