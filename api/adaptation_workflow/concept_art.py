"""Concept-art Pi scratch file helpers."""

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


def concept_scratch_dir(book_root: Path) -> Path:
    path = book_root / ".concept-scratch"
    path.mkdir(parents=True, exist_ok=True)
    return path


def concept_scratch_path(book_root: Path, key: str) -> Path:
    return concept_scratch_dir(book_root) / f"{key}.md"


def _next_concept_key(book_root: Path, prefix: str) -> str:
    from ids import new_ulid

    existing = {path.stem for path in concept_scratch_dir(book_root).glob("*.md")}
    for _ in range(8):
        key = f"{prefix}-{new_ulid()[:8].lower()}"
        if key not in existing:
            return key
    index = 1
    while True:
        key = f"{prefix}-{index}"
        if key not in existing:
            return key
        index += 1


def next_character_concept_key(book_root: Path) -> str:
    return _next_concept_key(book_root, "character-concept")


def next_location_concept_key(book_root: Path) -> str:
    return _next_concept_key(book_root, "location-concept")


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
        raise ValidationError(f"Prompt missing expressions block: {path}")


def validate_concept_location_art(path: Path, expected_key: str) -> None:
    from adaptation_workflow.validate import ValidationError, validate_no_chat_wrappers, validate_nonempty_file

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
    if not section.get("prompt", "").strip():
        raise ValidationError(f"Prompt body is empty: {path}")
