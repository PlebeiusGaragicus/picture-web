"""Filesystem-backed photo-library operations."""

from __future__ import annotations

import json
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
    DisplayPatch,
    GenerateRequest,
    GenerateResponse,
    GenerationReceipt,
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
THUMB_MAX_SIZE = (384, 384)


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


def read_asset(slug: str, asset_id: str) -> AssetSummary:
    require_project(slug)
    metadata = AssetMetadata.model_validate(read_json(asset_json_path(slug, asset_id)))
    return metadata_to_summary(slug, metadata)


def read_asset_metadata(slug: str, asset_id: str) -> AssetMetadata:
    require_project(slug)
    return AssetMetadata.model_validate(read_json(asset_json_path(slug, asset_id)))


def write_asset_metadata(slug: str, metadata: AssetMetadata) -> AssetSummary:
    write_json(asset_json_path(slug, metadata.id), metadata.model_dump(mode="json"))
    return metadata_to_summary(slug, metadata)


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
    path = canvas_json_path(slug)
    if not path.is_file():
        return CanvasDocument()
    return CanvasDocument.model_validate(read_json(path))


def write_canvas(slug: str, canvas: CanvasDocument) -> CanvasDocument:
    require_project(slug)
    write_json(canvas_json_path(slug), canvas.model_dump(mode="json"))
    return canvas


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
    try:
        with tmp_path.open("wb") as fh:
            shutil.copyfileobj(upload.file, fh)
        with Image.open(tmp_path) as image:
            image.save(out_png, format="PNG")
    finally:
        tmp_path.unlink(missing_ok=True)

    now = utc_now()
    metadata = AssetMetadata(
        id=asset_id,
        kind="imported",
        title=title or Path(upload.filename or asset_id).stem or asset_id,
        tags=[],
        createdAt=now,
        updatedAt=now,
    )
    return write_asset_metadata(slug, metadata)


def thumbnail_path(slug: str, asset_id: str) -> Path:
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

    for index in range(payload.batchCount):
        asset_id = new_ulid()
        seed = base_seed + index if payload.batchCount > 1 else base_seed
        out_png = asset_png_path(slug, asset_id)
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
    return GenerateResponse(assets=created)
