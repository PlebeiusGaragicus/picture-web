"""Character extraction routes (pi agent jobs)."""

from __future__ import annotations

from fastapi import APIRouter

import adaptation
import adaptation_jobs
from models import (
    AdaptationStatus,
    AdaptationWorkflowStatus,
)

router = APIRouter()

@router.post("/api/projects/{slug}/adaptation/characters/list", response_model=AdaptationWorkflowStatus)
def start_character_list(slug: str) -> AdaptationWorkflowStatus:
    return adaptation_jobs.start_character_list(slug)


@router.get("/api/projects/{slug}/adaptation/characters/list", response_model=AdaptationWorkflowStatus)
def get_character_list(slug: str) -> AdaptationWorkflowStatus:
    return adaptation_jobs.character_list_status(slug)


@router.post("/api/projects/{slug}/adaptation/characters/extract-all", response_model=AdaptationWorkflowStatus)
def start_character_extract_all(slug: str) -> AdaptationWorkflowStatus:
    return adaptation_jobs.start_character_extract_all(slug)


@router.get("/api/projects/{slug}/adaptation/characters/extract-all", response_model=AdaptationWorkflowStatus)
def get_character_extract_all(slug: str) -> AdaptationWorkflowStatus:
    return adaptation_jobs.character_extract_all_status(slug)


@router.post("/api/projects/{slug}/adaptation/characters/{key}/extract", response_model=AdaptationWorkflowStatus)
def start_character_extract(slug: str, key: str, force: bool = False) -> AdaptationWorkflowStatus:
    return adaptation_jobs.start_character_extract(slug, key, force=force)


@router.get("/api/projects/{slug}/adaptation/characters/{key}/extract", response_model=AdaptationWorkflowStatus)
def get_character_extract(slug: str, key: str) -> AdaptationWorkflowStatus:
    return adaptation_jobs.character_extract_status(slug, key)


@router.post("/api/projects/{slug}/adaptation/characters/reset", response_model=AdaptationStatus)
def reset_character_data(slug: str) -> AdaptationStatus:
    return adaptation.reset_character_data(slug)
