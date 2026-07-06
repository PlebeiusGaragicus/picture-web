"""Project, tag registry, and asset routes."""

from __future__ import annotations

from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import FileResponse
from starlette import status

import library
from models import (
    ArchivePatch,
    AssetSummary,
    DisplayPatch,
    ProjectCoverPatch,
    ProjectCreate,
    ProjectDetail,
    ProjectMetadata,
    TagCanonicalPatch,
    TagDefinition,
    TagRegistryDocument,
)

router = APIRouter()

@router.get("/api/projects", response_model=list[ProjectMetadata])
def list_projects() -> list[ProjectMetadata]:
    return library.list_projects()


@router.post("/api/projects", response_model=ProjectMetadata)
def create_project(payload: ProjectCreate) -> ProjectMetadata:
    return library.create_project(payload)


@router.get("/api/projects/{slug}", response_model=ProjectDetail)
def get_project(slug: str, includeArchived: bool = Query(default=False)) -> ProjectDetail:
    if includeArchived:
        return ProjectDetail(project=library.get_project(slug), assets=library.list_assets(slug, include_archived=True), tags=library.list_project_tags(slug))
    return library.get_project_detail(slug)


@router.patch("/api/projects/{slug}", response_model=ProjectMetadata)
def patch_project(slug: str, payload: ProjectCoverPatch) -> ProjectMetadata:
    return library.patch_project_cover(slug, payload.coverAssetId)


@router.get("/api/projects/{slug}/tags", response_model=list[TagDefinition])
def list_tags(slug: str) -> list[TagDefinition]:
    return library.list_project_tags(slug)


@router.put("/api/projects/{slug}/tags/{tag_id}/canonical", response_model=list[TagDefinition])
def put_tag_canonical(slug: str, tag_id: str, payload: TagCanonicalPatch) -> list[TagDefinition]:
    return library.set_tag_canonical(slug, tag_id, payload.assetId)


@router.put("/api/projects/{slug}/tags", response_model=TagRegistryDocument)
def put_tags(slug: str, payload: TagRegistryDocument) -> TagRegistryDocument:
    return library.write_tag_registry(slug, payload)


@router.delete("/api/projects/{slug}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(slug: str) -> None:
    library.delete_project(slug)


@router.get("/api/projects/{slug}/assets", response_model=list[AssetSummary])
def list_assets(slug: str, includeArchived: bool = Query(default=False)) -> list[AssetSummary]:
    return library.list_assets(slug, include_archived=includeArchived)


@router.get("/api/projects/{slug}/assets/{asset_id}", response_model=AssetSummary)
def get_asset(slug: str, asset_id: str) -> AssetSummary:
    return library.read_asset(slug, asset_id)


@router.patch("/api/projects/{slug}/assets/{asset_id}/display", response_model=AssetSummary)
def patch_display(slug: str, asset_id: str, payload: DisplayPatch) -> AssetSummary:
    return library.patch_display(slug, asset_id, payload)


@router.patch("/api/projects/{slug}/assets/{asset_id}/archive", response_model=AssetSummary)
def patch_archive(slug: str, asset_id: str, payload: ArchivePatch) -> AssetSummary:
    return library.patch_archive(slug, asset_id, payload)


@router.delete("/api/projects/{slug}/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(slug: str, asset_id: str) -> None:
    library.delete_asset(slug, asset_id)


@router.post("/api/projects/{slug}/assets/import", response_model=AssetSummary)
async def import_asset(
    slug: str,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    canvasX: float | None = Form(default=None),
    canvasY: float | None = Form(default=None),
) -> AssetSummary:
    return await library.import_asset(slug, file, title=title, canvas_x=canvasX, canvas_y=canvasY)


@router.get("/api/projects/{slug}/assets/{asset_id}/thumb")
def get_thumb(slug: str, asset_id: str) -> FileResponse:
    return FileResponse(library.thumbnail_path(slug, asset_id))


@router.get("/api/projects/{slug}/assets/{asset_id}/image")
def get_image(slug: str, asset_id: str) -> FileResponse:
    return FileResponse(library.image_path(slug, asset_id), media_type="image/png")
