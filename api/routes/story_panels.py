"""Story panel and page layout routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

import story_panels
import story_panels_print
from models import (
    ConceptNodeResponse,
    StoryPanelBookmarkCreate,
    StoryPanelCreate,
    StoryPanelDocument,
    StoryPanelImagePromptWrite,
    StoryPanelPatch,
)

router = APIRouter()

@router.get("/api/projects/{slug}/story-panels/book")
def get_story_panel_book(slug: str) -> dict[str, str]:
    text = story_panels.optional_book_text(slug)
    return {"text": text or ""}


@router.get("/api/projects/{slug}/story-panels", response_model=StoryPanelDocument)
def get_story_panels(slug: str) -> StoryPanelDocument:
    return story_panels.read_document(slug)


@router.get("/api/projects/{slug}/story-panels/print/booklet.pdf")
def get_story_panels_booklet_pdf(slug: str, pageBorder: story_panels_print.PageBorder = "black") -> Response:
    if pageBorder not in {"black", "grey", "none"}:
        raise HTTPException(status_code=400, detail=f"Unknown pageBorder: {pageBorder}")
    pdf = story_panels_print.render_booklet_pdf(slug, page_border=pageBorder)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{slug}-comic-booklet.pdf"'},
    )


@router.put("/api/projects/{slug}/story-panels", response_model=StoryPanelDocument)
def put_story_panels(slug: str, payload: StoryPanelDocument) -> StoryPanelDocument:
    return story_panels.save_document(slug, payload)


@router.post("/api/projects/{slug}/story-panels/panels", response_model=StoryPanelDocument)
def create_story_panel(slug: str, payload: StoryPanelCreate) -> StoryPanelDocument:
    return story_panels.create_panel(slug, payload)


@router.post("/api/projects/{slug}/story-panels/panels/bookmark", response_model=StoryPanelDocument)
def create_story_panel_bookmark(slug: str, payload: StoryPanelBookmarkCreate) -> StoryPanelDocument:
    return story_panels.create_bookmark(slug, payload)


@router.patch("/api/projects/{slug}/story-panels/panels/{panel_id}", response_model=StoryPanelDocument)
def patch_story_panel(slug: str, panel_id: str, payload: StoryPanelPatch) -> StoryPanelDocument:
    return story_panels.patch_panel(slug, panel_id, payload)


@router.post("/api/projects/{slug}/story-panels/panels/{panel_id}/image-prompts")
def append_story_panel_image_prompt(slug: str, panel_id: str, payload: StoryPanelImagePromptWrite) -> dict[str, str]:
    prompt_id = story_panels.append_image_prompt(
        slug,
        panel_id,
        payload.text,
        character_slugs=payload.characterSlugs,
        location_slug=payload.locationSlug,
    )
    return {"promptId": prompt_id}


@router.put("/api/projects/{slug}/story-panels/panels/{panel_id}/image-prompts/{prompt_id}")
def replace_story_panel_image_prompt(
    slug: str, panel_id: str, prompt_id: str, payload: StoryPanelImagePromptWrite
) -> dict[str, str]:
    story_panels.replace_image_prompt(slug, panel_id, prompt_id, payload.text)
    return {"promptId": prompt_id}


@router.post("/api/projects/{slug}/story-panels/panels/{panel_id}/draft-to-canvas", response_model=ConceptNodeResponse)
def draft_story_panel_to_canvas(slug: str, panel_id: str, promptId: str) -> ConceptNodeResponse:
    return story_panels.draft_panel_to_canvas(slug, panel_id, promptId)


@router.post("/api/projects/{slug}/story-panels/panels/{panel_id}/auto-place", response_model=StoryPanelDocument)
def auto_place_story_panel(slug: str, panel_id: str) -> StoryPanelDocument:
    return story_panels.auto_place_panel(slug, panel_id)


@router.delete("/api/projects/{slug}/story-panels/panels/{panel_id}", response_model=StoryPanelDocument)
def delete_story_panel(slug: str, panel_id: str) -> StoryPanelDocument:
    return story_panels.delete_panel(slug, panel_id)


@router.post("/api/projects/{slug}/story-panels/reset-layout", response_model=StoryPanelDocument)
def reset_story_panel_layout(slug: str) -> StoryPanelDocument:
    return story_panels.reset_layout(slug)


@router.post("/api/projects/{slug}/story-panels/reset-chunks", response_model=StoryPanelDocument)
def reset_story_panel_chunks(slug: str) -> StoryPanelDocument:
    return story_panels.reset_chunks(slug)
