"""Project-backed comic adaptation helpers."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import os
from pathlib import Path
from typing import Any, Literal

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
    SceneListDocument,
    SceneListLine,
    SceneListLineCreate,
    SceneListReplace,
    SceneMomentsDocument,
    SceneMomentsUpdate,
    MomentLayoutSection,
    MomentRefInput,
    MomentLayoutSection,
    MomentSequenceEntry,
    MomentSequenceDocument,
    MomentSequenceCounts,
    MomentPatch,
    ArtifactKind,
    AssetSummary,
    DraftCanvasNode,
    GenerateRequest,
    StyleRefKind,
    StyleRefStatus,
    StoryArtifactCanvasNode,
    VisualStyleCreate,
    VisualStyleDefinition,
    VisualStylePatch,
    utc_now,
)


STYLE_TEMPLATE = "Style:\nColor palette:\nRealism:\nLighting:\n"


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


def slugify_style_name(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return base or "style"


def unique_style_id(root: Path, name: str) -> str:
    styles = read_visual_styles(root)
    existing = {style.id for style in styles}
    candidate = slugify_style_name(name)
    if candidate not in existing:
        return candidate
    index = 2
    while f"{candidate}-{index}" in existing:
        index += 1
    return f"{candidate}-{index}"


def visual_style_prompt(slug: str, style_id: str) -> str:
    root = ensure_adaptation(slug)
    for style in read_visual_styles(root):
        if style.id == style_id:
            return style.prompt
    raise HTTPException(status_code=404, detail=f"Visual style not found: {style_id}")


def create_visual_style(slug: str, payload: VisualStyleCreate) -> AdaptationStatus:
    root = ensure_adaptation(slug)
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
    return status(slug)


def update_visual_style(slug: str, style_id: str, payload: VisualStylePatch) -> AdaptationStatus:
    root = ensure_adaptation(slug)
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
    return status(slug)


def delete_visual_style(slug: str, style_id: str) -> AdaptationStatus:
    root = ensure_adaptation(slug)
    styles = read_visual_styles(root)
    removed = next((style for style in styles if style.id == style_id), None)
    if removed is None:
        raise HTTPException(status_code=404, detail=f"Visual style not found: {style_id}")
    next_styles = [style for style in styles if style.id != style_id]
    if removed.default and next_styles:
        next_styles = _mark_default_visual_style(next_styles, next_styles[0].id)
    write_visual_styles(root, next_styles)
    return status(slug)


def adaptation_dir(slug: str) -> Path:
    library.require_project(slug)
    return library.project_dir(slug) / "adaptation"


def _has_book_session(root: Path) -> bool:
    manifest = root / "sessions" / "book-session.json"
    if not manifest.is_file():
        return False
    try:
        data = library.read_json(manifest)
    except (json.JSONDecodeError, OSError):
        return False
    session_id = data.get("sessionId")
    session_file = data.get("sessionFile")
    return bool(session_id) and bool(session_file) and Path(str(session_file)).is_file()


def metadata_path(slug: str) -> Path:
    return adaptation_dir(slug) / "adaptation.json"


WORKFLOW_STAGES = ("ingest", "characters", "scene-list", "scenes", "locations", "moments", "all")
RUN_WORKFLOW_STAGES = ("ingest", "characters", "scene-list", "all")
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


def artifact_link_groups(metadata: AdaptationMetadata) -> tuple[dict[str, AdaptationAssetLink], ...]:
    return (metadata.characters, metadata.locations, metadata.scenes, metadata.pages, metadata.panels)


def clear_stale_artifact_assets(slug: str, metadata: AdaptationMetadata) -> tuple[AdaptationMetadata, bool]:
    changed = False
    for group in artifact_link_groups(metadata):
        for key, link in list(group.items()):
            asset_ids = [asset_id for asset_id in link.assetIds if asset_exists(slug, asset_id)]
            active_asset_id = link.activeAssetId if link.activeAssetId in asset_ids else (asset_ids[-1] if asset_ids else None)
            next_status = "generated" if asset_ids else ("ready" if link.prompt else "missing")
            if asset_ids != link.assetIds or active_asset_id != link.activeAssetId or next_status != link.status:
                group[key] = link.model_copy(
                    update={
                        "assetIds": asset_ids,
                        "activeAssetId": active_asset_id,
                        "status": next_status,
                    }
                )
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


def require_run_stage(stage: str) -> str:
    if stage not in RUN_WORKFLOW_STAGES:
        raise HTTPException(status_code=400, detail=f"Unknown workflow stage: {stage}")
    return stage


def workflow_status_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{stage}-status.json"


def workflow_log_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{stage}.log"


def workflow_launcher_log_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{stage}-launcher.log"


def workflow_manifest_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{stage}-manifest.json"


def validation_status_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"validate-{stage}-status.json"


def validation_log_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"validate-{stage}.log"


def validation_launcher_log_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"validate-{stage}-launcher.log"


def workflow_python() -> str:
    venv_python = library.REPO_ROOT / ".venv" / "bin" / "python"
    if venv_python.is_file():
        return venv_python.as_posix()
    return "python3"


def workflow_log_files(slug: str, stage: str, *, validation: bool = False) -> dict[str, str]:
    root = adaptation_dir(slug)
    prefix = "validate" if validation else "run"
    sessions = root / "sessions"
    files = {
        "log": (sessions / f"{prefix}-{stage}.log").relative_to(root).as_posix(),
        "events": (sessions / f"{prefix}-{stage}.events.jsonl").relative_to(root).as_posix(),
        "summary": (sessions / f"{prefix}-{stage}.summary.json").relative_to(root).as_posix(),
        "manifest": (sessions / f"{prefix}-{stage}-manifest.json").relative_to(root).as_posix(),
        "launcher": (sessions / f"{prefix}-{stage}-launcher.log").relative_to(root).as_posix(),
        "tasksDir": (sessions / "tasks").relative_to(root).as_posix(),
    }
    manifest_path = sessions / f"{prefix}-{stage}-manifest.json"
    if manifest_path.is_file():
        try:
            manifest = library.read_json(manifest_path)
            for key in ("log", "events", "summary", "tasksDir"):
                if key in manifest:
                    files[key] = str(manifest[key])
        except (json.JSONDecodeError, OSError):
            pass
    return files


def ensure_adaptation(slug: str) -> Path:
    root = adaptation_dir(slug)
    for path in [
        root / "sessions",
        root / "style-refs",
        root / "characters" / "artifacts",
        root / "characters" / "sheets",
        root / "acts",
        root / "scenes",
        root / "scenes" / "artifacts",
        root / "locations",
        root / "locations" / "staging",
        root / "pages" / "plans",
        root / "panels" / "prompts",
        root / "locations" / "prompts",
    ]:
        path.mkdir(parents=True, exist_ok=True)
    styles_path = visual_styles_path(root)
    if not styles_path.is_file():
        write_visual_styles(root, [])
    if not metadata_path(slug).exists():
        write_metadata(slug, AdaptationMetadata())
    return root


def process_status(slug: str, status_path: Path, log_path: Path, *, validation: bool = False) -> AdaptationWorkflowStatus:
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
    stage_name = log_path.name
    if stage_name.startswith("validate-"):
        stage_name = stage_name.removeprefix("validate-").removesuffix(".log")
    else:
        stage_name = stage_name.removeprefix("run-").removesuffix(".log")
    return AdaptationWorkflowStatus(
        running=running,
        returnCode=data.get("returnCode"),
        startedAt=data.get("startedAt"),
        completedAt=data.get("completedAt"),
        log=log,
        logFiles=workflow_log_files(slug, stage_name, validation=validation),
    )


def workflow_status(slug: str, stage: str = "all") -> AdaptationWorkflowStatus:
    require_stage(stage)
    return process_status(slug, workflow_status_path(slug, stage), workflow_log_path(slug, stage), validation=False)


def validation_status(slug: str, stage: str = "all") -> AdaptationWorkflowStatus:
    require_stage(stage)
    return process_status(slug, validation_status_path(slug, stage), validation_log_path(slug, stage), validation=True)


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
    launcher_log_path: Path,
    status_path: Path,
    start_line: str,
    script_command: str,
    validation: bool = False,
) -> AdaptationWorkflowStatus:
    root = ensure_adaptation(slug)
    current = process_status(slug, status_path, log_path, validation=validation)
    if current.running:
        raise HTTPException(status_code=409, detail="Process is already running")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    launcher_file = launcher_log_path.open("w")
    launcher_file.write(f"[{utc_now()}] {start_line}\n")
    launcher_file.flush()
    python_bin = workflow_python()
    launcher_file.write(f"[{utc_now()}] python: {python_bin}\n")
    launcher_file.flush()
    command = [
        "bash",
        "-lc",
        (
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
    from adaptation_workflow.config import pi_runtime_env

    env = pi_runtime_env(env)
    env["SLUG"] = slug
    env["STATUS_PATH"] = str(status_path)
    process = subprocess.Popen(
        command,
        cwd=library.REPO_ROOT,
        stdout=launcher_file,
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
    launcher_file.close()
    return process_status(slug, status_path, log_path, validation=validation)


def start_workflow(slug: str, stage: str = "all") -> AdaptationWorkflowStatus:
    root = ensure_adaptation(slug)
    require_run_stage(stage)
    if not (root / "book.txt").is_file():
        raise HTTPException(status_code=400, detail="Upload book.txt before running adaptation")
    # stage is validated against WORKFLOW_STAGES above, so it is safe to interpolate.
    return start_logged_process(
        slug,
        log_path=workflow_log_path(slug, stage),
        launcher_log_path=workflow_launcher_log_path(slug, stage),
        status_path=workflow_status_path(slug, stage),
        start_line=f"Starting adaptation workflow ({stage}) for {slug}",
        script_command=f"cd api && {workflow_python()} -m adaptation_workflow run \"$SLUG\" \"{stage}\"",
        validation=False,
    )


def start_validation(slug: str, stage: str = "all") -> AdaptationWorkflowStatus:
    ensure_adaptation(slug)
    require_stage(stage)
    return start_logged_process(
        slug,
        log_path=validation_log_path(slug, stage),
        launcher_log_path=validation_launcher_log_path(slug, stage),
        status_path=validation_status_path(slug, stage),
        start_line=f"Starting adaptation validation ({stage}) for {slug}",
        script_command=f"cd api && {workflow_python()} -m adaptation_workflow validate \"$SLUG\" \"{stage}\"",
        validation=True,
    )


def sync_style_ref_to_canvas(slug: str, kind: str) -> AdaptationCanvasImportResponse:
    ref_kind = require_style_ref_kind(kind)
    before = library.read_stored_canvas(slug)
    after = library.sync_style_ref_canvas_nodes(slug, before, ref_kind)
    saved = library.write_canvas(slug, after)
    return AdaptationCanvasImportResponse(canvas=saved, importedNodeCount=0)


def import_drafts_to_canvas(slug: str) -> AdaptationCanvasImportResponse:
    metadata = sync_prompt_links(slug, read_metadata(slug))
    library.sync_entity_tags(
        slug,
        character_keys=list(metadata.characters.keys()),
        location_keys=list(metadata.locations.keys()),
    )
    before = library.read_stored_canvas(slug)
    after = library.default_canvas_for_story_artifacts(slug, before)
    imported_count = max(0, len(after.nodes) - len(before.nodes))
    saved = library.write_canvas(slug, after)
    return AdaptationCanvasImportResponse(canvas=saved, importedNodeCount=imported_count)


def import_artifact_to_canvas(slug: str, artifact_kind: str, artifact_key: str) -> AdaptationCanvasImportResponse:
    metadata = sync_prompt_links(slug, read_metadata(slug))
    library.sync_entity_tags(
        slug,
        character_keys=list(metadata.characters.keys()),
        location_keys=list(metadata.locations.keys()),
    )
    if artifact_kind == "character-sheet":
        entries = metadata.characters
    elif artifact_kind == "location-prompt":
        entries = metadata.locations
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported artifact kind for draft import: {artifact_kind}")
    entry = entries.get(artifact_key)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Unknown adaptation artifact: {artifact_kind}:{artifact_key}")
    before = library.read_stored_canvas(slug)
    after, created, _node_id = library.sync_single_story_artifact_node(
        before,
        artifact_kind=artifact_kind,
        artifact_key=artifact_key,
        entry=entry,
        entries=entries,
    )
    saved = library.write_canvas(slug, after)
    return AdaptationCanvasImportResponse(canvas=saved, importedNodeCount=1 if created else 0)


def migrate_legacy_canonical(slug: str, metadata: AdaptationMetadata) -> AdaptationMetadata:
    path = metadata_path(slug)
    if not path.is_file():
        return metadata
    raw = library.read_json(path)
    if not isinstance(raw, dict):
        return metadata
    changed = False
    entity_groups: tuple[tuple[str, dict[str, AdaptationAssetLink]], ...] = (
        ("characters", metadata.characters),
        ("locations", metadata.locations),
    )
    for group_name, links in entity_groups:
        raw_group = raw.get(group_name, {})
        if not isinstance(raw_group, dict):
            continue
        for key, link_raw in raw_group.items():
            if not isinstance(link_raw, dict):
                continue
            canonical = link_raw.pop("canonicalAssetId", None)
            if not canonical:
                continue
            changed = True
            link = links.get(key)
            if link is None:
                continue
            asset_ids = list(link.assetIds)
            if asset_exists(slug, canonical) and canonical not in asset_ids:
                asset_ids.append(canonical)
            links[key] = link.model_copy(
                update={
                    "assetIds": asset_ids,
                    "status": "generated" if asset_ids else link.status,
                }
            )
            if asset_exists(slug, canonical):
                library.apply_entity_tag_to_asset(slug, canonical, key)
    for group_name in ("characters", "locations", "scenes", "pages", "panels"):
        raw_group = raw.get(group_name, {})
        if not isinstance(raw_group, dict):
            continue
        for link_raw in raw_group.values():
            if isinstance(link_raw, dict):
                link_raw.pop("canonicalAssetId", None)
    if changed:
        library.write_json(path, raw)
        metadata = AdaptationMetadata.model_validate(raw)
    return metadata


def read_metadata(slug: str) -> AdaptationMetadata:
    ensure_adaptation(slug)
    metadata = AdaptationMetadata.model_validate(library.read_json(metadata_path(slug)))
    return migrate_legacy_canonical(slug, metadata)


def write_metadata(slug: str, metadata: AdaptationMetadata) -> AdaptationMetadata:
    library.write_json(metadata_path(slug), metadata.model_dump(mode="json"))
    library.sync_entity_tags(
        slug,
        character_keys=list(metadata.characters.keys()),
        location_keys=list(metadata.locations.keys()),
    )
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


def scene_list_path(slug: str) -> Path:
    return ensure_adaptation(slug) / "scenes" / "list.txt"


def scene_list_document(slug: str) -> SceneListDocument:
    from adaptation_workflow.scene_list import parse_scene_list

    entries = parse_scene_list(scene_list_path(slug))
    return SceneListDocument(lines=[SceneListLine(slug=entry.slug, description=entry.description) for entry in entries])


def replace_scene_list(slug: str, payload: SceneListReplace) -> SceneListDocument:
    from adaptation_workflow.scene_list import SceneListEntry, write_scene_list

    write_scene_list(
        scene_list_path(slug),
        [SceneListEntry(slug=line.slug, description=line.description, line_no=index) for index, line in enumerate(payload.lines, start=1)],
    )
    return scene_list_document(slug)


def add_scene_list_line(slug: str, payload: SceneListLineCreate) -> SceneListDocument:
    from adaptation_workflow.scene_list import SceneListEntry, parse_scene_list, write_scene_list

    path = scene_list_path(slug)
    entries = parse_scene_list(path)
    if any(entry.slug == payload.slug for entry in entries):
        raise HTTPException(status_code=409, detail=f"Scene already in list: {payload.slug}")
    entries.append(SceneListEntry(slug=payload.slug, description=payload.description, line_no=len(entries) + 1))
    write_scene_list(path, entries)
    return scene_list_document(slug)


def delete_scene_list_line(slug: str, key: str) -> SceneListDocument:
    from adaptation_workflow.scene_list import parse_scene_list, write_scene_list

    path = scene_list_path(slug)
    entries = parse_scene_list(path)
    target = key.strip().lower()
    if not any(entry.slug == target for entry in entries):
        raise HTTPException(status_code=404, detail=f"Scene not in list: {key}")
    artifact = ensure_adaptation(slug) / "scenes" / "artifacts" / f"{target}.md"
    if artifact.is_file():
        raise HTTPException(status_code=409, detail=f"Remove or keep scene artifact before deleting list entry: {key}")
    write_scene_list(path, [entry for entry in entries if entry.slug != target])
    return scene_list_document(slug)


def scene_extract_stage_name(scene_slug: str) -> str:
    from adaptation_workflow.runner import scene_extract_stage

    return scene_extract_stage(scene_slug)


def scene_extract_status_path(slug: str, scene_slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{scene_extract_stage_name(scene_slug)}-status.json"


def scene_extract_log_path(slug: str, scene_slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{scene_extract_stage_name(scene_slug)}.log"


def scene_extract_launcher_log_path(slug: str, scene_slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{scene_extract_stage_name(scene_slug)}-launcher.log"


def _require_character_registry(slug: str) -> None:
    from adaptation_workflow.entity_registry import (
        CharacterRegistryNotReadyError,
        assert_character_registry_ready,
        read_metadata_entity_keys,
    )

    root = ensure_adaptation(slug)
    metadata_characters, _metadata_locations = read_metadata_entity_keys(root)
    try:
        assert_character_registry_ready(root, metadata_characters)
    except CharacterRegistryNotReadyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def start_scene_extract(slug: str, scene_slug: str, *, force: bool = False) -> AdaptationWorkflowStatus:
    root = ensure_adaptation(slug)
    if not (root / "book.txt").is_file():
        raise HTTPException(status_code=400, detail="Upload book.txt before extracting scenes")
    from adaptation_workflow.scene_list import find_scene_list_line

    if find_scene_list_line(scene_list_path(slug), scene_slug) is None:
        raise HTTPException(status_code=404, detail=f"Scene not in list: {scene_slug}")
    _require_character_registry(slug)
    force_flag = " --force" if force else ""
    return start_logged_process(
        slug,
        log_path=scene_extract_log_path(slug, scene_slug),
        launcher_log_path=scene_extract_launcher_log_path(slug, scene_slug),
        status_path=scene_extract_status_path(slug, scene_slug),
        start_line=f"Starting scene extract for {scene_slug} in {slug}",
        script_command=(
            f'cd api && {workflow_python()} -m adaptation_workflow extract-scene "$SLUG" "{scene_slug}"{force_flag}'
        ),
        validation=False,
    )


def scene_extract_status(slug: str, scene_slug: str) -> AdaptationWorkflowStatus:
    return process_status(
        slug,
        scene_extract_status_path(slug, scene_slug),
        scene_extract_log_path(slug, scene_slug),
        validation=False,
    )


def scene_plan_stage_name(scene_slug: str) -> str:
    from adaptation_workflow.runner import scene_plan_stage

    return scene_plan_stage(scene_slug)


def scene_plan_status_path(slug: str, scene_slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{scene_plan_stage_name(scene_slug)}-status.json"


def scene_plan_log_path(slug: str, scene_slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{scene_plan_stage_name(scene_slug)}.log"


def scene_plan_launcher_log_path(slug: str, scene_slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{scene_plan_stage_name(scene_slug)}-launcher.log"


def _require_scene_list_line(slug: str, scene_slug: str) -> str:
    from adaptation_workflow.scene_list import find_scene_list_line

    scene_line = find_scene_list_line(scene_list_path(slug), scene_slug)
    if scene_line is None:
        raise HTTPException(status_code=404, detail=f"Scene not in list: {scene_slug}")
    return scene_line


def _require_scene_artifact(slug: str, scene_slug: str) -> Path:
    artifact = ensure_adaptation(slug) / "scenes" / "artifacts" / f"{scene_slug}.md"
    if not artifact.is_file():
        raise HTTPException(status_code=409, detail=f"Extract scene before planning moments: {scene_slug}")
    return artifact


def _layout_section_model(
    slug: str,
    key: str,
    section: dict[str, str],
    metadata: AdaptationMetadata,
) -> MomentLayoutSection:
    from moment_refs import moment_ref_inputs

    refs = section.get("style_ref", "")
    ref_inputs, count, limit, limit_exceeded, can_generate = moment_ref_inputs(slug, metadata, refs)
    return MomentLayoutSection(
        key=key,
        refs=refs,
        narration=section.get("narration", ""),
        dialogue=section.get("dialogue", ""),
        caption=section.get("caption", ""),
        prompt=section.get("prompt", ""),
        refInputs=ref_inputs,
        canGenerate=can_generate,
        referenceImageCount=count,
        referenceImageLimit=limit,
        referenceLimitExceeded=limit_exceeded,
    )


def scene_moments_document(slug: str, scene_slug: str) -> SceneMomentsDocument:
    from adaptation_workflow.moments import moment_output_path, moment_section_count, ordered_layout_sections, read_story_kind

    target = scene_slug.strip().lower()
    _require_scene_list_line(slug, target)
    root = ensure_adaptation(slug)
    story_kind = read_story_kind(root)
    moment_path = moment_output_path(root, story_kind, target)
    body = read_text(moment_path)
    metadata = read_metadata(slug)
    sections = [
        _layout_section_model(slug, key, section, metadata)
        for key, section in ordered_layout_sections(moment_path)
    ]
    return SceneMomentsDocument(
        sceneSlug=target,
        path=relpath(root, moment_path),
        body=body,
        sections=sections,
        sectionCount=moment_section_count(moment_path),
        storyKind=story_kind,  # type: ignore[arg-type]
        exists=moment_path.is_file(),
    )


def put_scene_moments(slug: str, scene_slug: str, payload: SceneMomentsUpdate) -> SceneMomentsDocument:
    from adaptation_workflow.moments import layout_section_dict, moment_output_path, read_story_kind, write_ordered_layout_sections
    from adaptation_workflow.validate import ValidationError, validate_moment_file

    has_body = payload.body is not None
    has_sections = payload.sections is not None
    if has_body == has_sections:
        raise HTTPException(status_code=400, detail="Provide exactly one of body or sections")

    target = scene_slug.strip().lower()
    _require_scene_list_line(slug, target)
    _require_scene_artifact(slug, target)
    root = ensure_adaptation(slug)
    story_kind = read_story_kind(root)
    moment_path = moment_output_path(root, story_kind, target)
    moment_path.parent.mkdir(parents=True, exist_ok=True)

    if has_sections:
        assert payload.sections is not None
        keys = [section.key for section in payload.sections]
        if len(keys) != len(set(keys)):
            raise HTTPException(status_code=400, detail="Duplicate section keys in payload")
        items = [
            (
                section.key,
                layout_section_dict(
                    refs=section.refs,
                    narration=section.narration,
                    dialogue=section.dialogue,
                    caption=section.caption,
                    prompt=section.prompt,
                ),
            )
            for section in payload.sections
        ]
        write_ordered_layout_sections(moment_path, items)
    else:
        body = payload.body or ""
        moment_path.write_text(body.rstrip() + ("\n" if body.strip() else ""))

    if moment_path.is_file() and moment_path.stat().st_size > 0:
        try:
            validate_moment_file(moment_path)
        except ValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    sync_prompt_links(slug, read_metadata(slug))
    return scene_moments_document(slug, target)


def start_scene_plan(slug: str, scene_slug: str) -> AdaptationWorkflowStatus:
    target = scene_slug.strip().lower()
    root = ensure_adaptation(slug)
    if not (root / "book.txt").is_file():
        raise HTTPException(status_code=400, detail="Upload book.txt before planning moments")
    _require_scene_list_line(slug, target)
    _require_scene_artifact(slug, target)
    _require_character_registry(slug)
    return start_logged_process(
        slug,
        log_path=scene_plan_log_path(slug, target),
        launcher_log_path=scene_plan_launcher_log_path(slug, target),
        status_path=scene_plan_status_path(slug, target),
        start_line=f"Starting scene plan for {target} in {slug}",
        script_command=f'cd api && {workflow_python()} -m adaptation_workflow plan-scene "$SLUG" "{target}"',
        validation=False,
    )


def scene_plan_status(slug: str, scene_slug: str) -> AdaptationWorkflowStatus:
    target = scene_slug.strip().lower()
    return process_status(
        slug,
        scene_plan_status_path(slug, target),
        scene_plan_log_path(slug, target),
        validation=False,
    )


def _find_moment_link(metadata: AdaptationMetadata, moment_key: str) -> tuple[ArtifactKind, AdaptationAssetLink] | None:
    if moment_key in metadata.pages:
        return "page-plan", metadata.pages[moment_key]
    if moment_key in metadata.panels:
        return "panel-prompt", metadata.panels[moment_key]
    return None


def _moment_link_to_entry(
    slug: str,
    scene_slug: str,
    moment_key: str,
    artifact_kind: ArtifactKind,
    link: AdaptationAssetLink,
    metadata: AdaptationMetadata,
    *,
    model: str | None = None,
) -> MomentSequenceEntry:
    from moment_refs import moment_ref_inputs

    illustrated = bool(link.activeAssetId or link.assetIds)
    status_value: Literal["missing", "ready", "generated"] = "generated" if illustrated else "ready"
    ref_inputs, count, limit, limit_exceeded, can_generate = moment_ref_inputs(
        slug, metadata, link.styleRef, model=model
    )
    return MomentSequenceEntry(
        momentKey=moment_key,
        sceneSlug=scene_slug,
        artifactKind=artifact_kind,
        promptPath=link.promptPath,
        prompt=link.prompt,
        narration=link.narration,
        dialogue=link.dialogue,
        caption=link.caption,
        refs=link.styleRef,
        assetIds=list(link.assetIds),
        activeAssetId=link.activeAssetId,
        finalized=link.finalized,
        status=status_value,
        refInputs=ref_inputs,
        canGenerate=can_generate,
        referenceImageCount=count,
        referenceImageLimit=limit,
        referenceLimitExceeded=limit_exceeded,
    )


def _moment_progress_counts(metadata: AdaptationMetadata) -> MomentSequenceCounts:
    total = 0
    illustrated = 0
    finalized = 0
    for group in (metadata.pages, metadata.panels):
        for link in group.values():
            total += 1
            if link.activeAssetId or link.assetIds:
                illustrated += 1
            if link.finalized:
                finalized += 1
    return MomentSequenceCounts(total=total, illustrated=illustrated, finalized=finalized)


def moment_sequence_document(slug: str) -> MomentSequenceDocument:
    from adaptation_workflow.moments import ordered_moment_sequence

    root = ensure_adaptation(slug)
    metadata = sync_prompt_links(slug, read_metadata(slug))
    moments: list[MomentSequenceEntry] = []
    for item in ordered_moment_sequence(root):
        found = _find_moment_link(metadata, item.moment_key)
        if found is None:
            continue
        artifact_kind, link = found
        moments.append(
            _moment_link_to_entry(slug, item.scene_slug, item.moment_key, artifact_kind, link, metadata)
        )
    return MomentSequenceDocument(moments=moments, counts=_moment_progress_counts(metadata))


def patch_moment(slug: str, moment_key: str, payload: MomentPatch) -> MomentSequenceEntry:
    from adaptation_workflow.moments import ordered_moment_sequence, update_layout_section

    target = moment_key.strip()
    metadata = read_metadata(slug)
    found = _find_moment_link(metadata, target)
    if found is None:
        raise HTTPException(status_code=404, detail=f"Moment not found: {target}")
    artifact_kind, link = found
    root = ensure_adaptation(slug)
    moment_path = root / link.promptPath
    scene_slug = next((item.scene_slug for item in ordered_moment_sequence(root) if item.moment_key == target), "")

    file_updates: dict[str, str] = {}
    if payload.narration is not None:
        file_updates["narration"] = payload.narration
    if payload.dialogue is not None:
        file_updates["dialogue"] = payload.dialogue
    if payload.caption is not None:
        file_updates["caption"] = payload.caption
    if file_updates:
        if not moment_path.is_file():
            raise HTTPException(status_code=404, detail=f"Moment file missing: {link.promptPath}")
        update_layout_section(moment_path, target, file_updates)

    meta_updates: dict[str, object] = {}
    if payload.activeAssetId is not None:
        if payload.activeAssetId and payload.activeAssetId not in link.assetIds:
            raise HTTPException(status_code=400, detail=f"Asset not attached to moment: {payload.activeAssetId}")
        meta_updates["activeAssetId"] = payload.activeAssetId
    if payload.finalized is not None:
        meta_updates["finalized"] = payload.finalized
    if meta_updates:
        updated = link.model_copy(update=meta_updates)
        if artifact_kind == "page-plan":
            metadata.pages[target] = updated
        else:
            metadata.panels[target] = updated
        write_metadata(slug, metadata)

    metadata = sync_prompt_links(slug, read_metadata(slug))
    found = _find_moment_link(metadata, target)
    if found is None:
        raise HTTPException(status_code=404, detail=f"Moment not found after update: {target}")
    artifact_kind, link = found
    if not scene_slug:
        scene_slug = next((item.scene_slug for item in ordered_moment_sequence(root) if item.moment_key == target), "")
    return _moment_link_to_entry(slug, scene_slug, target, artifact_kind, link, metadata)


def parse_layout_sections(path: Path) -> dict[str, dict[str, str]]:
    from adaptation_workflow.moments import parse_layout_sections as workflow_parse_layout_sections

    return workflow_parse_layout_sections(path)


def prompt_link(
    *,
    artifact_kind: ArtifactKind,
    prompt_path: str,
    section: dict[str, str],
    existing: AdaptationAssetLink | None,
) -> AdaptationAssetLink:
    asset_ids = list(existing.assetIds) if existing else []
    active_asset_id = existing.activeAssetId if existing else None
    if active_asset_id and active_asset_id not in asset_ids:
        active_asset_id = asset_ids[-1] if asset_ids else None
    elif not active_asset_id and asset_ids:
        active_asset_id = asset_ids[-1]
    return AdaptationAssetLink(
        artifactKind=artifact_kind,
        promptPath=prompt_path,
        mode=section.get("mode", ""),
        styleRef=section.get("style_ref", ""),
        prompt=section.get("prompt", ""),
        narration=section.get("narration", ""),
        dialogue=section.get("dialogue", ""),
        caption=section.get("caption", ""),
        assetIds=asset_ids,
        activeAssetId=active_asset_id,
        finalized=existing.finalized if existing else False,
        status="generated" if asset_ids else "ready",
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
    old_pages = metadata.pages
    new_pages: dict[str, AdaptationAssetLink] = {}
    for plan_file in sorted((root / "pages" / "plans").glob("*.md")):
        prompt_path = relpath(root, plan_file)
        for key, section in parse_layout_sections(plan_file).items():
            existing = old_pages.get(key)
            new_pages[key] = prompt_link(
                artifact_kind="page-plan",
                prompt_path=prompt_path,
                section=section,
                existing=existing,
            )
    metadata.pages = new_pages
    old_panels = metadata.panels
    new_panels: dict[str, AdaptationAssetLink] = {}
    for prompt_file in sorted((root / "panels" / "prompts").glob("*.md")):
        prompt_path = relpath(root, prompt_file)
        for key, section in parse_layout_sections(prompt_file).items():
            existing = old_panels.get(key)
            new_panels[key] = prompt_link(
                artifact_kind="panel-prompt",
                prompt_path=prompt_path,
                section=section,
                existing=existing,
            )
    metadata.panels = new_panels
    return write_metadata(slug, metadata)


def status(slug: str) -> AdaptationStatus:
    root = ensure_adaptation(slug)
    metadata = sync_prompt_links(slug, read_metadata(slug))
    metadata, changed = clear_stale_style_ref_assets(slug, metadata)
    metadata, artifact_changed = clear_stale_artifact_assets(slug, metadata)
    if changed or artifact_changed:
        metadata = write_metadata(slug, metadata)
    statuses = style_ref_statuses(slug, metadata)
    moment_counts = _moment_progress_counts(metadata)
    return AdaptationStatus(
        projectSlug=slug,
        settings=metadata.settings,
        hasBook=(root / "book.txt").is_file(),
        hasBookSession=_has_book_session(root),
        styleRefs={
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
            "sceneListLines": count_nonempty_lines(root / "scenes" / "list.txt"),
            "sceneArtifacts": len(list((root / "scenes" / "artifacts").glob("*.md"))),
            "locationPrompts": len(list((root / "locations" / "prompts").glob("*.md"))),
            "pagePlans": len(list((root / "pages" / "plans").glob("*.md"))),
            "panelPrompts": len(list((root / "panels" / "prompts").glob("*.md"))),
            "momentSections": _count_moment_sections(root),
            "illustratedMoments": moment_counts.illustrated,
            "finalizedMoments": moment_counts.finalized,
        },
        visualStyles=(styles := read_visual_styles(root)),
        defaultVisualStyleId=resolve_default_visual_style_id(styles),
        characters=metadata.characters,
        locations=metadata.locations,
        scenes=metadata.scenes,
        pages=metadata.pages,
        panels=metadata.panels,
    )


def count_nonempty_lines(path: Path) -> int:
    return sum(1 for line in read_text(path).splitlines() if line.strip())


def _count_moment_sections(root: Path) -> int:
    from adaptation_workflow.moments import moment_section_count

    total = 0
    for directory in (root / "pages" / "plans", root / "panels" / "prompts"):
        if not directory.is_dir():
            continue
        for moment_file in directory.glob("*.md"):
            total += moment_section_count(moment_file)
    return total


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
    canvas = library.sync_style_ref_canvas_nodes(slug, library.read_stored_canvas(slug), kind)
    library.write_canvas(slug, canvas)
    if not request.visualStyleId:
        raise HTTPException(status_code=400, detail="visualStyleId is required to generate a style reference")
    draft_node = canvas.nodes.get(source_node_id)
    draft_params = draft_node.params if isinstance(draft_node, DraftCanvasNode) else None
    prompt_path = style_ref_prompt_path(root, kind)
    prompt_text = read_text(prompt_path).strip()
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
            if link is None or not link.assetIds:
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


def parse_semantic_ref(ref: str) -> tuple[str, str] | None:
    if ":" not in ref:
        return None
    kind, key = ref.split(":", 1)
    return kind.strip(), key.strip()


def entity_kind_for_semantic_ref(kind: str) -> str | None:
    if kind in {"character", "character-sheet"}:
        return "characters"
    if kind in {"location", "location-prompt"}:
        return "locations"
    if kind in {"scene", "scene-artifact"}:
        return "scenes"
    if kind in {"page", "page-plan"}:
        return "pages"
    if kind in {"panel", "panel-prompt"}:
        return "panels"
    return None


def link_for_semantic_ref(metadata: AdaptationMetadata, ref: str) -> AdaptationAssetLink | None:
    parsed = parse_semantic_ref(ref)
    if parsed is None:
        return None
    kind, key = parsed
    group_name = entity_kind_for_semantic_ref(kind)
    if group_name is None:
        return None
    group = getattr(metadata, group_name)
    return group.get(key)


def resolve_entity_assets(slug: str, metadata: AdaptationMetadata, ref: str) -> list[str]:
    link = link_for_semantic_ref(metadata, ref)
    if link is None:
        return []
    return [asset_id for asset_id in link.assetIds if asset_exists(slug, asset_id)]


def artifact_ref_asset_ids(
    slug: str,
    metadata: AdaptationMetadata,
    artifact_kind: ArtifactKind,
    link: AdaptationAssetLink,
    *,
    model: str | None = None,
) -> list[str]:
    if artifact_kind == "scene-artifact":
        return []
    if artifact_kind in {"page-plan", "panel-prompt"}:
        import gemini
        from moment_refs import assert_moment_refs_ready

        resolved_model = model or gemini.default_model()
        return assert_moment_refs_ready(slug, metadata, link.styleRef, model=resolved_model)
    if link.mode == "new-image":
        ref_asset_id = style_ref_asset_id(metadata, artifact_kind)
        if ref_asset_id is None:
            raise HTTPException(status_code=400, detail=missing_style_ref_detail(artifact_kind))
        return [ref_asset_id]
    if link.mode == "edit-reference":
        entries = artifact_entries(metadata, artifact_kind)
        base_key = style_ref_artifact_key(link.styleRef)
        base = entries.get(base_key)
        if base is None:
            raise HTTPException(status_code=400, detail=f"Referenced base artifact not found: {base_key}")
        asset_ids = list(base.assetIds)
        if not asset_ids:
            raise HTTPException(status_code=400, detail=f"Generate base artifact before variant: {base_key}")
        return asset_ids
    raise HTTPException(status_code=400, detail=f"Unsupported artifact generation mode: {link.mode or 'missing'}")


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
    canvas = library.read_stored_canvas(slug)
    canvas_node_id = request.canvasNodeId
    if canvas_node_id is None:
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
    artifact_node = canvas.nodes.get(canvas_node_id) if canvas_node_id else None
    artifact_params = artifact_node.params if isinstance(artifact_node, StoryArtifactCanvasNode) else None
    resolved_model = request.model or (artifact_params.model if artifact_params else None) or gemini.default_model()
    ref_asset_ids = artifact_ref_asset_ids(
        slug, metadata, request.artifactKind, link, model=resolved_model
    )
    prompt = f"{link.prompt.strip()}\n"
    visual_style_id = request.visualStyleId or (
        artifact_node.visualStyleId if isinstance(artifact_node, StoryArtifactCanvasNode) else None
    )
    if not visual_style_id:
        raise HTTPException(status_code=400, detail="visualStyleId is required to generate a story artifact image")
    entity_tags = (
        [request.artifactKey]
        if request.artifactKind in {"character-sheet", "location-prompt"}
        else []
    )
    payload = GenerateRequest(
        prompt=prompt,
        refs=ref_asset_ids,
        model=request.model or (artifact_params.model if artifact_params else None),
        aspectRatio=request.aspectRatio or (artifact_params.aspectRatio if artifact_params else None) or "16:9",
        imageSize=request.imageSize or (artifact_params.imageSize if artifact_params else None) or "1K",
        seed=request.seed if request.seed is not None else (artifact_params.seed if artifact_params else None),
        batchCount=request.batchCount,
        title=f"{link.artifactKind.replace('-', ' ').title()}: {request.artifactKey}",
        tags=list(dict.fromkeys(["comic-adaptation", link.artifactKind, *entity_tags])),
        canvasNodeId=canvas_node_id,
        visualStyleId=visual_style_id,
    )
    response = library.create_generated_assets(slug, payload, gemini.generate_image)
    asset = response.assets[0]
    if entity_tags:
        library.apply_entity_tag_to_asset(slug, asset.id, request.artifactKey)
    next_asset_ids = list(dict.fromkeys([*link.assetIds, asset.id]))
    entries[request.artifactKey] = link.model_copy(
        update={
            "assetIds": next_asset_ids,
            "activeAssetId": asset.id,
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
