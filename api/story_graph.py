"""Story graph projection for book-derived artifacts on the canvas."""

from __future__ import annotations

from pathlib import Path

import library
from models import ArtifactSourceRole, CanvasDocument, DraftCanvasNode, GeneratedResultRole, ImageGroupCanvasNode, StoryArtifactCanvasNode, StyleRefSourceRole, VisualStyleSourceRole


VISUAL_STYLE_NODE_ID = "style_visual_style"


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


def sync_visual_style_node(slug: str, canvas: CanvasDocument) -> CanvasDocument:
    """Project the shared visual style prompt as a durable source node."""
    import adaptation

    root = adaptation.ensure_adaptation(slug)
    prompt_path = root / "style-refs" / "visual-style.md"
    existing = canvas.nodes.get(VISUAL_STYLE_NODE_ID)
    next_canvas = canvas.model_copy(deep=True)
    next_canvas.nodes[VISUAL_STYLE_NODE_ID] = DraftCanvasNode(
        displayName="Visual Style",
        x=existing.x if isinstance(existing, DraftCanvasNode) else 80,
        y=existing.y if isinstance(existing, DraftCanvasNode) else -120,
        width=existing.width if isinstance(existing, DraftCanvasNode) else 300,
        tags=library.node_tags("adaptation", "visual-style", "source-artifact"),
        role=VisualStyleSourceRole(),
        refs=[],
        prompt=adaptation.read_text(prompt_path),
    )
    return next_canvas


def sync_existing_story_artifacts(slug: str, canvas: CanvasDocument) -> CanvasDocument:
    """Refresh existing story source nodes without creating new source nodes."""
    import adaptation

    status = adaptation.status(slug)
    groups = {
        "character-sheet": status.characters,
        "location-prompt": status.locations,
        "scene-artifact": status.scenes,
        "page-plan": status.pages,
        "panel-prompt": status.panels,
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
        next_canvas.nodes[node_id] = DraftCanvasNode(
            displayName=str(config["display_name"]),
            x=source_x,
            y=source_y,
            width=source_width,
            tags=library.node_tags(*tags, "generated" if has_asset else "missing"),
            role=StyleRefSourceRole(kind=ref_kind),
            refs=[],
            prompt=status.promptText,
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


def sync_story_artifact_nodes(
    canvas: CanvasDocument,
    *,
    artifact_kind: str,
    entries: dict[str, object],
    start_x: int,
    start_y: int,
    base_tags: list[str],
) -> CanvasDocument:
    next_canvas = canvas.model_copy(deep=True)
    existing_artifacts = {
        (node.artifactKind, node.artifactKey)
        for node in next_canvas.nodes.values()
        if isinstance(node, StoryArtifactCanvasNode)
    }
    columns = 5
    x_gap = 310
    y_gap = 230
    for index, (key, entry) in enumerate(entries.items()):
        refs = story_artifact_refs(entries, entry)
        asset_ids = list(getattr(entry, "assetIds", None) or [])
        has_assets = len(asset_ids) > 0
        for node_id, node in list(next_canvas.nodes.items()):
            if isinstance(node, StoryArtifactCanvasNode) and node.artifactKind == artifact_kind and node.artifactKey == key:
                node.promptPath = entry.promptPath
                node.prompt = entry.prompt
                node.refs = refs
                node.generatedAssetIds = asset_ids
                node.tags = library.node_tags(
                    *story_artifact_base_tags(artifact_kind),
                    "generated" if has_assets else "missing",
                )
                node.role = ArtifactSourceRole(artifactKind=artifact_kind, artifactKey=key)
                next_canvas.nodes[node_id] = node
                break
        if (artifact_kind, key) not in existing_artifacts:
            node_id = library.story_artifact_node_id(artifact_kind, key)
            while node_id in next_canvas.nodes:
                node_id = f"{node_id}_{index}"
            next_canvas.nodes[node_id] = StoryArtifactCanvasNode(
                displayName=key,
                x=start_x + (index % columns) * x_gap,
                y=start_y + (index // columns) * y_gap,
                width=240,
                tags=library.node_tags(*base_tags, "generated" if has_assets else "missing"),
                role=ArtifactSourceRole(artifactKind=artifact_kind, artifactKey=key),
                artifactKind=artifact_kind,
                artifactKey=key,
                promptPath=entry.promptPath,
                prompt=entry.prompt,
                refs=refs,
                generatedAssetIds=asset_ids,
            )
        source_node_id = next(
            (
                current_node_id
                for current_node_id, current_node in next_canvas.nodes.items()
                if isinstance(current_node, StoryArtifactCanvasNode)
                and current_node.artifactKind == artifact_kind
                and current_node.artifactKey == key
            ),
            library.story_artifact_node_id(artifact_kind, key),
        )
        child_node_id = library.generated_result_node_id(source_node_id)
        if asset_ids:
            source_node = next_canvas.nodes[source_node_id]
            existing_child = next_canvas.nodes.get(child_node_id)
            if isinstance(existing_child, ImageGroupCanvasNode):
                child = existing_child
                child.assetIds = list(dict.fromkeys([*asset_ids, *child.assetIds]))
            else:
                child = ImageGroupCanvasNode(
                    displayName=getattr(entry, "promptPath", key) or key,
                    x=source_node.x + 320,
                    y=source_node.y,
                    width=240,
                    tags=library.node_tags(*base_tags, "generated-image"),
                    role=GeneratedResultRole(sourceNodeId=source_node_id),
                    assetIds=asset_ids,
                    activeAssetId=asset_ids[-1],
                )
            child.activeAssetId = asset_ids[-1]
            child.tags = library.node_tags(*base_tags, "generated-image")
            child.role = GeneratedResultRole(sourceNodeId=source_node_id)
            next_canvas.nodes[child_node_id] = child
        else:
            next_canvas.nodes.pop(child_node_id, None)
    return next_canvas


def _artifact_kind_layout(canvas: CanvasDocument, artifact_kind: str) -> tuple[int, int]:
    columns = 5
    y_gap = 230
    if artifact_kind == "character-sheet":
        return 80, 320
    if artifact_kind == "location-prompt":
        character_count = sum(
            1
            for node in canvas.nodes.values()
            if isinstance(node, StoryArtifactCanvasNode) and node.artifactKind == "character-sheet"
        )
        character_rows = max(1, (character_count + columns - 1) // columns)
        return 80, 320 + character_rows * y_gap + 180
    return 80, 320


def _artifact_base_tags(artifact_kind: str) -> list[str]:
    if artifact_kind == "character-sheet":
        return ["adaptation", "character-sheet"]
    if artifact_kind == "location-prompt":
        return ["adaptation", "location"]
    if artifact_kind == "scene-artifact":
        return ["adaptation", "scene"]
    if artifact_kind == "page-plan":
        return ["adaptation", "page"]
    if artifact_kind == "panel-prompt":
        return ["adaptation", "panel"]
    return ["adaptation"]


def sync_single_story_artifact_node(
    canvas: CanvasDocument,
    *,
    artifact_kind: str,
    artifact_key: str,
    entry: object,
    entries: dict[str, object],
) -> tuple[CanvasDocument, bool, str]:
    next_canvas = canvas.model_copy(deep=True)
    base_tags = _artifact_base_tags(artifact_kind)
    refs = story_artifact_refs(entries, entry)
    asset_ids = list(getattr(entry, "assetIds", None) or [])
    has_assets = len(asset_ids) > 0
    created = False
    source_node_id = next(
        (
            current_node_id
            for current_node_id, current_node in next_canvas.nodes.items()
            if isinstance(current_node, StoryArtifactCanvasNode)
            and current_node.artifactKind == artifact_kind
            and current_node.artifactKey == artifact_key
        ),
        "",
    )
    if source_node_id:
        node = next_canvas.nodes[source_node_id]
        if isinstance(node, StoryArtifactCanvasNode):
            node.promptPath = entry.promptPath
            node.prompt = entry.prompt
            node.refs = refs
            node.generatedAssetIds = asset_ids
            node.tags = library.node_tags(*story_artifact_base_tags(artifact_kind), "generated" if has_assets else "missing")
            node.role = ArtifactSourceRole(artifactKind=artifact_kind, artifactKey=artifact_key)
            next_canvas.nodes[source_node_id] = node
    else:
        existing_of_kind = [
            node
            for node in next_canvas.nodes.values()
            if isinstance(node, StoryArtifactCanvasNode) and node.artifactKind == artifact_kind
        ]
        index = len(existing_of_kind)
        columns = 5
        x_gap = 310
        y_gap = 230
        start_x, start_y = _artifact_kind_layout(next_canvas, artifact_kind)
        node_id = library.story_artifact_node_id(artifact_kind, artifact_key)
        while node_id in next_canvas.nodes:
            node_id = f"{node_id}_{index}"
        next_canvas.nodes[node_id] = StoryArtifactCanvasNode(
            displayName=artifact_key,
            x=start_x + (index % columns) * x_gap,
            y=start_y + (index // columns) * y_gap,
            width=240,
            tags=library.node_tags(*base_tags, "generated" if has_assets else "missing"),
            role=ArtifactSourceRole(artifactKind=artifact_kind, artifactKey=artifact_key),
            artifactKind=artifact_kind,
            artifactKey=artifact_key,
            promptPath=entry.promptPath,
            prompt=entry.prompt,
            refs=refs,
            generatedAssetIds=asset_ids,
        )
        source_node_id = node_id
        created = True

    child_node_id = library.generated_result_node_id(source_node_id)
    if asset_ids:
        source_node = next_canvas.nodes[source_node_id]
        existing_child = next_canvas.nodes.get(child_node_id)
        if isinstance(existing_child, ImageGroupCanvasNode):
            child = existing_child
            child.assetIds = list(dict.fromkeys([*asset_ids, *child.assetIds]))
        else:
            child = ImageGroupCanvasNode(
                displayName=getattr(entry, "promptPath", artifact_key) or artifact_key,
                x=source_node.x + 320,
                y=source_node.y,
                width=240,
                tags=library.node_tags(*base_tags, "generated-image"),
                role=GeneratedResultRole(sourceNodeId=source_node_id),
                assetIds=asset_ids,
                activeAssetId=asset_ids[-1],
            )
        child.activeAssetId = asset_ids[-1]
        child.tags = library.node_tags(*base_tags, "generated-image")
        child.role = GeneratedResultRole(sourceNodeId=source_node_id)
        next_canvas.nodes[child_node_id] = child
    else:
        next_canvas.nodes.pop(child_node_id, None)
    return next_canvas, created, source_node_id


def sync_character_nodes(canvas: CanvasDocument, entries: dict[str, object], start_y: int) -> CanvasDocument:
    return sync_story_artifact_nodes(canvas, artifact_kind="character-sheet", entries=entries, start_x=80, start_y=start_y, base_tags=["adaptation", "character-sheet"])


def sync_location_nodes(canvas: CanvasDocument, entries: dict[str, object], start_y: int) -> CanvasDocument:
    return sync_story_artifact_nodes(canvas, artifact_kind="location-prompt", entries=entries, start_x=80, start_y=start_y, base_tags=["adaptation", "location"])


def sync_scene_nodes(canvas: CanvasDocument, entries: dict[str, object], start_y: int) -> CanvasDocument:
    return sync_story_artifact_nodes(canvas, artifact_kind="scene-artifact", entries=entries, start_x=80, start_y=start_y, base_tags=["adaptation", "scene"])


def sync_moment_nodes(canvas: CanvasDocument, pages: dict[str, object], panels: dict[str, object], page_start_y: int, panel_start_y: int) -> CanvasDocument:
    next_canvas = sync_story_artifact_nodes(canvas, artifact_kind="page-plan", entries=pages, start_x=80, start_y=page_start_y, base_tags=["adaptation", "page"])
    return sync_story_artifact_nodes(next_canvas, artifact_kind="panel-prompt", entries=panels, start_x=80, start_y=panel_start_y, base_tags=["adaptation", "panel"])


def default_canvas_for_story_artifacts(slug: str, canvas: CanvasDocument) -> CanvasDocument:
    import adaptation

    status = adaptation.status(slug)
    next_canvas = sync_visual_style_node(slug, canvas)
    next_canvas = sync_style_ref_canvas_nodes(slug, next_canvas)
    columns = 5
    y_gap = 230
    character_start_y = 320
    character_rows = max(1, (len(status.characters) + columns - 1) // columns)
    location_start_y = character_start_y + character_rows * y_gap + 180
    scene_start_y = location_start_y + max(1, (len(status.locations) + columns - 1) // columns) * y_gap + 180
    page_start_y = location_start_y + max(1, (len(status.locations) + len(status.scenes) + columns - 1) // columns) * y_gap + 360
    panel_start_y = location_start_y + max(1, (len(status.locations) + len(status.scenes) + len(status.pages) + columns - 1) // columns) * y_gap + 540
    next_canvas = sync_character_nodes(next_canvas, status.characters, character_start_y)
    next_canvas = sync_location_nodes(next_canvas, status.locations, location_start_y)
    next_canvas = sync_scene_nodes(next_canvas, status.scenes, scene_start_y)
    next_canvas = sync_moment_nodes(next_canvas, status.pages, status.panels, page_start_y, panel_start_y)
    return next_canvas
