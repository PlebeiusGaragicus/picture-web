"""Character routes (non-pi; extraction runs through /pi-tasks)."""

from __future__ import annotations

from fastapi import APIRouter

import adaptation
from models import AdaptationStatus

router = APIRouter()

@router.post("/api/projects/{slug}/adaptation/characters/reset", response_model=AdaptationStatus)
def reset_character_data(slug: str) -> AdaptationStatus:
    return adaptation.reset_character_data(slug)
