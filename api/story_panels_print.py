"""PDF booklet export for story panel documents."""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
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
OUTER_MARGIN = 18
TOP_MARGIN = 18
BOTTOM_MARGIN = 18
INNER_GUTTER = 18
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


@dataclass
class RichTextRun:
    text: str
    bold: bool = False
    italic: bool = False
    underline: bool = False


class RichTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.runs: list[RichTextRun | None] = []
        self._bold = 0
        self._italic = 0
        self._underline = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"strong", "b"}:
            self._bold += 1
        elif tag in {"em", "i"}:
            self._italic += 1
        elif tag == "u":
            self._underline += 1
        elif tag in {"br", "div", "p"}:
            self.runs.append(None)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"strong", "b"}:
            self._bold = max(0, self._bold - 1)
        elif tag in {"em", "i"}:
            self._italic = max(0, self._italic - 1)
        elif tag == "u":
            self._underline = max(0, self._underline - 1)
        elif tag in {"div", "p"}:
            self.runs.append(None)

    def handle_data(self, data: str) -> None:
        if not data:
            return
        self.runs.append(
            RichTextRun(
                text=data,
                bold=self._bold > 0,
                italic=self._italic > 0,
                underline=self._underline > 0,
            )
        )


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
    style = panel.textStyle
    transparent = panel.sourceKind == "caption" and style.background == "transparent"
    if transparent:
        pdf.setFillColor(white)
        pdf.setStrokeColor(white)
    else:
        pdf.setFillColor(white)
        pdf.setStrokeColor(HexColor("#cbd5e1"))
    radius = min(w, h) / 2 if panel.sourceKind == "caption" and style.shape == "oval" else 0
    if radius > 0:
        pdf.roundRect(x, y, w, h, radius, stroke=0 if transparent else 1, fill=0 if transparent else 1)
    else:
        pdf.rect(x, y, w, h, stroke=0 if transparent else 1, fill=0 if transparent else 1)
    rich_text = panel.richText or _plain_text_to_rich_text(panel.customText or panel.selectedText)
    text_color = HexColor(style.color) if panel.sourceKind == "caption" else black
    text_x = x + 5
    text_y = y + h - 8
    text_w = w - 10
    text_h = h - 10
    if transparent and panel.sourceKind == "caption":
        outline_color = HexColor(style.outlineColor)
        for dx, dy in (
            (-0.6, 0),
            (0.6, 0),
            (0, -0.6),
            (0, 0.6),
            (-0.6, -0.6),
            (0.6, -0.6),
            (-0.6, 0.6),
            (0.6, 0.6),
        ):
            _draw_rich_text(
                pdf,
                rich_text,
                text_x + dx,
                text_y + dy,
                text_w,
                text_h,
                font_family=style.fontFamily,
                size=style.fontSize,
                align=style.align,
                color=outline_color,
            )
    _draw_rich_text(
        pdf,
        rich_text,
        text_x,
        text_y,
        text_w,
        text_h,
        font_family=style.fontFamily,
        size=style.fontSize,
        align=style.align,
        color=text_color,
    )


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


def _plain_text_to_rich_text(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")


def _comic_sans_paths() -> list[Path]:
    return [
        Path("/System/Library/Fonts/Supplemental/Comic Sans MS.ttf"),
        Path("/Library/Fonts/Comic Sans MS.ttf"),
        Path.home() / "Library/Fonts/Comic Sans MS.ttf",
        Path("C:/Windows/Fonts/comic.ttf"),
    ]


def _ensure_comic_sans_registered() -> bool:
    cached = getattr(_ensure_comic_sans_registered, "_available", None)
    if cached is not None:
        return cached
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    for path in _comic_sans_paths():
        if not path.is_file():
            continue
        try:
            pdfmetrics.registerFont(TTFont("ComicSans", str(path)))
        except Exception:
            continue
        _ensure_comic_sans_registered._available = True
        return True
    _ensure_comic_sans_registered._available = False
    return False


def _base_font(font_family: str) -> str:
    if font_family == "sans":
        return "Helvetica"
    if font_family == "mono":
        return "Courier"
    if font_family == "comic":
        return "ComicSans" if _ensure_comic_sans_registered() else "Helvetica"
    return "Times"


def _font_name(font_family: str, *, bold: bool = False, italic: bool = False) -> str:
    base = _base_font(font_family)
    if base == "ComicSans":
        return "ComicSans"
    if base == "Times":
        if bold and italic:
            return "Times-BoldItalic"
        if bold:
            return "Times-Bold"
        if italic:
            return "Times-Italic"
        return "Times-Roman"
    if base == "Courier":
        if bold and italic:
            return "Courier-BoldOblique"
        if bold:
            return "Courier-Bold"
        if italic:
            return "Courier-Oblique"
        return "Courier"
    if bold and italic:
        return "Helvetica-BoldOblique"
    if bold:
        return "Helvetica-Bold"
    if italic:
        return "Helvetica-Oblique"
    return "Helvetica"


def _parse_rich_text(html: str) -> list[RichTextRun | None]:
    parser = RichTextParser()
    parser.feed(html)
    return parser.runs or [RichTextRun("")]


def _draw_rich_text(
    pdf: canvas.Canvas,
    html: str,
    x: float,
    y: float,
    width: float,
    height: float,
    *,
    font_family: str,
    size: int,
    align: str,
    color: HexColor | None = None,
) -> None:
    pdf.setFillColor(color or HexColor("#111827"))
    line_height = size * 1.25
    lines: list[list[RichTextRun]] = []
    current: list[RichTextRun] = []
    current_width = 0.0

    def push_line() -> None:
        nonlocal current, current_width
        lines.append(current)
        current = []
        current_width = 0.0

    for run in _parse_rich_text(html):
        if run is None:
            if current:
                push_line()
            else:
                lines.append([])
            continue
        for token in run.text.split(" "):
            if token == "" and current:
                continue
            word = token
            prefix = " " if current else ""
            font = _font_name(font_family, bold=run.bold, italic=run.italic)
            token_width = pdf.stringWidth(prefix + word, font, size)
            if current and current_width + token_width > width:
                push_line()
                prefix = ""
                token_width = pdf.stringWidth(word, font, size)
            current.append(RichTextRun(prefix + word, bold=run.bold, italic=run.italic, underline=run.underline))
            current_width += token_width
    if current:
        push_line()

    remaining_y = y
    min_y = y - height
    for line in lines:
        if remaining_y < min_y:
            return
        line_width = sum(
            pdf.stringWidth(run.text, _font_name(font_family, bold=run.bold, italic=run.italic), size)
            for run in line
        )
        cursor_x = x
        if align == "center":
            cursor_x = x + max(0, (width - line_width) / 2)
        elif align == "right":
            cursor_x = x + max(0, width - line_width)
        for run in line:
            font = _font_name(font_family, bold=run.bold, italic=run.italic)
            pdf.setFont(font, size)
            pdf.drawString(cursor_x, remaining_y, run.text)
            run_width = pdf.stringWidth(run.text, font, size)
            if run.underline and run.text.strip():
                pdf.line(cursor_x, remaining_y - 1.5, cursor_x + run_width, remaining_y - 1.5)
            cursor_x += run_width
        remaining_y -= line_height
