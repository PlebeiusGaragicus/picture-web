"""Shared canvas imageGroup node factories."""

from __future__ import annotations

import library
from ids import new_ulid
from models import CanvasDocument, CanvasNode, CanvasNodeOrigin, GenerationParams, ImageGroupNodeCreate, ImageGroupNodeResponse

NODE_LAYOUT = {"columns": 5, "start_x": 80, "start_y": 320, "x_gap": 310, "y_gap": 230}


def next_canvas_position(canvas: CanvasDocument) -> tuple[float, float]:
    index = len(canvas.nodes)
    columns = NODE_LAYOUT["columns"]
    return (
        NODE_LAYOUT["start_x"] + (index % columns) * NODE_LAYOUT["x_gap"],
        NODE_LAYOUT["start_y"] + (index // columns) * NODE_LAYOUT["y_gap"],
    )


def create_image_group_node(
    slug: str,
    *,
    display_name: str = "",
    tags: list[str],
    prompt: str = "",
    refs: list[str] | None = None,
    params: GenerationParams | None = None,
    visual_style_id: str | None = None,
    x: float,
    y: float,
    width: float | None = 240,
    asset_ids: list[str] | None = None,
    active_asset_id: str | None = None,
    origin: CanvasNodeOrigin | None = None,
) -> tuple[str, CanvasDocument]:
    canvas = library.read_stored_canvas(slug)
    node_id = f"node_{new_ulid()}"
    while node_id in canvas.nodes:
        node_id = f"node_{new_ulid()}"
    ids = list(asset_ids or [])
    canvas.nodes[node_id] = CanvasNode(
        displayName=display_name,
        x=x,
        y=y,
        width=width,
        tags=library.node_tags(*tags),
        refs=list(refs or []),
        prompt=prompt,
        params=params or GenerationParams(),
        visualStyleId=visual_style_id,
        assetIds=ids,
        activeAssetId=active_asset_id if ids else None,
        origin=origin,
    )
    saved = library.write_canvas(slug, canvas)
    return node_id, saved


def spawn_from_character_variant(
    slug: str,
    character_slug: str,
    variant_key: str = "base",
) -> tuple[str, CanvasDocument]:
    import adaptation

    metadata = adaptation.read_metadata(slug)
    record = metadata.characters.get(character_slug)
    if record is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail=f"Unknown character: {character_slug}")
    link = record.variants.get(variant_key)
    if link is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail=f"Unknown character variant: {character_slug}/{variant_key}")
    canvas = library.read_stored_canvas(slug)
    x, y = next_canvas_position(canvas)
    display_name = adaptation.character_display_name(record)
    if variant_key != "base":
        display_name = f"{display_name} ({link.label.strip() or variant_key})"
    tags = library.node_tags("comic-adaptation", "character-sheet", character_slug)
    node_id, saved = create_image_group_node(
        slug,
        display_name=display_name,
        tags=tags,
        prompt=link.prompt.strip(),
        refs=list(link.assetIds),
        params=GenerationParams(),
        x=x,
        y=y,
    )
    return node_id, saved


def spawn_from_location(slug: str, location_key: str) -> tuple[str, CanvasDocument]:
    import adaptation

    metadata = adaptation.sync_location_links(slug, adaptation.read_metadata(slug))
    link = metadata.locations.get(location_key)
    if link is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail=f"Unknown location: {location_key}")
    canvas = library.read_stored_canvas(slug)
    x, y = next_canvas_position(canvas)
    tags = library.node_tags("comic-adaptation", "location-prompt", location_key)
    node_id, saved = create_image_group_node(
        slug,
        display_name=location_key.replace("-", " ").title(),
        tags=tags,
        prompt=link.prompt.strip(),
        refs=list(link.assetIds),
        params=GenerationParams(),
        x=x,
        y=y,
    )
    return node_id, saved


def create_image_group(slug: str, payload: ImageGroupNodeCreate) -> ImageGroupNodeResponse:
    canvas = library.read_stored_canvas(slug)
    x, y = next_canvas_position(canvas)
    node_id, saved = create_image_group_node(
        slug,
        display_name=payload.displayName.strip(),
        tags=payload.tags,
        prompt=payload.prompt,
        refs=list(payload.refs),
        visual_style_id=payload.visualStyleId,
        x=x,
        y=y,
    )
    return ImageGroupNodeResponse(nodeId=node_id, canvas=saved)
