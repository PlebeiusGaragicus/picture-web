"""Concept art nodes stored on the project canvas."""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException, UploadFile

import library
from canvas_nodes import create_image_group_node, next_canvas_position
from ids import new_ulid
from models import (
    CanvasDocument,
    ConceptArtSubjectKind,
    ConceptNodeResponse,
    DisplayPatch,
    GenerationParams,
    ImageGroupCanvasNode,
)

CONCEPT_TAG = "concept"
CONCEPT_LAYOUT = {"columns": 5, "start_x": 80, "start_y": 320, "x_gap": 310, "y_gap": 230}


def concept_tags(subject_kind: ConceptArtSubjectKind) -> list[str]:
    return library.node_tags(CONCEPT_TAG, f"concept-{subject_kind}")


def is_concept_node(node: object) -> bool:
    tags = getattr(node, "tags", None) or []
    return CONCEPT_TAG in tags


def concept_subject_kind(node: object) -> ConceptArtSubjectKind | None:
    tags = getattr(node, "tags", None) or []
    if "concept-character" in tags:
        return "character"
    if "concept-location" in tags:
        return "location"
    return None


def iter_concept_nodes(canvas: CanvasDocument):
    for node_id, node in canvas.nodes.items():
        if isinstance(node, ImageGroupCanvasNode) and is_concept_node(node):
            yield node_id, node


def count_concept_nodes(canvas: CanvasDocument) -> int:
    return sum(1 for _ in iter_concept_nodes(canvas))


def next_concept_position(canvas: CanvasDocument) -> tuple[float, float]:
    index = count_concept_nodes(canvas)
    columns = CONCEPT_LAYOUT["columns"]
    return (
        CONCEPT_LAYOUT["start_x"] + (index % columns) * CONCEPT_LAYOUT["x_gap"],
        CONCEPT_LAYOUT["start_y"] + (index // columns) * CONCEPT_LAYOUT["y_gap"],
    )


def default_concept_prompt(subject_kind: ConceptArtSubjectKind) -> str:
    if subject_kind == "character":
        from adaptation_workflow.character_file import default_character_reference_sheet_prompt

        return default_character_reference_sheet_prompt("New character")
    return ""


def existing_concept_summaries(slug: str) -> list[str]:
    canvas = library.read_stored_canvas(slug)
    summaries: list[str] = []
    for node_id, node in iter_concept_nodes(canvas):
        if node.prompt.strip():
            preview = node.prompt.strip().split("\n", 1)[0]
        else:
            preview = node.displayName or node_id
        subject = concept_subject_kind(node) or "concept"
        summaries.append(f"{subject}: {preview}")
    return summaries


def create_concept_draft(
    slug: str,
    subject_kind: ConceptArtSubjectKind,
    *,
    prompt: str | None = None,
    display_name: str = "",
) -> ConceptNodeResponse:
    canvas = library.read_stored_canvas(slug)
    x, y = next_concept_position(canvas)
    body = default_concept_prompt(subject_kind) if prompt is None else prompt
    node_id, saved = create_image_group_node(
        slug,
        display_name=display_name,
        tags=concept_tags(subject_kind),
        prompt=body,
        refs=[],
        params=GenerationParams(),
        x=x,
        y=y,
    )
    return ConceptNodeResponse(nodeId=node_id, canvas=saved)


async def upload_concept_image(slug: str, upload: UploadFile) -> ConceptNodeResponse:
    canvas = library.read_stored_canvas(slug)
    x, y = next_concept_position(canvas)
    title = upload.filename or "Concept upload"
    asset = await library.import_asset(slug, upload, title=title)
    library.patch_display(
        slug,
        asset.id,
        DisplayPatch(tags=list(dict.fromkeys(["comic-adaptation", CONCEPT_TAG]))),
    )
    node_id = library.canvas_node_id(asset.id)
    while node_id in canvas.nodes:
        node_id = f"{node_id}_{new_ulid()}"
    node_id, saved = create_image_group_node(
        slug,
        display_name=title,
        tags=[CONCEPT_TAG],
        x=x,
        y=y,
        asset_ids=[asset.id],
        active_asset_id=asset.id,
    )
    return ConceptNodeResponse(nodeId=node_id, canvas=saved)


def create_concept_draft_from_pi_file(
    slug: str,
    subject_kind: ConceptArtSubjectKind,
    path: Path,
    *,
    expected_key: str,
) -> str:
    from adaptation_workflow.concept_art import parse_concept_art_sections

    if not path.is_file():
        raise HTTPException(status_code=500, detail=f"Missing concept scratch file: {path}")
    sections = parse_concept_art_sections(path)
    section = sections.get(expected_key)
    if section is None:
        raise HTTPException(status_code=500, detail=f"Missing ## {expected_key} section in {path}")
    prompt = section.get("prompt", "").strip()
    if not prompt:
        raise HTTPException(status_code=500, detail=f"Concept prompt is empty: {path}")
    display_name = expected_key.replace("-", " ").title()
    response = create_concept_draft(
        slug,
        subject_kind,
        prompt=prompt,
        display_name=display_name,
    )
    path.unlink(missing_ok=True)
    return response.nodeId
