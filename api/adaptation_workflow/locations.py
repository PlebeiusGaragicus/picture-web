"""Merge scene-extract location staging into the global location index."""

from __future__ import annotations

import shutil
from pathlib import Path

from adaptation_workflow.sections import parse_index_sections_file, write_index_sections


def staging_dir(book_root: Path, scene_slug: str) -> Path:
    return book_root / "locations" / "staging" / scene_slug


def merge_staging_into_index(book_root: Path, scene_slug: str) -> list[str]:
    """Upsert staging sections into locations/index.md. Returns slugs newly added."""
    stage_path = staging_dir(book_root, scene_slug)
    if not stage_path.is_dir():
        return []

    index_path = book_root / "locations" / "index.md"
    existing = parse_index_sections_file(index_path)
    new_slugs: list[str] = []

    for fragment in sorted(stage_path.glob("*.md")):
        slug = fragment.stem
        section = fragment.read_text().rstrip() + "\n"
        if slug in existing:
            continue
        existing[slug] = section
        new_slugs.append(slug)

    if new_slugs:
        write_index_sections(index_path, existing)
    return new_slugs


def cleanup_staging(book_root: Path, scene_slug: str) -> None:
    path = staging_dir(book_root, scene_slug)
    if path.exists():
        shutil.rmtree(path)
