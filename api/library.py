"""Filesystem-backed photo-library operations."""

from __future__ import annotations

import json
import hashlib
import logging
import shutil
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile
from PIL import Image

from ids import new_seed, new_ulid
from models import (
    AssetMetadata,
    AssetSummary,
    CanvasDocument,
    DraftCanvasNode,
    DisplayPatch,
    GenerateRequest,
    GenerateResponse,
    GenerationReceipt,
    ImageGroupCanvasNode,
    Prompt,
    ProviderCapture,
    ProjectCreate,
    ProjectDetail,
    ProjectMetadata,
    utc_now,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
LIBRARY_ROOT = REPO_ROOT / "photo-library"
PROJECTS_ROOT = LIBRARY_ROOT / "projects"
SYSTEM_TRASH = Path.home() / ".Trash"
THUMB_MAX_SIZE = (384, 384)
logger = logging.getLogger(__name__)


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
        projects.append(ProjectMetadata.model_validate(read_json(path)))
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
        settings={},
    )
    assets_dir(payload.slug).mkdir(parents=True, exist_ok=True)
    write_json(project_json_path(payload.slug), project.model_dump(mode="json"))
    write_json(canvas_json_path(payload.slug), CanvasDocument().model_dump(mode="json"))
    return project


def get_project(slug: str) -> ProjectMetadata:
    require_project(slug)
    return ProjectMetadata.model_validate(read_json(project_json_path(slug)))


def get_project_detail(slug: str) -> ProjectDetail:
    return ProjectDetail(project=get_project(slug), assets=list_assets(slug))


def metadata_to_summary(slug: str, metadata: AssetMetadata) -> AssetSummary:
    data = metadata.model_dump(mode="json")
    data["hasPixels"] = asset_png_path(slug, metadata.id).is_file()
    data["thumbnailUrl"] = f"/api/projects/{slug}/assets/{metadata.id}/thumb"
    return AssetSummary.model_validate(data)


def list_assets(slug: str) -> list[AssetSummary]:
    require_project(slug)
    items: list[AssetSummary] = []
    for path in sorted(assets_dir(slug).glob("*.json")):
        metadata = AssetMetadata.model_validate(read_json(path))
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


def delete_asset(slug: str, asset_id: str) -> None:
    require_project(slug)
    if not asset_json_path(slug, asset_id).is_file():
        raise HTTPException(status_code=404, detail=f"Asset not found: {asset_id}")
    logger.debug("delete asset slug=%s asset_id=%s", slug, asset_id)
    move_to_trash(asset_json_path(slug, asset_id))
    move_to_trash(asset_png_path(slug, asset_id))

    canvas = read_stored_canvas(slug)
    changed = False
    for node_id, node in list(canvas.nodes.items()):
        if isinstance(node, DraftCanvasNode):
            next_refs = [ref for ref in node.refs if ref != asset_id]
            if next_refs != node.refs:
                node.refs = next_refs
                canvas.nodes[node_id] = node
                changed = True
        elif isinstance(node, ImageGroupCanvasNode) and asset_id in node.assetIds:
            node.assetIds = [current_id for current_id in node.assetIds if current_id != asset_id]
            if node.assetIds:
                if node.activeAssetId == asset_id or node.activeAssetId not in node.assetIds:
                    node.activeAssetId = node.assetIds[0]
                canvas.nodes[node_id] = node
            else:
                del canvas.nodes[node_id]
            changed = True
    if changed:
        write_canvas(slug, canvas)
        logger.debug("delete asset updated canvas slug=%s asset_id=%s", slug, asset_id)


def patch_display(slug: str, asset_id: str, payload: DisplayPatch) -> AssetSummary:
    metadata = read_asset_metadata(slug, asset_id)
    updates = payload.model_dump(exclude_unset=True)
    if "title" in updates and updates["title"] is not None:
        metadata.title = updates["title"]
    if "tags" in updates and updates["tags"] is not None:
        metadata.tags = updates["tags"]
    metadata.updatedAt = utc_now()
    return write_asset_metadata(slug, metadata)


def read_canvas(slug: str) -> CanvasDocument:
    require_project(slug)
    return normalize_variant_groups(slug, default_canvas_for_assets(slug, read_stored_canvas(slug)))


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
        if isinstance(node, DraftCanvasNode):
            validate_refs(slug, node.refs)
        elif isinstance(node, ImageGroupCanvasNode):
            for asset_id in node.assetIds:
                if not asset_json_path(slug, asset_id).is_file() or not asset_png_path(slug, asset_id).is_file():
                    raise HTTPException(status_code=400, detail=f"Invalid asset in canvas node {node_id}: {asset_id}")


def canvas_node_id(asset_id: str) -> str:
    return f"node_{asset_id}"


def default_canvas_for_assets(slug: str, canvas: CanvasDocument) -> CanvasDocument:
    """Add visible image groups for assets not yet represented on the canvas."""
    represented = {
        asset_id
        for node in canvas.nodes.values()
        if isinstance(node, ImageGroupCanvasNode)
        for asset_id in node.assetIds
    }
    next_canvas = canvas.model_copy(deep=True)
    index = len(next_canvas.nodes)
    for asset in list_assets(slug):
        if asset.id in represented:
            continue
        node_id = canvas_node_id(asset.id)
        while node_id in next_canvas.nodes:
            node_id = f"{canvas_node_id(asset.id)}_{index}"
            index += 1
        next_canvas.nodes[node_id] = ImageGroupCanvasNode(
            displayName=asset.title,
            x=80 + index * 40,
            y=80 + index * 40,
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


def variant_key_for_node(slug: str, node: ImageGroupCanvasNode) -> tuple[str, tuple[str, ...]] | None:
    for asset_id in node.assetIds:
        key = variant_key_for_asset(slug, asset_id)
        if key is not None:
            return key
    return None


def normalize_variant_groups(slug: str, canvas: CanvasDocument) -> CanvasDocument:
    """Collapse generated image groups that are variants of the same prompt/refs."""
    next_canvas = canvas.model_copy(deep=True)
    node_by_key: dict[tuple[str, tuple[str, ...]], str] = {}
    for node_id, node in list(next_canvas.nodes.items()):
        if not isinstance(node, ImageGroupCanvasNode):
            continue
        key = variant_key_for_node(slug, node)
        if key is None:
            continue
        target_id = node_by_key.get(key)
        if target_id is None:
            node_by_key[key] = node_id
            continue
        target = next_canvas.nodes[target_id]
        if not isinstance(target, ImageGroupCanvasNode):
            continue
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


async def import_asset(slug: str, upload: UploadFile, title: str | None = None) -> AssetSummary:
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
    logger.debug("import asset complete slug=%s asset_id=%s hash=%s", slug, asset_id, content_hash)
    return summary


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


def create_generated_assets(
    slug: str,
    payload: GenerateRequest,
    generate_one,
) -> GenerateResponse:
    import gemini

    require_project(slug)
    parent_paths = parent_png_paths(slug, payload.refs)
    run_id = new_ulid()
    created: list[AssetSummary] = []
    base_seed = payload.seed if payload.seed is not None else new_seed()
    model = payload.model or gemini.default_model()
    aspect_ratio = payload.aspectRatio or gemini.default_aspect_ratio()
    image_size = payload.imageSize or gemini.default_image_size()

    logger.debug(
        "create generation run slug=%s run_id=%s canvas_node=%s refs=%s parent_paths=%s model=%s aspect_ratio=%s image_size=%s base_seed=%s batch_count=%s",
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
                prompt_text=payload.prompt,
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


def attach_generated_assets_to_canvas(slug: str, node_id: str, assets: list[AssetSummary]) -> None:
    canvas = normalize_variant_groups(slug, read_stored_canvas(slug))
    existing = canvas.nodes.get(node_id)
    asset_ids = [asset.id for asset in assets]
    active_asset_id = asset_ids[0] if asset_ids else None
    target_node_id = matching_variant_group_node_id(slug, canvas, assets)
    logger.debug(
        "attach generated assets slug=%s requested_node=%s existing_type=%s target_node=%s asset_ids=%s",
        slug,
        node_id,
        type(existing).__name__ if existing is not None else None,
        target_node_id,
        asset_ids,
    )
    if target_node_id and target_node_id != node_id:
        target = canvas.nodes[target_node_id]
        if isinstance(target, ImageGroupCanvasNode):
            target.assetIds = list(dict.fromkeys([*target.assetIds, *asset_ids]))
            target.activeAssetId = active_asset_id or target.activeAssetId
            canvas.nodes[target_node_id] = target
            canvas.nodes.pop(node_id, None)
    elif existing is None or isinstance(existing, DraftCanvasNode):
        x = existing.x if isinstance(existing, DraftCanvasNode) else 120
        y = existing.y if isinstance(existing, DraftCanvasNode) else 120
        width = existing.width if isinstance(existing, DraftCanvasNode) else None
        display_name = existing.displayName if isinstance(existing, DraftCanvasNode) else None
        canvas.nodes[node_id] = ImageGroupCanvasNode(
            displayName=display_name if display_name is not None else (assets[0].title if assets else ""),
            x=x,
            y=y,
            width=width,
            assetIds=asset_ids,
            activeAssetId=active_asset_id,
        )
    elif isinstance(existing, ImageGroupCanvasNode):
        merged = list(dict.fromkeys([*existing.assetIds, *asset_ids]))
        existing.assetIds = merged
        existing.activeAssetId = active_asset_id or existing.activeAssetId
        canvas.nodes[node_id] = existing
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
        if not isinstance(node, ImageGroupCanvasNode):
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
