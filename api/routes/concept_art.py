"""Concept card routes (concept suggestions run through /pi-tasks)."""

from __future__ import annotations

from fastapi import APIRouter, File, Query, UploadFile
from starlette import status

import concept_cards
from models import (
    ConceptCardDocument,
    ConceptCardPatch,
    ConceptNodeCreate,
    ConceptNodeResponse,
)

router = APIRouter()

@router.get("/api/projects/{slug}/concept-cards", response_model=list[ConceptCardDocument])
def list_concept_cards(slug: str, includeArchived: bool = Query(default=False)) -> list[ConceptCardDocument]:
    return concept_cards.list_cards(slug, include_archived=includeArchived)


@router.post("/api/projects/{slug}/concept-cards", response_model=ConceptCardDocument)
def create_concept_card(slug: str, payload: ConceptNodeCreate) -> ConceptCardDocument:
    return concept_cards.create_card(slug, payload)


@router.patch("/api/projects/{slug}/concept-cards/{card_id}", response_model=ConceptCardDocument)
def patch_concept_card(slug: str, card_id: str, payload: ConceptCardPatch) -> ConceptCardDocument:
    return concept_cards.update_card(slug, card_id, payload)


@router.delete("/api/projects/{slug}/concept-cards/{card_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_concept_card(slug: str, card_id: str) -> None:
    concept_cards.delete_card(slug, card_id)


@router.post("/api/projects/{slug}/concept-cards/{card_id}/draft", response_model=ConceptNodeResponse)
def draft_concept_card(slug: str, card_id: str) -> ConceptNodeResponse:
    return concept_cards.draft_card_to_canvas(slug, card_id)


@router.post("/api/projects/{slug}/concept-cards/{card_id}/upload", response_model=ConceptCardDocument)
async def upload_concept_card_image(slug: str, card_id: str, file: UploadFile = File(...)) -> ConceptCardDocument:
    return await concept_cards.upload_card_image(slug, card_id, file)
