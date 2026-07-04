"""Canvas document, image-group, and generation routes."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Query

import canvas_nodes
import library
from models import (
    CanvasDocument,
    GenerateRequest,
    GenerateResponse,
    ImageGroupNodeCreate,
    ImageGroupNodeResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter()

@router.get("/api/projects/{slug}/canvas", response_model=CanvasDocument)
def get_canvas(slug: str, includeArchived: bool = Query(default=False)) -> CanvasDocument:
    return library.read_canvas(slug, include_archived=includeArchived)


@router.put("/api/projects/{slug}/canvas", response_model=CanvasDocument)
def put_canvas(slug: str, canvas: CanvasDocument) -> CanvasDocument:
    return library.write_canvas(slug, canvas)


@router.post("/api/projects/{slug}/canvas/image-groups", response_model=ImageGroupNodeResponse)
def create_canvas_image_group(slug: str, payload: ImageGroupNodeCreate) -> ImageGroupNodeResponse:
    return canvas_nodes.create_image_group(slug, payload)


@router.post("/api/projects/{slug}/generate", response_model=GenerateResponse)
def generate(slug: str, payload: GenerateRequest) -> GenerateResponse:
    import gemini

    logger.debug(
        "generate request slug=%s canvas_node=%s refs=%s model=%s aspect_ratio=%s image_size=%s seed=%s batch_count=%s prompt_chars=%s",
        slug,
        payload.canvasNodeId,
        payload.refs,
        payload.model,
        payload.aspectRatio,
        payload.imageSize,
        payload.seed,
        payload.batchCount,
        len(payload.prompt),
    )
    return library.create_generated_assets(slug, payload, gemini.generate_image)
