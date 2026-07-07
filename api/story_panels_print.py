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
from models import StoryPanel, StoryPanelCaption, StoryPanelDocument, StoryPanelImageCrop, StoryPanelPage, LAYOUT_PAGE_ROWS

SHEET_WIDTH, SHEET_HEIGHT = landscape(letter)
HALF_WIDTH = SHEET_WIDTH / 2
PAGE_HEIGHT = SHEET_HEIGHT
OUTER_MARGIN = 18
TOP_MARGIN = 18
BOTTOM_MARGIN = 18
INNER_GUTTER = 18
GRID_COLUMNS = 12


def _is_caption_panel(panel: StoryPanel | StoryPanelCaption) -> bool:
    return isinstance(panel, StoryPanelCaption)


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


def _spread_right_page_by_left(document: StoryPanelDocument) -> dict[str, str]:
    """Right-page id per left page of each two-page spread.

    The front cover pairs with the back cover (they face each other when the
    booklet is closed); interior pages pair sequentially in reading order.
    """
    pages = sorted(document.pages, key=lambda page: (page.order, page.id))
    pairs: dict[str, str] = {}
    cover = next((page for page in pages if page.pageKind == "cover"), None)
    back_cover = next((page for page in pages if page.pageKind == "back-cover"), None)
    if cover and back_cover:
        pairs[cover.id] = back_cover.id
    interior = [page for page in pages if page.pageKind not in ("cover", "back-cover")]
    for index in range(0, len(interior) - 1, 2):
        pairs[interior[index].id] = interior[index + 1].id
    return pairs


def _panels_by_page(document: StoryPanelDocument) -> dict[str, list[tuple[StoryPanel, float]]]:
    """Panels per page as (panel, column_offset); spread-spanning panels appear
    on both pages of their spread (offset 0 on the left, 12 on the right)."""
    right_by_left = _spread_right_page_by_left(document)
    panels: dict[str, list[tuple[StoryPanel, float]]] = {}
    for panel in document.panels:
        if panel.pageId is None:
            continue
        panels.setdefault(panel.pageId, []).append((panel, 0.0))
        if panel.spansSpread:
            partner = right_by_left.get(panel.pageId)
            if partner is not None:
                panels.setdefault(partner, []).append((panel, float(GRID_COLUMNS)))
    for page_panels in panels.values():
        page_panels.sort(key=lambda entry: (entry[0].layer, entry[0].rect.y, entry[0].rect.x, entry[0].order))
    return panels


def _draw_sheet_side(
    pdf: canvas.Canvas,
    slug: str,
    document: StoryPanelDocument,
    panels_by_page: dict[str, list[tuple[StoryPanel, float]]],
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
    panels_by_page: dict[str, list[tuple[StoryPanel, float]]],
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
    page_rows = float(LAYOUT_PAGE_ROWS)
    for panel, column_offset in page_panels:
        clipped = panel.spansSpread
        if clipped:
            # Spanning panels overhang the page; clip each half to its page.
            pdf.saveState()
            clip = pdf.beginPath()
            clip.rect(page_x, page_y, page_w, page_h)
            pdf.clipPath(clip, stroke=0, fill=0)
        _draw_panel(pdf, panel, print_page.number, page_x, page_y, page_w, page_h, page_rows, slug=slug, column_offset=column_offset)
        for caption in sorted(panel.captions, key=lambda item: (item.layer, item.rect.y, item.rect.x, item.id)):
            _draw_caption(pdf, caption, page_x, page_y, page_w, page_h, page_rows, column_offset=column_offset)
        if clipped:
            pdf.restoreState()
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
    column_offset: float = 0.0,
) -> None:
    x = page_x + ((panel.rect.x - column_offset) / GRID_COLUMNS) * page_w
    w = (panel.rect.w / GRID_COLUMNS) * page_w
    h = (panel.rect.h / page_rows) * page_h
    y = page_y + page_h - ((panel.rect.y / page_rows) * page_h) - h
    if panel.panelKind == "text":
        _draw_text_panel(pdf, panel, x, y, w, h)
        return
    _draw_image_panel(pdf, panel, page_number, x, y, w, h, slug=slug)


def _draw_caption(
    pdf: canvas.Canvas,
    caption: StoryPanelCaption,
    page_x: float,
    page_y: float,
    page_w: float,
    page_h: float,
    page_rows: float,
    *,
    column_offset: float = 0.0,
) -> None:
    x = page_x + ((caption.rect.x - column_offset) / GRID_COLUMNS) * page_w
    w = (caption.rect.w / GRID_COLUMNS) * page_w
    h = (caption.rect.h / page_rows) * page_h
    y = page_y + page_h - ((caption.rect.y / page_rows) * page_h) - h
    _draw_text_panel(pdf, caption, x, y, w, h)


def _caption_outline_offsets() -> tuple[tuple[float, float], ...]:
    # CSS uses a fixed 1px text-shadow halo; 1 CSS px is 0.75pt in print.
    offset = 0.75
    return (
        (-offset, offset),
        (offset, offset),
        (-offset, -offset),
        (offset, -offset),
        (0, offset),
        (0, -offset),
        (-offset, 0),
        (offset, 0),
    )


def _draw_text_panel(pdf: canvas.Canvas, panel: StoryPanel | StoryPanelCaption, x: float, y: float, w: float, h: float) -> None:
    style = panel.textStyle
    is_caption = _is_caption_panel(panel)
    transparent = is_caption and style.background == "transparent"
    if transparent:
        pdf.setFillColor(white)
        pdf.setStrokeColor(white)
    else:
        pdf.setFillColor(white)
        pdf.setStrokeColor(HexColor("#cbd5e1"))
    radius = min(w, h) / 2 if is_caption and style.speechKind == "dialogue" else 0
    if radius > 0:
        pdf.roundRect(x, y, w, h, radius, stroke=0 if transparent else 1, fill=0 if transparent else 1)
    else:
        pdf.rect(x, y, w, h, stroke=0 if transparent else 1, fill=0 if transparent else 1)
    selected_text = panel.selectedText if isinstance(panel, StoryPanel) else ""
    visible_text = panel.visibleText or selected_text
    rich_text = panel.richText or _plain_text_to_rich_text(visible_text)
    text_color = HexColor(style.color) if is_caption else black
    text_x = x + 5
    text_y = y + h - 8
    text_w = w - 10
    text_h = h - 10
    outline_color = HexColor(style.outlineColor) if transparent and is_caption else None
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
        outline_color=outline_color,
        outline_offsets=_caption_outline_offsets() if outline_color is not None else (),
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
        _draw_cropped_image(pdf, asset_path, x, y, w, h, panel.imageCrop)
    else:
        pdf.setFillColor(HexColor("#dbeafe"))
        pdf.setStrokeColor(HexColor("#2563eb"))
        pdf.rect(x, y, w, h, stroke=1, fill=1)
        label = f"Page {page_number or '?'} Panel"
        body = (panel.storyText or panel.selectedText).strip()
        _draw_wrapped_text(pdf, f"{label}\n{body}", x + 5, y + h - 12, w - 10, h - 10, size=7)
        return
    pdf.setStrokeColor(HexColor("#0f172a"))
    pdf.rect(x, y, w, h, stroke=1, fill=0)


def _active_asset_path(slug: str, panel: StoryPanel) -> Path | None:
    if not panel.activeAssetId:
        return None
    path = library.asset_png_path(slug, panel.activeAssetId)
    return path if path.is_file() else None


def _source_crop_box(
    crop: StoryPanelImageCrop | None,
    source_w: int,
    source_h: int,
    target_ratio: float,
) -> tuple[int, int, int, int]:
    focal_x = 0.5 if crop is None else crop.focalX
    focal_y = 0.5 if crop is None else crop.focalY
    scale = 1.0 if crop is None else crop.scale
    source_ratio = source_w / source_h
    if source_ratio > target_ratio:
        crop_h = float(source_h)
        crop_w = source_h * target_ratio
    else:
        crop_w = float(source_w)
        crop_h = source_w / target_ratio
    crop_w /= scale
    crop_h /= scale
    left = max(0.0, min(source_w - crop_w, focal_x * (source_w - crop_w)))
    top = max(0.0, min(source_h - crop_h, focal_y * (source_h - crop_h)))
    return (
        int(round(left)),
        int(round(top)),
        int(round(left + crop_w)),
        int(round(top + crop_h)),
    )


def _draw_cropped_image(
    pdf: canvas.Canvas,
    path: Path,
    x: float,
    y: float,
    w: float,
    h: float,
    crop: StoryPanelImageCrop | None = None,
) -> None:
    with Image.open(path) as image:
        image = image.convert("RGB")
        source_w, source_h = image.size
        target_ratio = w / h
        box = _source_crop_box(crop, source_w, source_h, target_ratio)
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


def _draw_rich_text_line(
    pdf: canvas.Canvas,
    line: list[RichTextRun],
    cursor_x: float,
    y: float,
    *,
    font_family: str,
    size: int,
    render_mode: int,
    fill_color: HexColor | None = None,
) -> None:
    text = pdf.beginText(cursor_x, y)
    text.setTextRenderMode(render_mode)
    if fill_color is not None:
        text.setFillColor(fill_color)
    for run in line:
        font = _font_name(font_family, bold=run.bold, italic=run.italic)
        text.setFont(font, size)
        text.textOut(run.text)
    pdf.drawText(text)


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
    outline_color: HexColor | None = None,
    outline_offsets: tuple[tuple[float, float], ...] = (),
) -> None:
    fill_color = color or HexColor("#111827")
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
        if outline_color is not None and outline_offsets:
            for offset_x, offset_y in outline_offsets:
                _draw_rich_text_line(
                    pdf,
                    line,
                    cursor_x + offset_x,
                    remaining_y + offset_y,
                    font_family=font_family,
                    size=size,
                    render_mode=0,
                    fill_color=outline_color,
                )
            _draw_rich_text_line(
                pdf,
                line,
                cursor_x,
                remaining_y,
                font_family=font_family,
                size=size,
                render_mode=0,
                fill_color=fill_color,
            )
        else:
            for run in line:
                font = _font_name(font_family, bold=run.bold, italic=run.italic)
                pdf.setFillColor(fill_color)
                pdf.setFont(font, size)
                pdf.drawString(cursor_x, remaining_y, run.text)
                cursor_x += pdf.stringWidth(run.text, font, size)
        underline_start_x = x
        if align == "center":
            underline_start_x = x + max(0, (width - line_width) / 2)
        elif align == "right":
            underline_start_x = x + max(0, width - line_width)
        for run in line:
            font = _font_name(font_family, bold=run.bold, italic=run.italic)
            run_width = pdf.stringWidth(run.text, font, size)
            if run.underline and run.text.strip():
                pdf.setStrokeColor(fill_color)
                pdf.setLineWidth(0.75)
                pdf.line(underline_start_x, remaining_y - 1.5, underline_start_x + run_width, remaining_y - 1.5)
            underline_start_x += run_width
        remaining_y -= line_height
