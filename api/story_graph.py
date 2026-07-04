"""Story graph projection for book-derived artifacts on the canvas."""

from __future__ import annotations

from pathlib import Path

import library
from models import ArtifactSourceRole, CanvasDocument, DraftCanvasNode, GeneratedResultRole, GenerationParams, ImageGroupCanvasNode, StoryArtifactCanvasNode, StyleRefSourceRole


def story_artifact_refs(entries: dict[str, object], entry: object) -> list[str]:
    mode = getattr(entry, "mode", "")
    style_ref = getattr(entry, "styleRef", "")
    if mode != "edit-reference" or not style_ref:
        return []
    base_key = Path(style_ref).stem
    base = entries.get(base_key)
    if base is None:
        return []
    asset_ids = getattr(base, "assetIds", None) or []
    return list(asset_ids)


def story_artifact_base_tags(kind: str) -> list[str]:
    tags_by_kind = {
        "character-sheet": ["adaptation", "character-sheet"],
        "location-prompt": ["adaptation", "location"],
        "scene-artifact": ["adaptation", "scene"],
        "page-plan": ["adaptation", "page"],
        "panel-prompt": ["adaptation", "panel"],
    }
    return tags_by_kind.get(kind, ["adaptation"])


def entry_has_assets(entry: object) -> bool:
    asset_ids = getattr(entry, "assetIds", None) or []
    return len(asset_ids) > 0


def sync_existing_story_artifacts(slug: str, canvas: CanvasDocument) -> CanvasDocument:
    """Refresh existing story source nodes without creating new source nodes."""
    import adaptation

    status = adaptation.status(slug)
    character_entries = adaptation.character_entries_from_records(status.characters)
    groups = {
        "character-sheet": character_entries,
        "location-prompt": status.locations,
    }
    next_canvas = canvas.model_copy(deep=True)
    for node_id, node in list(next_canvas.nodes.items()):
        if not isinstance(node, StoryArtifactCanvasNode):
            continue
        entries = groups.get(node.artifactKind)
        if entries is None:
            continue
        entry = entries.get(node.artifactKey)
        if entry is None:
            continue
        node.promptPath = entry.promptPath
        node.prompt = entry.prompt
        node.refs = story_artifact_refs(entries, entry)
        node.generatedAssetIds = list(entry.assetIds)
        node.tags = library.node_tags(
            *story_artifact_base_tags(node.artifactKind),
            "generated" if entry_has_assets(entry) else "missing",
        )
        node.role = ArtifactSourceRole(artifactKind=node.artifactKind, artifactKey=node.artifactKey)
        next_canvas.nodes[node_id] = node
    return next_canvas


def sync_style_ref_canvas_nodes(slug: str, canvas: CanvasDocument, kind: str | None = None) -> CanvasDocument:
    """Project style-reference prompts as durable source nodes with generated child results."""
    import adaptation

    next_canvas = canvas.model_copy(deep=True)
    kinds = adaptation.STYLE_REF_KINDS if kind is None else (adaptation.require_style_ref_kind(kind),)
    metadata = adaptation.read_metadata(slug)
    metadata, changed = adaptation.clear_stale_style_ref_assets(slug, metadata)
    if changed:
        metadata = adaptation.write_metadata(slug, metadata)

    for ref_kind in kinds:
        config = adaptation.style_ref_config(ref_kind)
        status = adaptation.style_ref_status(slug, ref_kind, metadata)
        tags = adaptation.style_ref_tags(ref_kind)
        asset_id = status.assetId
        has_asset = asset_id is not None
        node_id = status.canvasDraftNodeId
        image_node_id = status.canvasImageNodeId
        legacy_image_node_id = f"{node_id}_image"
        existing = next_canvas.nodes.get(node_id)
        source_x = existing.x if isinstance(existing, DraftCanvasNode | ImageGroupCanvasNode) else float(config["x"])
        source_y = existing.y if isinstance(existing, DraftCanvasNode | ImageGroupCanvasNode) else float(config["y"])
        source_width = existing.width if isinstance(existing, DraftCanvasNode | ImageGroupCanvasNode) else 240
        preserved_visual_style_id = existing.visualStyleId if isinstance(existing, DraftCanvasNode) else None
        preserved_params = existing.params if isinstance(existing, DraftCanvasNode) else None
        next_canvas.nodes[node_id] = DraftCanvasNode(
            displayName=str(config["display_name"]),
            x=source_x,
            y=source_y,
            width=source_width,
            tags=library.node_tags(*tags, "generated" if has_asset else "missing"),
            role=StyleRefSourceRole(kind=ref_kind),
            refs=[],
            prompt=status.promptText,
            visualStyleId=preserved_visual_style_id,
            params=preserved_params if preserved_params is not None else GenerationParams(),
        )
        legacy_image = next_canvas.nodes.get(legacy_image_node_id)
        if asset_id is not None:
            child = next_canvas.nodes.get(image_node_id)
            if isinstance(child, ImageGroupCanvasNode):
                image_node = child
            elif isinstance(existing, ImageGroupCanvasNode):
                image_node = existing
            elif isinstance(legacy_image, ImageGroupCanvasNode):
                image_node = legacy_image
            else:
                image_node = ImageGroupCanvasNode(
                    displayName=str(config["display_name"]),
                    x=source_x + 320,
                    y=source_y,
                    width=240,
                    tags=library.node_tags(*tags, "imported-image"),
                    role=GeneratedResultRole(sourceNodeId=node_id),
                    assetIds=[asset_id],
                    activeAssetId=asset_id,
                )
            if asset_id not in image_node.assetIds:
                image_node.assetIds = [asset_id, *image_node.assetIds]
            image_node.activeAssetId = asset_id
            image_node.tags = library.node_tags(*tags, "imported-image")
            image_node.role = GeneratedResultRole(sourceNodeId=node_id)
            next_canvas.nodes[image_node_id] = image_node
            next_canvas.nodes.pop(legacy_image_node_id, None)
        else:
            next_canvas.nodes.pop(image_node_id, None)
            next_canvas.nodes.pop(legacy_image_node_id, None)
    return next_canvas
