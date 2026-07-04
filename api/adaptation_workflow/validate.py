"""Validation helpers for character files and concept art outputs."""

from __future__ import annotations

import re
from pathlib import Path


CHAT_WRAPPER_RE = re.compile(
    r"^(Sure|Here is|Here's|I wrote|Done\.|```|Apologies|I'm sorry)",
    re.MULTILINE,
)


class ValidationError(Exception):
    pass


def file_has(path: Path, text: str) -> bool:
    return text in path.read_text()


def validate_contains(path: Path, text: str) -> None:
    if not file_has(path, text):
        raise ValidationError(f"File is missing required text '{text}': {path}")


def validate_nonempty_file(path: Path) -> None:
    if not path.is_file() or path.stat().st_size == 0:
        raise ValidationError(f"Expected non-empty file was not written: {path}")


def validate_no_chat_wrappers(path: Path) -> None:
    if CHAT_WRAPPER_RE.search(path.read_text()):
        raise ValidationError(f"File appears to contain chat wrapper text: {path}")


def validate_character_stub(path: Path) -> None:
    from adaptation_workflow.character_file import parse_character_file

    validate_nonempty_file(path)
    validate_no_chat_wrappers(path)
    validate_contains(path, "## Summary")
    parsed = parse_character_file(path)
    if parsed.slug != path.stem:
        raise ValidationError(f"First section slug must match filename stem '{path.stem}': {path}")
    if parsed.variants:
        raise ValidationError(f"List stub must not include variant sections: {path}")


def validate_character_file(path: Path, *, require_variants: bool = False) -> None:
    from adaptation_workflow.character_file import (
        FORBIDDEN_DESCRIPTION_SECTIONS,
        LAYOUT_SNIPPET,
        REQUIRED_DESCRIPTION_SECTIONS,
        parse_character_file,
    )

    validate_nonempty_file(path)
    validate_no_chat_wrappers(path)
    text = path.read_text()
    for forbidden in FORBIDDEN_DESCRIPTION_SECTIONS:
        if forbidden in text:
            raise ValidationError(f"File must not contain {forbidden}: {path}")
    for required in REQUIRED_DESCRIPTION_SECTIONS:
        validate_contains(path, required)
    parsed = parse_character_file(path)
    if parsed.slug != path.stem:
        raise ValidationError(f"First section slug must match filename stem '{path.stem}': {path}")
    if not require_variants:
        return
    base = parsed.variants.get("base")
    if base is None:
        raise ValidationError(f"Missing # base variant section: {path}")
    for required in ("mode:", "style_ref:", LAYOUT_SNIPPET, "Expressions:"):
        if required == "mode:" and not base.get("mode"):
            raise ValidationError(f"# base missing mode: {path}")
        if required == "style_ref:" and not base.get("style_ref"):
            raise ValidationError(f"# base missing style_ref: {path}")
        if required not in ("mode:", "style_ref:") and required not in base.get("prompt", ""):
            raise ValidationError(f"# base prompt missing {required}: {path}")
    if not base.get("prompt", "").strip():
        raise ValidationError(f"# base has empty prompt: {path}")
    for variant_key, section in parsed.variants.items():
        if variant_key == "base":
            continue
        if not section.get("mode") or not section.get("style_ref"):
            raise ValidationError(f"Variant #{variant_key} missing mode/style_ref: {path}")
        prompt = section.get("prompt", "")
        if LAYOUT_SNIPPET not in prompt or "Expressions:" not in prompt:
            raise ValidationError(f"Variant #{variant_key} prompt missing layout/expressions: {path}")

