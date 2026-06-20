"""PDF booklet export for story panel documents."""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image
from reportlab.lib.colors import HexColor, black, lightgrey, white
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from typing import Literal

import library
import story_panels
from models import StoryPanel, StoryPanelDocument, StoryPanelPage

SHEET_WIDTH, SHEET_HEIGHT = landscape(letter)
HALF_WIDTH = SHEET_WIDTH / 2
PAGE_HEIGHT = SHEET_HEIGHT
OUTER_MARGIN = 9
TOP_MARGIN = 18
BOTTOM_MARGIN = 18
INNER_GUTTER = 27
GRID_COLUMNS = 12


@dataclass(frozen=True)
class PrintPage:
    page: StoryPanelPage | None
    number: int | None


@dataclass(frozen=True)
class ImposedSheet:
    front_left: PrintPage
    front_right: PrintPage
    back_left: PrintPage
    back_right: PrintPage


def story_pages(document: StoryPanelDocument) -> list[PrintPage]:
    story_number = 0
    pages: list[PrintPage] = []
    for page in sorted(document.pages, key=lambda page: (page.order, page.id)):
        if page.pageKind == "story":
            story_number += 1
            pages.append(PrintPage(page=page, number=story_number))
        else:
            pages.append(PrintPage(page=page, number=None))
    return pages


def padded_booklet_pages(pages: list[PrintPage]) -> list[PrintPage]:
    """Pad to a multiple of four for saddle-stitch imposition.

    Blanks are inserted before the last page so the back cover stays at the
    final reading-order position (outside back when the booklet is closed).
    """
    blank = PrintPage(page=None, number=None)
    padded = [*pages]
    while len(padded) == 0 or len(padded) % 4 != 0:
        if len(padded) == 0:
            padded.append(blank)
        else:
            padded.insert(-1, blank)
    return padded


def impose_booklet_pages(pages: list[PrintPage]) -> list[ImposedSheet]:
    padded = padded_booklet_pages(pages)
    sheets: list[ImposedSheet] = []
    left = 0
    right = len(padded) - 1
    while left < right:
        sheets.append(
            ImposedSheet(
                front_left=padded[right],
                front_right=padded[left],
                back_left=padded[left + 1],
                back_right=padded[right - 1],
            )
        )
        left += 2
        right -= 2
    return sheets


PageBorder = Literal["black", "grey", "none"]


def render_booklet_pdf(slug: str, *, page_border: PageBorder = "black") -> bytes:
    document = story_panels.read_document(slug)
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(SHEET_WIDTH, SHEET_HEIGHT))
    panels_by_page = _panels_by_page(document)
    for sheet in impose_booklet_pages(story_pages(document)):
        _draw_sheet_side(pdf, slug, document, panels_by_page, sheet.front_left, sheet.front_right, page_border=page_border)
        pdf.showPage()
        _draw_sheet_side(pdf, slug, document, panels_by_page, sheet.back_left, sheet.back_right, page_border=page_border)
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def _panels_by_page(document: StoryPanelDocument) -> dict[str, list[StoryPanel]]:
    panels: dict[str, list[StoryPanel]] = {}
    for panel in document.panels:
        panels.setdefault(panel.pageId, []).append(panel)
    for page_panels in panels.values():
        page_panels.sort(key=lambda panel: (panel.layer, panel.rect.y, panel.rect.x, panel.order))
    return panels


def _draw_sheet_side(
    pdf: canvas.Canvas,
    slug: str,
    document: StoryPanelDocument,
    panels_by_page: dict[str, list[StoryPanel]],
    left_page: PrintPage,
    right_page: PrintPage,
    *,
    page_border: PageBorder = "black",
) -> None:
    pdf.setFillColor(white)
    pdf.rect(0, 0, SHEET_WIDTH, SHEET_HEIGHT, stroke=0, fill=1)
    _draw_comic_page(pdf, slug, document, panels_by_page, left_page, 0, is_left=True, page_border=page_border)
    _draw_comic_page(pdf, slug, document, panels_by_page, right_page, HALF_WIDTH, is_left=False, page_border=page_border)
    pdf.setStrokeColor(lightgrey)
    pdf.setDash(3, 4)
    pdf.line(HALF_WIDTH, 0, HALF_WIDTH, SHEET_HEIGHT)
    pdf.setDash()


def _draw_comic_page(
    pdf: canvas.Canvas,
    slug: str,
    document: StoryPanelDocument,
    panels_by_page: dict[str, list[StoryPanel]],
    print_page: PrintPage,
    origin_x: float,
    *,
    is_left: bool,
    page_border: PageBorder = "black",
) -> None:
    inner_margin = INNER_GUTTER if is_left else OUTER_MARGIN
    outer_margin = OUTER_MARGIN if is_left else INNER_GUTTER
    page_x = origin_x + outer_margin
    page_y = BOTTOM_MARGIN
    page_w = HALF_WIDTH - outer_margin - inner_margin
    page_h = PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN
    if page_border == "black":
        pdf.setStrokeColor(black)
        pdf.setLineWidth(0.75)
        pdf.rect(page_x, page_y, page_w, page_h, stroke=1, fill=0)
    elif page_border == "grey":
        pdf.setStrokeColor(HexColor("#cbd5e1"))
        pdf.setLineWidth(0.5)
        pdf.rect(page_x, page_y, page_w, page_h, stroke=1, fill=0)
    if print_page.page is None:
        _draw_blank_page(pdf, page_x, page_y, page_w, page_h)
        return
    page_panels = panels_by_page.get(print_page.page.id, [])
    page_rows = max([10.0, *(panel.rect.y + panel.rect.h for panel in page_panels)])
    for panel in page_panels:
        _draw_panel(pdf, panel, print_page.number, page_x, page_y, page_w, page_h, page_rows, slug=slug)
    if print_page.number is not None:
        pdf.setFillColor(HexColor("#475569"))
        pdf.setFont("Helvetica", 7)
        pdf.drawCentredString(page_x + page_w / 2, page_y - 10, str(print_page.number))


def _draw_blank_page(pdf: canvas.Canvas, x: float, y: float, w: float, h: float) -> None:
    pdf.setFillColor(HexColor("#64748b"))
    pdf.setFont("Helvetica-Oblique", 10)
    pdf.drawCentredString(x + w / 2, y + h / 2, "This page intentionally left blank.")


def _draw_panel(
    pdf: canvas.Canvas,
    panel: StoryPanel,
    page_number: int | None,
    page_x: float,
    page_y: float,
    page_w: float,
    page_h: float,
    page_rows: float,
    *,
    slug: str,
) -> None:
    x = page_x + (panel.rect.x / GRID_COLUMNS) * page_w
    w = (panel.rect.w / GRID_COLUMNS) * page_w
    h = (panel.rect.h / page_rows) * page_h
    y = page_y + page_h - ((panel.rect.y / page_rows) * page_h) - h
    if panel.panelKind == "text":
        _draw_text_panel(pdf, panel, x, y, w, h)
        return
    _draw_image_panel(pdf, panel, page_number, x, y, w, h, slug=slug)


def _draw_text_panel(pdf: canvas.Canvas, panel: StoryPanel, x: float, y: float, w: float, h: float) -> None:
    pdf.setFillColor(HexColor("#ede9fe"))
    pdf.setStrokeColor(HexColor("#8b5cf6"))
    pdf.rect(x, y, w, h, stroke=1, fill=1)
    text = (panel.customText or panel.selectedText).strip()
    _draw_wrapped_text(pdf, text, x + 5, y + h - 12, w - 10, h - 10, font="Times-Roman", size=8)


def _draw_image_panel(
    pdf: canvas.Canvas,
    panel: StoryPanel,
    page_number: int | None,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    slug: str,
) -> None:
    asset_path = _active_asset_path(slug, panel)
    if asset_path is not None:
        _draw_cropped_image(pdf, asset_path, x, y, w, h)
    else:
        pdf.setFillColor(HexColor("#dbeafe"))
        pdf.setStrokeColor(HexColor("#2563eb"))
        pdf.rect(x, y, w, h, stroke=1, fill=1)
        label = "Image block" if panel.sourceKind == "free-image" else f"Page {page_number or '?'} Panel"
        body = panel.selectedText.strip() or panel.customText.strip()
        _draw_wrapped_text(pdf, f"{label}\n{body}", x + 5, y + h - 12, w - 10, h - 10, size=7)
        return
    pdf.setStrokeColor(HexColor("#0f172a"))
    pdf.rect(x, y, w, h, stroke=1, fill=0)


def _active_asset_path(slug: str, panel: StoryPanel) -> Path | None:
    if not panel.activeAssetId:
        return None
    path = library.asset_png_path(slug, panel.activeAssetId)
    return path if path.is_file() else None


def _draw_cropped_image(pdf: canvas.Canvas, path: Path, x: float, y: float, w: float, h: float) -> None:
    with Image.open(path) as image:
        image = image.convert("RGB")
        source_w, source_h = image.size
        target_ratio = w / h
        source_ratio = source_w / source_h
        if source_ratio > target_ratio:
            crop_w = int(source_h * target_ratio)
            left = (source_w - crop_w) // 2
            box = (left, 0, left + crop_w, source_h)
        else:
            crop_h = int(source_w / target_ratio)
            top = (source_h - crop_h) // 2
            box = (0, top, source_w, top + crop_h)
        cropped = image.crop(box)
        buffer = BytesIO()
        cropped.save(buffer, format="PNG")
        buffer.seek(0)
        pdf.drawImage(ImageReader(buffer), x, y, width=w, height=h)


def _draw_wrapped_text(
    pdf: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    width: float,
    height: float,
    *,
    font: str = "Helvetica",
    size: int = 8,
) -> None:
    pdf.setFillColor(HexColor("#0f172a"))
    pdf.setFont(font, size)
    line_height = size * 1.25
    remaining_y = y
    min_y = y - height
    for paragraph in text.splitlines() or [""]:
        line = ""
        for word in paragraph.split():
            candidate = f"{line} {word}".strip()
            if pdf.stringWidth(candidate, font, size) <= width:
                line = candidate
                continue
            if line:
                pdf.drawString(x, remaining_y, line)
                remaining_y -= line_height
            line = word
            if remaining_y < min_y:
                return
        if line and remaining_y >= min_y:
            pdf.drawString(x, remaining_y, line)
            remaining_y -= line_height
        if remaining_y < min_y:
            return
