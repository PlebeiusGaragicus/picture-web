"""Validation helpers for ingest, character, and location artifacts."""

from __future__ import annotations

import re
from pathlib import Path

from adaptation_workflow.sections import extract_sections
from adaptation_workflow.slugify import slugify_name

CHAT_WRAPPER_RE = re.compile(
    r"^(Sure|Here is|Here's|I wrote|Done\.|```|Apologies|I'm sorry)",
    re.MULTILINE,
)
_LOCATION_METADATA_OPENER_RE = re.compile(r"Environment reference for|Location prompt for")
_LOCATION_SOURCE_CITATION_RE = re.compile(r"`L[0-9][0-9][0-9]|LINE-VERIFY")


class ValidationError(Exception):
    pass


class ValidationReport:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.passes: list[str] = []

    def fail(self, message: str) -> None:
        self.failures.append(message)

    def ok(self, message: str) -> None:
        self.passes.append(message)

    @property
    def success(self) -> bool:
        return not self.failures


def file_has(path: Path, text: str) -> bool:
    return text in path.read_text()


def validate_common_file(path: Path, report: ValidationReport) -> bool:
    if not path.is_file():
        report.fail(f"{path} missing")
        return False
    if path.stat().st_size == 0:
        report.fail(f"{path} empty")
        return False
    text = path.read_text()
    if CHAT_WRAPPER_RE.search(text):
        report.fail(f"{path} contains chat wrapper text")
        return False
    return True


def validate_contains(path: Path, text: str) -> None:
    if not file_has(path, text):
        raise ValidationError(f"File is missing required text '{text}': {path}")


def validate_nonempty_file(path: Path) -> None:
    if not path.is_file() or path.stat().st_size == 0:
        raise ValidationError(f"Expected non-empty file was not written: {path}")


def validate_no_chat_wrappers(path: Path) -> None:
    if CHAT_WRAPPER_RE.search(path.read_text()):
        raise ValidationError(f"File appears to contain chat wrapper text: {path}")


def validate_character_artifact(path: Path) -> None:
    validate_nonempty_file(path)
    validate_no_chat_wrappers(path)
    for required in ("## Summary", "## Visual Description", "## Visual Variants", "## Source References"):
        validate_contains(path, required)


def validate_character_sheet(path: Path) -> None:
    validate_nonempty_file(path)
    validate_no_chat_wrappers(path)
    for required in ("mode:", "style_ref:", "Layout: top row", "Expressions:"):
        validate_contains(path, required)


def validate_location_prompt(path: Path) -> None:
    validate_nonempty_file(path)
    validate_no_chat_wrappers(path)
    for required in ("mode:", "style_ref:", "No characters, no text, no labels, no watermarks."):
        validate_contains(path, required)
    text = path.read_text()
    if _LOCATION_METADATA_OPENER_RE.search(text):
        raise ValidationError(f"File contains metadata-style opener: {path}")
    if _LOCATION_SOURCE_CITATION_RE.search(text):
        raise ValidationError(f"File contains source citation text: {path}")


def validate_style_refs(book_root: Path, report: ValidationReport) -> None:
    report.ok("Style refs")
    archetype_character = book_root / "style-refs" / "archetype-character.md"
    archetype_scene = book_root / "style-refs" / "archetype-scene.md"
    if validate_common_file(archetype_character, report):
        report.ok("archetype-character.md present")
    if validate_common_file(archetype_scene, report):
        report.ok("archetype-scene.md present")


def validate_character_list(book_root: Path, report: ValidationReport) -> None:
    report.ok("Characters")
    list_path = book_root / "characters" / "list.txt"
    if not validate_common_file(list_path, report):
        return
    expected = 0
    for line in list_path.read_text().splitlines():
        character_line = line.strip()
        if not character_line:
            continue
        expected += 1
        if ":" not in character_line:
            report.fail(f"character list line missing colon: {character_line}")
            continue
        if character_line.count(":") > 1:
            report.fail(f"character list line has more than one colon: {character_line}")
            continue
        character_name = character_line.split(":", 1)[0]
        slug = slugify_name(character_name)
        artifact = book_root / "characters" / "artifacts" / f"{slug}.md"
        sheet = book_root / "characters" / "sheets" / f"{slug}.md"
        try:
            validate_character_artifact(artifact)
        except ValidationError as exc:
            report.fail(str(exc))
        try:
            validate_character_sheet(sheet)
        except ValidationError as exc:
            report.fail(str(exc))
    report.ok(f"checked {expected} character list entries")


def validate_locations(book_root: Path, report: ValidationReport) -> None:
    report.ok("Locations")
    index_path = book_root / "locations" / "index.md"
    if not validate_common_file(index_path, report):
        return

    tmp_dir = book_root / "locations" / ".validate-entries"
    entries = extract_sections(index_path, tmp_dir)
    if not entries:
        report.fail("locations/index.md has no ## location sections")
        return

    for entry in entries:
        slug = entry.stem
        for required in ("Name:", "Type:", "Source References:", "Visual Traits:"):
            if not file_has(entry, required):
                report.fail(f"locations/index.md section {slug} missing {required}")
        prompt = book_root / "locations" / "prompts" / f"{slug}.md"
        if not validate_common_file(prompt, report):
            continue
        try:
            validate_location_prompt(prompt)
        except ValidationError as exc:
            report.fail(str(exc))

    report.ok(f"checked {len(entries)} location entries")


def run_validation(book_root: Path, stage: str) -> ValidationReport:
    report = ValidationReport()
    if stage in {"ingest", "all"}:
        validate_style_refs(book_root, report)
    if stage in {"characters", "all"}:
        validate_character_list(book_root, report)
    if stage in {"locations", "all"}:
        validate_locations(book_root, report)
    return report
