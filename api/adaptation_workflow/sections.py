"""Split markdown files on ## headings into per-section files."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

_SECTION_HEADING_RE = re.compile(r"^##[ \t]+(.+)$", re.MULTILINE)
_SLUG_SANITIZE_RE = re.compile(r"[^A-Za-z0-9_-]+")


def section_slug(heading_line: str) -> str:
    slug = heading_line.strip()
    slug = slug.split(None, 1)[0] if slug else slug
    return _SLUG_SANITIZE_RE.sub("-", slug).strip("-")


def parse_index_sections(text: str) -> dict[str, str]:
    """Return slug -> full ## section text (including heading)."""
    matches = list(_SECTION_HEADING_RE.finditer(text))
    if not matches:
        return {}
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        section_text = text[start:end].rstrip() + "\n"
        slug = section_slug(match.group(1))
        if slug:
            sections[slug] = section_text
    return sections


def parse_index_sections_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    return parse_index_sections(path.read_text())


def write_index_sections(path: Path, sections: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not sections:
        path.write_text("")
        return
    body = "\n".join(section.rstrip() for section in sections.values())
    path.write_text(body.rstrip() + "\n")


def extract_sections(input_path: Path, out_dir: Path, *, prefix: str = "") -> list[Path]:
    """Write each ## section from input_path to out_dir/{prefix}{slug}.md."""
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    text = input_path.read_text()
    matches = list(_SECTION_HEADING_RE.finditer(text))
    if not matches:
        return []

    written: list[Path] = []
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        section_text = text[start:end].rstrip() + "\n"
        slug = section_slug(match.group(1))
        if not slug:
            continue
        out_path = out_dir / f"{prefix}{slug}.md"
        out_path.write_text(section_text)
        written.append(out_path)
    return written
