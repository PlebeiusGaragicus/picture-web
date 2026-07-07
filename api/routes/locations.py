"""Location record routes (non-pi; extraction runs through /pi-tasks)."""

from __future__ import annotations

from fastapi import APIRouter

import adaptation
from models import AdaptationCanvasImportResponse, AdaptationStatus, LocationCreate, LocationPatch, LocationRecord

router = APIRouter()


@router.get("/api/projects/{slug}/locations", response_model=list[LocationRecord])
def list_locations(slug: str) -> list[LocationRecord]:
    return adaptation.list_locations(slug)


@router.post("/api/projects/{slug}/locations", response_model=LocationRecord)
def create_location(slug: str, payload: LocationCreate) -> LocationRecord:
    return adaptation.create_location(slug, payload)


@router.patch("/api/projects/{slug}/locations/{location_slug}", response_model=LocationRecord)
def update_location(slug: str, location_slug: str, payload: LocationPatch) -> LocationRecord:
    return adaptation.update_location(slug, location_slug, payload)


@router.delete("/api/projects/{slug}/locations/{location_slug}", response_model=AdaptationStatus)
def delete_location(slug: str, location_slug: str) -> AdaptationStatus:
    return adaptation.delete_location(slug, location_slug)


@router.post(
    "/api/projects/{slug}/locations/{location_slug}/variants/{variant_key}/draft-to-canvas",
    response_model=AdaptationCanvasImportResponse,
)
def draft_location_variant_to_canvas(slug: str, location_slug: str, variant_key: str) -> AdaptationCanvasImportResponse:
    return adaptation.draft_location_variant_to_canvas(slug, location_slug, variant_key)
