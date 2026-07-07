"""Project-backed comic adaptation: metadata, book text, character records."""

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
    AdaptationFileCreate,
    AdaptationFileDocument,
    AdaptationFileKind,
    AdaptationFileUpdate,
    AdaptationAssetLink,
    CharacterCreate,
    CharacterPatch,
    CharacterRecord,
    EntityVariant,
    AdaptationMetadata,
    AdaptationStatus,
    ArtifactKind,
)



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


def _clear_stale_link_group(slug: str, group: dict[str, AdaptationAssetLink]) -> bool:
    changed = False
    for key, link in list(group.items()):
        asset_ids = [asset_id for asset_id in link.assetIds if asset_exists(slug, asset_id)]
        active_asset_id = link.activeAssetId if link.activeAssetId in asset_ids else (asset_ids[-1] if asset_ids else None)
        next_status = "generated" if asset_ids else ("ready" if link.prompt else "missing")
        if asset_ids != link.assetIds or active_asset_id != link.activeAssetId or next_status != link.status:
            group[key] = link.model_copy(
                update={
                    "assetIds": asset_ids,
                    "activeAssetId": active_asset_id,
                    "status": next_status,
                }
            )
            changed = True
    return changed


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


def artifact_link_groups(metadata: AdaptationMetadata) -> tuple[dict[str, AdaptationAssetLink], ...]:
    return (metadata.locations,)


def variant_entity_key(character_slug: str, variant_key: str) -> str:
    if variant_key == "base":
        return character_slug
    return f"{character_slug}-{variant_key}"


def character_entity_keys_and_names(metadata: AdaptationMetadata) -> tuple[list[str], dict[str, str]]:
    """Flat entity-tag keys for every character variant, plus display names.

    The base variant shares the character's slug; other variants get
    `slug-<variant>` tags of their own so each durable look can carry its own
    canonical reference image."""
    keys: list[str] = []
    names: dict[str, str] = {}
    for slug_key, record in metadata.characters.items():
        display = character_display_name(record)
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


def character_is_extracted(record: CharacterRecord) -> bool:
    base = record.variants.get("base")
    return bool(record.visualDescription.strip() and base is not None and base.prompt.strip())


def character_display_name(record: CharacterRecord) -> str:
    return record.name.strip() or " ".join(part.capitalize() for part in record.slug.split("-") if part)


def list_characters(slug: str) -> list[CharacterRecord]:
    metadata = read_metadata(slug)
    return [metadata.characters[key] for key in sorted(metadata.characters)]


def create_character(slug: str, payload: CharacterCreate) -> CharacterRecord:
    metadata = read_metadata(slug)
    character_slug = payload.slug or slugify(payload.name, "character")
    if character_slug in metadata.characters:
        raise HTTPException(status_code=409, detail=f"Character already exists: {character_slug}")
    now = utc_now()
    record = CharacterRecord(
        slug=character_slug,
        name=payload.name.strip(),
        summary=payload.summary,
        createdAt=now,
        updatedAt=now,
    )
    metadata.characters[character_slug] = record
    write_metadata(slug, metadata)
    return record


def update_character(slug: str, character_slug: str, patch: CharacterPatch) -> CharacterRecord:
    metadata = read_metadata(slug)
    record = metadata.characters.get(character_slug)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Character not found: {character_slug}")
    updates: dict[str, Any] = {}
    for field in ("name", "summary", "visualDescription", "performanceNotes", "continuityNotes"):
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
        merged = existing.model_copy(
            update={
                key: value
                for key, value in variant_patch.model_dump(exclude_none=True).items()
            }
        )
        variants[variant_key] = merged
    for variant_key in patch.removeVariants or []:
        variants.pop(variant_key, None)
    updates["variants"] = variants
    next_slug = patch.slug or character_slug
    if next_slug != character_slug:
        if next_slug in metadata.characters:
            raise HTTPException(status_code=409, detail=f"Character already exists: {next_slug}")
        updates["slug"] = next_slug
    updates["updatedAt"] = utc_now()
    next_record = record.model_copy(update=updates)
    if next_slug != character_slug:
        metadata.characters.pop(character_slug)
    metadata.characters[next_slug] = next_record
    write_metadata(slug, metadata)
    return next_record


def delete_character(slug: str, character_slug: str) -> AdaptationStatus:
    metadata = read_metadata(slug)
    if character_slug not in metadata.characters:
        raise HTTPException(status_code=404, detail=f"Character not found: {character_slug}")
    metadata.characters.pop(character_slug)
    write_metadata(slug, metadata)
    return status(slug)


def clear_stale_artifact_assets(slug: str, metadata: AdaptationMetadata) -> tuple[AdaptationMetadata, bool]:
    changed = False
    for group in artifact_link_groups(metadata):
        if _clear_stale_link_group(slug, group):
            changed = True
    for character_slug, record in list(metadata.characters.items()):
        variants = dict(record.variants)
        if _clear_stale_variant_group(slug, variants):
            metadata.characters[character_slug] = record.model_copy(update={"variants": variants})
            changed = True
    return metadata, changed


def ensure_adaptation(slug: str) -> Path:
    root = adaptation_dir(slug)
    for path in [
        root / "sessions",
        root / "style-refs",
        root / "locations",
        root / "locations" / "prompts",
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


def import_artifact_to_canvas(slug: str, artifact_kind: str, artifact_key: str) -> AdaptationCanvasImportResponse:
    metadata = sync_location_links(slug, read_metadata(slug))
    from canvas_nodes import spawn_from_location

    if artifact_kind == "location-prompt":
        entry = metadata.locations.get(artifact_key)
        if entry is None:
            raise HTTPException(status_code=404, detail=f"Unknown adaptation artifact: {artifact_kind}:{artifact_key}")
        if not entry.prompt.strip():
            raise HTTPException(status_code=400, detail=f"Missing prompt for location: {artifact_key}")
        node_id, saved = spawn_from_location(slug, artifact_key)
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported artifact kind for draft import: {artifact_kind}")
    return AdaptationCanvasImportResponse(canvas=saved, importedNodeCount=1, nodeId=node_id)


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


def read_metadata(slug: str) -> AdaptationMetadata:
    ensure_adaptation(slug)
    return AdaptationMetadata.model_validate(library.read_json(metadata_path(slug)))


def write_metadata(slug: str, metadata: AdaptationMetadata) -> AdaptationMetadata:
    library.write_json(metadata_path(slug), metadata.model_dump(mode="json"))
    character_keys, character_names = character_entity_keys_and_names(metadata)
    library.sync_entity_tags(
        slug,
        character_keys=character_keys,
        location_keys=list(metadata.locations.keys()),
        character_names=character_names,
    )
    return metadata


def relpath(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def read_text(path: Path) -> str:
    if not path.is_file():
        return ""
    return path.read_text()


def slug_from_heading(line: str) -> str:
    return line.removeprefix("## ").strip()


def parse_prompt_sections(path: Path) -> dict[str, dict[str, str]]:
    sections: dict[str, dict[str, str]] = {}
    current: str | None = None
    mode = ""
    style_ref = ""
    subject = ""
    prompt_lines: list[str] = []
    in_prompt = False
    for raw_line in read_text(path).splitlines():
        if raw_line.startswith("## "):
            if current is not None:
                sections[current] = {
                    "mode": mode,
                    "style_ref": style_ref,
                    "subject": subject,
                    "prompt": "\n".join(prompt_lines).strip(),
                }
            current = slug_from_heading(raw_line)
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


def file_kind_config(kind: AdaptationFileKind) -> tuple[ArtifactKind, Path]:
    root = Path()
    configs: dict[AdaptationFileKind, tuple[ArtifactKind, Path]] = {
        "locations": ("location-prompt", root / "locations" / "prompts"),
    }
    return configs[kind]


def adaptation_file_path(slug: str, kind: AdaptationFileKind, key: str) -> Path:
    root = ensure_adaptation(slug)
    _artifact_kind, directory = file_kind_config(kind)
    return root / directory / f"{key}.md"


def format_prompt_file(key: str, body: str, mode: str, style_ref: str, *, subject: str = "") -> str:
    subject_line = f"subject: {subject.strip()}\n" if subject.strip() else ""
    return f"## {key}\n{subject_line}mode: {mode.strip()}\nstyle_ref: {style_ref.strip()}\n\n{body.strip()}\n"


def format_adaptation_file(
    kind: AdaptationFileKind,
    key: str,
    body: str,
    mode: str,
    style_ref: str,
    *,
    subject_kind: str = "",
) -> str:
    return format_prompt_file(key, body, mode or "new-image", style_ref)


def adaptation_file_from_link(
    *,
    slug: str,
    kind: AdaptationFileKind,
    key: str,
    link: AdaptationAssetLink,
) -> AdaptationFileDocument:
    return AdaptationFileDocument(
        kind=kind,
        key=key,
        promptPath=link.promptPath,
        artifactKind=link.artifactKind,
        body=link.prompt,
        mode=link.mode,
        styleRef=link.styleRef,
        subjectKind=link.subjectKind,
        status=link.status,
    )


def list_adaptation_files(slug: str, kind: AdaptationFileKind) -> list[AdaptationFileDocument]:
    root = ensure_adaptation(slug)
    metadata = sync_location_links(slug, read_metadata(slug))
    groups: dict[AdaptationFileKind, dict[str, AdaptationAssetLink]] = {
        "locations": metadata.locations,
    }
    return [
        adaptation_file_from_link(slug=slug, kind=kind, key=key, link=link)
        for key, link in sorted(groups[kind].items())
        if (root / link.promptPath).is_file()
    ]


def create_adaptation_file(slug: str, kind: AdaptationFileKind, payload: AdaptationFileCreate) -> AdaptationFileDocument:
    path = adaptation_file_path(slug, kind, payload.key)
    if path.exists():
        raise HTTPException(status_code=409, detail=f"{kind} file already exists: {payload.key}")
    path.write_text(
        format_adaptation_file(
            kind,
            payload.key,
            payload.body,
            payload.mode,
            payload.styleRef,
            subject_kind=payload.subjectKind or "",
        )
    )
    metadata = sync_location_links(slug, read_metadata(slug))
    write_metadata(slug, metadata)
    files = {item.key: item for item in list_adaptation_files(slug, kind)}
    if payload.key not in files:
        raise HTTPException(status_code=500, detail=f"Failed to register {kind} file: {payload.key}")
    return files[payload.key]


def update_adaptation_file(slug: str, kind: AdaptationFileKind, key: str, payload: AdaptationFileUpdate) -> AdaptationFileDocument:
    current_path = adaptation_file_path(slug, kind, key)
    if not current_path.exists():
        raise HTTPException(status_code=404, detail=f"{kind} file not found: {key}")
    current_files = {item.key: item for item in list_adaptation_files(slug, kind)}
    current = current_files.get(key)
    if current is None:
        raise HTTPException(status_code=404, detail=f"{kind} file not found: {key}")
    next_key = payload.key or current.key
    next_path = adaptation_file_path(slug, kind, next_key)
    if next_key != key and next_path.exists():
        raise HTTPException(status_code=409, detail=f"{kind} file already exists: {next_key}")
    next_body = current.body if payload.body is None else payload.body
    next_mode = current.mode if payload.mode is None else payload.mode
    next_style_ref = current.styleRef if payload.styleRef is None else payload.styleRef
    if next_key != key:
        current_path.unlink()
    next_path.write_text(
        format_adaptation_file(
            kind,
            next_key,
            next_body,
            next_mode,
            next_style_ref,
        )
    )
    if next_key != key:
        metadata = read_metadata(slug)
        existing = metadata.locations.pop(key, None)
        if existing is not None:
            metadata.locations[next_key] = existing
            write_metadata(slug, metadata)
    if payload.userTags is not None:
        metadata = sync_location_links(slug, read_metadata(slug))
        link = metadata.locations.get(next_key)
        if link is not None:
            metadata.locations[next_key] = link.model_copy(update={"userTags": list(payload.userTags)})
            write_metadata(slug, metadata)
    files = {item.key: item for item in list_adaptation_files(slug, kind)}
    return files[next_key]


def delete_adaptation_file(slug: str, kind: AdaptationFileKind, key: str) -> AdaptationStatus:
    current_path = adaptation_file_path(slug, kind, key)
    if not current_path.exists():
        raise HTTPException(status_code=404, detail=f"{kind} file not found: {key}")
    current_path.unlink()
    metadata = sync_location_links(slug, read_metadata(slug))
    write_metadata(slug, metadata)
    return status(slug)


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


def prompt_link(
    *,
    artifact_kind: ArtifactKind,
    prompt_path: str,
    section: dict[str, str],
    existing: AdaptationAssetLink | None,
) -> AdaptationAssetLink:
    asset_ids = list(existing.assetIds) if existing else []
    active_asset_id = existing.activeAssetId if existing else None
    if active_asset_id and active_asset_id not in asset_ids:
        active_asset_id = asset_ids[-1] if asset_ids else None
    elif not active_asset_id and asset_ids:
        active_asset_id = asset_ids[-1]
    subject_raw = section.get("subject", "").strip()
    subject_kind = subject_raw if subject_raw in {"character", "location"} else None
    if subject_kind is None and existing is not None:
        subject_kind = existing.subjectKind
    return AdaptationAssetLink(
        artifactKind=artifact_kind,
        promptPath=prompt_path,
        subjectKind=subject_kind,
        mode=section.get("mode", ""),
        styleRef=section.get("style_ref", ""),
        prompt=section.get("prompt", ""),
        narration=section.get("narration", ""),
        dialogue=section.get("dialogue", ""),
        caption=section.get("caption", ""),
        assetIds=asset_ids,
        activeAssetId=active_asset_id,
        finalized=existing.finalized if existing else False,
        status="generated" if asset_ids else "ready",
        userTags=list(existing.userTags) if existing else [],
    )


def sync_location_links(slug: str, metadata: AdaptationMetadata) -> AdaptationMetadata:
    """Rebuild location links from locations/prompts/*.md. Characters live in
    adaptation.json directly and are never touched here."""
    root = ensure_adaptation(slug)
    old_locations = metadata.locations
    new_locations: dict[str, AdaptationAssetLink] = {}
    for prompt_file in sorted((root / "locations" / "prompts").glob("*.md")):
        prompt_path = relpath(root, prompt_file)
        for key, section in parse_prompt_sections(prompt_file).items():
            existing = old_locations.get(key)
            new_locations[key] = prompt_link(
                artifact_kind="location-prompt",
                prompt_path=prompt_path,
                section=section,
                existing=existing,
            )
    metadata.locations = new_locations
    return write_metadata(slug, metadata)


def status(slug: str) -> AdaptationStatus:
    import concept_cards
    import visual_styles

    root = ensure_adaptation(slug)
    metadata = sync_location_links(slug, read_metadata(slug))
    metadata, artifact_changed = clear_stale_artifact_assets(slug, metadata)
    if artifact_changed:
        metadata = write_metadata(slug, metadata)

    # Seed entity-tag canonicals from character/location records: the registry
    # is the read path for consistency refs, and a manually starred canonical
    # always wins over the record-derived default.
    canonical_by_tag_id: dict[str, str | None] = {}
    for character_slug, record in metadata.characters.items():
        for variant_key, variant in record.variants.items():
            asset_id = variant.activeAssetId or (variant.assetIds[0] if variant.assetIds else None)
            if asset_id:
                canonical_by_tag_id[library.normalize_tag_id(variant_entity_key(character_slug, variant_key))] = asset_id
    for location_key, link in metadata.locations.items():
        asset_id = link.activeAssetId or (link.assetIds[0] if link.assetIds else None)
        if asset_id:
            canonical_by_tag_id[library.normalize_tag_id(location_key)] = asset_id
    library.update_entity_tag_canonicals(slug, canonical_by_tag_id, default_only=True)

    return AdaptationStatus(
        projectSlug=slug,
        hasBook=(root / "book.txt").is_file(),
        hasBookSession=_has_book_session(root),
        counts={
            "characters": len(metadata.characters),
            "charactersExtracted": sum(1 for record in metadata.characters.values() if character_is_extracted(record)),
            "locationPrompts": len(list((root / "locations" / "prompts").glob("*.md"))),
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

