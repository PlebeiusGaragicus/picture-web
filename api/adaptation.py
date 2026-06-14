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
    AdaptationFileCreate,
    AdaptationFileDocument,
    AdaptationFileKind,
    AdaptationFileUpdate,
    AdaptationGenerateStyleRefRequest,
    AdaptationGenerateArtifactRequest,
    AdaptationAssetLink,
    AdaptationGenerateResponse,
    AdaptationMetadata,
    AdaptationSettingsPatch,
    AdaptationStatus,
    AdaptationStylePromptPatch,
    AdaptationStyleRefAssetRequest,
    AdaptationWorkflowStatus,
    ArtifactKind,
    AssetSummary,
    GenerateRequest,
    StyleRefKind,
    StyleRefStatus,
    StoryArtifactCanvasNode,
    utc_now,
)


STYLE_TEMPLATE = "Style:\nColor palette:\nRealism:\nLighting:\n"


def adaptation_dir(slug: str) -> Path:
    library.require_project(slug)
    return library.project_dir(slug) / "adaptation"


def metadata_path(slug: str) -> Path:
    return adaptation_dir(slug) / "adaptation.json"


WORKFLOW_STAGES = ("ingest", "characters", "locations", "scenes", "moments", "all")
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


def asset_exists(slug: str, asset_id: str) -> bool:
    return library.asset_json_path(slug, asset_id).is_file() and library.asset_png_path(slug, asset_id).is_file()


def clear_stale_style_ref_assets(slug: str, metadata: AdaptationMetadata) -> tuple[AdaptationMetadata, bool]:
    changed = False
    for kind in STYLE_REF_KINDS:
        asset_id = get_style_ref_asset_id(metadata, kind)
        if asset_id and not asset_exists(slug, asset_id):
            set_style_ref_asset_id(metadata, kind, None)
            changed = True
    return metadata, changed


def style_ref_status(slug: str, kind: StyleRefKind, metadata: AdaptationMetadata | None = None) -> StyleRefStatus:
    root = ensure_adaptation(slug)
    metadata = metadata or read_metadata(slug)
    prompt_path = style_ref_prompt_path(root, kind)
    draft_node_id, image_node_id = style_ref_node_ids(kind)
    asset_id = get_style_ref_asset_id(metadata, kind)
    if asset_id and not asset_exists(slug, asset_id):
        asset_id = None
    return StyleRefStatus(
        kind=kind,
        promptPath=relpath(root, prompt_path),
        promptText=read_text(prompt_path),
        assetId=asset_id,
        canvasDraftNodeId=draft_node_id,
        canvasImageNodeId=image_node_id,
    )


def style_ref_statuses(slug: str, metadata: AdaptationMetadata) -> dict[StyleRefKind, StyleRefStatus]:
    return {kind: style_ref_status(slug, kind, metadata) for kind in STYLE_REF_KINDS}


def require_stage(stage: str) -> str:
    if stage not in WORKFLOW_STAGES:
        raise HTTPException(status_code=400, detail=f"Unknown workflow stage: {stage}")
    return stage


def workflow_status_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{stage}-status.json"


def workflow_log_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{stage}.log"


def validation_status_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"validate-{stage}-status.json"


def validation_log_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"validate-{stage}.log"


def ensure_adaptation(slug: str) -> Path:
    root = adaptation_dir(slug)
    for path in [
        root / "sessions",
        root / "style-refs",
        root / "characters" / "artifacts",
        root / "characters" / "sheets",
        root / "acts",
        root / "scenes" / "artifacts",
        root / "pages" / "plans",
        root / "panels" / "prompts",
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
    log = read_text(log_path)
    log_limit = 400000
    if len(log) > log_limit:
        log = log[-log_limit:]
        # Drop a partial first line so the UI never tries to parse a truncated event.
        newline = log.find("\n")
        if newline != -1:
            log = log[newline + 1 :]
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


def workflow_status(slug: str, stage: str = "all") -> AdaptationWorkflowStatus:
    require_stage(stage)
    return process_status(slug, workflow_status_path(slug, stage), workflow_log_path(slug, stage))


def validation_status(slug: str, stage: str = "all") -> AdaptationWorkflowStatus:
    require_stage(stage)
    return process_status(slug, validation_status_path(slug, stage), validation_log_path(slug, stage))


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


def start_workflow(slug: str, stage: str = "all") -> AdaptationWorkflowStatus:
    root = ensure_adaptation(slug)
    require_stage(stage)
    if not (root / "book.txt").is_file():
        raise HTTPException(status_code=400, detail="Upload book.txt before running adaptation")
    # stage is validated against WORKFLOW_STAGES above, so it is safe to interpolate.
    return start_logged_process(
        slug,
        log_path=workflow_log_path(slug, stage),
        status_path=workflow_status_path(slug, stage),
        start_line=f"Starting adaptation workflow ({stage}) for {slug}",
        script_command=f"./scripts/comic-adaptation/run \"$SLUG\" \"{stage}\"",
    )


def start_validation(slug: str, stage: str = "all") -> AdaptationWorkflowStatus:
    ensure_adaptation(slug)
    require_stage(stage)
    return start_logged_process(
        slug,
        log_path=validation_log_path(slug, stage),
        status_path=validation_status_path(slug, stage),
        start_line=f"Starting adaptation validation ({stage}) for {slug}",
        script_command=f"./scripts/comic-adaptation/validate \"$SLUG\" \"{stage}\"",
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


def parse_scene_artifact(path: Path) -> dict[str, str]:
    text = read_text(path).strip()
    if not text:
        return {}
    return {
        "mode": "story-only",
        "style_ref": "",
        "prompt": text,
    }


def file_kind_config(kind: AdaptationFileKind) -> tuple[ArtifactKind, Path]:
    root = Path()
    configs: dict[AdaptationFileKind, tuple[ArtifactKind, Path]] = {
        "characters": ("character-sheet", root / "characters" / "sheets"),
        "locations": ("location-prompt", root / "locations" / "prompts"),
        "scenes": ("scene-artifact", root / "scenes" / "artifacts"),
    }
    return configs[kind]


def adaptation_file_path(slug: str, kind: AdaptationFileKind, key: str) -> Path:
    root = ensure_adaptation(slug)
    _artifact_kind, directory = file_kind_config(kind)
    return root / directory / f"{key}.md"


def format_prompt_file(key: str, body: str, mode: str, style_ref: str) -> str:
    return f"## {key}\nmode: {mode.strip()}\nstyle_ref: {style_ref.strip()}\n\n{body.strip()}\n"


def format_adaptation_file(kind: AdaptationFileKind, key: str, body: str, mode: str, style_ref: str) -> str:
    if kind == "scenes":
        return (body.strip() or f"# {key}") + "\n"
    return format_prompt_file(key, body, mode or "new-image", style_ref)


def adaptation_file_from_link(
    *,
    slug: str,
    kind: AdaptationFileKind,
    key: str,
    link: AdaptationAssetLink,
) -> AdaptationFileDocument:
    return AdaptationFileDocument(
        kind=kind,
        key=key,
        promptPath=link.promptPath,
        artifactKind=link.artifactKind,
        body=link.prompt,
        mode=link.mode,
        styleRef=link.styleRef,
        status=link.status,
        canonicalAssetId=link.canonicalAssetId,
    )


def list_adaptation_files(slug: str, kind: AdaptationFileKind) -> list[AdaptationFileDocument]:
    root = ensure_adaptation(slug)
    metadata = sync_prompt_links(slug, read_metadata(slug))
    groups: dict[AdaptationFileKind, dict[str, AdaptationAssetLink]] = {
        "characters": metadata.characters,
        "locations": metadata.locations,
        "scenes": metadata.scenes,
    }
    return [
        adaptation_file_from_link(slug=slug, kind=kind, key=key, link=link)
        for key, link in sorted(groups[kind].items())
        if (root / link.promptPath).is_file()
    ]


def create_adaptation_file(slug: str, kind: AdaptationFileKind, payload: AdaptationFileCreate) -> AdaptationFileDocument:
    path = adaptation_file_path(slug, kind, payload.key)
    if path.exists():
        raise HTTPException(status_code=409, detail=f"{kind} file already exists: {payload.key}")
    path.write_text(format_adaptation_file(kind, payload.key, payload.body, payload.mode, payload.styleRef))
    files = {item.key: item for item in list_adaptation_files(slug, kind)}
    return files[payload.key]


def update_adaptation_file(slug: str, kind: AdaptationFileKind, key: str, payload: AdaptationFileUpdate) -> AdaptationFileDocument:
    current_path = adaptation_file_path(slug, kind, key)
    if not current_path.exists():
        raise HTTPException(status_code=404, detail=f"{kind} file not found: {key}")
    current_files = {item.key: item for item in list_adaptation_files(slug, kind)}
    current = current_files.get(key)
    if current is None:
        raise HTTPException(status_code=404, detail=f"{kind} file not found: {key}")
    next_key = payload.key or current.key
    next_path = adaptation_file_path(slug, kind, next_key)
    if next_key != key and next_path.exists():
        raise HTTPException(status_code=409, detail=f"{kind} file already exists: {next_key}")
    next_body = current.body if payload.body is None else payload.body
    next_mode = current.mode if payload.mode is None else payload.mode
    next_style_ref = current.styleRef if payload.styleRef is None else payload.styleRef
    if next_key != key:
        current_path.unlink()
    next_path.write_text(format_adaptation_file(kind, next_key, next_body, next_mode, next_style_ref))
    if next_key != key:
        metadata = read_metadata(slug)
        groups: dict[AdaptationFileKind, dict[str, AdaptationAssetLink]] = {
            "characters": metadata.characters,
            "locations": metadata.locations,
            "scenes": metadata.scenes,
        }
        existing = groups[kind].pop(key, None)
        if existing is not None:
            groups[kind][next_key] = existing
            write_metadata(slug, metadata)
    files = {item.key: item for item in list_adaptation_files(slug, kind)}
    return files[next_key]


def parse_layout_sections(path: Path) -> dict[str, dict[str, str]]:
    sections: dict[str, dict[str, str]] = {}
    current: str | None = None
    mode = ""
    refs = ""
    prompt_lines: list[str] = []
    in_prompt = False
    for raw_line in read_text(path).splitlines():
        if raw_line.startswith("## "):
            if current is not None:
                sections[current] = {
                    "mode": mode,
                    "style_ref": refs,
                    "prompt": "\n".join(prompt_lines).strip(),
                }
            current = slug_from_heading(raw_line)
            mode = ""
            refs = ""
            prompt_lines = []
            in_prompt = False
            continue
        if current is None:
            continue
        if raw_line.startswith("mode:"):
            mode = raw_line.split(":", 1)[1].strip()
            continue
        if raw_line.startswith("refs:"):
            refs = raw_line.split(":", 1)[1].strip()
            continue
        if raw_line == "" and mode:
            in_prompt = True
            continue
        if in_prompt:
            prompt_lines.append(raw_line)
    if current is not None:
        sections[current] = {
            "mode": mode,
            "style_ref": refs,
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
    asset_ids = list(existing.assetIds) if existing else []
    canonical_asset_id = existing.canonicalAssetId if existing else None
    return AdaptationAssetLink(
        artifactKind=artifact_kind,
        promptPath=prompt_path,
        mode=section.get("mode", ""),
        styleRef=section.get("style_ref", ""),
        prompt=section.get("prompt", ""),
        assetIds=asset_ids,
        canonicalAssetId=canonical_asset_id,
        status="generated" if canonical_asset_id else "ready",
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
    for artifact_file in sorted((root / "scenes" / "artifacts").glob("*.md")):
        prompt_path = relpath(root, artifact_file)
        key = artifact_file.stem
        section = parse_scene_artifact(artifact_file)
        if not section:
            continue
        existing = metadata.scenes.get(key)
        metadata.scenes[key] = prompt_link(
            artifact_kind="scene-artifact",
            prompt_path=prompt_path,
            section=section,
            existing=existing,
        )
    for plan_file in sorted((root / "pages" / "plans").glob("*.md")):
        prompt_path = relpath(root, plan_file)
        for key, section in parse_layout_sections(plan_file).items():
            existing = metadata.pages.get(key)
            metadata.pages[key] = prompt_link(
                artifact_kind="page-plan",
                prompt_path=prompt_path,
                section=section,
                existing=existing,
            )
    for prompt_file in sorted((root / "panels" / "prompts").glob("*.md")):
        prompt_path = relpath(root, prompt_file)
        for key, section in parse_layout_sections(prompt_file).items():
            existing = metadata.panels.get(key)
            metadata.panels[key] = prompt_link(
                artifact_kind="panel-prompt",
                prompt_path=prompt_path,
                section=section,
                existing=existing,
            )
    return write_metadata(slug, metadata)


def status(slug: str) -> AdaptationStatus:
    root = ensure_adaptation(slug)
    metadata = sync_prompt_links(slug, read_metadata(slug))
    metadata, changed = clear_stale_style_ref_assets(slug, metadata)
    if changed:
        metadata = write_metadata(slug, metadata)
    statuses = style_ref_statuses(slug, metadata)
    return AdaptationStatus(
        projectSlug=slug,
        settings=metadata.settings,
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
        styleRefStatuses=statuses,
        archetypeCharacterAssetId=metadata.styleRefs.archetypeCharacterAssetId,
        archetypeSceneAssetId=metadata.styleRefs.archetypeSceneAssetId,
        archetypeCharacterPromptText=statuses["archetype-character"].promptText,
        archetypeScenePromptText=statuses["archetype-scene"].promptText,
        counts={
            "characterListLines": count_nonempty_lines(root / "characters" / "list.txt"),
            "characterArtifacts": len(list((root / "characters" / "artifacts").glob("*.md"))),
            "characterSheets": len(list((root / "characters" / "sheets").glob("*.md"))),
            "sceneManifest": 1 if (root / "scenes" / "manifest.md").is_file() else 0,
            "playByPlay": 1 if (root / "acts" / "play-by-play.md").is_file() else 0,
            "sceneArtifacts": len(list((root / "scenes" / "artifacts").glob("*.md"))),
            "locationPrompts": len(list((root / "locations" / "prompts").glob("*.md"))),
            "pagePlans": len(list((root / "pages" / "plans").glob("*.md"))),
            "panelPrompts": len(list((root / "panels" / "prompts").glob("*.md"))),
        },
        visualStyle=read_text(root / "style-refs" / "visual-style.md"),
        characters=metadata.characters,
        locations=metadata.locations,
        scenes=metadata.scenes,
        pages=metadata.pages,
        panels=metadata.panels,
    )


def count_nonempty_lines(path: Path) -> int:
    return sum(1 for line in read_text(path).splitlines() if line.strip())


def write_visual_style(slug: str, value: str) -> AdaptationStatus:
    root = ensure_adaptation(slug)
    (root / "style-refs" / "visual-style.md").write_text(value.rstrip() + "\n")
    return status(slug)


def write_style_ref_prompt(slug: str, request: AdaptationStylePromptPatch) -> AdaptationStatus:
    kind = require_style_ref_kind(request.kind)
    root = ensure_adaptation(slug)
    style_ref_prompt_path(root, kind).write_text(request.prompt.rstrip() + "\n")
    library.write_canvas(slug, library.sync_style_ref_canvas_nodes(slug, library.read_stored_canvas(slug), kind))
    return status(slug)


def read_book(slug: str) -> str:
    root = ensure_adaptation(slug)
    book = root / "book.txt"
    if not book.is_file():
        raise HTTPException(status_code=404, detail="No book.txt uploaded")
    return read_text(book)


def write_settings(slug: str, patch: AdaptationSettingsPatch) -> AdaptationStatus:
    metadata = read_metadata(slug)
    metadata.settings.storyKind = patch.storyKind
    write_metadata(slug, metadata)
    return status(slug)


async def import_book(slug: str, upload: UploadFile) -> AdaptationStatus:
    root = ensure_adaptation(slug)
    if upload.content_type not in {None, "text/plain", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Book import expects a text file")
    with (root / "book.txt").open("wb") as fh:
        shutil.copyfileobj(upload.file, fh)
    return status(slug)


async def import_style_ref(slug: str, kind: str, upload: UploadFile) -> AdaptationStatus:
    ref_kind = require_style_ref_kind(kind)
    root = ensure_adaptation(slug)
    target = style_ref_legacy_png_path(root, ref_kind)
    with target.open("wb") as fh:
        shutil.copyfileobj(upload.file, fh)
    summary = library.import_asset_file(slug, target, title=f"Comic adaptation {ref_kind}")
    metadata = read_metadata(slug)
    set_style_ref_asset_id(metadata, ref_kind, summary.id)
    write_metadata(slug, metadata)
    library.write_canvas(slug, library.sync_style_ref_canvas_nodes(slug, library.read_stored_canvas(slug), ref_kind))
    return status(slug)


def set_style_ref_asset(slug: str, request: AdaptationStyleRefAssetRequest) -> AdaptationStatus:
    kind = require_style_ref_kind(request.kind)
    library.read_asset(slug, request.assetId)
    metadata = read_metadata(slug)
    set_style_ref_asset_id(metadata, kind, request.assetId)
    write_metadata(slug, metadata)
    library.write_canvas(slug, library.sync_style_ref_canvas_nodes(slug, library.read_stored_canvas(slug), kind))
    return status(slug)


def import_existing_style_refs(slug: str) -> AdaptationStatus:
    root = ensure_adaptation(slug)
    metadata = read_metadata(slug)
    imported_kinds: list[StyleRefKind] = []
    for kind in STYLE_REF_KINDS:
        path = style_ref_legacy_png_path(root, kind)
        if get_style_ref_asset_id(metadata, kind) is not None or not path.is_file():
            continue
        summary = library.import_asset_file(slug, path, title=f"Comic adaptation {kind}")
        set_style_ref_asset_id(metadata, kind, summary.id)
        imported_kinds.append(kind)
    write_metadata(slug, metadata)
    if imported_kinds:
        canvas = library.read_stored_canvas(slug)
        for kind in imported_kinds:
            canvas = library.sync_style_ref_canvas_nodes(slug, canvas, kind)
        library.write_canvas(slug, canvas)
    return status(slug)


def generate_style_ref(slug: str, request: AdaptationGenerateStyleRefRequest) -> AdaptationGenerateResponse:
    root = ensure_adaptation(slug)
    kind = require_style_ref_kind(request.kind)
    source_node_id, _ = style_ref_node_ids(kind)
    library.write_canvas(slug, library.sync_style_ref_canvas_nodes(slug, library.read_stored_canvas(slug), kind))
    prompt_path = style_ref_prompt_path(root, kind)
    prompt_text = read_text(prompt_path).strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail=f"Missing prompt: {prompt_path}")
    visual_style = read_text(root / "style-refs" / "visual-style.md").strip()
    prompt = f"{prompt_text}\n\n{visual_style}\n" if visual_style else f"{prompt_text}\n"
    title = str(style_ref_config(kind)["display_name"])
    tags = ["comic-adaptation", *style_ref_tags(kind)[1:]]
    payload = GenerateRequest(
        prompt=prompt,
        refs=[],
        aspectRatio="1:1",
        imageSize="1K",
        batchCount=1,
        title=title,
        tags=tags,
        canvasNodeId=source_node_id,
    )
    response = library.create_generated_assets(slug, payload, gemini.generate_image)
    asset = response.assets[0]
    metadata = read_metadata(slug)
    set_style_ref_asset_id(metadata, kind, asset.id)
    write_metadata(slug, metadata)
    library.write_canvas(slug, library.sync_style_ref_canvas_nodes(slug, library.read_stored_canvas(slug), kind))
    return AdaptationGenerateResponse(
        generated=True,
        kind="style-ref",
        key=kind,
        asset=asset,
        status=status(slug),
        message=f"Generated {title}.",
    )


def next_base_character(slug: str) -> tuple[str, Path, dict[str, str]] | None:
    root = ensure_adaptation(slug)
    metadata = sync_prompt_links(slug, read_metadata(slug))
    for sheet in sorted((root / "characters" / "sheets").glob("*.md")):
        for key, section in parse_prompt_sections(sheet).items():
            if section.get("mode") != "new-image":
                continue
            link = metadata.characters.get(key)
            if link is None or link.canonicalAssetId is None:
                return key, sheet, section
    return None


def artifact_entries(metadata: AdaptationMetadata, artifact_kind: ArtifactKind) -> dict[str, AdaptationAssetLink]:
    groups = {
        "character-sheet": metadata.characters,
        "location-prompt": metadata.locations,
        "scene-artifact": metadata.scenes,
        "page-plan": metadata.pages,
        "panel-prompt": metadata.panels,
    }
    return groups[artifact_kind]


def style_ref_asset_id(metadata: AdaptationMetadata, artifact_kind: ArtifactKind) -> str | None:
    if artifact_kind == "character-sheet":
        return metadata.styleRefs.archetypeCharacterAssetId
    if artifact_kind in {"location-prompt", "page-plan", "panel-prompt"}:
        return metadata.styleRefs.archetypeSceneAssetId
    return metadata.styleRefs.archetypeSceneAssetId


def missing_style_ref_detail(artifact_kind: ArtifactKind) -> str:
    if artifact_kind == "character-sheet":
        return "Import archetype character style ref before generating"
    return "Import archetype scene style ref before generating"


def style_ref_artifact_key(style_ref: str) -> str:
    return Path(style_ref).stem


def canonical_asset_id(link: AdaptationAssetLink) -> str | None:
    return link.canonicalAssetId


def artifact_ref_asset_id(metadata: AdaptationMetadata, artifact_kind: ArtifactKind, link: AdaptationAssetLink) -> str:
    if link.mode == "new-image":
        ref_asset_id = style_ref_asset_id(metadata, artifact_kind)
        if ref_asset_id is None:
            raise HTTPException(status_code=400, detail=missing_style_ref_detail(artifact_kind))
        return ref_asset_id
    if link.mode == "edit-reference":
        entries = artifact_entries(metadata, artifact_kind)
        base_key = style_ref_artifact_key(link.styleRef)
        base = entries.get(base_key)
        if base is None:
            raise HTTPException(status_code=400, detail=f"Referenced base artifact not found: {base_key}")
        base_asset_id = canonical_asset_id(base)
        if base_asset_id is None:
            raise HTTPException(status_code=400, detail=f"Generate base artifact before variant: {base_key}")
        return base_asset_id
    raise HTTPException(status_code=400, detail=f"Unsupported artifact generation mode: {link.mode or 'missing'}")


def parse_semantic_ref(ref: str) -> tuple[str, str] | None:
    if ":" not in ref:
        return None
    kind, key = ref.split(":", 1)
    return kind.strip(), key.strip()


def resolve_semantic_ref(metadata: AdaptationMetadata, ref: str) -> str | None:
    parsed = parse_semantic_ref(ref)
    if parsed is None:
        return None
    kind, key = parsed
    groups: dict[str, dict[str, AdaptationAssetLink]] = {
        "character": metadata.characters,
        "character-sheet": metadata.characters,
        "location": metadata.locations,
        "location-prompt": metadata.locations,
        "scene": metadata.scenes,
        "scene-artifact": metadata.scenes,
        "page": metadata.pages,
        "page-plan": metadata.pages,
        "panel": metadata.panels,
        "panel-prompt": metadata.panels,
    }
    link = groups.get(kind, {}).get(key)
    return canonical_asset_id(link) if link is not None else None


def artifact_ref_asset_ids(metadata: AdaptationMetadata, artifact_kind: ArtifactKind, link: AdaptationAssetLink) -> list[str]:
    if artifact_kind == "scene-artifact":
        return []
    if artifact_kind in {"page-plan", "panel-prompt"}:
        refs: list[str] = []
        style_ref_id = style_ref_asset_id(metadata, artifact_kind)
        if style_ref_id:
            refs.append(style_ref_id)
        for raw_ref in [item.strip() for item in link.styleRef.split(",") if item.strip()]:
            asset_id = resolve_semantic_ref(metadata, raw_ref)
            if asset_id is not None:
                refs.append(asset_id)
        return list(dict.fromkeys(refs))
    return [artifact_ref_asset_id(metadata, artifact_kind, link)]


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
    target.generatedAssetIds = list(dict.fromkeys([*target.generatedAssetIds, asset_id]))
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
    if request.artifactKind == "scene-artifact":
        raise HTTPException(status_code=400, detail="Scene artifacts are planning artifacts and cannot be generated directly")
    ref_asset_ids = artifact_ref_asset_ids(metadata, request.artifactKind, link)
    visual_style = read_text(root / "style-refs" / "visual-style.md")
    prompt = f"{link.prompt.strip()}\n\n{visual_style.strip()}\n"
    canvas_node_id = request.canvasNodeId
    if canvas_node_id is None:
        canvas = library.read_stored_canvas(slug)
        canvas_node_id = next(
            (
                node_id
                for node_id, node in canvas.nodes.items()
                if isinstance(node, StoryArtifactCanvasNode)
                and node.artifactKind == request.artifactKind
                and node.artifactKey == request.artifactKey
            ),
            None,
        )
    payload = GenerateRequest(
        prompt=prompt,
        refs=ref_asset_ids,
        aspectRatio="16:9",
        imageSize="1K",
        batchCount=1,
        title=f"{link.artifactKind.replace('-', ' ').title()}: {request.artifactKey}",
        tags=["comic-adaptation", link.artifactKind],
        canvasNodeId=canvas_node_id,
    )
    response = library.create_generated_assets(slug, payload, gemini.generate_image)
    asset = response.assets[0]
    next_asset_ids = list(dict.fromkeys([*link.assetIds, asset.id]))
    entries[request.artifactKey] = link.model_copy(
        update={
            "assetIds": next_asset_ids,
            "canonicalAssetId": asset.id,
            "status": "generated",
        }
    )
    write_metadata(slug, metadata)
    attach_artifact_asset_to_canvas(
        slug,
        artifact_kind=request.artifactKind,
        artifact_key=request.artifactKey,
        asset_id=asset.id,
        canvas_node_id=canvas_node_id,
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
