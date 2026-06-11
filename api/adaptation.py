"""Project-backed comic adaptation helpers."""

from __future__ import annotations

import shutil
import subprocess
import os
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile

import gemini
import library
from models import (
    AdaptationCanvasImportResponse,
    AdaptationGenerateArtifactRequest,
    AdaptationAssetLink,
    AdaptationGenerateResponse,
    AdaptationMetadata,
    AdaptationStatus,
    AdaptationStyleRefAssetRequest,
    AdaptationWorkflowStatus,
    ArtifactKind,
    AssetSummary,
    GenerateRequest,
    StoryArtifactCanvasNode,
    utc_now,
)


STYLE_TEMPLATE = "Style:\nColor palette:\nRealism:\nLighting:\n"


def adaptation_dir(slug: str) -> Path:
    library.require_project(slug)
    return library.project_dir(slug) / "adaptation"


def metadata_path(slug: str) -> Path:
    return adaptation_dir(slug) / "adaptation.json"


def workflow_status_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / "run-status.json"


def workflow_log_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / "run.log"


def validation_status_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / "validate-status.json"


def validation_log_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / "validate.log"


def ensure_adaptation(slug: str) -> Path:
    root = adaptation_dir(slug)
    for path in [
        root / "sessions",
        root / "style-refs",
        root / "characters" / "artifacts",
        root / "characters" / "sheets",
        root / "scenes",
        root / "locations" / "prompts",
    ]:
        path.mkdir(parents=True, exist_ok=True)
    visual_style = root / "style-refs" / "visual-style.md"
    if not visual_style.exists():
        visual_style.write_text(STYLE_TEMPLATE)
    if not metadata_path(slug).exists():
        write_metadata(slug, AdaptationMetadata())
    return root


def process_status(slug: str, status_path: Path, log_path: Path) -> AdaptationWorkflowStatus:
    ensure_adaptation(slug)
    data: dict[str, Any] = {}
    if status_path.is_file():
        data = library.read_json(status_path)
    running = False
    pid = data.get("pid")
    if data.get("running") and isinstance(pid, int):
        running = process_is_running(pid)
    log = read_text(log_path)[-20000:]
    if data.get("running") and not running:
        data["running"] = False
        data["completedAt"] = data.get("completedAt") or utc_now()
        data["returnCode"] = data.get("returnCode")
        library.write_json(status_path, data)
    return AdaptationWorkflowStatus(
        running=running,
        returnCode=data.get("returnCode"),
        startedAt=data.get("startedAt"),
        completedAt=data.get("completedAt"),
        log=log,
    )


def workflow_status(slug: str) -> AdaptationWorkflowStatus:
    return process_status(slug, workflow_status_path(slug), workflow_log_path(slug))


def validation_status(slug: str) -> AdaptationWorkflowStatus:
    return process_status(slug, validation_status_path(slug), validation_log_path(slug))


def process_is_running(pid: int) -> bool:
    try:
        import os

        os.kill(pid, 0)
        return True
    except OSError:
        return False


def start_logged_process(
    slug: str,
    *,
    log_path: Path,
    status_path: Path,
    start_line: str,
    script_command: str,
) -> AdaptationWorkflowStatus:
    root = ensure_adaptation(slug)
    current = process_status(slug, status_path, log_path)
    if current.running:
        raise HTTPException(status_code=409, detail="Process is already running")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = log_path.open("w")
    log_file.write(f"[{utc_now()}] {start_line}\n")
    log_file.flush()
    command = [
        "bash",
        "-lc",
        (
            "echo \"node: $(command -v node) $(node --version 2>/dev/null || true)\"; "
            "echo \"pi: $(command -v pi)\"; "
            f"{script_command}; code=$?; "
            "python3 - \"$STATUS_PATH\" \"$code\" <<'PY'\n"
            "import json\n"
            "import sys\n"
            "from datetime import datetime, timezone\n"
            "from pathlib import Path\n"
            "path = Path(sys.argv[1])\n"
            "data = json.loads(path.read_text())\n"
            "data['running'] = False\n"
            "data['returnCode'] = int(sys.argv[2])\n"
            "data['completedAt'] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')\n"
            "path.write_text(json.dumps(data, indent=2) + '\\n')\n"
            "PY\n"
            "exit $code"
        ),
    ]
    env = os.environ.copy()
    node22_bin = Path("/opt/homebrew/opt/node@22/bin")
    if node22_bin.is_dir():
        env["PATH"] = f"{node22_bin.as_posix()}:{env.get('PATH', '')}"
    env["SLUG"] = slug
    env["STATUS_PATH"] = str(status_path)
    process = subprocess.Popen(
        command,
        cwd=library.REPO_ROOT,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        env=env,
        start_new_session=True,
    )
    library.write_json(
        status_path,
        {
            "running": True,
            "pid": process.pid,
            "returnCode": None,
            "startedAt": utc_now(),
            "completedAt": None,
        },
    )
    log_file.close()
    return process_status(slug, status_path, log_path)


def start_workflow(slug: str) -> AdaptationWorkflowStatus:
    root = ensure_adaptation(slug)
    if not (root / "book.txt").is_file():
        raise HTTPException(status_code=400, detail="Upload book.txt before running adaptation")
    return start_logged_process(
        slug,
        log_path=workflow_log_path(slug),
        status_path=workflow_status_path(slug),
        start_line=f"Starting adaptation workflow for {slug}",
        script_command="./scripts/comic-adaptation/run \"$SLUG\"",
    )


def start_validation(slug: str) -> AdaptationWorkflowStatus:
    ensure_adaptation(slug)
    return start_logged_process(
        slug,
        log_path=validation_log_path(slug),
        status_path=validation_status_path(slug),
        start_line=f"Starting adaptation validation for {slug}",
        script_command="./scripts/comic-adaptation/validate \"$SLUG\"",
    )


def import_drafts_to_canvas(slug: str) -> AdaptationCanvasImportResponse:
    before = library.read_stored_canvas(slug)
    after = library.default_canvas_for_story_artifacts(slug, before)
    imported_count = max(0, len(after.nodes) - len(before.nodes))
    saved = library.write_canvas(slug, after)
    return AdaptationCanvasImportResponse(canvas=saved, importedNodeCount=imported_count)


def read_metadata(slug: str) -> AdaptationMetadata:
    ensure_adaptation(slug)
    return AdaptationMetadata.model_validate(library.read_json(metadata_path(slug)))


def write_metadata(slug: str, metadata: AdaptationMetadata) -> AdaptationMetadata:
    library.write_json(metadata_path(slug), metadata.model_dump(mode="json"))
    return metadata


def relpath(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def read_text(path: Path) -> str:
    if not path.is_file():
        return ""
    return path.read_text()


def slug_from_heading(line: str) -> str:
    return line.removeprefix("## ").strip()


def parse_prompt_sections(path: Path) -> dict[str, dict[str, str]]:
    sections: dict[str, dict[str, str]] = {}
    current: str | None = None
    mode = ""
    style_ref = ""
    prompt_lines: list[str] = []
    in_prompt = False
    for raw_line in read_text(path).splitlines():
        if raw_line.startswith("## "):
            if current is not None:
                sections[current] = {
                    "mode": mode,
                    "style_ref": style_ref,
                    "prompt": "\n".join(prompt_lines).strip(),
                }
            current = slug_from_heading(raw_line)
            mode = ""
            style_ref = ""
            prompt_lines = []
            in_prompt = False
            continue
        if current is None:
            continue
        if raw_line.startswith("mode:"):
            mode = raw_line.split(":", 1)[1].strip()
            continue
        if raw_line.startswith("style_ref:"):
            style_ref = raw_line.split(":", 1)[1].strip()
            continue
        if raw_line == "" and style_ref:
            in_prompt = True
            continue
        if in_prompt:
            prompt_lines.append(raw_line)
    if current is not None:
        sections[current] = {
            "mode": mode,
            "style_ref": style_ref,
            "prompt": "\n".join(prompt_lines).strip(),
        }
    return sections


def prompt_link(
    *,
    artifact_kind: ArtifactKind,
    prompt_path: str,
    section: dict[str, str],
    existing: AdaptationAssetLink | None,
) -> AdaptationAssetLink:
    return AdaptationAssetLink(
        artifactKind=artifact_kind,
        promptPath=prompt_path,
        mode=section.get("mode", ""),
        styleRef=section.get("style_ref", ""),
        prompt=section.get("prompt", ""),
        assetId=existing.assetId if existing else None,
        status="generated" if existing and existing.assetId else "ready",
    )


def sync_prompt_links(slug: str, metadata: AdaptationMetadata) -> AdaptationMetadata:
    root = ensure_adaptation(slug)
    for sheet in sorted((root / "characters" / "sheets").glob("*.md")):
        prompt_path = relpath(root, sheet)
        for key, section in parse_prompt_sections(sheet).items():
            existing = metadata.characters.get(key)
            metadata.characters[key] = prompt_link(
                artifact_kind="character-sheet",
                prompt_path=prompt_path,
                section=section,
                existing=existing,
            )
    for prompt_file in sorted((root / "locations" / "prompts").glob("*.md")):
        prompt_path = relpath(root, prompt_file)
        for key, section in parse_prompt_sections(prompt_file).items():
            existing = metadata.locations.get(key)
            metadata.locations[key] = prompt_link(
                artifact_kind="location-prompt",
                prompt_path=prompt_path,
                section=section,
                existing=existing,
            )
    return write_metadata(slug, metadata)


def status(slug: str) -> AdaptationStatus:
    root = ensure_adaptation(slug)
    metadata = sync_prompt_links(slug, read_metadata(slug))
    return AdaptationStatus(
        projectSlug=slug,
        hasBook=(root / "book.txt").is_file(),
        hasBookSession=(root / "sessions" / "book-load.env").is_file(),
        styleRefs={
            "visualStyle": (root / "style-refs" / "visual-style.md").is_file(),
            "archetypeCharacterPrompt": (root / "style-refs" / "archetype-character.md").is_file(),
            "archetypeCharacterPng": (root / "style-refs" / "archetype-character.png").is_file(),
            "archetypeScenePrompt": (root / "style-refs" / "archetype-scene.md").is_file(),
            "archetypeScenePng": (root / "style-refs" / "archetype-scene.png").is_file(),
            "archetypeCharacterAsset": metadata.styleRefs.archetypeCharacterAssetId is not None,
            "archetypeSceneAsset": metadata.styleRefs.archetypeSceneAssetId is not None,
        },
        counts={
            "characterListLines": count_nonempty_lines(root / "characters" / "list.txt"),
            "characterArtifacts": len(list((root / "characters" / "artifacts").glob("*.md"))),
            "characterSheets": len(list((root / "characters" / "sheets").glob("*.md"))),
            "sceneManifest": 1 if (root / "scenes" / "manifest.md").is_file() else 0,
            "locationPrompts": len(list((root / "locations" / "prompts").glob("*.md"))),
        },
        visualStyle=read_text(root / "style-refs" / "visual-style.md"),
        characters=metadata.characters,
        locations=metadata.locations,
    )


def count_nonempty_lines(path: Path) -> int:
    return sum(1 for line in read_text(path).splitlines() if line.strip())


def write_visual_style(slug: str, value: str) -> AdaptationStatus:
    root = ensure_adaptation(slug)
    (root / "style-refs" / "visual-style.md").write_text(value.rstrip() + "\n")
    return status(slug)


async def import_book(slug: str, upload: UploadFile) -> AdaptationStatus:
    root = ensure_adaptation(slug)
    if upload.content_type not in {None, "text/plain", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Book import expects a text file")
    with (root / "book.txt").open("wb") as fh:
        shutil.copyfileobj(upload.file, fh)
    return status(slug)


async def import_style_ref(slug: str, kind: str, upload: UploadFile) -> AdaptationStatus:
    if kind not in {"archetype-character", "archetype-scene"}:
        raise HTTPException(status_code=400, detail="Invalid style ref kind")
    root = ensure_adaptation(slug)
    target = root / "style-refs" / f"{kind}.png"
    with target.open("wb") as fh:
        shutil.copyfileobj(upload.file, fh)
    summary = library.import_asset_file(slug, target, title=f"Comic adaptation {kind}")
    metadata = read_metadata(slug)
    if kind == "archetype-character":
        metadata.styleRefs.archetypeCharacterAssetId = summary.id
    else:
        metadata.styleRefs.archetypeSceneAssetId = summary.id
    write_metadata(slug, metadata)
    return status(slug)


def set_style_ref_asset(slug: str, request: AdaptationStyleRefAssetRequest) -> AdaptationStatus:
    library.read_asset(slug, request.assetId)
    metadata = read_metadata(slug)
    if request.kind == "archetype-character":
        metadata.styleRefs.archetypeCharacterAssetId = request.assetId
    else:
        metadata.styleRefs.archetypeSceneAssetId = request.assetId
    write_metadata(slug, metadata)
    return status(slug)


def import_existing_style_refs(slug: str) -> AdaptationStatus:
    root = ensure_adaptation(slug)
    metadata = read_metadata(slug)
    existing = [
        ("archetype-character", root / "style-refs" / "archetype-character.png", metadata.styleRefs.archetypeCharacterAssetId),
        ("archetype-scene", root / "style-refs" / "archetype-scene.png", metadata.styleRefs.archetypeSceneAssetId),
    ]
    for kind, path, current_asset_id in existing:
        if current_asset_id is not None or not path.is_file():
            continue
        summary = library.import_asset_file(slug, path, title=f"Comic adaptation {kind}")
        if kind == "archetype-character":
            metadata.styleRefs.archetypeCharacterAssetId = summary.id
        else:
            metadata.styleRefs.archetypeSceneAssetId = summary.id
    write_metadata(slug, metadata)
    return status(slug)


def next_base_character(slug: str) -> tuple[str, Path, dict[str, str]] | None:
    root = ensure_adaptation(slug)
    metadata = sync_prompt_links(slug, read_metadata(slug))
    for sheet in sorted((root / "characters" / "sheets").glob("*.md")):
        for key, section in parse_prompt_sections(sheet).items():
            if section.get("mode") != "new-image":
                continue
            link = metadata.characters.get(key)
            if link is None or link.assetId is None:
                return key, sheet, section
    return None


def artifact_entries(metadata: AdaptationMetadata, artifact_kind: ArtifactKind) -> dict[str, AdaptationAssetLink]:
    return metadata.characters if artifact_kind == "character-sheet" else metadata.locations


def style_ref_asset_id(metadata: AdaptationMetadata, artifact_kind: ArtifactKind) -> str | None:
    if artifact_kind == "character-sheet":
        return metadata.styleRefs.archetypeCharacterAssetId
    return metadata.styleRefs.archetypeSceneAssetId


def missing_style_ref_detail(artifact_kind: ArtifactKind) -> str:
    if artifact_kind == "character-sheet":
        return "Import archetype character style ref before generating"
    return "Import archetype scene style ref before generating"


def attach_artifact_asset_to_canvas(
    slug: str,
    *,
    artifact_kind: ArtifactKind,
    artifact_key: str,
    asset_id: str,
    canvas_node_id: str | None,
) -> None:
    canvas = library.read_stored_canvas(slug)
    target_id = canvas_node_id
    target = canvas.nodes.get(target_id or "") if target_id else None
    if not isinstance(target, StoryArtifactCanvasNode):
        for node_id, node in canvas.nodes.items():
            if isinstance(node, StoryArtifactCanvasNode) and node.artifactKind == artifact_kind and node.artifactKey == artifact_key:
                target_id = node_id
                target = node
                break
    if not isinstance(target, StoryArtifactCanvasNode) or target_id is None:
        return
    target.generatedAssetId = asset_id
    target.tags = library.node_tags(*target.tags, "generated")
    canvas.nodes[target_id] = target
    library.write_canvas(slug, canvas)


def generate_artifact(slug: str, request: AdaptationGenerateArtifactRequest) -> AdaptationGenerateResponse:
    root = ensure_adaptation(slug)
    metadata = sync_prompt_links(slug, read_metadata(slug))
    entries = artifact_entries(metadata, request.artifactKind)
    link = entries.get(request.artifactKey)
    if link is None:
        raise HTTPException(status_code=404, detail=f"Story artifact not found: {request.artifactKey}")
    ref_asset_id = style_ref_asset_id(metadata, request.artifactKind)
    if ref_asset_id is None:
        raise HTTPException(status_code=400, detail=missing_style_ref_detail(request.artifactKind))
    if link.mode != "new-image":
        raise HTTPException(status_code=400, detail="Only new-image story artifacts can be generated directly")
    visual_style = read_text(root / "style-refs" / "visual-style.md")
    prompt = f"{link.prompt.strip()}\n\n{visual_style.strip()}\n"
    payload = GenerateRequest(
        prompt=prompt,
        refs=[ref_asset_id],
        aspectRatio="16:9",
        imageSize="1K",
        batchCount=1,
        title=f"{link.artifactKind.replace('-', ' ').title()}: {request.artifactKey}",
        tags=["comic-adaptation", link.artifactKind],
    )
    response = library.create_generated_assets(slug, payload, gemini.generate_image)
    asset = response.assets[0]
    entries[request.artifactKey] = link.model_copy(update={"assetId": asset.id, "status": "generated"})
    write_metadata(slug, metadata)
    attach_artifact_asset_to_canvas(
        slug,
        artifact_kind=request.artifactKind,
        artifact_key=request.artifactKey,
        asset_id=asset.id,
        canvas_node_id=request.canvasNodeId,
    )
    return AdaptationGenerateResponse(
        generated=True,
        kind="artifact",
        key=request.artifactKey,
        asset=asset,
        status=status(slug),
        message=f"Generated {request.artifactKey}.",
    )


def generate_next_character_sheet(slug: str) -> AdaptationGenerateResponse:
    metadata = sync_prompt_links(slug, read_metadata(slug))
    if metadata.styleRefs.archetypeCharacterAssetId is None:
        raise HTTPException(status_code=400, detail=missing_style_ref_detail("character-sheet"))
    next_item = next_base_character(slug)
    if next_item is None:
        return AdaptationGenerateResponse(generated=False, kind="character", message="No missing base character sheets.")
    key, _sheet, _section = next_item
    response = generate_artifact(
        slug,
        AdaptationGenerateArtifactRequest(artifactKind="character-sheet", artifactKey=key),
    )
    return response.model_copy(update={"kind": "character"})
