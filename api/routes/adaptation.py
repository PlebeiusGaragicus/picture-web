"""Adaptation status, visual styles, and file routes."""

from __future__ import annotations

from fastapi import APIRouter, File, UploadFile

import adaptation
import visual_styles
from models import (
    AdaptationCanvasImportResponse,
    AdaptationFileCreate,
    AdaptationFileDocument,
    AdaptationFileKind,
    AdaptationFileUpdate,
    AdaptationImportArtifactRequest,
    AdaptationStatus,
    VisualStyleCreate,
    VisualStylePatch,
)

router = APIRouter()

@router.get("/api/projects/{slug}/adaptation", response_model=AdaptationStatus)
def get_adaptation(slug: str) -> AdaptationStatus:
    return adaptation.status(slug)


@router.post("/api/projects/{slug}/adaptation/visual-styles", response_model=AdaptationStatus)
def create_adaptation_visual_style(slug: str, payload: VisualStyleCreate) -> AdaptationStatus:
    return visual_styles.create_visual_style(slug, payload)


@router.patch("/api/projects/{slug}/adaptation/visual-styles/{style_id}", response_model=AdaptationStatus)
def patch_adaptation_visual_style(slug: str, style_id: str, payload: VisualStylePatch) -> AdaptationStatus:
    return visual_styles.update_visual_style(slug, style_id, payload)


@router.delete("/api/projects/{slug}/adaptation/visual-styles/{style_id}", response_model=AdaptationStatus)
def delete_adaptation_visual_style(slug: str, style_id: str) -> AdaptationStatus:
    return visual_styles.delete_visual_style(slug, style_id)


@router.get("/api/projects/{slug}/adaptation/files/{kind}", response_model=list[AdaptationFileDocument])
def list_adaptation_files(slug: str, kind: AdaptationFileKind) -> list[AdaptationFileDocument]:
    return adaptation.list_adaptation_files(slug, kind)


@router.post("/api/projects/{slug}/adaptation/files/{kind}", response_model=AdaptationFileDocument)
def create_adaptation_file(slug: str, kind: AdaptationFileKind, payload: AdaptationFileCreate) -> AdaptationFileDocument:
    return adaptation.create_adaptation_file(slug, kind, payload)


@router.put("/api/projects/{slug}/adaptation/files/{kind}/{key}", response_model=AdaptationFileDocument)
def update_adaptation_file(slug: str, kind: AdaptationFileKind, key: str, payload: AdaptationFileUpdate) -> AdaptationFileDocument:
    return adaptation.update_adaptation_file(slug, kind, key, payload)


@router.delete("/api/projects/{slug}/adaptation/files/{kind}/{key}", response_model=AdaptationStatus)
def delete_adaptation_file(slug: str, kind: AdaptationFileKind, key: str) -> AdaptationStatus:
    return adaptation.delete_adaptation_file(slug, kind, key)


@router.post("/api/projects/{slug}/adaptation/import-artifact-to-canvas", response_model=AdaptationCanvasImportResponse)
def import_adaptation_artifact_to_canvas(slug: str, payload: AdaptationImportArtifactRequest) -> AdaptationCanvasImportResponse:
    return adaptation.import_artifact_to_canvas(slug, payload.artifactKind, payload.artifactKey)


@router.post("/api/projects/{slug}/adaptation/import-book", response_model=AdaptationStatus)
async def import_adaptation_book(slug: str, file: UploadFile = File(...)) -> AdaptationStatus:
    return await adaptation.import_book(slug, file)
