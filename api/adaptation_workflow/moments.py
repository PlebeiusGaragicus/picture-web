"""Moment planning paths, layout section parsing, and ordered sequence."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

PAGE_STORY_KINDS = frozenset({"picture-book", "illustrated-story"})
TEXT_FIELDS = ("narration", "dialogue", "caption")


def read_story_kind(book_root: Path) -> str:
    metadata_path = book_root / "adaptation.json"
    if not metadata_path.is_file():
        return "comic-book"
    data = json.loads(metadata_path.read_text())
    return str(data.get("settings", {}).get("storyKind", "comic-book"))


def moment_uses_pages(story_kind: str) -> bool:
    return story_kind in PAGE_STORY_KINDS


def moment_artifact_kind(story_kind: str) -> str:
    return "page-plan" if moment_uses_pages(story_kind) else "panel-prompt"


def moment_output_path(book_root: Path, story_kind: str, scene_slug: str) -> Path:
    if moment_uses_pages(story_kind):
        return book_root / "pages" / "plans" / f"{scene_slug}.md"
    return book_root / "panels" / "prompts" / f"{scene_slug}.md"


def _slug_from_heading(line: str) -> str:
    return line.removeprefix("## ").strip().split()[0]


def empty_layout_section() -> dict[str, str]:
    return {
        "mode": "",
        "style_ref": "",
        "narration": "",
        "dialogue": "",
        "caption": "",
        "prompt": "",
    }


def parse_layout_sections(path: Path) -> dict[str, dict[str, str]]:
    sections: dict[str, dict[str, str]] = {}
    if not path.is_file():
        return sections
    current: str | None = None
    section = empty_layout_section()
    prompt_lines: list[str] = []
    in_prompt = False
    for raw_line in path.read_text().splitlines():
        if raw_line.startswith("## "):
            if current is not None:
                section["prompt"] = "\n".join(prompt_lines).strip()
                sections[current] = section
            current = _slug_from_heading(raw_line)
            section = empty_layout_section()
            prompt_lines = []
            in_prompt = False
            continue
        if current is None:
            continue
        if raw_line.startswith("mode:"):
            section["mode"] = raw_line.split(":", 1)[1].strip()
            continue
        if raw_line.startswith("refs:"):
            section["style_ref"] = raw_line.split(":", 1)[1].strip()
            continue
        matched_text = False
        for field in TEXT_FIELDS:
            prefix = f"{field}:"
            if raw_line.startswith(prefix):
                section[field] = raw_line.split(":", 1)[1].strip()
                matched_text = True
                break
        if matched_text:
            continue
        if raw_line == "" and section["mode"]:
            in_prompt = True
            continue
        if in_prompt:
            prompt_lines.append(raw_line)
    if current is not None:
        section["prompt"] = "\n".join(prompt_lines).strip()
        sections[current] = section
    return sections


def format_layout_section(slug: str, section: dict[str, str]) -> str:
    lines = [
        f"## {slug}",
        f"mode: {section.get('mode', 'story-layout').strip() or 'story-layout'}",
        f"refs: {section.get('style_ref', '').strip()}",
        f"narration: {section.get('narration', '').strip()}",
        f"dialogue: {section.get('dialogue', '').strip()}",
        f"caption: {section.get('caption', '').strip()}",
        "",
        section.get("prompt", "").strip(),
    ]
    return "\n".join(lines).rstrip() + "\n"


def write_layout_sections(path: Path, sections: dict[str, dict[str, str]], *, order: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    keys = order if order is not None else list(sections.keys())
    body = "".join(format_layout_section(slug, sections[slug]) for slug in keys if slug in sections)
    path.write_text(body)


def update_layout_section(path: Path, slug: str, section: dict[str, str]) -> None:
    sections = parse_layout_sections(path)
    if slug not in sections:
        raise KeyError(slug)
    order = list(sections.keys())
    sections[slug] = {**sections[slug], **section}
    write_layout_sections(path, sections, order=order)


def moment_section_count(path: Path) -> int:
    return len(parse_layout_sections(path))


def layout_section_dict(
    *,
    refs: str,
    narration: str,
    dialogue: str,
    caption: str,
    prompt: str,
) -> dict[str, str]:
    return {
        "mode": "story-layout",
        "style_ref": refs,
        "narration": narration,
        "dialogue": dialogue,
        "caption": caption,
        "prompt": prompt,
    }


def ordered_layout_sections(path: Path) -> list[tuple[str, dict[str, str]]]:
    return list(parse_layout_sections(path).items())


def write_ordered_layout_sections(path: Path, items: list[tuple[str, dict[str, str]]]) -> None:
    sections = dict(items)
    order = [key for key, _ in items]
    write_layout_sections(path, sections, order=order)


@dataclass(frozen=True)
class MomentSequenceItem:
    scene_slug: str
    moment_key: str
    artifact_kind: str
    prompt_path: str
    section: dict[str, str]


def ordered_moment_sequence(book_root: Path) -> list[MomentSequenceItem]:
    from adaptation_workflow.scene_list import parse_scene_list

    story_kind = read_story_kind(book_root)
    artifact_kind = moment_artifact_kind(story_kind)
    list_path = book_root / "scenes" / "list.txt"
    if not list_path.is_file():
        return []
    items: list[MomentSequenceItem] = []
    for entry in parse_scene_list(list_path):
        moment_path = moment_output_path(book_root, story_kind, entry.slug)
        if not moment_path.is_file():
            continue
        rel_path = moment_path.relative_to(book_root).as_posix()
        for moment_key, section in parse_layout_sections(moment_path).items():
            items.append(
                MomentSequenceItem(
                    scene_slug=entry.slug,
                    moment_key=moment_key,
                    artifact_kind=artifact_kind,
                    prompt_path=rel_path,
                    section=section,
                )
            )
    return items
