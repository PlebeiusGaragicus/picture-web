"""Project-backed story panel chunking and page layout helpers."""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError

import adaptation
import library
from models import (
    LAYOUT_PAGE_ROWS,
    StoryPanel,
    StoryPanelBookmarkCreate,
    StoryPanelCreate,
    StoryPanelDocument,
    StoryPanelDraftCreate,
    StoryPanelPage,
    StoryPanelPatch,
    StoryPanelRect,
)


def story_panels_dir(slug: str) -> Path:
    library.require_project(slug)
    return library.project_dir(slug) / "story-panels"


def document_path(slug: str) -> Path:
    return story_panels_dir(slug) / "panels.json"


def default_story_pages() -> list[StoryPanelPage]:
    return [
        StoryPanelPage(id=f"page-{index:03d}", order=index + 1, title=f"Page {index}", pageKind="story")
        for index in range(1, 5)
    ]


def default_page() -> StoryPanelPage:
    return default_story_pages()[0]


def empty_document() -> StoryPanelDocument:
    return _normalize_document_pages(StoryPanelDocument(pages=default_story_pages(), panels=[]))


def _fixed_page(id: str, order: int, title: str, page_kind: str) -> StoryPanelPage:
    return StoryPanelPage(id=id, order=order, title=title, pageKind=page_kind)  # type: ignore[arg-type]


def _normalize_document_pages(document: StoryPanelDocument) -> StoryPanelDocument:
    existing_by_id = {page.id: page for page in document.pages}
    story_pages = sorted(
        [page for page in document.pages if page.pageKind == "story"],
        key=lambda page: (page.order, page.id),
    )
    if not story_pages:
        story_pages = default_story_pages()
    fixed_front = [
        _fixed_page("cover", 0, "Front Cover", "cover"),
        _fixed_page("inside-front-cover", 1, "Inside Front Cover", "inside-cover"),
    ]
    fixed_back = [
        _fixed_page("inside-back-cover", 0, "Inside Back Cover", "inside-back-cover"),
        _fixed_page("back-cover", 0, "Back Cover", "back-cover"),
    ]
    ordered_pages: list[StoryPanelPage] = []
    for fixed in [*fixed_front, *story_pages, *fixed_back]:
        existing = existing_by_id.get(fixed.id)
        if existing and fixed.pageKind != "story":
            ordered_pages.append(
                StoryPanelPage.model_validate(
                    {**existing.model_dump(mode="json"), "title": fixed.title, "pageKind": fixed.pageKind}
                )
            )
        else:
            ordered_pages.append(existing if existing else fixed)
    document.pages = [
        StoryPanelPage.model_validate({**page.model_dump(mode="json"), "order": index})
        for index, page in enumerate(ordered_pages)
    ]
    _ensure_default_fixed_page_panels(document)
    return document


def _ensure_default_fixed_page_panels(document: StoryPanelDocument) -> None:
    defaults = {
        "cover": {
            "customText": "Title goes here",
            "rect": StoryPanelRect(x=1.5, y=1.25, w=9, h=1.25),
        },
        "inside-front-cover": {
            "customText": "Copyright information goes here.",
            "rect": StoryPanelRect(x=1, y=1, w=10, h=2),
        },
        "inside-back-cover": {
            "customText": "About this comic, acknowledgements, or bonus notes go here.",
            "rect": StoryPanelRect(x=1, y=1, w=10, h=2),
        },
    }
    existing_pages = {page.id for page in document.pages}
    occupied_pages = {panel.pageId for panel in document.panels if panel.pageId is not None}
    next_order = max((panel.order for panel in document.panels), default=-1) + 1
    for page_id, default in defaults.items():
        if page_id not in existing_pages or page_id in occupied_pages:
            continue
        document.panels.append(
            StoryPanel(
                id=_next_panel_id(document),
                order=next_order,
                sourceKind="free-text",
                startOffset=None,
                endOffset=None,
                selectedText="",
                customText=default["customText"],
                pageId=page_id,
                panelKind="text",
                rect=default["rect"],
                layer=0,
            )
        )
        next_order += 1


def read_book(slug: str) -> str:
    return adaptation.read_book(slug)


def optional_book_text(slug: str) -> str | None:
    try:
        return read_book(slug)
    except HTTPException as exc:
        if exc.status_code == 404:
            return None
        raise


def _validate_against_book(slug: str, document: StoryPanelDocument) -> StoryPanelDocument:
    book = optional_book_text(slug)
    if book is None:
        return document
    book_len = len(book)
    for panel in document.panels:
        if panel.sourceKind not in {"story", "bookmark"}:
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
    raw = library.read_json(path)
    for panel in raw.get("panels", []):
        if panel.get("sourceKind") == "note":
            panel["sourceKind"] = "story"
    document = StoryPanelDocument.model_validate(raw)
    return _validate_against_book(slug, _normalize_document_pages(document))


def _write_document(slug: str, document: StoryPanelDocument) -> StoryPanelDocument:
    path = document_path(slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    library.write_json(path, document.model_dump(mode="json"))
    return document


def _validate_story_overlaps(document: StoryPanelDocument) -> None:
    ranges = sorted(
        (panel.startOffset, panel.endOffset, panel.id)
        for panel in document.panels
        if panel.sourceKind == "story" and panel.startOffset is not None and panel.endOffset is not None
    )
    for previous, current in zip(ranges, ranges[1:]):
        if previous[1] > current[0]:
            raise HTTPException(status_code=400, detail=f"Panel text ranges overlap: {previous[2]} and {current[2]}")


def save_document(slug: str, document: StoryPanelDocument) -> StoryPanelDocument:
    return _write_document(slug, _validate_against_book(slug, _normalize_document_pages(document)))


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


def _clamp_panel_rect(rect: StoryPanelRect) -> StoryPanelRect:
    h = min(rect.h, float(LAYOUT_PAGE_ROWS))
    y = min(rect.y, float(LAYOUT_PAGE_ROWS) - h)
    return StoryPanelRect(x=rect.x, y=max(0.0, y), w=rect.w, h=h)


def _default_rect(document: StoryPanelDocument, page_id: str) -> StoryPanelRect:
    panels_on_page = [panel for panel in document.panels if panel.pageId == page_id and panel.layer == 0]
    y = 0.0
    if panels_on_page:
        y = max(panel.rect.y + panel.rect.h for panel in panels_on_page)
    return _clamp_panel_rect(StoryPanelRect(x=0, y=y, w=4, h=3))


def _story_order_placement(document: StoryPanelDocument, start_offset: int) -> tuple[str, StoryPanelRect]:
    ordered = sorted(
        [panel for panel in document.panels if panel.sourceKind == "story" and panel.startOffset is not None and panel.endOffset is not None and panel.pageId is not None],
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
    return page_id, _clamp_panel_rect(StoryPanelRect(x=anchor.rect.x, y=y, w=anchor.rect.w, h=anchor.rect.h))


def _place_below_panel(document: StoryPanelDocument, anchor: StoryPanel) -> tuple[str, StoryPanelRect]:
    page_id = anchor.pageId
    if page_id is None:
        page_id = _next_page(document).id
        return page_id, _default_rect(document, page_id)
    anchor_bottom = anchor.rect.y + anchor.rect.h
    panels_below_anchor = [
        panel
        for panel in document.panels
        if panel.pageId == page_id and panel.layer == 0 and panel.rect.y >= anchor.rect.y
    ]
    y = max([anchor_bottom, *[panel.rect.y + panel.rect.h for panel in panels_below_anchor]], default=anchor_bottom)
    return page_id, _clamp_panel_rect(StoryPanelRect(x=anchor.rect.x, y=y, w=anchor.rect.w, h=anchor.rect.h))


def _draft_order_placement(document: StoryPanelDocument, insert_after_panel_id: str | None) -> tuple[str, StoryPanelRect]:
    if insert_after_panel_id:
        anchor = next((panel for panel in document.panels if panel.id == insert_after_panel_id), None)
        if anchor and anchor.sourceKind in {"story", "draft"}:
            if anchor.pageId is not None:
                return _place_below_panel(document, anchor)
    placed = sorted(
        [panel for panel in document.panels if panel.sourceKind in {"story", "draft"} and panel.pageId is not None],
        key=lambda panel: panel.order,
    )
    if placed:
        return _place_below_panel(document, placed[-1])
    page_id = _next_page(document).id
    return page_id, _default_rect(document, page_id)


def create_panel(slug: str, payload: StoryPanelCreate) -> StoryPanelDocument:
    document = read_document(slug)
    if payload.autoPlace:
        inferred_page_id, inferred_rect = _story_order_placement(document, payload.startOffset)
        page_id = payload.pageId or inferred_page_id
        target_page = next((page for page in document.pages if page.id == page_id), None)
        if target_page is None:
            raise HTTPException(status_code=400, detail=f"Unknown page: {page_id}")
        if target_page.pageKind != "story":
            raise HTTPException(status_code=400, detail="Story panel chunks can only be created on story pages")
        rect = payload.rect or (inferred_rect if page_id == inferred_page_id else _default_rect(document, page_id))
    else:
        page_id = payload.pageId
        if page_id is not None:
            target_page = next((page for page in document.pages if page.id == page_id), None)
            if target_page is None:
                raise HTTPException(status_code=400, detail=f"Unknown page: {page_id}")
            if target_page.pageKind != "story":
                raise HTTPException(status_code=400, detail="Story panel chunks can only be created on story pages")
            rect = payload.rect or _default_rect(document, page_id)
        else:
            rect = payload.rect or StoryPanelRect(x=0, y=0, w=4, h=3)
    book = read_book(slug)
    if payload.endOffset > len(book):
        raise HTTPException(status_code=400, detail="Panel range exceeds book length")
    selected = book[payload.startOffset:payload.endOffset]
    if payload.selectedText and payload.selectedText != selected:
        raise HTTPException(status_code=400, detail="Panel selectedText does not match book range")
    next_order = _order_for_insert_after(document, payload.insertAfterPanelId)
    panel = StoryPanel(
        id=_next_panel_id(document),
        order=next_order,
        sourceKind="story",
        startOffset=payload.startOffset,
        endOffset=payload.endOffset,
        selectedText=selected,
        customText=payload.customText.strip(),
        pageId=page_id,
        rect=rect,
        layer=payload.layer,
    )
    document.panels.append(panel)
    _validate_story_overlaps(document)
    return save_document(slug, document)


def _order_for_insert_after(document: StoryPanelDocument, after_panel_id: str | None) -> int:
    if after_panel_id is None:
        return max((panel.order for panel in document.panels), default=-1) + 1
    after_panel = next((panel for panel in document.panels if panel.id == after_panel_id), None)
    if after_panel is None:
        raise HTTPException(status_code=404, detail=f"Panel not found: {after_panel_id}")
    insert_order = after_panel.order + 1
    for panel in document.panels:
        if panel.order >= insert_order:
            panel.order += 1
    return insert_order


def create_draft_panel(slug: str, payload: StoryPanelDraftCreate) -> StoryPanelDocument:
    document = read_document(slug)
    text = payload.customText.strip()
    page_id = payload.pageId
    rect = payload.rect
    if payload.autoPlace:
        inferred_page_id, inferred_rect = _draft_order_placement(document, payload.insertAfterPanelId)
        page_id = page_id or inferred_page_id
        target_page = next((page for page in document.pages if page.id == page_id), None)
        if target_page is None:
            raise HTTPException(status_code=400, detail=f"Unknown page: {page_id}")
        if target_page.pageKind != "story":
            raise HTTPException(status_code=400, detail="Draft panel chunks can only be created on story pages")
        rect = rect or (inferred_rect if page_id == inferred_page_id else _default_rect(document, page_id))
    elif page_id is not None:
        target_page = next((page for page in document.pages if page.id == page_id), None)
        if target_page is None:
            raise HTTPException(status_code=400, detail=f"Unknown page: {page_id}")
        if target_page.pageKind != "story":
            raise HTTPException(status_code=400, detail="Draft panel chunks can only be created on story pages")
        rect = rect or _default_rect(document, page_id)
    else:
        rect = rect or StoryPanelRect(x=0, y=0, w=4, h=3)
    next_order = _order_for_insert_after(document, payload.insertAfterPanelId)
    panel = StoryPanel(
        id=_next_panel_id(document),
        order=next_order,
        sourceKind="draft",
        startOffset=None,
        endOffset=None,
        selectedText=text,
        customText=text,
        pageId=page_id,
        rect=rect,
        layer=payload.layer,
    )
    document.panels.append(panel)
    return save_document(slug, document)


def create_bookmark(slug: str, payload: StoryPanelBookmarkCreate) -> StoryPanelDocument:
    document = read_document(slug)
    book = optional_book_text(slug)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    if payload.endOffset > len(book):
        raise HTTPException(status_code=400, detail="Bookmark range exceeds book length")
    selected = book[payload.startOffset:payload.endOffset]
    if payload.selectedText and payload.selectedText != selected:
        raise HTTPException(status_code=400, detail="Bookmark selectedText does not match book range")
    custom_text = payload.customText.strip()
    if not custom_text:
        custom_text = selected.replace("\n", " ").strip()[:120]
    next_order = _order_for_insert_after(document, payload.insertAfterPanelId)
    panel = StoryPanel(
        id=_next_panel_id(document),
        order=next_order,
        sourceKind="bookmark",
        startOffset=payload.startOffset,
        endOffset=payload.endOffset,
        selectedText=selected,
        customText=custom_text,
        pageId=None,
        panelKind="text",
        rect=StoryPanelRect(x=0, y=0, w=4, h=3),
        layer=0,
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
    next_source_kind = updates.get("sourceKind", current.sourceKind)
    if "pageId" in updates:
        page_id = updates["pageId"]
        if page_id is not None and not any(page.id == page_id for page in document.pages):
            raise HTTPException(status_code=400, detail=f"Unknown page: {page_id}")
        if page_id is None and next_source_kind not in {"story", "draft", "bookmark"}:
            raise HTTPException(status_code=400, detail="Only story, draft, and bookmark panels may be unplaced")
        if page_id is not None:
            target_page = next(page for page in document.pages if page.id == page_id)
            if next_source_kind in {"story", "draft"} and target_page.pageKind != "story":
                raise HTTPException(status_code=400, detail="Story panel chunks can only be placed on story pages")
    elif current.pageId is not None:
        target_page = next(page for page in document.pages if page.id == current.pageId)
        if next_source_kind in {"story", "draft"} and target_page.pageKind != "story":
            raise HTTPException(status_code=400, detail="Story panel chunks can only be placed on story pages")
    if "activeAssetId" in updates and updates["activeAssetId"] is None:
        updates["activeAssetId"] = None
    next_panel = StoryPanel.model_validate({**current.model_dump(mode="json"), **updates})
    document.panels[index] = next_panel
    if next_panel.sourceKind == "story":
        _validate_story_overlaps(document)
    return save_document(slug, document)


def delete_panel(slug: str, panel_id: str) -> StoryPanelDocument:
    document = read_document(slug)
    next_panels = [panel for panel in document.panels if panel.id != panel_id]
    if len(next_panels) == len(document.panels):
        raise HTTPException(status_code=404, detail=f"Panel not found: {panel_id}")
    document.panels = next_panels
    return save_document(slug, document)


def _read_document_lenient(slug: str) -> StoryPanelDocument | None:
    """Parse panels.json without book cross-checks; None when the file no longer validates."""
    path = document_path(slug)
    if not path.is_file():
        return empty_document()
    raw = library.read_json(path)
    for panel in raw.get("panels", []):
        if panel.get("sourceKind") == "note":
            panel["sourceKind"] = "story"
    try:
        document = StoryPanelDocument.model_validate(raw)
    except ValidationError:
        return None
    return _normalize_document_pages(document)


def reset_chunks(slug: str) -> StoryPanelDocument:
    """Wipe story-panel chunks and layout while keeping canvas, assets, tags, and adaptation.

    Writes a fresh document without reading the old file so projects with incompatible
    panels.json can recover after breaking schema changes during local development.
    """
    library.require_project(slug)
    return _write_document(slug, empty_document())


def reset_layout(slug: str) -> StoryPanelDocument:
    """Drop page placement and layout-only panels; keep story, draft, and bookmark chunks.

    When panels.json no longer validates, falls back to reset_chunks so the project can
    reopen Story and Layout without deleting canvas assets or adaptation work.
    """
    document = _read_document_lenient(slug)
    if document is None:
        return reset_chunks(slug)
    default_rect = StoryPanelRect(x=0, y=0, w=4, h=3)
    chunk_kinds = {"story", "draft", "bookmark"}
    document.panels = [
        panel.model_copy(
            update={
                "pageId": None,
                "rect": default_rect,
                "layer": 0,
                "finalized": False,
            }
        )
        for panel in document.panels
        if panel.sourceKind in chunk_kinds
    ]
    document = _normalize_document_pages(document)
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
