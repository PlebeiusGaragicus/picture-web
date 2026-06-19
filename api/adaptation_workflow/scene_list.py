"""Parse and write scenes/list.txt."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


@dataclass(frozen=True)
class SceneListEntry:
    slug: str
    description: str
    line_no: int


class SceneListError(ValueError):
    pass


def scene_slug_from_line(line: str) -> str:
    stripped = line.strip()
    if ":" not in stripped:
        raise SceneListError(f"scene list line missing colon: {stripped}")
    slug = stripped.split(":", 1)[0].strip().lower()
    if not slug or not _SLUG_RE.match(slug):
        raise SceneListError(f"invalid scene slug: {slug}")
    return slug


def parse_scene_list(path: Path) -> list[SceneListEntry]:
    if not path.is_file():
        return []
    entries: list[SceneListEntry] = []
    for line_no, raw in enumerate(path.read_text().splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        slug = scene_slug_from_line(line)
        description = line.split(":", 1)[1].strip()
        entries.append(SceneListEntry(slug=slug, description=description, line_no=line_no))
    return entries


def format_scene_list_line(slug: str, description: str) -> str:
    slug = slug.strip().lower()
    if not _SLUG_RE.match(slug):
        raise SceneListError(f"invalid scene slug: {slug}")
    return f"{slug}: {description.strip()}"


def write_scene_list(path: Path, entries: list[SceneListEntry]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [format_scene_list_line(entry.slug, entry.description) for entry in entries]
    path.write_text("\n".join(lines) + ("\n" if lines else ""))


def find_scene_list_line(path: Path, slug: str) -> str | None:
    target = slug.strip().lower()
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            if scene_slug_from_line(line) == target:
                return line
        except SceneListError:
            continue
    return None


def reorder_scene_list(path: Path, slugs: list[str]) -> None:
    entries = parse_scene_list(path)
    by_slug = {entry.slug: entry for entry in entries}
    ordered = [s.strip().lower() for s in slugs]
    if set(ordered) != set(by_slug):
        raise SceneListError("reorder must include the same scene slugs")
    write_scene_list(
        path,
        [SceneListEntry(slug=slug, description=by_slug[slug].description, line_no=index) for index, slug in enumerate(ordered, start=1)],
    )
