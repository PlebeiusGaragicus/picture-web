"""Filesystem-backed photo-library operations."""

from __future__ import annotations

import json
import hashlib
import logging
import os
import random
import re
import shutil
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile
from PIL import Image

import paths
from ids import new_seed, new_ulid
from common import utc_now
from models import (
    ArchivePatch,
    AssetMetadata,
    AssetSummary,
    CanvasDocument,
    ChatSessionDocument,
    ChatTurn,
    CanvasNode,
    DisplayPatch,
    GenerateRequest,
    GenerateResponse,
    GenerationParams,
    GenerationReceipt,
    Prompt,
    ProviderCapture,
    ProjectCreate,
    ProjectDetail,
    ProjectMetadata,
    TagDefinition,
    TagRegistryDocument,
    TAG_RE,
    EntityKind,
)

LIBRARY_ROOT = paths.HOME
PROJECTS_ROOT = LIBRARY_ROOT / "projects"
SEED_DEFAULTS_ROOT = paths.SEED_DEFAULTS_DIR
SYSTEM_TRASH = Path(os.environ.get("PHOTO_WEB_TRASH_DIR", str(Path.home() / ".Trash")))
THUMB_MAX_SIZE = (384, 384)
DEFAULT_STARTER_DRAFT_NODE_ID = "draft_seed"
logger = logging.getLogger(__name__)


def list_seed_default_prompts() -> list[tuple[str, str]]:
    if not SEED_DEFAULTS_ROOT.is_dir():
        return []
    seeds: list[tuple[str, str]] = []
    for path in sorted(SEED_DEFAULTS_ROOT.glob("*.md")):
        prompt = path.read_text().strip()
        if prompt:
            display_name = path.stem.replace("-", " ").replace("_", " ").strip().title()
            seeds.append((display_name, prompt))
    return seeds


def pick_random_seed_default_prompt() -> tuple[str, str] | None:
    seeds = list_seed_default_prompts()
    if not seeds:
        return None
    return random.choice(seeds)


def style_seed_nodes() -> dict[str, CanvasNode]:
    """Ordinary style-anchor nodes: generate, pick a take, it becomes the style canonical."""
    return {
        "style_character": CanvasNode(
            displayName="Character Style",
            x=80,
            y=-220,
            width=240,
            tags=["adaptation", "archetype", "character-style"],
            params=GenerationParams(aspectRatio="1:1", imageSize="1K", batchCount=1),
        ),
        "style_scene": CanvasNode(
            displayName="Scene Style",
            x=400,
            y=-220,
            width=240,
            tags=["adaptation", "archetype", "scene-style"],
            params=GenerationParams(aspectRatio="1:1", imageSize="1K", batchCount=1),
        ),
    }


def default_canvas_for_new_project() -> CanvasDocument:
    nodes: dict[str, CanvasNode] = dict(style_seed_nodes())
    seed = pick_random_seed_default_prompt()
    if seed is not None:
        display_name, prompt = seed
        nodes[DEFAULT_STARTER_DRAFT_NODE_ID] = CanvasNode(
            displayName=display_name,
            x=120,
            y=120,
            refs=[],
            prompt=prompt,
            params=GenerationParams(
                model="gemini-3.1-flash-image",
                aspectRatio="16:9",
                imageSize="1K",
                batchCount=1,
            ),
        )
    return CanvasDocument(nodes=nodes)


def ensure_library() -> None:
    PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)


def project_dir(slug: str) -> Path:
    return PROJECTS_ROOT / slug


def assets_dir(slug: str) -> Path:
    return project_dir(slug) / "assets"


def asset_json_path(slug: str, asset_id: str) -> Path:
    return assets_dir(slug) / f"{asset_id}.json"


def asset_png_path(slug: str, asset_id: str) -> Path:
    return assets_dir(slug) / f"{asset_id}.png"


def project_json_path(slug: str) -> Path:
    return project_dir(slug) / "project.json"


def canvas_json_path(slug: str) -> Path:
    return project_dir(slug) / "canvas.json"


def tags_json_path(slug: str) -> Path:
    return project_dir(slug) / "tags.json"


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Not found: {path.name}") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"Invalid JSON: {path}") from exc


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n")


def require_project(slug: str) -> None:
    if not project_json_path(slug).is_file():
        raise HTTPException(status_code=404, detail=f"Project not found: {slug}")


def list_projects() -> list[ProjectMetadata]:
    ensure_library()
    projects: list[ProjectMetadata] = []
    for path in sorted(PROJECTS_ROOT.glob("*/project.json")):
        slug = path.parent.name
        projects.append(enrich_project(slug, ProjectMetadata.model_validate(read_json(path))))
    return projects


def create_project(payload: ProjectCreate) -> ProjectMetadata:
    ensure_library()
    root = project_dir(payload.slug)
    if root.exists():
        raise HTTPException(status_code=409, detail=f"Project already exists: {payload.slug}")
    now = utc_now()
    project = ProjectMetadata(
        slug=payload.slug,
        name=payload.name,
        createdAt=now,
        settings=payload.settings,
    )
    assets_dir(payload.slug).mkdir(parents=True, exist_ok=True)
    write_json(project_json_path(payload.slug), project_json_payload(project))
    write_json(tags_json_path(payload.slug), TagRegistryDocument().model_dump(mode="json"))
    write_json(canvas_json_path(payload.slug), default_canvas_for_new_project().model_dump(mode="json"))
    return project


def delete_project(slug: str) -> None:
    require_project(slug)
    logger.debug("delete project slug=%s", slug)
    move_to_trash(project_dir(slug))


def get_project(slug: str) -> ProjectMetadata:
    require_project(slug)
    return enrich_project(slug, ProjectMetadata.model_validate(read_json(project_json_path(slug))))


def project_json_payload(project: ProjectMetadata) -> dict[str, Any]:
    return project.model_dump(mode="json", exclude={"coverThumbnailUrl"})


def enrich_project(slug: str, project: ProjectMetadata) -> ProjectMetadata:
    cover_id = project.coverAssetId
    thumb_url = None
    if cover_id and asset_json_path(slug, cover_id).is_file() and asset_png_path(slug, cover_id).is_file():
        thumb_url = f"/api/projects/{slug}/assets/{cover_id}/thumb"
    return project.model_copy(update={"coverThumbnailUrl": thumb_url})


def patch_project_cover(slug: str, cover_asset_id: str | None) -> ProjectMetadata:
    require_project(slug)
    project = ProjectMetadata.model_validate(read_json(project_json_path(slug)))
    if cover_asset_id is not None:
        asset = read_asset(slug, cover_asset_id)
        if not asset.hasPixels:
            raise HTTPException(status_code=400, detail="Cover asset must have image pixels")
    project.coverAssetId = cover_asset_id
    write_json(project_json_path(slug), project_json_payload(project))
    return enrich_project(slug, project)


def get_project_detail(slug: str) -> ProjectDetail:
    return ProjectDetail(project=get_project(slug), assets=list_assets(slug), tags=list_project_tags(slug))


def normalize_tag_id(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    if not normalized or not re.match(TAG_RE, normalized):
        raise HTTPException(status_code=400, detail=f"Invalid tag slug: {value}")
    return normalized


def normalize_tag_name(name: str) -> str:
    return normalize_tag_id(name)


def coerce_tag_definition(raw: dict[str, Any]) -> TagDefinition:
    if "id" in raw:
        return TagDefinition.model_validate(raw)
    slug = normalize_tag_id(str(raw["name"]))
    display_name = str(raw.get("name", slug)).strip() or slug
    return TagDefinition(id=slug, name=display_name, color=str(raw["color"]))


def read_tag_registry(slug: str) -> TagRegistryDocument:
    require_project(slug)
    path = tags_json_path(slug)
    if not path.is_file():
        return TagRegistryDocument()
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return TagRegistryDocument()
    raw_tags = payload.get("tags", []) if isinstance(payload, dict) else []
    tags = [coerce_tag_definition(item) for item in raw_tags if isinstance(item, dict)]
    return TagRegistryDocument(tags=tags)


def write_tag_registry(
    slug: str,
    registry: TagRegistryDocument,
    *,
    preserve_orphan_locked_entity_tags: bool = True,
) -> TagRegistryDocument:
    require_project(slug)
    existing = read_tag_registry(slug)
    locked_by_id = {tag.id: tag for tag in existing.tags if tag.locked}
    normalized_incoming = [
        TagDefinition(
            id=normalize_tag_id(tag.id),
            name=tag.name.strip(),
            color=tag.color,
            locked=tag.locked,
            entityKind=tag.entityKind,
            canonicalAssetId=tag.canonicalAssetId,
        )
        for tag in registry.tags
    ]
    next_by_id: dict[str, TagDefinition] = {}
    for tag in normalized_incoming:
        existing_locked = locked_by_id.get(tag.id)
        if existing_locked is not None and not tag.locked:
            next_by_id[tag.id] = existing_locked
        else:
            next_by_id[tag.id] = tag
    if preserve_orphan_locked_entity_tags:
        for tag_id, locked_tag in locked_by_id.items():
            next_by_id.setdefault(tag_id, locked_tag)
    normalized = TagRegistryDocument(
        tags=sorted(next_by_id.values(), key=lambda item: item.name),
    )
    write_json(tags_json_path(slug), normalized.model_dump(mode="json", exclude_none=True, exclude_defaults=True))
    return normalized


ENTITY_TAG_COLORS: dict[EntityKind, str] = {
    "character": "#3b82f6",
    "location": "#f59e0b",
    "style": "#c084fc",
}


def entity_display_name(key: str) -> str:
    return " ".join(part.capitalize() for part in key.split("-") if part)


def entity_tag_for_key(key: str, entity_kind: EntityKind) -> TagDefinition:
    normalized_id = normalize_tag_id(key)
    return TagDefinition(
        id=normalized_id,
        name=entity_display_name(normalized_id),
        color=ENTITY_TAG_COLORS[entity_kind],
        locked=True,
        entityKind=entity_kind,
    )


def sync_entity_tags(
    slug: str,
    *,
    character_keys: list[str],
    location_keys: list[str],
    entity_names: dict[str, str] | None = None,
) -> TagRegistryDocument:
    registry = read_tag_registry(slug)
    entity_ids = {normalize_tag_id(key) for key in character_keys} | {normalize_tag_id(key) for key in location_keys}
    user_tags = [tag for tag in registry.tags if not tag.locked and tag.id not in entity_ids]
    style_tags = [tag for tag in registry.tags if tag.entityKind == "style" and tag.id not in entity_ids]
    canonical_by_id = {tag.id: tag.canonicalAssetId for tag in registry.tags if tag.canonicalAssetId}
    names_by_id = {
        normalize_tag_id(key): name.strip()
        for key, name in (entity_names or {}).items()
        if name.strip()
    }
    entity_tags = [
        *[entity_tag_for_key(key, "character") for key in sorted(character_keys)],
        *[entity_tag_for_key(key, "location") for key in sorted(location_keys)],
    ]
    entity_tags = [
        tag.model_copy(update={"name": names_by_id[tag.id]}) if tag.id in names_by_id else tag
        for tag in entity_tags
    ]
    entity_tags = [
        tag.model_copy(update={"canonicalAssetId": canonical_by_id.get(tag.id)}) if tag.id in canonical_by_id else tag
        for tag in entity_tags
    ]
    return write_tag_registry(
        slug,
        TagRegistryDocument(tags=[*user_tags, *style_tags, *entity_tags]),
        preserve_orphan_locked_entity_tags=False,
    )


def update_entity_tag_canonicals(
    slug: str,
    canonical_by_tag_id: dict[str, str | None],
    *,
    default_only: bool = False,
) -> None:
    """Point entity tags at their canonical reference image; writes only on change.

    With default_only, a tag that already has a canonical keeps it — the user's
    explicit ★ choice wins over record-derived defaults."""
    registry = read_tag_registry(slug)
    changed = False
    next_tags: list[TagDefinition] = []
    for tag in registry.tags:
        if (
            tag.entityKind is not None
            and tag.id in canonical_by_tag_id
            and tag.canonicalAssetId != canonical_by_tag_id[tag.id]
            and not (default_only and tag.canonicalAssetId is not None)
        ):
            next_tags.append(tag.model_copy(update={"canonicalAssetId": canonical_by_tag_id[tag.id]}))
            changed = True
        else:
            next_tags.append(tag)
    if changed:
        write_tag_registry(slug, TagRegistryDocument(tags=next_tags))


def locked_entity_tag_ids(slug: str) -> set[str]:
    return {tag.id for tag in list_project_tags(slug) if tag.locked}


def assets_for_entity_tag(slug: str, tag_id: str) -> list[str]:
    normalized = normalize_tag_id(tag_id)
    return [asset.id for asset in list_assets(slug) if normalized in asset.tags]


def apply_entity_tag_to_asset(slug: str, asset_id: str, entity_key: str) -> AssetSummary:
    metadata = read_asset_metadata(slug, asset_id)
    entity_tag = normalize_tag_id(entity_key)
    if entity_tag not in metadata.tags:
        metadata.tags = [*metadata.tags, entity_tag]
        metadata.updatedAt = utc_now()
        return write_asset_metadata(slug, metadata)
    return metadata_to_summary(slug, metadata)


def merge_asset_tags_preserving_locked(slug: str, asset_id: str, requested_tags: list[str]) -> list[str]:
    metadata = read_asset_metadata(slug, asset_id)
    locked_ids = locked_entity_tag_ids(slug)
    preserved = [tag for tag in metadata.tags if tag in locked_ids]
    return list(dict.fromkeys([*requested_tags, *preserved]))


def list_project_tags(slug: str) -> list[TagDefinition]:
    return read_tag_registry(slug).tags


def upsert_tag(slug: str, tag: TagDefinition) -> TagRegistryDocument:
    registry = read_tag_registry(slug)
    normalized_id = normalize_tag_id(tag.id)
    next_tags = [existing for existing in registry.tags if existing.id != normalized_id]
    next_tags.append(
        TagDefinition(
            id=normalized_id,
            name=tag.name.strip(),
            color=tag.color,
            locked=tag.locked,
            entityKind=tag.entityKind,
            canonicalAssetId=tag.canonicalAssetId,
        )
    )
    return write_tag_registry(slug, TagRegistryDocument(tags=sorted(next_tags, key=lambda item: item.name)))


def metadata_to_summary(slug: str, metadata: AssetMetadata) -> AssetSummary:
    data = metadata.model_dump(mode="json")
    data["hasPixels"] = asset_png_path(slug, metadata.id).is_file()
    data["thumbnailUrl"] = f"/api/projects/{slug}/assets/{metadata.id}/thumb"
    try:
        import chat_sessions

        data["isProtected"] = metadata.id in chat_sessions.protected_asset_ids(slug)
    except Exception:
        data["isProtected"] = False
    return AssetSummary.model_validate(data)


def list_assets(slug: str, include_archived: bool = False) -> list[AssetSummary]:
    require_project(slug)
    items: list[AssetSummary] = []
    for path in sorted(assets_dir(slug).glob("*.json")):
        metadata = AssetMetadata.model_validate(read_json(path))
        if metadata.archivedAt is not None and not include_archived:
            continue
        items.append(metadata_to_summary(slug, metadata))
    return items


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def matching_import_by_hash(slug: str, content_hash: str) -> AssetSummary | None:
    for asset in list_assets(slug):
        if asset.kind == "imported" and asset.contentHash == content_hash:
            return asset
    return None


def read_asset(slug: str, asset_id: str) -> AssetSummary:
    require_project(slug)
    metadata = AssetMetadata.model_validate(read_json(asset_json_path(slug, asset_id)))
    return metadata_to_summary(slug, metadata)


def read_asset_metadata(slug: str, asset_id: str) -> AssetMetadata:
    require_project(slug)
    return AssetMetadata.model_validate(read_json(asset_json_path(slug, asset_id)))


def write_asset_metadata(slug: str, metadata: AssetMetadata) -> AssetSummary:
    logger.debug("write asset metadata slug=%s asset_id=%s kind=%s title=%s", slug, metadata.id, metadata.kind, metadata.title)
    write_json(asset_json_path(slug, metadata.id), metadata.model_dump(mode="json"))
    return metadata_to_summary(slug, metadata)


def move_to_trash(path: Path) -> None:
    if not path.exists():
        logger.debug("trash skip missing path=%s", path)
        return
    destination = SYSTEM_TRASH / path.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    counter = 1
    while destination.exists():
        destination = SYSTEM_TRASH / f"{path.stem}_{counter}{path.suffix}"
        counter += 1
    shutil.move(str(path), str(destination))
    logger.debug("moved to trash source=%s destination=%s", path, destination)


def detach_asset_from_project(slug: str, asset_id: str) -> None:
    canvas = read_stored_canvas(slug)
    changed = False
    for node_id, node in list(canvas.nodes.items()):
        next_refs = [ref for ref in node.refs if ref != asset_id]
        if next_refs != node.refs:
            node.refs = next_refs
            canvas.nodes[node_id] = node
            changed = True
        if asset_id in node.assetIds:
            node.assetIds = [current_id for current_id in node.assetIds if current_id != asset_id]
            if node.assetIds:
                if node.activeAssetId == asset_id or node.activeAssetId not in node.assetIds:
                    node.activeAssetId = node.assetIds[0]
                canvas.nodes[node_id] = node
            elif node.prompt.strip() or node.refs or node.visualStyleId is not None:
                node.activeAssetId = None
                canvas.nodes[node_id] = node
            else:
                del canvas.nodes[node_id]
            changed = True
    if changed:
        write_canvas(slug, canvas)
        logger.debug("detached asset from canvas slug=%s asset_id=%s", slug, asset_id)

    stale_canonicals = {
        tag.id: None
        for tag in list_project_tags(slug)
        if tag.canonicalAssetId == asset_id
    }
    if stale_canonicals:
        update_entity_tag_canonicals(slug, stale_canonicals)

    project_path = project_json_path(slug)
    if project_path.is_file():
        project = ProjectMetadata.model_validate(read_json(project_path))
        if project.coverAssetId == asset_id:
            project.coverAssetId = None
            write_json(project_path, project_json_payload(project))


def delete_asset(slug: str, asset_id: str) -> None:
    require_project(slug)
    if not asset_json_path(slug, asset_id).is_file():
        raise HTTPException(status_code=404, detail=f"Asset not found: {asset_id}")
    import chat_sessions

    blockers = chat_sessions.blocking_session_ids(slug, asset_id)
    if blockers:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Asset is protected by chat session history. Archive it instead.",
                "chatSessionIds": blockers,
            },
        )
    logger.debug("delete asset slug=%s asset_id=%s", slug, asset_id)
    move_to_trash(asset_json_path(slug, asset_id))
    move_to_trash(asset_png_path(slug, asset_id))
    detach_asset_from_project(slug, asset_id)


def patch_display(slug: str, asset_id: str, payload: DisplayPatch) -> AssetSummary:
    metadata = read_asset_metadata(slug, asset_id)
    updates = payload.model_dump(exclude_unset=True)
    if "title" in updates and updates["title"] is not None:
        metadata.title = updates["title"]
    if "tags" in updates and updates["tags"] is not None:
        metadata.tags = merge_asset_tags_preserving_locked(slug, asset_id, updates["tags"])
    metadata.updatedAt = utc_now()
    return write_asset_metadata(slug, metadata)


def patch_archive(slug: str, asset_id: str, payload: ArchivePatch) -> AssetSummary:
    metadata = read_asset_metadata(slug, asset_id)
    metadata.archivedAt = utc_now() if payload.archived else None
    metadata.updatedAt = utc_now()
    summary = write_asset_metadata(slug, metadata)
    if not payload.archived:
        restore_asset_to_canvas(slug, asset_id)
    return summary


def read_canvas(slug: str, include_archived: bool = False) -> CanvasDocument:
    require_project(slug)
    canvas = default_canvas_for_assets(slug, read_stored_canvas(slug), include_archived=include_archived)
    return normalize_variant_groups(slug, canvas)


def read_stored_canvas(slug: str) -> CanvasDocument:
    require_project(slug)
    path = canvas_json_path(slug)
    if not path.is_file():
        return CanvasDocument()
    return CanvasDocument.model_validate(read_json(path))


def write_canvas(slug: str, canvas: CanvasDocument) -> CanvasDocument:
    require_project(slug)
    validate_canvas(slug, canvas)
    write_json(canvas_json_path(slug), canvas.model_dump(mode="json"))
    return canvas


def validate_canvas(slug: str, canvas: CanvasDocument) -> None:
    require_project(slug)
    for node_id, node in canvas.nodes.items():
        validate_refs(slug, node.refs)
        for asset_id in node.assetIds:
            if not asset_json_path(slug, asset_id).is_file() or not asset_png_path(slug, asset_id).is_file():
                raise HTTPException(status_code=400, detail=f"Invalid asset in canvas node {node_id}: {asset_id}")


def canvas_node_id(asset_id: str) -> str:
    return f"node_{asset_id}"


def node_tags(*tags: str) -> list[str]:
    return list(dict.fromkeys(tags))


def restore_asset_to_canvas(slug: str, asset_id: str) -> None:
    canvas = read_stored_canvas(slug)
    represented = {
        current_id
        for node in canvas.nodes.values()
        for current_id in node.assetIds
    }
    if asset_id in represented:
        return
    metadata = read_asset_metadata(slug, asset_id)
    asset = metadata_to_summary(slug, metadata)
    index = len(canvas.nodes)
    max_story_x = 80.0
    for node in canvas.nodes.values():
        if not node.assetIds:
            max_story_x = max(max_story_x, node.x + (node.width or 240) + 80)
    asset_start_x = max(1500.0, max_story_x)
    node_id = canvas_node_id(asset.id)
    while node_id in canvas.nodes:
        node_id = f"{canvas_node_id(asset.id)}_{index}"
        index += 1
    canvas.nodes[node_id] = CanvasNode(
        displayName=asset.title,
        x=asset_start_x + (index % 3) * 280,
        y=80 + (index // 3) * 240,
        tags=node_tags(*asset.tags, "generated-image" if asset.kind == "generated" else "imported-image"),
        assetIds=[asset.id],
        activeAssetId=asset.id,
    )
    write_canvas(slug, canvas)
    logger.debug("restored asset to canvas slug=%s asset_id=%s", slug, asset_id)


def default_canvas_for_assets(slug: str, canvas: CanvasDocument, include_archived: bool = False) -> CanvasDocument:
    """Add visible image groups for assets not yet represented on the canvas."""
    next_canvas = canvas.model_copy(deep=True)
    represented = {
        asset_id
        for node in next_canvas.nodes.values()
        for asset_id in node.assetIds
    }
    index = len(next_canvas.nodes)
    max_story_x = 80.0
    for node in next_canvas.nodes.values():
        if not node.assetIds:
            max_story_x = max(max_story_x, node.x + (node.width or 240) + 80)
    asset_start_x = max(1500.0, max_story_x)
    for asset in list_assets(slug, include_archived=include_archived):
        if asset.id in represented:
            continue
        node_id = canvas_node_id(asset.id)
        while node_id in next_canvas.nodes:
            node_id = f"{canvas_node_id(asset.id)}_{index}"
            index += 1
        next_canvas.nodes[node_id] = CanvasNode(
            displayName=asset.title,
            x=asset_start_x + (index % 3) * 280,
            y=80 + (index // 3) * 240,
            tags=node_tags(*asset.tags, "generated-image" if asset.kind == "generated" else "imported-image"),
            assetIds=[asset.id],
            activeAssetId=asset.id,
        )
        index += 1
    return next_canvas


def variant_key_for_asset(slug: str, asset_id: str) -> tuple[str, tuple[str, ...]] | None:
    metadata = read_asset_metadata(slug, asset_id)
    if metadata.kind != "generated" or metadata.prompt is None or metadata.generation is None:
        return None
    return (metadata.prompt.text, tuple(metadata.generation.refs))


def variant_key_for_node(slug: str, node: CanvasNode) -> tuple[str, tuple[str, ...]] | None:
    for asset_id in node.assetIds:
        key = variant_key_for_asset(slug, asset_id)
        if key is not None:
            return key
    return None


STYLE_ENTITY_TAGS: dict[str, str] = {
    "character-style": "Character Style",
    "scene-style": "Scene Style",
}


def ensure_style_entity_tags(slug: str) -> None:
    """Seed the two style entity tags; their canonicalAssetId anchors visual consistency."""
    registry = read_tag_registry(slug)
    present = {tag.id for tag in registry.tags}
    missing = [tag_id for tag_id in STYLE_ENTITY_TAGS if tag_id not in present]
    if not missing:
        return
    next_tags = [
        *registry.tags,
        *[
            TagDefinition(
                id=tag_id,
                name=STYLE_ENTITY_TAGS[tag_id],
                color=ENTITY_TAG_COLORS["style"],
                locked=True,
                entityKind="style",
            )
            for tag_id in missing
        ],
    ]
    write_tag_registry(slug, TagRegistryDocument(tags=next_tags))


def set_tag_canonical(slug: str, tag_id: str, asset_id: str | None) -> list[TagDefinition]:
    """Point an entity tag at its canonical reference image."""
    normalized = normalize_tag_id(tag_id)
    tag = next((item for item in list_project_tags(slug) if item.id == normalized), None)
    if tag is None or tag.entityKind is None:
        raise HTTPException(status_code=404, detail=f"Unknown entity tag: {tag_id}")
    if asset_id is not None:
        read_asset_metadata(slug, asset_id)
    update_entity_tag_canonicals(slug, {normalized: asset_id})
    return list_project_tags(slug)


def canonical_refs_for_tags(slug: str, tags: list[str]) -> list[str]:
    """The consistency machinery: each entity tag pulls its canonical image
    in as a generation reference automatically (canvas model, ARCHITECTURE.md)."""
    by_id = {tag.id: tag for tag in list_project_tags(slug)}
    refs: list[str] = []
    for tag_id in tags:
        tag = by_id.get(normalize_tag_id(tag_id))
        if tag is None or tag.entityKind is None or not tag.canonicalAssetId:
            continue
        if asset_png_path(slug, tag.canonicalAssetId).is_file():
            refs.append(tag.canonicalAssetId)
    return list(dict.fromkeys(refs))


def normalize_variant_groups(slug: str, canvas: CanvasDocument) -> CanvasDocument:
    """Collapse generated image groups that are variants of the same prompt/refs."""
    next_canvas = canvas.model_copy(deep=True)
    node_by_key: dict[tuple[str, tuple[str, ...]], str] = {}
    for node_id, node in list(next_canvas.nodes.items()):
        if node_id.startswith("generated_"):
            continue
        key = variant_key_for_node(slug, node)
        if key is None:
            continue
        target_id = node_by_key.get(key)
        if target_id is None:
            node_by_key[key] = node_id
            continue
        target = next_canvas.nodes[target_id]
        target.assetIds = list(dict.fromkeys([*target.assetIds, *node.assetIds]))
        if target.activeAssetId not in target.assetIds:
            target.activeAssetId = target.assetIds[0]
        next_canvas.nodes[target_id] = target
        del next_canvas.nodes[node_id]
    return next_canvas


def validate_refs(slug: str, refs: list[str]) -> None:
    require_project(slug)
    seen: set[str] = set()
    for ref in refs:
        if ref in seen:
            raise HTTPException(status_code=400, detail=f"Duplicate ref: {ref}")
        seen.add(ref)
        if not asset_json_path(slug, ref).is_file() or not asset_png_path(slug, ref).is_file():
            raise HTTPException(status_code=400, detail=f"Invalid same-project ref: {ref}")


def parent_png_paths(slug: str, refs: list[str]) -> list[Path]:
    validate_refs(slug, refs)
    return [asset_png_path(slug, ref) for ref in refs]


async def import_asset(
    slug: str,
    upload: UploadFile,
    title: str | None = None,
    canvas_x: float | None = None,
    canvas_y: float | None = None,
) -> AssetSummary:
    require_project(slug)
    if upload.content_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise HTTPException(status_code=400, detail="Only PNG, JPEG, and WebP imports are supported")
    asset_id = new_ulid()
    out_png = asset_png_path(slug, asset_id)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_png.with_suffix(".upload")
    logger.debug(
        "import asset start slug=%s asset_id=%s filename=%s content_type=%s title=%s",
        slug,
        asset_id,
        upload.filename,
        upload.content_type,
        title,
    )
    try:
        with tmp_path.open("wb") as fh:
            shutil.copyfileobj(upload.file, fh)
        with Image.open(tmp_path) as image:
            image.save(out_png, format="PNG")
        content_hash = file_sha256(out_png)
        duplicate = matching_import_by_hash(slug, content_hash)
        if duplicate is not None:
            logger.debug("import duplicate slug=%s asset_id=%s duplicate_id=%s hash=%s", slug, asset_id, duplicate.id, content_hash)
            out_png.unlink(missing_ok=True)
            raise HTTPException(status_code=409, detail=f"Already imported: {duplicate.title}")
    finally:
        tmp_path.unlink(missing_ok=True)

    now = utc_now()
    metadata = AssetMetadata(
        id=asset_id,
        kind="imported",
        title=title or Path(upload.filename or asset_id).stem or asset_id,
        tags=[],
        contentHash=content_hash,
        createdAt=now,
        updatedAt=now,
    )
    summary = write_asset_metadata(slug, metadata)
    if canvas_x is not None and canvas_y is not None:
        canvas = read_stored_canvas(slug)
        node_id = canvas_node_id(asset_id)
        canvas.nodes[node_id] = CanvasNode(
            displayName=summary.title,
            x=canvas_x,
            y=canvas_y,
            tags=node_tags("imported-image"),
            assetIds=[asset_id],
            activeAssetId=asset_id,
        )
        write_canvas(slug, canvas)
    logger.debug("import asset complete slug=%s asset_id=%s hash=%s", slug, asset_id, content_hash)
    return summary


def import_asset_file(slug: str, source_path: Path, title: str) -> AssetSummary:
    require_project(slug)
    asset_id = new_ulid()
    out_png = asset_png_path(slug, asset_id)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source_path) as image:
        image.save(out_png, format="PNG")
    content_hash = file_sha256(out_png)
    duplicate = matching_import_by_hash(slug, content_hash)
    if duplicate is not None:
        out_png.unlink(missing_ok=True)
        return duplicate
    now = utc_now()
    metadata = AssetMetadata(
        id=asset_id,
        kind="imported",
        title=title,
        tags=[],
        contentHash=content_hash,
        createdAt=now,
        updatedAt=now,
    )
    logger.debug("import asset file complete slug=%s asset_id=%s source=%s hash=%s", slug, asset_id, source_path, content_hash)
    return write_asset_metadata(slug, metadata)


def thumbnail_path(slug: str, asset_id: str) -> Path:
    path = asset_png_path(slug, asset_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Pixels not found: {asset_id}")
    return path


def image_path(slug: str, asset_id: str) -> Path:
    path = asset_png_path(slug, asset_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Pixels not found: {asset_id}")
    return path


def compose_generation_prompt(user_prompt: str, style_prompt: str | None) -> str:
    user = user_prompt.strip()
    style = (style_prompt or "").strip()
    if not style:
        return f"{user}\n" if user else ""
    if not user:
        return f"{style}\n"
    return f"{user}\n\n{style}\n"


def resolve_visual_style_prompt(slug: str, visual_style_id: str | None) -> str | None:
    if not visual_style_id:
        return None
    import visual_styles

    return visual_styles.visual_style_prompt(slug, visual_style_id).strip() or None


def create_generated_assets(
    slug: str,
    payload: GenerateRequest,
    generate_one,
) -> GenerateResponse:
    import gemini

    require_project(slug)
    # Entity tags auto-attach their canonical image as a reference; the merged
    # list is what lands in each take's generation receipt.
    auto_refs = [ref for ref in canonical_refs_for_tags(slug, payload.tags) if ref not in payload.refs]
    if auto_refs:
        payload = payload.model_copy(update={"refs": [*payload.refs, *auto_refs]})
    parent_paths = parent_png_paths(slug, payload.refs)
    run_id = new_ulid()
    created: list[AssetSummary] = []
    base_seed = payload.seed if payload.seed is not None else new_seed()
    model = payload.model or gemini.default_model()
    aspect_ratio = payload.aspectRatio or gemini.default_aspect_ratio()
    image_size = payload.imageSize or gemini.default_image_size()
    style_prompt = resolve_visual_style_prompt(slug, payload.visualStyleId)
    provider_prompt = compose_generation_prompt(payload.prompt, style_prompt)

    logger.debug(
        "create generation run slug=%s run_id=%s canvas_node=%s refs=%s parent_paths=%s model=%s aspect_ratio=%s image_size=%s base_seed=%s batch_count=%s visual_style_id=%s",
        slug,
        run_id,
        payload.canvasNodeId,
        payload.refs,
        [str(path) for path in parent_paths],
        model,
        aspect_ratio,
        image_size,
        base_seed,
        payload.batchCount,
        payload.visualStyleId,
    )
    for index in range(payload.batchCount):
        asset_id = new_ulid()
        seed = base_seed + index if payload.batchCount > 1 else base_seed
        out_png = asset_png_path(slug, asset_id)
        logger.debug(
            "generating asset slug=%s run_id=%s index=%s asset_id=%s seed=%s output=%s",
            slug,
            run_id,
            index,
            asset_id,
            seed,
            out_png,
        )
        try:
            result = generate_one(
                prompt_text=provider_prompt,
                parent_png_paths=parent_paths,
                output_png=out_png,
                seed=seed,
                model=model,
                aspect_ratio=aspect_ratio,
                image_size=image_size,
            )
        except Exception as exc:
            logger.exception("generation failed slug=%s run_id=%s index=%s asset_id=%s", slug, run_id, index, asset_id)
            out_png.unlink(missing_ok=True)
            from gemini import ImageGenerationError, http_status_for_generation_error

            if isinstance(exc, ImageGenerationError):
                raise HTTPException(
                    status_code=http_status_for_generation_error(exc),
                    detail=str(exc),
                ) from exc
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        now = utc_now()
        metadata = AssetMetadata(
            id=asset_id,
            kind="generated",
            title=payload.title or f"Generated {asset_id}",
            tags=payload.tags,
            createdAt=now,
            updatedAt=now,
            prompt=Prompt(text=payload.prompt),
            generation=GenerationReceipt(
                refs=payload.refs,
                runId=run_id,
                runIndex=index,
                model=model,
                aspectRatio=aspect_ratio,
                imageSize=image_size,
                seed=seed,
                visualStyleId=payload.visualStyleId,
            ),
            provider=ProviderCapture(
                name="google-genai",
                response=result.provider_response,
            ),
        )
        created.append(write_asset_metadata(slug, metadata))
        logger.debug("generated asset metadata written slug=%s asset_id=%s", slug, asset_id)
    if payload.canvasNodeId:
        attach_generated_assets_to_canvas(slug, payload.canvasNodeId, created)
    logger.debug("generation run complete slug=%s run_id=%s created=%s", slug, run_id, [asset.id for asset in created])
    return GenerateResponse(assets=created)


def default_style_canonicals(slug: str, node: CanvasNode) -> None:
    """A style-tagged node's first take becomes that style tag's canonical."""
    if node.activeAssetId is None:
        return
    style_tags = [tag for tag in node.tags if tag in STYLE_ENTITY_TAGS]
    if not style_tags:
        return
    ensure_style_entity_tags(slug)
    registry = {tag.id: tag for tag in list_project_tags(slug)}
    updates = {
        tag_id: node.activeAssetId
        for tag_id in style_tags
        if tag_id in registry and registry[tag_id].canonicalAssetId is None
    }
    if updates:
        update_entity_tag_canonicals(slug, updates)


def attach_generated_assets_to_canvas(slug: str, node_id: str, assets: list[AssetSummary]) -> None:
    canvas = normalize_variant_groups(slug, read_stored_canvas(slug))
    existing = canvas.nodes.get(node_id)
    asset_ids = [asset.id for asset in assets]
    active_asset_id = asset_ids[0] if asset_ids else None
    if existing is not None and (existing.assetIds or existing.origin is not None):
        # Results join the node's stack; domain-linked prompt nodes keep their identity.
        existing.assetIds = list(dict.fromkeys([*existing.assetIds, *asset_ids]))
        existing.activeAssetId = active_asset_id or existing.activeAssetId
        canvas.nodes[node_id] = existing
        write_canvas(slug, canvas)
        default_style_canonicals(slug, existing)
        if existing.origin is not None and existing.origin.kind == "panel":
            import story_panels

            story_panels.attach_assets_to_panel(slug, existing.origin.id, asset_ids)
        return
    target_node_id = matching_variant_group_node_id(slug, canvas, assets)
    logger.debug(
        "attach generated assets slug=%s requested_node=%s target_node=%s asset_ids=%s",
        slug,
        node_id,
        target_node_id,
        asset_ids,
    )
    if target_node_id and target_node_id != node_id:
        target = canvas.nodes[target_node_id]
        target.assetIds = list(dict.fromkeys([*target.assetIds, *asset_ids]))
        target.activeAssetId = active_asset_id or target.activeAssetId
        canvas.nodes[target_node_id] = target
        canvas.nodes.pop(node_id, None)
    elif existing is not None:
        # A draft-state node generated: the stack fills in place.
        existing.assetIds = asset_ids
        existing.activeAssetId = active_asset_id
        canvas.nodes[node_id] = existing
        default_style_canonicals(slug, existing)
    else:
        canvas.nodes[node_id] = CanvasNode(
            displayName=assets[0].title if assets else "",
            x=120,
            y=120,
            assetIds=asset_ids,
            activeAssetId=active_asset_id,
        )
    write_canvas(slug, canvas)


def attach_chat_assets_to_canvas(
    slug: str,
    session: ChatSessionDocument,
    turn: ChatTurn,
    assets: list[AssetSummary],
) -> None:
    if not assets:
        return
    canvas = read_stored_canvas(slug)
    source_node_id = session.source.canvasNodeId
    source_node = canvas.nodes.get(source_node_id or "") if source_node_id else None
    if source_node is not None and source_node_id is not None:
        # Refinements are attempts at the same image: they join the stack.
        source_node.assetIds = list(dict.fromkeys([*source_node.assetIds, *[asset.id for asset in assets]]))
        source_node.activeAssetId = assets[0].id
        canvas.nodes[source_node_id] = source_node
        write_canvas(slug, canvas)
        return
    turn_index = max(
        0,
        len([current for current in session.turns if current.role == "model"]) - 1,
    )
    node_id = f"chat_{session.id}_{turn.id}"
    while node_id in canvas.nodes:
        node_id = f"{node_id}_{new_ulid()}"
    canvas.nodes[node_id] = CanvasNode(
        displayName=f"{session.title} turn {turn_index + 1}",
        x=120,
        y=120 + turn_index * 260,
        width=None,
        assetIds=[asset.id for asset in assets],
        activeAssetId=assets[0].id,
    )
    write_canvas(slug, canvas)


def matching_variant_group_node_id(
    slug: str,
    canvas: CanvasDocument,
    assets: list[AssetSummary],
) -> str | None:
    if not assets:
        return None
    first = assets[0]
    if first.kind != "generated" or first.prompt is None or first.generation is None:
        return None
    prompt_text = first.prompt.text
    refs = first.generation.refs
    for node_id, node in canvas.nodes.items():
        if node_id.startswith("generated_"):
            continue
        for asset_id in node.assetIds:
            metadata = read_asset_metadata(slug, asset_id)
            if (
                metadata.kind == "generated"
                and metadata.prompt is not None
                and metadata.generation is not None
                and metadata.prompt.text == prompt_text
                and metadata.generation.refs == refs
            ):
                return node_id
    return None
