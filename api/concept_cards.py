"""Concept art cards stored as editable artifacts before drafting to canvas."""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException, UploadFile

import adaptation
import library
from canvas_nodes import create_image_group_node, next_canvas_position
from ids import new_ulid
from models import (
    ConceptArtSubjectKind,
    ConceptCardDocument,
    ConceptCardPatch,
    ConceptNodeCreate,
    ConceptNodeResponse,
    DisplayPatch,
    GenerationParams,
    ImageGroupCanvasNode,
    utc_now,
)

CONCEPT_TAG = "concept"


def concept_tags(subject_kind: ConceptArtSubjectKind) -> list[str]:
    return library.node_tags(CONCEPT_TAG, f"concept-{subject_kind}")


def _cards_path(slug: str) -> Path:
    return adaptation.ensure_adaptation(slug) / "concept-art" / "cards.json"


def _read_cards_raw(slug: str) -> list[ConceptCardDocument]:
    path = _cards_path(slug)
    if not path.is_file():
        return []
    data = library.read_json(path)
    if not isinstance(data, list):
        return []
    return [ConceptCardDocument.model_validate(item) for item in data]


def _write_cards(slug: str, cards: list[ConceptCardDocument]) -> list[ConceptCardDocument]:
    library.write_json(_cards_path(slug), [card.model_dump(mode="json") for card in cards])
    return cards


def _subject_from_tags(tags: list[str]) -> ConceptArtSubjectKind | None:
    if "concept-character" in tags:
        return "character"
    if "concept-location" in tags:
        return "location"
    return None


def _legacy_card_from_node(slug: str, node_id: str, node: ImageGroupCanvasNode) -> ConceptCardDocument | None:
    subject = _subject_from_tags(node.tags)
    if subject is None:
        return None
    now = utc_now()
    return ConceptCardDocument(
        id=node_id,
        projectSlug=slug,
        subjectKind=subject,
        displayName=node.displayName,
        prompt=node.prompt,
        assetIds=list(node.assetIds),
        activeAssetId=node.activeAssetId,
        createdAt=now,
        updatedAt=now,
    )


def _sync_legacy_canvas_cards(slug: str, cards: list[ConceptCardDocument]) -> list[ConceptCardDocument]:
    existing_ids = {card.id for card in cards}
    canvas = library.read_stored_canvas(slug)
    changed = False
    for node_id, node in canvas.nodes.items():
        if (
            not isinstance(node, ImageGroupCanvasNode)
            or CONCEPT_TAG not in node.tags
            or node.sourceConceptCardId is not None
            or node_id in existing_ids
        ):
            continue
        card = _legacy_card_from_node(slug, node_id, node)
        if card is None:
            continue
        cards.append(card)
        existing_ids.add(card.id)
        changed = True
    if changed:
        _write_cards(slug, cards)
    return cards


def list_cards(slug: str, include_archived: bool = False) -> list[ConceptCardDocument]:
    cards = _sync_legacy_canvas_cards(slug, _read_cards_raw(slug))
    return sorted(
        [card for card in cards if include_archived or card.archivedAt is None],
        key=lambda card: card.updatedAt,
        reverse=True,
    )


def read_card(slug: str, card_id: str) -> ConceptCardDocument:
    for card in list_cards(slug, include_archived=True):
        if card.id == card_id:
            return card
    raise HTTPException(status_code=404, detail=f"Concept card not found: {card_id}")


def create_card(slug: str, payload: ConceptNodeCreate) -> ConceptCardDocument:
    now = utc_now()
    card = ConceptCardDocument(
        id=new_ulid(),
        projectSlug=slug,
        subjectKind=payload.subjectKind,
        displayName=payload.displayName,
        prompt=payload.prompt or default_concept_prompt(payload.subjectKind),
        createdAt=now,
        updatedAt=now,
    )
    cards = _read_cards_raw(slug)
    cards.append(card)
    _write_cards(slug, cards)
    return card


def update_card(slug: str, card_id: str, payload: ConceptCardPatch) -> ConceptCardDocument:
    cards = list_cards(slug, include_archived=True)
    for index, card in enumerate(cards):
        if card.id != card_id:
            continue
        if payload.displayName is not None:
            card.displayName = payload.displayName
        if payload.prompt is not None:
            card.prompt = payload.prompt
        if payload.archived is not None:
            card.archivedAt = utc_now() if payload.archived else None
        card.updatedAt = utc_now()
        cards[index] = card
        _write_cards(slug, cards)
        return card
    raise HTTPException(status_code=404, detail=f"Concept card not found: {card_id}")


def delete_card(slug: str, card_id: str) -> None:
    cards = list_cards(slug, include_archived=True)
    next_cards = [card for card in cards if card.id != card_id]
    if len(next_cards) == len(cards):
        raise HTTPException(status_code=404, detail=f"Concept card not found: {card_id}")
    _write_cards(slug, next_cards)


async def upload_card_image(slug: str, upload: UploadFile) -> ConceptCardDocument:
    title = upload.filename or "Concept upload"
    asset = await library.import_asset(slug, upload, title=title)
    library.patch_display(
        slug,
        asset.id,
        DisplayPatch(tags=list(dict.fromkeys(["comic-adaptation", CONCEPT_TAG]))),
    )
    now = utc_now()
    card = ConceptCardDocument(
        id=new_ulid(),
        projectSlug=slug,
        subjectKind="character",
        displayName=title,
        assetIds=[asset.id],
        activeAssetId=asset.id,
        createdAt=now,
        updatedAt=now,
    )
    cards = _read_cards_raw(slug)
    cards.append(card)
    _write_cards(slug, cards)
    return card


def draft_card_to_canvas(slug: str, card_id: str) -> ConceptNodeResponse:
    card = read_card(slug, card_id)
    canvas = library.read_stored_canvas(slug)
    x, y = next_canvas_position(canvas)
    node_id, saved = create_image_group_node(
        slug,
        display_name=card.displayName,
        tags=concept_tags(card.subjectKind),
        prompt=card.prompt,
        refs=[],
        params=GenerationParams(),
        x=x,
        y=y,
        asset_ids=card.assetIds,
        active_asset_id=card.activeAssetId,
        source_concept_card_id=card.id,
    )
    return ConceptNodeResponse(nodeId=node_id, canvas=saved)


def default_concept_prompt(subject_kind: ConceptArtSubjectKind) -> str:
    if subject_kind == "character":
        from adaptation_workflow.character_file import default_character_reference_sheet_prompt

        return default_character_reference_sheet_prompt("New character")
    return ""


def existing_concept_summaries(slug: str) -> list[str]:
    summaries: list[str] = []
    for card in list_cards(slug):
        if card.prompt.strip():
            preview = card.prompt.strip().split("\n", 1)[0]
        else:
            preview = card.displayName or card.id
        summaries.append(f"{card.subjectKind}: {preview}")
    return summaries


def create_concept_card_from_pi_file(
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
    card = create_card(
        slug,
        ConceptNodeCreate(
            subjectKind=subject_kind,
            displayName=expected_key.replace("-", " ").title(),
            prompt=prompt,
        ),
    )
    path.unlink(missing_ok=True)
    return card.id
