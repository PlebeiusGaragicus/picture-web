"""Character record routes (non-pi; extraction runs through /pi-tasks)."""

from __future__ import annotations

from fastapi import APIRouter

import adaptation
from models import AdaptationCanvasImportResponse, AdaptationStatus, CharacterCreate, CharacterPatch, CharacterRecord

router = APIRouter()


@router.get("/api/projects/{slug}/characters", response_model=list[CharacterRecord])
def list_characters(slug: str) -> list[CharacterRecord]:
    return adaptation.list_characters(slug)


@router.post("/api/projects/{slug}/characters", response_model=CharacterRecord)
def create_character(slug: str, payload: CharacterCreate) -> CharacterRecord:
    return adaptation.create_character(slug, payload)


@router.patch("/api/projects/{slug}/characters/{character_slug}", response_model=CharacterRecord)
def update_character(slug: str, character_slug: str, payload: CharacterPatch) -> CharacterRecord:
    return adaptation.update_character(slug, character_slug, payload)


@router.delete("/api/projects/{slug}/characters/{character_slug}", response_model=AdaptationStatus)
def delete_character(slug: str, character_slug: str) -> AdaptationStatus:
    return adaptation.delete_character(slug, character_slug)


@router.post(
    "/api/projects/{slug}/characters/{character_slug}/variants/{variant_key}/draft-to-canvas",
    response_model=AdaptationCanvasImportResponse,
)
def draft_character_variant_to_canvas(slug: str, character_slug: str, variant_key: str) -> AdaptationCanvasImportResponse:
    return adaptation.draft_character_variant_to_canvas(slug, character_slug, variant_key)


@router.post("/api/projects/{slug}/adaptation/characters/reset", response_model=AdaptationStatus)
def reset_character_data(slug: str) -> AdaptationStatus:
    return adaptation.reset_character_data(slug)
