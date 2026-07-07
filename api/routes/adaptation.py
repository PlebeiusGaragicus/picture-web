"""Adaptation status, visual styles, and book import routes."""

from __future__ import annotations

from fastapi import APIRouter, File, UploadFile

import adaptation
import visual_styles
from models import (
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


@router.post("/api/projects/{slug}/adaptation/import-book", response_model=AdaptationStatus)
async def import_adaptation_book(slug: str, file: UploadFile = File(...)) -> AdaptationStatus:
    return await adaptation.import_book(slug, file)
