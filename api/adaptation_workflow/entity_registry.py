"""Character and location entity keys for scene/moment planning."""

from __future__ import annotations

import json
import re
from pathlib import Path

from adaptation_workflow.sections import parse_index_sections_file
from adaptation_workflow.slugify import slugify_name

ENTITY_REF_RE = re.compile(r"\b(character|location):([a-z0-9]+(?:-[a-z0-9]+)*)\b")
VISUAL_CONTINUITY_CHARACTERS_RE = re.compile(r"^- Characters:\s*(.+)$", re.MULTILINE)
VISUAL_CONTINUITY_LOCATIONS_RE = re.compile(r"^- Locations:\s*(.+)$", re.MULTILINE)
_NONE_TOKENS = frozenset({"none", "none."})


class CharacterRegistryNotReadyError(Exception):
    pass


def read_metadata_entity_keys(root: Path) -> tuple[dict[str, object], dict[str, object]]:
    meta_path = root / "adaptation.json"
    if not meta_path.is_file():
        return {}, {}
    data = json.loads(meta_path.read_text())
    characters = data.get("characters") or {}
    locations = data.get("locations") or {}
    return characters, locations


def sheet_section_keys(path: Path) -> list[str]:
    if not path.is_file():
        return []
    keys: list[str] = []
    for line in path.read_text().splitlines():
        if not line.startswith("## "):
            continue
        key = line.removeprefix("## ").strip().split()[0]
        if key:
            keys.append(key)
    return keys


def character_stems(root: Path) -> set[str]:
    stems: set[str] = set()
    list_path = root / "characters" / "list.txt"
    if list_path.is_file():
        for line in list_path.read_text().splitlines():
            stripped = line.strip()
            if not stripped or ": See " in stripped:
                continue
            if ":" not in stripped:
                continue
            name = stripped.split(":", 1)[0]
            stems.add(slugify_name(name))
    characters_dir = root / "characters"
    if characters_dir.is_dir():
        for char_file in characters_dir.glob("*.md"):
            stems.add(char_file.stem)
    return stems


def character_variant_keys_from_file(path: Path) -> list[str]:
    from adaptation_workflow.character_file import parse_character_file, variant_entity_key

    try:
        parsed = parse_character_file(path)
    except ValueError:
        return []
    return [variant_entity_key(parsed.slug, variant_key) for variant_key in parsed.variants.keys()]


def character_entity_keys(root: Path, metadata_characters: dict[str, object] | None = None) -> list[str]:
    keys: set[str] = set()
    characters_dir = root / "characters"
    if characters_dir.is_dir():
        for char_file in characters_dir.glob("*.md"):
            keys.update(character_variant_keys_from_file(char_file))
    if metadata_characters:
        for slug, record in metadata_characters.items():
            if isinstance(record, dict):
                variants = record.get("variants") or {}
                if isinstance(variants, dict):
                    for variant_key in variants.keys():
                        from adaptation_workflow.character_file import variant_entity_key

                        keys.add(variant_entity_key(str(slug), str(variant_key)))
    return sorted(keys)


def location_entity_keys(root: Path, metadata_locations: dict[str, object] | None = None) -> list[str]:
    keys: set[str] = set()
    if metadata_locations:
        keys.update(metadata_locations.keys())
    prompts_dir = root / "locations" / "prompts"
    if prompts_dir.is_dir():
        for prompt in prompts_dir.glob("*.md"):
            keys.update(sheet_section_keys(prompt))
    index_path = root / "locations" / "index.md"
    if index_path.is_file():
        keys.update(parse_index_sections_file(index_path).keys())
    return sorted(keys)


def classify_character_key(key: str, stems: set[str]) -> tuple[str, str | None]:
    if key in stems:
        return "base", key
    matches = [stem for stem in stems if key.startswith(f"{stem}-")]
    if matches:
        return "variant", max(matches, key=len)
    return "unknown", None


def _parse_continuity_slugs(value: str) -> list[str]:
    slugs: list[str] = []
    for part in value.split(","):
        slug = part.strip().split()[0]
        if not slug or slug.lower() in _NONE_TOKENS:
            continue
        slugs.append(slug)
    return slugs


def format_entity_registry_prompt(
    root: Path,
    metadata_characters: dict[str, object] | None = None,
    metadata_locations: dict[str, object] | None = None,
) -> str:
    char_keys = character_entity_keys(root, metadata_characters)
    loc_keys = location_entity_keys(root, metadata_locations)
    stems = character_stems(root)

    lines = [
        "## Entity registry (use these exact keys in Visual Continuity and refs)",
        "",
        "Characters:",
    ]
    if not char_keys:
        lines.append("- (none)")
    else:
        for key in char_keys:
            kind, base = classify_character_key(key, stems)
            if kind == "base":
                lines.append(f"- {key} (base)")
            elif kind == "variant":
                lines.append(f"- {key} (variant of {base})")
            else:
                lines.append(f"- {key}")

    lines.extend(["", "Locations:"])
    if not loc_keys:
        lines.append("- (none)")
    else:
        for key in loc_keys:
            lines.append(f"- {key}")

    lines.extend(
        [
            "",
            "Visual Continuity character keys must come from this registry. "
            "Use variant keys when Character States require a non-base look.",
        ]
    )
    return "\n".join(lines) + "\n"


def assert_character_registry_ready(
    root: Path,
    metadata_characters: dict[str, object] | None = None,
) -> None:
    from adaptation_workflow.character_file import character_file_has_variants

    characters_dir = root / "characters"
    ready = False
    if characters_dir.is_dir():
        for char_file in characters_dir.glob("*.md"):
            if character_file_has_variants(char_file):
                ready = True
                break
    if not ready:
        keys = character_entity_keys(root, metadata_characters)
        raise CharacterRegistryNotReadyError(
            "Complete character extraction before scene extract or moment plan. "
            f"Found {len(keys)} character entity keys but no extracted # base variants."
        )


def entity_keys_for_validation(root: Path) -> tuple[set[str], set[str]]:
    metadata_characters, metadata_locations = read_metadata_entity_keys(root)
    return (
        set(character_entity_keys(root, metadata_characters)),
        set(location_entity_keys(root, metadata_locations)),
    )


def validate_entity_refs_in_text(
    text: str,
    character_keys: set[str],
    location_keys: set[str],
    *,
    path_label: str = "",
) -> list[str]:
    errors: list[str] = []
    prefix = f"{path_label}: " if path_label else ""

    char_match = VISUAL_CONTINUITY_CHARACTERS_RE.search(text)
    if char_match:
        for slug in _parse_continuity_slugs(char_match.group(1)):
            if slug not in character_keys:
                errors.append(f"{prefix}unknown character key in Visual Continuity: {slug}")

    loc_match = VISUAL_CONTINUITY_LOCATIONS_RE.search(text)
    if loc_match:
        for slug in _parse_continuity_slugs(loc_match.group(1)):
            if slug not in location_keys:
                errors.append(f"{prefix}unknown location key in Visual Continuity: {slug}")

    for match in ENTITY_REF_RE.finditer(text):
        kind, key = match.group(1), match.group(2)
        if kind == "character" and key not in character_keys:
            errors.append(f"{prefix}unknown character ref: {kind}:{key}")
        if kind == "location" and key not in location_keys:
            errors.append(f"{prefix}unknown location ref: {kind}:{key}")

    return errors
