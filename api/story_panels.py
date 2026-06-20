"""Project-backed story panel chunking and page layout helpers."""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import HTTPException

import adaptation
import library
from models import (
    StoryPanel,
    StoryPanelCreate,
    StoryPanelDocument,
    StoryPanelPage,
    StoryPanelPatch,
    StoryPanelRect,
)


def story_panels_dir(slug: str) -> Path:
    library.require_project(slug)
    return library.project_dir(slug) / "story-panels"


def document_path(slug: str) -> Path:
    return story_panels_dir(slug) / "panels.json"


def default_page() -> StoryPanelPage:
    return StoryPanelPage(id="page-001", order=2, title="Page 1", pageKind="story")


def empty_document() -> StoryPanelDocument:
    return StoryPanelDocument(
        pages=[
            StoryPanelPage(id="cover", order=0, title="Cover", pageKind="cover"),
            StoryPanelPage(id="copyright", order=1, title="Copyright / Indicia", pageKind="inside-cover"),
            default_page(),
            StoryPanelPage(id="back-cover", order=3, title="Back Cover", pageKind="back-cover"),
        ],
        panels=[],
    )


def read_book(slug: str) -> str:
    return adaptation.read_book(slug)


def _write_document(slug: str, document: StoryPanelDocument) -> StoryPanelDocument:
    path = document_path(slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    library.write_json(path, document.model_dump(mode="json"))
    return document


def _validate_against_book(slug: str, document: StoryPanelDocument) -> StoryPanelDocument:
    book = read_book(slug)
    book_len = len(book)
    for panel in document.panels:
        if panel.sourceKind != "story":
            continue
        assert panel.startOffset is not None and panel.endOffset is not None
        if panel.endOffset > book_len:
            raise HTTPException(status_code=400, detail=f"Panel range exceeds book length: {panel.id}")
        selected = book[panel.startOffset:panel.endOffset]
        if panel.selectedText and panel.selectedText != selected:
            raise HTTPException(status_code=400, detail=f"Panel selectedText does not match book range: {panel.id}")
        panel.selectedText = selected
    return document


def read_document(slug: str) -> StoryPanelDocument:
    path = document_path(slug)
    if not path.is_file():
        return empty_document()
    return _validate_against_book(slug, StoryPanelDocument.model_validate(library.read_json(path)))


def save_document(slug: str, document: StoryPanelDocument) -> StoryPanelDocument:
    return _write_document(slug, _validate_against_book(slug, document))


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "panel"


def _next_panel_id(document: StoryPanelDocument) -> str:
    existing = {panel.id for panel in document.panels}
    index = len(existing) + 1
    while True:
        candidate = f"panel-{index:03d}"
        if candidate not in existing:
            return candidate
        index += 1


def _next_page(document: StoryPanelDocument) -> StoryPanelPage:
    story_pages = [page for page in document.pages if page.pageKind == "story"]
    if story_pages:
        return sorted(story_pages, key=lambda page: (page.order, page.id))[0]
    page = default_page()
    document.pages.append(page)
    return page


def _default_rect(document: StoryPanelDocument, page_id: str) -> StoryPanelRect:
    panels_on_page = [panel for panel in document.panels if panel.pageId == page_id and panel.layer == 0]
    y = 0
    if panels_on_page:
        y = max(panel.rect.y + panel.rect.h for panel in panels_on_page)
    return StoryPanelRect(x=0, y=y, w=12, h=3)


def _story_order_placement(document: StoryPanelDocument, start_offset: int) -> tuple[str, StoryPanelRect]:
    ordered = sorted(
        [panel for panel in document.panels if panel.sourceKind == "story" and panel.startOffset is not None and panel.endOffset is not None],
        key=lambda panel: (panel.startOffset, panel.endOffset, panel.order),
    )
    previous_panel = next((panel for panel in reversed(ordered) if panel.startOffset is not None and panel.startOffset <= start_offset), None)
    next_panel = next((panel for panel in ordered if panel.startOffset is not None and panel.startOffset > start_offset), None)
    anchor = previous_panel or next_panel
    if anchor is None:
        page_id = _next_page(document).id
        return page_id, _default_rect(document, page_id)
    page_id = anchor.pageId
    anchor_bottom = anchor.rect.y + anchor.rect.h
    panels_below_anchor = [
        panel
        for panel in document.panels
        if panel.pageId == page_id and panel.layer == 0 and panel.rect.y >= anchor.rect.y
    ]
    y = max([anchor_bottom, *[panel.rect.y + panel.rect.h for panel in panels_below_anchor]], default=anchor_bottom)
    return page_id, StoryPanelRect(x=anchor.rect.x, y=y, w=anchor.rect.w, h=anchor.rect.h)


def create_panel(slug: str, payload: StoryPanelCreate) -> StoryPanelDocument:
    document = read_document(slug)
    inferred_page_id, inferred_rect = _story_order_placement(document, payload.startOffset)
    page_id = payload.pageId or inferred_page_id
    target_page = next((page for page in document.pages if page.id == page_id), None)
    if target_page is None:
        raise HTTPException(status_code=400, detail=f"Unknown page: {page_id}")
    if target_page.pageKind != "story":
        raise HTTPException(status_code=400, detail="Story panel chunks can only be created on story pages")
    rect = payload.rect or (inferred_rect if page_id == inferred_page_id else _default_rect(document, page_id))
    book = read_book(slug)
    if payload.endOffset > len(book):
        raise HTTPException(status_code=400, detail="Panel range exceeds book length")
    selected = book[payload.startOffset:payload.endOffset]
    if payload.selectedText and payload.selectedText != selected:
        raise HTTPException(status_code=400, detail="Panel selectedText does not match book range")
    next_order = max((panel.order for panel in document.panels), default=-1) + 1
    panel = StoryPanel(
        id=_next_panel_id(document),
        order=next_order,
        sourceKind="story",
        startOffset=payload.startOffset,
        endOffset=payload.endOffset,
        selectedText=selected,
        pageId=page_id,
        rect=rect,
        layer=payload.layer,
    )
    document.panels.append(panel)
    return save_document(slug, document)


def patch_panel(slug: str, panel_id: str, payload: StoryPanelPatch) -> StoryPanelDocument:
    document = read_document(slug)
    index = next((idx for idx, panel in enumerate(document.panels) if panel.id == panel_id), None)
    if index is None:
        raise HTTPException(status_code=404, detail=f"Panel not found: {panel_id}")
    current = document.panels[index]
    updates = payload.model_dump(exclude_unset=True)
    if "pageId" in updates and not any(page.id == updates["pageId"] for page in document.pages):
        raise HTTPException(status_code=400, detail=f"Unknown page: {updates['pageId']}")
    target_page_id = updates.get("pageId", current.pageId)
    target_page = next(page for page in document.pages if page.id == target_page_id)
    next_source_kind = updates.get("sourceKind", current.sourceKind)
    if next_source_kind == "story" and target_page.pageKind != "story":
        raise HTTPException(status_code=400, detail="Story panel chunks can only be placed on story pages")
    if "activeAssetId" in updates and updates["activeAssetId"] is None:
        updates["activeAssetId"] = None
    next_panel = StoryPanel.model_validate({**current.model_dump(mode="json"), **updates})
    document.panels[index] = next_panel
    return save_document(slug, document)


def delete_panel(slug: str, panel_id: str) -> StoryPanelDocument:
    document = read_document(slug)
    next_panels = [panel for panel in document.panels if panel.id != panel_id]
    if len(next_panels) == len(document.panels):
        raise HTTPException(status_code=404, detail=f"Panel not found: {panel_id}")
    document.panels = next_panels
    return save_document(slug, document)


def add_page(slug: str, title: str = "") -> StoryPanelDocument:
    document = read_document(slug)
    existing = {page.id for page in document.pages}
    index = len(existing) + 1
    while True:
        page_id = _slugify(title) if title else f"page-{index:03d}"
        if page_id not in existing:
            break
        index += 1
        page_id = f"page-{index:03d}"
    document.pages.append(
        StoryPanelPage(
            id=page_id,
            order=max((page.order for page in document.pages), default=-1) + 1,
            title=title or f"Page {index}",
            pageKind="story",
        )
    )
    return save_document(slug, document)
