"""Reusable visual style snippets appended to image prompts."""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException

import library
from common import slugify
from models import AdaptationStatus, VisualStyleCreate, VisualStyleDefinition, VisualStylePatch


STYLE_TEMPLATE = "Style:\nColor palette:\nRealism:\nLighting:\n"


DEFAULT_VISUAL_STYLE_PROMPT = (
    "Style: Textured, hand-drawn crayon illustration featuring bold, expressive, and coarse strokes "
    'that create a deliberate "rough" or unpolished sketchbook aesthetic.\n'
    "Color palette: Highly saturated, vibrant primary and secondary colors with heavy layering of pigments.\n"
    "Realism: Stylized/Non-realistic; uses simplified shapes, exaggerated character features, and prominent medium texture over anatomical precision.\n"
    "Lighting: Flat to moderate, achieved through coarse cross-hatching and visible colored strokes rather than smooth gradients.\n"
)


def default_visual_styles() -> list[VisualStyleDefinition]:
    return [
        VisualStyleDefinition(
            id="crayons",
            name="crayons",
            prompt=DEFAULT_VISUAL_STYLE_PROMPT,
            default=True,
        )
    ]


def visual_styles_path(root: Path) -> Path:
    return root / "style-refs" / "visual-styles.json"


def read_visual_styles(root: Path) -> list[VisualStyleDefinition]:
    path = visual_styles_path(root)
    if not path.is_file():
        return []
    data = library.read_json(path)
    if not isinstance(data, list):
        return []
    return [VisualStyleDefinition.model_validate(item) for item in data]


def write_visual_styles(root: Path, styles: list[VisualStyleDefinition]) -> None:
    library.write_json(visual_styles_path(root), [style.model_dump() for style in styles])


def resolve_default_visual_style_id(styles: list[VisualStyleDefinition]) -> str | None:
    marked = [style.id for style in styles if style.default]
    if len(marked) == 1:
        return marked[0]
    if styles:
        return styles[0].id
    return None


def _mark_default_visual_style(styles: list[VisualStyleDefinition], style_id: str) -> list[VisualStyleDefinition]:
    return [
        VisualStyleDefinition(
            id=style.id,
            name=style.name,
            prompt=style.prompt,
            default=style.id == style_id,
        )
        for style in styles
    ]


def unique_style_id(root: Path, name: str) -> str:
    styles = read_visual_styles(root)
    existing = {style.id for style in styles}
    candidate = slugify(name, "style")
    if candidate not in existing:
        return candidate
    index = 2
    while f"{candidate}-{index}" in existing:
        index += 1
    return f"{candidate}-{index}"


def visual_style_prompt(slug: str, style_id: str) -> str:
    import adaptation

    root = adaptation.ensure_adaptation(slug)
    for style in read_visual_styles(root):
        if style.id == style_id:
            return style.prompt
    raise HTTPException(status_code=404, detail=f"Visual style not found: {style_id}")


def create_visual_style(slug: str, payload: VisualStyleCreate) -> AdaptationStatus:
    import adaptation

    root = adaptation.ensure_adaptation(slug)
    styles = read_visual_styles(root)
    style_id = unique_style_id(root, payload.name)
    prompt = payload.prompt if payload.prompt is not None else STYLE_TEMPLATE
    is_first = not styles
    styles.append(
        VisualStyleDefinition(
            id=style_id,
            name=payload.name.strip(),
            prompt=prompt.rstrip() + "\n",
            default=is_first,
        )
    )
    write_visual_styles(root, styles)
    import adaptation

    return adaptation.status(slug)


def update_visual_style(slug: str, style_id: str, payload: VisualStylePatch) -> AdaptationStatus:
    import adaptation

    root = adaptation.ensure_adaptation(slug)
    styles = read_visual_styles(root)
    index = next((item for item, style in enumerate(styles) if style.id == style_id), None)
    if index is None:
        raise HTTPException(status_code=404, detail=f"Visual style not found: {style_id}")
    current = styles[index]
    name = payload.name.strip() if payload.name is not None else current.name
    prompt = payload.prompt if payload.prompt is not None else current.prompt
    styles[index] = VisualStyleDefinition(
        id=style_id,
        name=name,
        prompt=prompt.rstrip() + "\n",
        default=current.default,
    )
    if payload.default is True:
        styles = _mark_default_visual_style(styles, style_id)
    write_visual_styles(root, styles)
    import adaptation

    return adaptation.status(slug)


def delete_visual_style(slug: str, style_id: str) -> AdaptationStatus:
    import adaptation

    root = adaptation.ensure_adaptation(slug)
    styles = read_visual_styles(root)
    removed = next((style for style in styles if style.id == style_id), None)
    if removed is None:
        raise HTTPException(status_code=404, detail=f"Visual style not found: {style_id}")
    next_styles = [style for style in styles if style.id != style_id]
    if removed.default and next_styles:
        next_styles = _mark_default_visual_style(next_styles, next_styles[0].id)
    write_visual_styles(root, next_styles)
    import adaptation

    return adaptation.status(slug)
