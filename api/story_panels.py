"""Project-backed story panel chunking and page layout helpers."""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError

import adaptation
import library
from common import slugify, utc_now
from models import (
    DEFAULT_AUTO_PLACE_H,
    DEFAULT_AUTO_PLACE_W,
    LAYOUT_GRID_COLUMNS,
    LAYOUT_PAGE_ROWS,
    StoryPanel,
    StoryPanelBookmarkCreate,
    StoryPanelCaption,
    StoryPanelCreate,
    StoryPanelDocument,
    StoryPanelPage,
    StoryPanelImagePrompt,
    StoryPanelPatch,
    StoryPanelRect,
)

logger = logging.getLogger(__name__)


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
    document = _normalize_document_pages(StoryPanelDocument(pages=default_story_pages(), panels=[]))
    _ensure_default_fixed_page_panels(document)
    return document


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
    return document


def _ensure_default_fixed_page_panels(document: StoryPanelDocument) -> None:
    defaults = {
        "cover": {
            "title": "Title",
            "visibleText": "Title goes here",
            "rect": StoryPanelRect(x=1.5, y=1.25, w=9, h=1.25),
        },
        "inside-front-cover": {
            "title": "Copyright",
            "visibleText": "Copyright information goes here.",
            "rect": StoryPanelRect(x=1, y=1, w=10, h=2),
        },
        "inside-back-cover": {
            "title": "About",
            "visibleText": "About this comic, acknowledgements, or bonus notes go here.",
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
                title=default["title"],
                sourceKind="panel",
                startOffset=None,
                endOffset=None,
                selectedText="",
                storyText="",
                visibleText=default["visibleText"],
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
        if panel.sourceKind == "panel" and (panel.startOffset is None or panel.endOffset is None):
            continue
        if panel.sourceKind not in {"panel", "bookmark"}:
            continue
        assert panel.startOffset is not None and panel.endOffset is not None
        if panel.endOffset > book_len:
            raise HTTPException(status_code=400, detail=f"Panel range exceeds book length: {panel.id}")
        selected = book[panel.startOffset:panel.endOffset]
        if panel.selectedText and panel.selectedText != selected:
            raise HTTPException(status_code=400, detail=f"Panel selectedText does not match book range: {panel.id}")
        panel.selectedText = selected
        if panel.sourceKind == "panel":
            panel.storyText = selected
    return document


def read_document(slug: str) -> StoryPanelDocument:
    path = document_path(slug)
    if not path.is_file():
        return empty_document()
    raw = library.read_json(path)
    _normalize_raw_document(raw)
    document = StoryPanelDocument.model_validate(raw)
    return _validate_against_book(slug, _normalize_document_pages(document))


def _normalize_raw_document(raw: dict) -> None:
    for panel in raw.get("panels", []):
        if panel.get("sourceKind") == "note":
            panel["sourceKind"] = "panel"
        legacy_custom_text = panel.pop("customText", "")
        is_fixed_page_text_block = (
            panel.get("sourceKind") == "panel"
            and panel.get("panelKind") == "text"
            and panel.get("startOffset") is None
            and panel.get("pageId") in {"cover", "inside-front-cover", "inside-back-cover"}
        )
        if panel.get("sourceKind") == "bookmark" and not panel.get("title"):
            panel["title"] = legacy_custom_text
        if "storyText" not in panel:
            panel["storyText"] = "" if is_fixed_page_text_block else (
                panel.get("selectedText", "") if panel.get("startOffset") is not None else legacy_custom_text
            )
        elif is_fixed_page_text_block and panel.get("storyText") == panel.get("visibleText", legacy_custom_text):
            panel["storyText"] = ""
        if "visibleText" not in panel:
            panel["visibleText"] = legacy_custom_text
        panel.setdefault("imagePrompts", [])
        for caption in panel.get("captions", []):
            legacy_caption_text = caption.pop("customText", "")
            if "visibleText" not in caption:
                caption["visibleText"] = legacy_caption_text
    caption_records = [panel for panel in raw.get("panels", []) if panel.get("parentPanelId")]
    if not caption_records:
        return
    parent_by_id = {
        panel.get("id"): panel
        for panel in raw.get("panels", [])
        if panel.get("id") and not panel.get("parentPanelId")
    }
    for caption in caption_records:
        parent = parent_by_id.get(caption.get("parentPanelId"))
        if parent is None:
            continue
        parent.setdefault("captions", []).append(
            StoryPanelCaption(
                id=caption["id"],
                visibleText=caption.get("visibleText", ""),
                richText=caption.get("richText", ""),
                textStyle=caption.get("textStyle", {}),
                rect=caption.get("rect", {}),
                layer=caption.get("layer", 0),
            ).model_dump(mode="json")
        )
    raw["panels"] = [panel for panel in raw.get("panels", []) if not panel.get("parentPanelId")]


def _write_document(slug: str, document: StoryPanelDocument) -> StoryPanelDocument:
    path = document_path(slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    library.write_json(path, document.model_dump(mode="json"))
    return document


def _validate_story_overlaps(document: StoryPanelDocument) -> None:
    ranges = sorted(
        (panel.startOffset, panel.endOffset, panel.id)
        for panel in document.panels
        if panel.sourceKind == "panel" and panel.startOffset is not None and panel.endOffset is not None
    )
    for previous, current in zip(ranges, ranges[1:]):
        if previous[1] > current[0]:
            raise HTTPException(status_code=400, detail=f"Panel text ranges overlap: {previous[2]} and {current[2]}")


def save_document(slug: str, document: StoryPanelDocument) -> StoryPanelDocument:
    return _write_document(slug, _validate_against_book(slug, _normalize_document_pages(document)))


def _next_panel_id(document: StoryPanelDocument) -> str:
    existing = {panel.id for panel in document.panels}
    existing.update(caption.id for panel in document.panels for caption in panel.captions)
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


def _auto_place_slot_fits(x: float, y: float, w: float, h: float) -> bool:
    return x + w <= LAYOUT_GRID_COLUMNS + 1e-9 and y + h <= LAYOUT_PAGE_ROWS + 1e-9


def _story_pages_sorted(document: StoryPanelDocument) -> list[StoryPanelPage]:
    return sorted(
        [page for page in document.pages if page.pageKind == "story"],
        key=lambda page: (page.order, page.id),
    )


def _story_page_ids(document: StoryPanelDocument) -> set[str]:
    return {page.id for page in document.pages if page.pageKind == "story"}


def _append_story_page(document: StoryPanelDocument) -> StoryPanelPage:
    existing = {page.id for page in document.pages}
    story_pages = _story_pages_sorted(document)
    index = len(story_pages) + 1
    while True:
        page_id = f"page-{index:03d}"
        if page_id not in existing:
            break
        index += 1
    page = StoryPanelPage(
        id=page_id,
        order=max((page.order for page in document.pages), default=-1) + 1,
        title=f"Page {index}",
        pageKind="story",
    )
    document.pages.append(page)
    return page


def _next_story_page(document: StoryPanelDocument, page_id: str) -> StoryPanelPage:
    story_pages = _story_pages_sorted(document)
    for index, page in enumerate(story_pages):
        if page.id == page_id:
            if index + 1 < len(story_pages):
                return story_pages[index + 1]
            return _append_story_page(document)
    return _append_story_page(document)


def _panels_on_page(document: StoryPanelDocument, page_id: str) -> list[StoryPanel]:
    return [panel for panel in document.panels if panel.pageId == page_id and panel.layer == 0]


def _candidate_slot_xy(
    document: StoryPanelDocument,
    page_id: str,
    anchor: StoryPanel,
    w: float,
    h: float,
) -> tuple[float, float]:
    next_x = anchor.rect.x + anchor.rect.w
    next_y = anchor.rect.y
    if _auto_place_slot_fits(next_x, next_y, w, h):
        return next_x, next_y
    same_row = [panel for panel in _panels_on_page(document, page_id) if panel.rect.y == anchor.rect.y]
    row_bottom = max(panel.rect.y + panel.rect.h for panel in (same_row or [anchor]))
    return 0.0, row_bottom


def _auto_place_slot(
    document: StoryPanelDocument,
    *,
    page_id: str,
    after: StoryPanel | None = None,
    w: float = DEFAULT_AUTO_PLACE_W,
    h: float = DEFAULT_AUTO_PLACE_H,
) -> tuple[str, StoryPanelRect]:
    if after is None:
        x, y = 0.0, 0.0
    else:
        x, y = _candidate_slot_xy(document, page_id, after, w, h)
    current_page_id = page_id
    while not _auto_place_slot_fits(x, y, w, h):
        next_page = _next_story_page(document, current_page_id)
        current_page_id = next_page.id
        x, y = 0.0, 0.0
    return current_page_id, _clamp_panel_rect(StoryPanelRect(x=x, y=y, w=w, h=h))


def _default_placement(document: StoryPanelDocument, page_id: str) -> tuple[str, StoryPanelRect]:
    panels_on_page = _panels_on_page(document, page_id)
    if not panels_on_page:
        return _auto_place_slot(document, page_id=page_id)
    ordered = sorted(panels_on_page, key=lambda panel: (panel.rect.y, panel.rect.x))
    return _auto_place_slot(document, page_id=page_id, after=ordered[-1])


def _story_order_placement(document: StoryPanelDocument, start_offset: int) -> tuple[str, StoryPanelRect]:
    ordered = sorted(
        [
            panel
            for panel in document.panels
            if panel.sourceKind == "panel"
            and panel.parentPanelId is None
            and panel.startOffset is not None
            and panel.endOffset is not None
            and panel.pageId is not None
        ],
        key=lambda panel: (panel.startOffset, panel.endOffset, panel.order),
    )
    previous_panel = next((panel for panel in reversed(ordered) if panel.startOffset is not None and panel.startOffset <= start_offset), None)
    next_panel = next((panel for panel in ordered if panel.startOffset is not None and panel.startOffset > start_offset), None)
    anchor = previous_panel or next_panel
    if anchor is None:
        page = _next_page(document)
        return _auto_place_slot(document, page_id=page.id)
    page_id = anchor.pageId
    assert page_id is not None
    return _auto_place_slot(document, page_id=page_id, after=anchor)


def _place_after_panel(
    document: StoryPanelDocument,
    anchor: StoryPanel,
    w: float = DEFAULT_AUTO_PLACE_W,
    h: float = DEFAULT_AUTO_PLACE_H,
) -> tuple[str, StoryPanelRect]:
    page_id = anchor.pageId
    if page_id is None:
        page = _next_page(document)
        return _auto_place_slot(document, page_id=page.id)
    return _auto_place_slot(document, page_id=page_id, after=anchor, w=w, h=h)


def _draft_order_placement(document: StoryPanelDocument, insert_after_panel_id: str | None) -> tuple[str, StoryPanelRect]:
    story_page_ids = _story_page_ids(document)
    if insert_after_panel_id:
        anchor = next((panel for panel in document.panels if panel.id == insert_after_panel_id), None)
        if anchor and anchor.sourceKind == "panel" and anchor.parentPanelId is None:
            if anchor.pageId is not None and anchor.pageId in story_page_ids:
                return _place_after_panel(document, anchor)
    placed = sorted(
        [
            panel
            for panel in document.panels
            if panel.sourceKind == "panel"
            and panel.parentPanelId is None
            and panel.pageId is not None
            and panel.pageId in story_page_ids
        ],
        key=lambda panel: panel.order,
    )
    if placed:
        return _place_after_panel(document, placed[-1])
    page = _next_page(document)
    return _auto_place_slot(document, page_id=page.id)


def create_panel(slug: str, payload: StoryPanelCreate) -> StoryPanelDocument:
    document = read_document(slug)
    has_book_offsets = payload.startOffset is not None and payload.endOffset is not None
    page_id = payload.pageId
    rect = payload.rect
    if payload.autoPlace:
        if has_book_offsets:
            assert payload.startOffset is not None
            inferred_page_id, inferred_rect = _story_order_placement(document, payload.startOffset)
        else:
            inferred_page_id, inferred_rect = _draft_order_placement(document, payload.insertAfterPanelId)
        page_id = page_id or inferred_page_id
        target_page = next((page for page in document.pages if page.id == page_id), None)
        if target_page is None:
            raise HTTPException(status_code=400, detail=f"Unknown page: {page_id}")
        if rect:
            pass
        elif page_id == inferred_page_id:
            rect = inferred_rect
        else:
            page_id, rect = _default_placement(document, page_id)
    else:
        if page_id is not None:
            target_page = next((page for page in document.pages if page.id == page_id), None)
            if target_page is None:
                raise HTTPException(status_code=400, detail=f"Unknown page: {page_id}")
            if not rect:
                page_id, rect = _default_placement(document, page_id)
        else:
            rect = rect or StoryPanelRect(x=0, y=0, w=DEFAULT_AUTO_PLACE_W, h=DEFAULT_AUTO_PLACE_H)
    selected = payload.selectedText.strip()
    story_text = payload.storyText.strip()
    visible_text = payload.visibleText.strip()
    if has_book_offsets:
        assert payload.startOffset is not None and payload.endOffset is not None
        book = read_book(slug)
        if payload.endOffset > len(book):
            raise HTTPException(status_code=400, detail="Panel range exceeds book length")
        selected = book[payload.startOffset:payload.endOffset]
        if payload.selectedText and payload.selectedText != selected:
            raise HTTPException(status_code=400, detail="Panel selectedText does not match book range")
        story_text = selected
    elif selected and not story_text:
        story_text = story_text or selected
    next_order = _order_for_insert_after(document, payload.insertAfterPanelId)
    panel = StoryPanel(
        id=_next_panel_id(document),
        order=next_order,
        title=payload.title.strip(),
        sourceKind="panel",
        startOffset=payload.startOffset,
        endOffset=payload.endOffset,
        selectedText=selected,
        storyText=story_text,
        visibleText=visible_text,
        imagePrompts=payload.imagePrompts,
        pageId=page_id,
        panelKind=payload.panelKind,
        rect=rect,
        layer=payload.layer,
    )
    document.panels.append(panel)
    if has_book_offsets:
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
    title = payload.title.strip() or selected.replace("\n", " ").strip()[:120]
    next_order = _order_for_insert_after(document, payload.insertAfterPanelId)
    panel = StoryPanel(
        id=_next_panel_id(document),
        order=next_order,
        sourceKind="bookmark",
        startOffset=payload.startOffset,
        endOffset=payload.endOffset,
        selectedText=selected,
        title=title,
        pageId=None,
        panelKind="text",
        rect=StoryPanelRect(x=0, y=0, w=DEFAULT_AUTO_PLACE_W, h=DEFAULT_AUTO_PLACE_H),
        layer=0,
    )
    document.panels.append(panel)
    return save_document(slug, document)


def _validate_image_prompt_text(text: str) -> str:
    from adaptation_workflow.validate import CHAT_WRAPPER_RE

    cleaned = text.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Image prompt text must not be empty")
    if CHAT_WRAPPER_RE.search(cleaned):
        raise HTTPException(status_code=400, detail="Image prompt text must be plain prose without chat wrapper phrases")
    return cleaned


def next_image_prompt_id(prompts: list[StoryPanelImagePrompt]) -> str:
    existing = {prompt.id for prompt in prompts}
    index = len(prompts) + 1
    while f"prompt-{index:03d}" in existing:
        index += 1
    return f"prompt-{index:03d}"


def validate_panel_entities(
    slug: str,
    character_slugs: list[str] | None,
    location_slug: str | None,
) -> None:
    """422 on entity slugs that don't exist in the adaptation's canonical records."""
    if not character_slugs and not location_slug:
        return
    status = adaptation.status(slug)
    unknown_characters = [item for item in (character_slugs or []) if item not in status.characters]
    if unknown_characters:
        known = ", ".join(sorted(status.characters)) or "(none extracted yet)"
        raise HTTPException(
            status_code=422,
            detail=f"Unknown character slugs: {', '.join(unknown_characters)}. Known characters: {known}",
        )
    if location_slug and location_slug not in status.locations:
        known = ", ".join(sorted(status.locations)) or "(none extracted yet)"
        raise HTTPException(
            status_code=422,
            detail=f"Unknown location slug: {location_slug}. Known locations: {known}",
        )


def _require_panel(document: StoryPanelDocument, panel_id: str) -> int:
    index = next((idx for idx, panel in enumerate(document.panels) if panel.id == panel_id), None)
    if index is None:
        raise HTTPException(status_code=404, detail=f"Panel not found: {panel_id}")
    return index


def append_image_prompt(
    slug: str,
    panel_id: str,
    text: str,
    *,
    character_slugs: list[str] | None = None,
    location_slug: str | None = None,
) -> str:
    """Append a validated image prompt to a panel; returns the new prompt id.

    Optional entity slugs (agent delivery) are validated against the canonical
    character/location records and written onto the panel itself.
    """
    cleaned = _validate_image_prompt_text(text)
    validate_panel_entities(slug, character_slugs, location_slug)
    document = read_document(slug)
    index = _require_panel(document, panel_id)
    panel = document.panels[index]
    prompt_id = next_image_prompt_id(panel.imagePrompts)
    prompts = [*panel.imagePrompts, StoryPanelImagePrompt(id=prompt_id, text=cleaned)]
    updates: dict = {"imagePrompts": prompts}
    if character_slugs is not None:
        updates["characterSlugs"] = list(dict.fromkeys(character_slugs))
    if location_slug is not None:
        updates["locationSlug"] = location_slug
    document.panels[index] = panel.model_copy(update=updates)
    save_document(slug, document)
    return prompt_id


def replace_image_prompt(slug: str, panel_id: str, prompt_id: str, text: str) -> None:
    """Replace one existing image prompt's text in place."""
    cleaned = _validate_image_prompt_text(text)
    document = read_document(slug)
    index = _require_panel(document, panel_id)
    panel = document.panels[index]
    if not any(prompt.id == prompt_id for prompt in panel.imagePrompts):
        raise HTTPException(status_code=404, detail=f"Image prompt not found: {prompt_id}")
    prompts = [
        prompt.model_copy(update={"text": cleaned}) if prompt.id == prompt_id else prompt
        for prompt in panel.imagePrompts
    ]
    document.panels[index] = panel.model_copy(update={"imagePrompts": prompts})
    save_document(slug, document)


def draft_panel_to_canvas(slug: str, panel_id: str, prompt_id: str):
    """Create a canvas imageGroup node for one panel image prompt.

    The node's refs are the canonical reference assets of the panel's tagged
    entities (character sheet base variants and the location's asset), so
    generation keeps characters and setting consistent. Blocks (409) when a
    tagged entity has no reference asset yet.
    """
    from canvas_nodes import create_image_group_node, next_canvas_position
    from models import ConceptNodeResponse, GenerationParams

    document = read_document(slug)
    panel = document.panels[_require_panel(document, panel_id)]
    prompt = next((item for item in panel.imagePrompts if item.id == prompt_id), None)
    if prompt is None:
        raise HTTPException(status_code=404, detail=f"Image prompt not found: {prompt_id}")
    if not prompt.text.strip():
        raise HTTPException(status_code=409, detail="Image prompt is empty")

    adaptation.status(slug)  # refresh entity links and canonical tag pointers
    entity_tags = {tag.id: tag for tag in library.list_project_tags(slug) if tag.entityKind is not None}
    refs: list[str] = []
    missing: list[str] = []
    for character_slug in panel.characterSlugs:
        tag = entity_tags.get(library.normalize_tag_id(character_slug))
        asset_id = tag.canonicalAssetId if tag else None
        if asset_id is None:
            missing.append(f"character {character_slug}")
        elif asset_id not in refs:
            refs.append(asset_id)
    if panel.locationSlug:
        tag = entity_tags.get(library.normalize_tag_id(panel.locationSlug))
        asset_id = tag.canonicalAssetId if tag else None
        if asset_id is None:
            missing.append(f"location {panel.locationSlug}")
        elif asset_id not in refs:
            refs.append(asset_id)
    if missing:
        raise HTTPException(
            status_code=409,
            detail="Missing reference images — generate them first: " + ", ".join(missing),
        )

    canvas = library.read_stored_canvas(slug)
    x, y = next_canvas_position(canvas)
    tags = ["comic-adaptation", "story-panel", panel_id, *panel.characterSlugs]
    if panel.locationSlug:
        tags.append(panel.locationSlug)
    display_name = panel.title.strip() or f"Panel {panel_id}"
    node_id, saved = create_image_group_node(
        slug,
        display_name=display_name,
        tags=library.node_tags(*tags),
        prompt=prompt.text,
        refs=refs,
        params=GenerationParams(),
        x=x,
        y=y,
        source_panel_id=panel_id,
    )
    return ConceptNodeResponse(nodeId=node_id, canvas=saved)


def attach_assets_to_panel(slug: str, panel_id: str, asset_ids: list[str]) -> None:
    """Attach generated assets to the panel (newest becomes active). Tolerates a deleted panel."""
    if not asset_ids:
        return
    document = read_document(slug)
    index = next((idx for idx, panel in enumerate(document.panels) if panel.id == panel_id), None)
    if index is None:
        return
    panel = document.panels[index]
    merged = list(dict.fromkeys([*panel.assetIds, *asset_ids]))
    document.panels[index] = panel.model_copy(
        update={"assetIds": merged, "activeAssetId": asset_ids[0], "imageCrop": None}
    )
    save_document(slug, document)


def patch_panel(slug: str, panel_id: str, payload: StoryPanelPatch) -> StoryPanelDocument:
    document = read_document(slug)
    index = next((idx for idx, panel in enumerate(document.panels) if panel.id == panel_id), None)
    if index is None:
        raise HTTPException(status_code=404, detail=f"Panel not found: {panel_id}")
    current = document.panels[index]
    updates = payload.model_dump(exclude_unset=True)
    if "characterSlugs" in updates or "locationSlug" in updates:
        validate_panel_entities(slug, updates.get("characterSlugs"), updates.get("locationSlug"))
    if "pageId" in updates:
        page_id = updates["pageId"]
        if page_id is not None and not any(page.id == page_id for page in document.pages):
            raise HTTPException(status_code=400, detail=f"Unknown page: {page_id}")
    if "activeAssetId" in updates and updates["activeAssetId"] is None:
        updates["activeAssetId"] = None
    next_panel = StoryPanel.model_validate({**current.model_dump(mode="json"), **updates})
    document.panels[index] = next_panel
    if next_panel.sourceKind == "panel" and next_panel.startOffset is not None and next_panel.endOffset is not None:
        _validate_story_overlaps(document)
    return save_document(slug, document)


def auto_place_panel(slug: str, panel_id: str) -> StoryPanelDocument:
    document = read_document(slug)
    index = next((idx for idx, panel in enumerate(document.panels) if panel.id == panel_id), None)
    if index is None:
        raise HTTPException(status_code=404, detail=f"Panel not found: {panel_id}")
    panel = document.panels[index]
    if panel.sourceKind != "panel" or panel.parentPanelId is not None:
        raise HTTPException(status_code=400, detail="Only top-level panels can be auto-placed on the layout")
    if panel.pageId is not None:
        raise HTTPException(status_code=400, detail="Panel is already placed on the layout")
    ordered = sorted(
        [candidate for candidate in document.panels if candidate.sourceKind == "panel" and candidate.parentPanelId is None],
        key=lambda candidate: candidate.order,
    )
    panel_index = next(idx for idx, candidate in enumerate(ordered) if candidate.id == panel_id)
    insert_after_id = ordered[panel_index - 1].id if panel_index > 0 else None
    page_id, rect = _draft_order_placement(document, insert_after_id)
    document.panels[index] = panel.model_copy(update={"pageId": page_id, "rect": rect})
    if panel.startOffset is not None and panel.endOffset is not None:
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
    _normalize_raw_document(raw)
    try:
        document = StoryPanelDocument.model_validate(raw)
    except ValidationError:
        return None
    return _normalize_document_pages(document)


def _backup_document(slug: str) -> None:
    """Copy panels.json aside before a destructive reset so user chunking is recoverable."""
    path = document_path(slug)
    if not path.is_file():
        return
    backup = path.with_name(f"panels.json.bak-{utc_now().replace(':', '-')}")
    shutil.copyfile(path, backup)


def reset_chunks(slug: str) -> StoryPanelDocument:
    """Wipe story-panel chunks and layout while keeping canvas, assets, tags, and adaptation.

    Writes a fresh document without reading the old file so projects with incompatible
    panels.json can recover after breaking schema changes during local development.
    The old file is kept as panels.json.bak-<timestamp>.
    """
    library.require_project(slug)
    _backup_document(slug)
    return _write_document(slug, empty_document())


def reset_layout(slug: str) -> StoryPanelDocument:
    """Drop page placement and layout-only panels; keep story, draft, and bookmark chunks.

    When panels.json no longer validates, falls back to reset_chunks so the project can
    reopen Story and Layout without deleting canvas assets or adaptation work.
    """
    document = _read_document_lenient(slug)
    if document is None:
        logger.warning("panels.json for %s no longer validates; falling back to reset_chunks", slug)
        return reset_chunks(slug)
    default_rect = StoryPanelRect(x=0, y=0, w=DEFAULT_AUTO_PLACE_W, h=DEFAULT_AUTO_PLACE_H)
    document.panels = [
        panel if panel.sourceKind == "bookmark" else panel.model_copy(
            update={
                "pageId": None,
                "rect": default_rect,
                "layer": 0,
                "finalized": False,
            }
        )
        for panel in document.panels
        if panel.sourceKind == "bookmark" or (panel.sourceKind == "panel" and panel.parentPanelId is None)
    ]
    document = _normalize_document_pages(document)
    _ensure_default_fixed_page_panels(document)
    return save_document(slug, document)


def add_page(slug: str, title: str = "") -> StoryPanelDocument:
    document = read_document(slug)
    existing = {page.id for page in document.pages}
    index = len(existing) + 1
    while True:
        page_id = slugify(title, "panel") if title else f"page-{index:03d}"
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
