"""Tag-based reference resolution and readiness gates for panel/page generation."""

from __future__ import annotations

from typing import Literal

from fastapi import HTTPException

import gemini
import library
from models import AdaptationMetadata, MomentRefInput

RefKind = Literal["character", "location", "unknown"]


def _parse_semantic_ref(ref: str) -> tuple[str, str] | None:
    if ":" not in ref:
        return None
    kind, key = ref.split(":", 1)
    return kind.strip(), key.strip()


def _asset_exists(slug: str, asset_id: str) -> bool:
    return library.asset_png_path(slug, asset_id).is_file()


def _ref_kind(prefix: str) -> RefKind:
    if prefix in {"character", "character-sheet"}:
        return "character"
    if prefix in {"location", "location-prompt"}:
        return "location"
    return "unknown"


def parse_refs_line(style_ref: str) -> list[str]:
    return [item.strip() for item in style_ref.split(",") if item.strip()]


def resolve_semantic_ref_tag_assets(slug: str, ref: str) -> tuple[RefKind, str, str, list[str]]:
    """Return kind, entity_key, tag_id, and asset ids sorted ascending for one semantic ref."""
    parsed = _parse_semantic_ref(ref)
    if parsed is None:
        return "unknown", "", "", []
    prefix, entity_key = parsed
    kind = _ref_kind(prefix)
    if kind == "unknown":
        return kind, entity_key, "", []
    tag_id = library.normalize_tag_id(entity_key)
    asset_ids = [
        asset_id
        for asset_id in library.assets_for_entity_tag(slug, tag_id)
        if _asset_exists(slug, asset_id)
    ]
    asset_ids.sort()
    return kind, entity_key, tag_id, asset_ids


def _missing_detail(kind: RefKind, ref: str, tag_id: str) -> str:
    if kind == "unknown":
        return f"{ref} is not a supported character: or location: reference"
    if not tag_id:
        return f"{ref} is invalid"
    return f"{ref} has no tagged images — apply tag `{tag_id}` on the canvas"


def moment_ref_inputs(
    slug: str,
    metadata: AdaptationMetadata,
    style_ref: str,
    *,
    model: str | None = None,
) -> tuple[list[MomentRefInput], int, int, bool, bool]:
    """Return ref inputs, image count, limit, limit_exceeded, and can_generate."""
    resolved_model = model or gemini.default_model()
    limit = gemini.reference_image_limit(resolved_model)
    tokens = parse_refs_line(style_ref)
    entity_tokens = [
        token
        for token in tokens
        if _ref_kind((_parse_semantic_ref(token) or ("", ""))[0]) in {"character", "location"}
    ]
    inputs: list[MomentRefInput] = []

    if not entity_tokens:
        inputs.append(
            MomentRefInput(
                ref="refs",
                kind="unknown",
                entityKey="",
                tagId="",
                ready=False,
                assetIds=[],
                detail="Panel refs must include at least one character: or location: reference",
            )
        )
        return inputs, 0, limit, False, False

    for token in tokens:
        kind, entity_key, tag_id, asset_ids = resolve_semantic_ref_tag_assets(slug, token)
        ready = kind != "unknown" and bool(asset_ids)
        detail = "" if ready else _missing_detail(kind, token, tag_id)
        if kind != "unknown" and not ready and entity_key:
            known = entity_key in metadata.characters if kind == "character" else entity_key in metadata.locations
            if not known:
                detail = (
                    f"{token} is not a known entity key — use exact Visual Continuity slugs; "
                    f"apply tag `{tag_id}` on the canvas"
                )
        inputs.append(
            MomentRefInput(
                ref=token,
                kind=kind,
                entityKey=entity_key,
                tagId=tag_id,
                ready=ready,
                assetIds=asset_ids,
                detail=detail,
            )
        )

    count = sum(len(item.assetIds) for item in inputs)
    limit_exceeded = count > limit
    character_or_location = [item for item in inputs if item.kind in {"character", "location"}]
    can_generate = (
        bool(character_or_location)
        and all(item.ready for item in character_or_location)
        and not limit_exceeded
    )
    return inputs, count, limit, limit_exceeded, can_generate


def ordered_moment_ref_asset_ids(slug: str, style_ref: str) -> list[str]:
    """Stable ordered asset ids: refs line left-to-right, assets sorted by id within each ref."""
    asset_ids: list[str] = []
    for token in parse_refs_line(style_ref):
        kind, _, _, ids = resolve_semantic_ref_tag_assets(slug, token)
        if kind in {"character", "location"}:
            asset_ids.extend(ids)
    return asset_ids


def assert_moment_refs_ready(
    slug: str,
    metadata: AdaptationMetadata,
    style_ref: str,
    *,
    model: str,
) -> list[str]:
    inputs, count, limit, limit_exceeded, can_generate = moment_ref_inputs(
        slug, metadata, style_ref, model=model
    )
    if not can_generate:
        failures = [item.detail for item in inputs if item.detail]
        if limit_exceeded:
            failures.append(
                f"Too many reference images ({count}); {model} allows {limit}. Remove tags or reduce refs."
            )
        message = "Panel references not ready: " + "; ".join(failures or ["unknown error"])
        raise HTTPException(status_code=400, detail=message)
    return ordered_moment_ref_asset_ids(slug, style_ref)
