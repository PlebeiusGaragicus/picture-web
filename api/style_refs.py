"""Style-reference prompts, canonical assets, and their canvas projection."""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException

import library
from models import (
    AdaptationGenerateResponse,
    AdaptationGenerateStyleRefRequest,
    AdaptationMetadata,
    AdaptationStatus,
    AdaptationStylePromptPatch,
    AdaptationStyleRefAssetRequest,
    CanvasDocument,
    DraftCanvasNode,
    GeneratedResultRole,
    GenerateRequest,
    GenerationParams,
    ImageGroupCanvasNode,
    StyleRefKind,
    StyleRefSourceRole,
    StyleRefStatus,
)



def sync_style_ref_canvas_nodes(slug: str, canvas: CanvasDocument, kind: str | None = None) -> CanvasDocument:
    """Project style-reference prompts as durable source nodes with generated child results."""
    import adaptation

    next_canvas = canvas.model_copy(deep=True)
    kinds = STYLE_REF_KINDS if kind is None else (require_style_ref_kind(kind),)
    metadata = adaptation.read_metadata(slug)
    metadata, changed = clear_stale_style_ref_assets(slug, metadata)
    if changed:
        metadata = adaptation.write_metadata(slug, metadata)

    for ref_kind in kinds:
        config = style_ref_config(ref_kind)
        status = style_ref_status(slug, ref_kind, metadata)
        tags = style_ref_tags(ref_kind)
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


STYLE_REF_KINDS: tuple[StyleRefKind, StyleRefKind] = ("archetype-character", "archetype-scene")


def require_style_ref_kind(kind: str) -> StyleRefKind:
    if kind not in STYLE_REF_KINDS:
        raise HTTPException(status_code=400, detail="Invalid style ref kind")
    return kind


def style_ref_config(kind: StyleRefKind) -> dict[str, object]:
    if kind == "archetype-character":
        return {
            "kind": kind,
            "display_name": "Character Archetype",
            "prompt_filename": "archetype-character.md",
            "legacy_png_filename": "archetype-character.png",
            "asset_field": "archetypeCharacterAssetId",
            "style_tag": "character-style",
            "x": 80,
            "y": 80,
        }
    return {
        "kind": kind,
        "display_name": "Scene Archetype",
        "prompt_filename": "archetype-scene.md",
        "legacy_png_filename": "archetype-scene.png",
        "asset_field": "archetypeSceneAssetId",
        "style_tag": "scene-style",
        "x": 360,
        "y": 80,
    }


def style_ref_prompt_path(root: Path, kind: StyleRefKind) -> Path:
    return root / "style-refs" / str(style_ref_config(kind)["prompt_filename"])


def style_ref_legacy_png_path(root: Path, kind: StyleRefKind) -> Path:
    return root / "style-refs" / str(style_ref_config(kind)["legacy_png_filename"])


def get_style_ref_asset_id(metadata: AdaptationMetadata, kind: StyleRefKind) -> str | None:
    return getattr(metadata.styleRefs, str(style_ref_config(kind)["asset_field"]))


def set_style_ref_asset_id(metadata: AdaptationMetadata, kind: StyleRefKind, asset_id: str | None) -> AdaptationMetadata:
    setattr(metadata.styleRefs, str(style_ref_config(kind)["asset_field"]), asset_id)
    return metadata


def style_ref_tags(kind: StyleRefKind) -> list[str]:
    return ["adaptation", "archetype", str(style_ref_config(kind)["style_tag"])]


def style_ref_node_ids(kind: StyleRefKind) -> tuple[str, str]:
    source_node_id = library.archetype_node_id(kind)
    return source_node_id, library.generated_result_node_id(source_node_id)


def clear_stale_style_ref_assets(slug: str, metadata: AdaptationMetadata) -> tuple[AdaptationMetadata, bool]:
    import adaptation

    changed = False
    for kind in STYLE_REF_KINDS:
        asset_id = get_style_ref_asset_id(metadata, kind)
        if asset_id and not adaptation.asset_exists(slug, asset_id):
            set_style_ref_asset_id(metadata, kind, None)
            changed = True
    return metadata, changed


def style_ref_status(slug: str, kind: StyleRefKind, metadata: AdaptationMetadata | None = None) -> StyleRefStatus:
    import adaptation

    root = adaptation.ensure_adaptation(slug)
    metadata = metadata or adaptation.read_metadata(slug)
    prompt_path = style_ref_prompt_path(root, kind)
    draft_node_id, image_node_id = style_ref_node_ids(kind)
    asset_id = get_style_ref_asset_id(metadata, kind)
    if asset_id and not adaptation.asset_exists(slug, asset_id):
        asset_id = None
    return StyleRefStatus(
        kind=kind,
        promptPath=adaptation.relpath(root, prompt_path),
        promptText=adaptation.read_text(prompt_path),
        assetId=asset_id,
        canvasDraftNodeId=draft_node_id,
        canvasImageNodeId=image_node_id,
    )


def style_ref_statuses(slug: str, metadata: AdaptationMetadata) -> dict[StyleRefKind, StyleRefStatus]:
    return {kind: style_ref_status(slug, kind, metadata) for kind in STYLE_REF_KINDS}


def write_style_ref_prompt(slug: str, request: AdaptationStylePromptPatch) -> AdaptationStatus:
    import adaptation

    kind = require_style_ref_kind(request.kind)
    root = adaptation.ensure_adaptation(slug)
    style_ref_prompt_path(root, kind).write_text(request.prompt.rstrip() + "\n")
    library.write_canvas(slug, sync_style_ref_canvas_nodes(slug, library.read_stored_canvas(slug), kind))
    return adaptation.status(slug)


def set_style_ref_asset(slug: str, request: AdaptationStyleRefAssetRequest) -> AdaptationStatus:
    import adaptation

    kind = require_style_ref_kind(request.kind)
    library.read_asset(slug, request.assetId)
    metadata = adaptation.read_metadata(slug)
    set_style_ref_asset_id(metadata, kind, request.assetId)
    adaptation.write_metadata(slug, metadata)
    library.write_canvas(slug, sync_style_ref_canvas_nodes(slug, library.read_stored_canvas(slug), kind))
    return adaptation.status(slug)


def generate_style_ref(slug: str, request: AdaptationGenerateStyleRefRequest) -> AdaptationGenerateResponse:
    import adaptation
    import gemini

    root = adaptation.ensure_adaptation(slug)
    kind = require_style_ref_kind(request.kind)
    source_node_id, _ = style_ref_node_ids(kind)
    canvas = sync_style_ref_canvas_nodes(slug, library.read_stored_canvas(slug), kind)
    library.write_canvas(slug, canvas)
    if not request.visualStyleId:
        raise HTTPException(status_code=400, detail="visualStyleId is required to generate a style reference")
    draft_node = canvas.nodes.get(source_node_id)
    draft_params = draft_node.params if isinstance(draft_node, DraftCanvasNode) else None
    prompt_path = style_ref_prompt_path(root, kind)
    prompt_text = adaptation.read_text(prompt_path).strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail=f"Missing prompt: {prompt_path}")
    prompt = f"{prompt_text}\n"
    title = str(style_ref_config(kind)["display_name"])
    tags = ["comic-adaptation", *style_ref_tags(kind)[1:]]
    payload = GenerateRequest(
        prompt=prompt,
        refs=[],
        model=request.model or (draft_params.model if draft_params else None),
        aspectRatio=request.aspectRatio or (draft_params.aspectRatio if draft_params else None) or "1:1",
        imageSize=request.imageSize or (draft_params.imageSize if draft_params else None) or "1K",
        seed=request.seed if request.seed is not None else (draft_params.seed if draft_params else None),
        batchCount=request.batchCount,
        title=title,
        tags=tags,
        canvasNodeId=source_node_id,
        visualStyleId=request.visualStyleId,
    )
    response = library.create_generated_assets(slug, payload, gemini.generate_image)
    asset = response.assets[0]
    metadata = adaptation.read_metadata(slug)
    set_style_ref_asset_id(metadata, kind, asset.id)
    adaptation.write_metadata(slug, metadata)
    library.write_canvas(slug, sync_style_ref_canvas_nodes(slug, library.read_stored_canvas(slug), kind))
    return AdaptationGenerateResponse(
        generated=True,
        kind="style-ref",
        key=kind,
        asset=asset,
        status=adaptation.status(slug),
        message=f"Generated {title}.",
    )
