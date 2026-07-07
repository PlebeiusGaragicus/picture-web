"""Project-backed comic adaptation: metadata, book text, character/location records."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile

import library
from common import slugify, utc_now
from models import (
    SLUG_RE,
    AdaptationCanvasImportResponse,
    AdaptationMetadata,
    AdaptationStatus,
    CharacterCreate,
    CharacterPatch,
    CharacterRecord,
    EntityVariant,
    LocationCreate,
    LocationPatch,
    LocationRecord,
)

CHARACTER_PATCH_FIELDS = ("name", "summary", "visualDescription", "performanceNotes", "continuityNotes")
LOCATION_PATCH_FIELDS = ("name", "summary", "visualDescription", "continuityNotes")


def adaptation_dir(slug: str) -> Path:
    library.require_project(slug)
    return library.project_dir(slug) / "adaptation"


def _has_book_session(root: Path) -> bool:
    manifest = root / "sessions" / "book-session.json"
    if not manifest.is_file():
        return False
    try:
        data = library.read_json(manifest)
    except (json.JSONDecodeError, OSError):
        return False
    session_id = data.get("sessionId")
    session_file = data.get("sessionFile")
    return bool(session_id) and bool(session_file) and Path(str(session_file)).is_file()


def metadata_path(slug: str) -> Path:
    return adaptation_dir(slug) / "adaptation.json"


def asset_exists(slug: str, asset_id: str) -> bool:
    return library.asset_json_path(slug, asset_id).is_file() and library.asset_png_path(slug, asset_id).is_file()


def _clear_stale_variant_group(slug: str, group: dict[str, EntityVariant]) -> bool:
    changed = False
    for key, variant in list(group.items()):
        asset_ids = [asset_id for asset_id in variant.assetIds if asset_exists(slug, asset_id)]
        active_asset_id = variant.activeAssetId if variant.activeAssetId in asset_ids else (asset_ids[-1] if asset_ids else None)
        if asset_ids != variant.assetIds or active_asset_id != variant.activeAssetId:
            group[key] = variant.model_copy(update={"assetIds": asset_ids, "activeAssetId": active_asset_id})
            changed = True
    return changed


def variant_status(variant: EntityVariant) -> str:
    return "generated" if variant.assetIds else ("ready" if variant.prompt.strip() else "missing")


def variant_entity_key(entity_slug: str, variant_key: str) -> str:
    if variant_key == "base":
        return entity_slug
    return f"{entity_slug}-{variant_key}"


def entity_display_name(record: CharacterRecord | LocationRecord) -> str:
    return record.name.strip() or " ".join(part.capitalize() for part in record.slug.split("-") if part)


# Kept under its old name for character-specific callers.
character_display_name = entity_display_name


def _entity_keys_and_names(records: dict[str, Any]) -> tuple[list[str], dict[str, str]]:
    """Flat entity-tag keys for every record variant, plus display names.

    The base variant shares the record's slug; other variants get
    `slug-<variant>` tags of their own so each durable look can carry its own
    canonical reference image."""
    keys: list[str] = []
    names: dict[str, str] = {}
    for slug_key, record in records.items():
        display = entity_display_name(record)
        keys.append(slug_key)
        if record.name.strip():
            names[slug_key] = record.name
        for variant_key, variant in record.variants.items():
            if variant_key == "base":
                continue
            flat_key = variant_entity_key(slug_key, variant_key)
            keys.append(flat_key)
            names[flat_key] = f"{display} ({variant.label.strip() or variant_key})"
    return keys, names


def entity_flat_keys(records: dict[str, Any]) -> set[str]:
    """Every valid flat key (slug for base, slug-<variant> otherwise)."""
    return {
        variant_entity_key(slug_key, variant_key)
        for slug_key, record in records.items()
        for variant_key in record.variants
    } | set(records)


def character_is_extracted(record: CharacterRecord) -> bool:
    base = record.variants.get("base")
    return bool(record.visualDescription.strip() and base is not None and base.prompt.strip())


def location_is_extracted(record: LocationRecord) -> bool:
    base = record.variants.get("base")
    return bool(record.visualDescription.strip() and base is not None and base.prompt.strip())


# --- generic record CRUD (characters + locations) -----------------------------


def _create_entity_record(
    slug: str,
    records: dict[str, Any],
    payload: CharacterCreate | LocationCreate,
    record_cls: type,
    kind_label: str,
) -> Any:
    entity_slug = payload.slug or slugify(payload.name, kind_label)
    if entity_slug in records:
        raise HTTPException(status_code=409, detail=f"{kind_label.capitalize()} already exists: {entity_slug}")
    now = utc_now()
    record = record_cls(
        slug=entity_slug,
        name=payload.name.strip(),
        summary=payload.summary,
        createdAt=now,
        updatedAt=now,
    )
    records[entity_slug] = record
    return record


def _update_entity_record(
    records: dict[str, Any],
    entity_slug: str,
    patch: CharacterPatch | LocationPatch,
    fields: tuple[str, ...],
    kind_label: str,
) -> Any:
    record = records.get(entity_slug)
    if record is None:
        raise HTTPException(status_code=404, detail=f"{kind_label.capitalize()} not found: {entity_slug}")
    updates: dict[str, Any] = {}
    for field in fields:
        value = getattr(patch, field)
        if value is not None:
            updates[field] = value
    if patch.userTags is not None:
        updates["userTags"] = list(patch.userTags)
    variants = dict(record.variants)
    for variant_key, variant_patch in (patch.variants or {}).items():
        if not re.match(SLUG_RE, variant_key):
            raise HTTPException(status_code=400, detail=f"Invalid variant key: {variant_key}")
        existing = variants.get(variant_key, EntityVariant())
        variants[variant_key] = existing.model_copy(
            update=variant_patch.model_dump(exclude_none=True)
        )
    for variant_key in patch.removeVariants or []:
        variants.pop(variant_key, None)
    updates["variants"] = variants
    next_slug = patch.slug or entity_slug
    if next_slug != entity_slug:
        if next_slug in records:
            raise HTTPException(status_code=409, detail=f"{kind_label.capitalize()} already exists: {next_slug}")
        updates["slug"] = next_slug
    updates["updatedAt"] = utc_now()
    next_record = record.model_copy(update=updates)
    if next_slug != entity_slug:
        records.pop(entity_slug)
    records[next_slug] = next_record
    return next_record


def list_characters(slug: str) -> list[CharacterRecord]:
    metadata = read_metadata(slug)
    return [metadata.characters[key] for key in sorted(metadata.characters)]


def create_character(slug: str, payload: CharacterCreate) -> CharacterRecord:
    metadata = read_metadata(slug)
    record = _create_entity_record(slug, metadata.characters, payload, CharacterRecord, "character")
    write_metadata(slug, metadata)
    return record


def update_character(slug: str, character_slug: str, patch: CharacterPatch) -> CharacterRecord:
    metadata = read_metadata(slug)
    record = _update_entity_record(metadata.characters, character_slug, patch, CHARACTER_PATCH_FIELDS, "character")
    write_metadata(slug, metadata)
    return record


def delete_character(slug: str, character_slug: str) -> AdaptationStatus:
    metadata = read_metadata(slug)
    if character_slug not in metadata.characters:
        raise HTTPException(status_code=404, detail=f"Character not found: {character_slug}")
    metadata.characters.pop(character_slug)
    write_metadata(slug, metadata)
    return status(slug)


def list_locations(slug: str) -> list[LocationRecord]:
    metadata = read_metadata(slug)
    return [metadata.locations[key] for key in sorted(metadata.locations)]


def create_location(slug: str, payload: LocationCreate) -> LocationRecord:
    metadata = read_metadata(slug)
    record = _create_entity_record(slug, metadata.locations, payload, LocationRecord, "location")
    write_metadata(slug, metadata)
    return record


def update_location(slug: str, location_slug: str, patch: LocationPatch) -> LocationRecord:
    metadata = read_metadata(slug)
    record = _update_entity_record(metadata.locations, location_slug, patch, LOCATION_PATCH_FIELDS, "location")
    write_metadata(slug, metadata)
    return record


def delete_location(slug: str, location_slug: str) -> AdaptationStatus:
    metadata = read_metadata(slug)
    if location_slug not in metadata.locations:
        raise HTTPException(status_code=404, detail=f"Location not found: {location_slug}")
    metadata.locations.pop(location_slug)
    write_metadata(slug, metadata)
    return status(slug)


def clear_stale_artifact_assets(slug: str, metadata: AdaptationMetadata) -> tuple[AdaptationMetadata, bool]:
    changed = False
    for records in (metadata.characters, metadata.locations):
        for entity_slug, record in list(records.items()):
            variants = dict(record.variants)
            if _clear_stale_variant_group(slug, variants):
                records[entity_slug] = record.model_copy(update={"variants": variants})
                changed = True
    return metadata, changed


def ensure_adaptation(slug: str) -> Path:
    root = adaptation_dir(slug)
    for path in [
        root / "sessions",
        root / "style-refs",
    ]:
        path.mkdir(parents=True, exist_ok=True)
    import visual_styles

    styles_path = visual_styles.visual_styles_path(root)
    if not styles_path.is_file():
        visual_styles.write_visual_styles(root, visual_styles.default_visual_styles())
    if not metadata_path(slug).exists():
        write_metadata(slug, AdaptationMetadata())
    library.ensure_style_entity_tags(slug)
    return root


def draft_character_variant_to_canvas(slug: str, character_slug: str, variant_key: str) -> AdaptationCanvasImportResponse:
    metadata = read_metadata(slug)
    record = metadata.characters.get(character_slug)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Character not found: {character_slug}")
    variant = record.variants.get(variant_key)
    if variant is None:
        raise HTTPException(status_code=404, detail=f"Unknown character variant: {character_slug}/{variant_key}")
    if not variant.prompt.strip():
        raise HTTPException(status_code=400, detail=f"Missing prompt for character variant: {character_slug}/{variant_key}")
    from canvas_nodes import spawn_from_character_variant

    node_id, saved = spawn_from_character_variant(slug, character_slug, variant_key)
    return AdaptationCanvasImportResponse(canvas=saved, importedNodeCount=1, nodeId=node_id)


def draft_location_variant_to_canvas(slug: str, location_slug: str, variant_key: str) -> AdaptationCanvasImportResponse:
    metadata = read_metadata(slug)
    record = metadata.locations.get(location_slug)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Location not found: {location_slug}")
    variant = record.variants.get(variant_key)
    if variant is None:
        raise HTTPException(status_code=404, detail=f"Unknown location variant: {location_slug}/{variant_key}")
    if not variant.prompt.strip():
        raise HTTPException(status_code=400, detail=f"Missing prompt for location variant: {location_slug}/{variant_key}")
    from canvas_nodes import spawn_from_location_variant

    node_id, saved = spawn_from_location_variant(slug, location_slug, variant_key)
    return AdaptationCanvasImportResponse(canvas=saved, importedNodeCount=1, nodeId=node_id)


def read_metadata(slug: str) -> AdaptationMetadata:
    ensure_adaptation(slug)
    return AdaptationMetadata.model_validate(library.read_json(metadata_path(slug)))


def write_metadata(slug: str, metadata: AdaptationMetadata) -> AdaptationMetadata:
    library.write_json(metadata_path(slug), metadata.model_dump(mode="json"))
    character_keys, character_names = _entity_keys_and_names(metadata.characters)
    location_keys, location_names = _entity_keys_and_names(metadata.locations)
    library.sync_entity_tags(
        slug,
        character_keys=character_keys,
        location_keys=location_keys,
        entity_names={**character_names, **location_names},
    )
    return metadata


def read_text(path: Path) -> str:
    if not path.is_file():
        return ""
    return path.read_text()


def reset_character_data(slug: str) -> AdaptationStatus:
    ensure_adaptation(slug)
    sessions = adaptation_dir(slug) / "sessions"
    if sessions.is_dir():
        for path in sessions.iterdir():
            name = path.name
            if not path.is_file():
                continue
            if name.startswith("run-discover-characters") or name.startswith("run-character-extract-"):
                path.unlink()
    metadata = read_metadata(slug)
    metadata.characters = {}
    write_metadata(slug, metadata)
    return status(slug)


def status(slug: str) -> AdaptationStatus:
    import concept_cards
    import visual_styles

    root = ensure_adaptation(slug)
    metadata = read_metadata(slug)
    metadata, artifact_changed = clear_stale_artifact_assets(slug, metadata)
    if artifact_changed:
        metadata = write_metadata(slug, metadata)

    # Seed entity-tag canonicals from character/location records: the registry
    # is the read path for consistency refs, and a manually starred canonical
    # always wins over the record-derived default.
    canonical_by_tag_id: dict[str, str | None] = {}
    for records in (metadata.characters, metadata.locations):
        for entity_slug, record in records.items():
            for variant_key, variant in record.variants.items():
                asset_id = variant.activeAssetId or (variant.assetIds[0] if variant.assetIds else None)
                if asset_id:
                    canonical_by_tag_id[library.normalize_tag_id(variant_entity_key(entity_slug, variant_key))] = asset_id
    library.update_entity_tag_canonicals(slug, canonical_by_tag_id, default_only=True)

    return AdaptationStatus(
        projectSlug=slug,
        hasBook=(root / "book.txt").is_file(),
        hasBookSession=_has_book_session(root),
        counts={
            "characters": len(metadata.characters),
            "charactersExtracted": sum(1 for record in metadata.characters.values() if character_is_extracted(record)),
            "locations": len(metadata.locations),
            "locationsExtracted": sum(1 for record in metadata.locations.values() if location_is_extracted(record)),
            "conceptArt": len(concept_cards.list_cards(slug)),
        },
        visualStyles=(styles := visual_styles.read_visual_styles(root)),
        defaultVisualStyleId=visual_styles.resolve_default_visual_style_id(styles),
        characters=metadata.characters,
        locations=metadata.locations,
    )


def read_book(slug: str) -> str:
    root = ensure_adaptation(slug)
    book = root / "book.txt"
    if not book.is_file():
        raise HTTPException(status_code=404, detail="No book.txt uploaded")
    return read_text(book)


async def import_book(slug: str, upload: UploadFile) -> AdaptationStatus:
    root = ensure_adaptation(slug)
    if upload.content_type not in {None, "text/plain", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Book import expects a text file")
    with (root / "book.txt").open("wb") as fh:
        shutil.copyfileobj(upload.file, fh)
    return status(slug)
