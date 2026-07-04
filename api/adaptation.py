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
    ImageGroupNodeCreate,
    ImageGroupNodeResponse,
    AdaptationImportArtifactRequest,
    AdaptationFileCreate,
    AdaptationFileDocument,
    AdaptationFileKind,
    AdaptationFileUpdate,
    DisplayPatch,
    AdaptationGenerateStyleRefRequest,
    AdaptationAssetLink,
    AdaptationGenerateResponse,
    CharacterRecord,
    AdaptationMetadata,
    AdaptationStatus,
    AdaptationStylePromptPatch,
    AdaptationStyleRefAssetRequest,
    AdaptationWorkflowStatus,
    ArtifactKind,
    AssetSummary,
    DraftCanvasNode,
    GenerateRequest,
    ImageGroupCanvasNode,
    StyleRefKind,
    StyleRefStatus,
    VisualStyleCreate,
    VisualStyleDefinition,
    VisualStylePatch,
    utc_now,
)


STYLE_TEMPLATE = "Style:\nColor palette:\nRealism:\nLighting:\n"

DEFAULT_VISUAL_STYLE_PROMPT = (
    "Style: Textured, hand-drawn crayon illustration featuring bold, expressive, and coarse strokes "
    'that create a deliberate "rough" or unpolished sketchbook aesthetic.\n'
    "Color palette: Highly saturated, vibrant primary and secondary colors with heavy layering of pigments.\n"
    "Realism: Stylized/Non-realistic; uses simplified shapes, exaggerated character features, and prominent medium texture over anatomical precision.\n"
    "Lighting: Flat to moderate, achieved through coarse cross-hatching and visible colored strokes rather than smooth gradients.\n"
)


def default_visual_styles() -> list[VisualStyleDefinition]:
    return [
        VisualStyleDefinition(
            id="crayons",
            name="crayons",
            prompt=DEFAULT_VISUAL_STYLE_PROMPT,
            default=True,
        )
    ]


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


def _clear_stale_link_group(slug: str, group: dict[str, AdaptationAssetLink]) -> bool:
    changed = False
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
    return changed


def artifact_link_groups(metadata: AdaptationMetadata) -> tuple[dict[str, AdaptationAssetLink], ...]:
    return (metadata.locations,)


def character_entries_from_records(characters: dict[str, CharacterRecord]) -> dict[str, AdaptationAssetLink]:
    return {key: link for key, (_slug, _variant, link) in character_flat_entries_from_records(characters).items()}


def character_flat_entries_from_records(characters: dict[str, CharacterRecord]) -> dict[str, tuple[str, str, AdaptationAssetLink]]:
    from adaptation_workflow.character_file import variant_entity_key

    entries: dict[str, tuple[str, str, AdaptationAssetLink]] = {}
    for slug, record in characters.items():
        for variant_key, link in record.variants.items():
            entries[variant_entity_key(slug, variant_key)] = (slug, variant_key, link)
    return entries


def character_flat_entries(metadata: AdaptationMetadata) -> dict[str, tuple[str, str, AdaptationAssetLink]]:
    return character_flat_entries_from_records(metadata.characters)


def resolve_character_link(
    metadata: AdaptationMetadata,
    character_slug: str,
    variant_key: str = "base",
) -> AdaptationAssetLink | None:
    record = metadata.characters.get(character_slug)
    if record is None:
        return None
    return record.variants.get(variant_key)


def resolve_character_flat_link(metadata: AdaptationMetadata, flat_key: str) -> tuple[str, str, AdaptationAssetLink] | None:
    from adaptation_workflow.character_file import resolve_character_variant_key

    for slug in metadata.characters:
        resolved = resolve_character_variant_key(slug, flat_key)
        if resolved is None:
            continue
        character_slug, variant_key = resolved
        link = resolve_character_link(metadata, character_slug, variant_key)
        if link is not None:
            return character_slug, variant_key, link
    return None


def update_character_variant_link(
    metadata: AdaptationMetadata,
    character_slug: str,
    variant_key: str,
    link: AdaptationAssetLink,
) -> None:
    record = metadata.characters.get(character_slug)
    if record is None:
        return
    variants = dict(record.variants)
    variants[variant_key] = link
    metadata.characters[character_slug] = record.model_copy(update={"variants": variants})


def clear_stale_artifact_assets(slug: str, metadata: AdaptationMetadata) -> tuple[AdaptationMetadata, bool]:
    changed = False
    for group in artifact_link_groups(metadata):
        if _clear_stale_link_group(slug, group):
            changed = True
    for character_slug, record in list(metadata.characters.items()):
        variants = dict(record.variants)
        if _clear_stale_link_group(slug, variants):
            metadata.characters[character_slug] = record.model_copy(update={"variants": variants})
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


def workflow_status_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{stage}-status.json"


def workflow_log_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{stage}.log"


def workflow_launcher_log_path(slug: str, stage: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{stage}-launcher.log"


def workflow_python() -> str:
    venv_python = library.REPO_ROOT / ".venv" / "bin" / "python"
    if venv_python.is_file():
        return venv_python.as_posix()
    return "python3"


def workflow_log_files(slug: str, stage: str) -> dict[str, str]:
    root = adaptation_dir(slug)
    prefix = "run"
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
        root / "characters",
        root / "locations",
        root / "locations" / "prompts",
    ]:
        path.mkdir(parents=True, exist_ok=True)
    styles_path = visual_styles_path(root)
    if not styles_path.is_file():
        write_visual_styles(root, default_visual_styles())
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
    stage_name = log_path.name.removeprefix("run-").removesuffix(".log")
    return AdaptationWorkflowStatus(
        running=running,
        returnCode=data.get("returnCode"),
        startedAt=data.get("startedAt"),
        completedAt=data.get("completedAt"),
        log=log,
        logFiles=workflow_log_files(slug, stage_name),
    )


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
    extra_env: dict[str, str] | None = None,
) -> AdaptationWorkflowStatus:
    root = ensure_adaptation(slug)
    current = process_status(slug, status_path, log_path)
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
    if extra_env:
        env.update(extra_env)
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
    return process_status(slug, status_path, log_path)


def import_artifact_to_canvas(slug: str, artifact_kind: str, artifact_key: str) -> AdaptationCanvasImportResponse:
    metadata = sync_prompt_links(slug, read_metadata(slug))
    library.sync_entity_tags(
        slug,
        character_keys=list(metadata.characters.keys()),
        location_keys=list(metadata.locations.keys()),
    )
    from canvas_nodes import spawn_from_character_variant, spawn_from_location

    if artifact_kind == "character-sheet":
        resolved = resolve_character_flat_link(metadata, artifact_key)
        if resolved is None:
            raise HTTPException(status_code=404, detail=f"Unknown adaptation artifact: {artifact_kind}:{artifact_key}")
        character_slug, variant_key, entry = resolved
        if not entry.prompt.strip():
            raise HTTPException(status_code=400, detail=f"Missing prompt for character: {artifact_key}")
        node_id, saved = spawn_from_character_variant(slug, character_slug, variant_key)
    elif artifact_kind == "location-prompt":
        entry = metadata.locations.get(artifact_key)
        if entry is None:
            raise HTTPException(status_code=404, detail=f"Unknown adaptation artifact: {artifact_kind}:{artifact_key}")
        if not entry.prompt.strip():
            raise HTTPException(status_code=400, detail=f"Missing prompt for location: {artifact_key}")
        node_id, saved = spawn_from_location(slug, artifact_key)
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported artifact kind for draft import: {artifact_kind}")
    return AdaptationCanvasImportResponse(canvas=saved, importedNodeCount=1, nodeId=node_id)


def read_metadata(slug: str) -> AdaptationMetadata:
    ensure_adaptation(slug)
    return AdaptationMetadata.model_validate(library.read_json(metadata_path(slug)))


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
    subject = ""
    prompt_lines: list[str] = []
    in_prompt = False
    for raw_line in read_text(path).splitlines():
        if raw_line.startswith("## "):
            if current is not None:
                sections[current] = {
                    "mode": mode,
                    "style_ref": style_ref,
                    "subject": subject,
                    "prompt": "\n".join(prompt_lines).strip(),
                }
            current = slug_from_heading(raw_line)
            mode = ""
            style_ref = ""
            subject = ""
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
        if raw_line.startswith("subject:"):
            subject = raw_line.split(":", 1)[1].strip()
            continue
        if raw_line == "" and not in_prompt:
            in_prompt = True
            continue
        if in_prompt:
            prompt_lines.append(raw_line)
    if current is not None:
        sections[current] = {
            "mode": mode,
            "style_ref": style_ref,
            "subject": subject,
            "prompt": "\n".join(prompt_lines).strip(),
        }
    return sections


def file_kind_config(kind: AdaptationFileKind) -> tuple[ArtifactKind, Path]:
    root = Path()
    configs: dict[AdaptationFileKind, tuple[ArtifactKind, Path]] = {
        "characters": ("character-sheet", root / "characters"),
        "locations": ("location-prompt", root / "locations" / "prompts"),
    }
    return configs[kind]


def adaptation_file_path(slug: str, kind: AdaptationFileKind, key: str) -> Path:
    root = ensure_adaptation(slug)
    _artifact_kind, directory = file_kind_config(kind)
    return root / directory / f"{key}.md"


def format_prompt_file(key: str, body: str, mode: str, style_ref: str, *, subject: str = "") -> str:
    subject_line = f"subject: {subject.strip()}\n" if subject.strip() else ""
    return f"## {key}\n{subject_line}mode: {mode.strip()}\nstyle_ref: {style_ref.strip()}\n\n{body.strip()}\n"


def format_adaptation_file(
    kind: AdaptationFileKind,
    key: str,
    body: str,
    mode: str,
    style_ref: str,
    *,
    subject_kind: str = "",
) -> str:
    if kind == "characters":
        from adaptation_workflow.character_file import format_character_stub

        name = key.replace("-", " ").title()
        summary = body.strip() or "New character."
        return format_character_stub(key, f"{name}: {summary}")
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
        subjectKind=link.subjectKind,
        status=link.status,
    )


def list_adaptation_files(slug: str, kind: AdaptationFileKind) -> list[AdaptationFileDocument]:
    root = ensure_adaptation(slug)
    metadata = sync_prompt_links(slug, read_metadata(slug))
    if kind == "characters":
        return [
            adaptation_file_from_character_record(slug=slug, record=record)
            for _slug, record in sorted(metadata.characters.items())
            if (root / record.promptPath).is_file()
        ]
    groups: dict[AdaptationFileKind, dict[str, AdaptationAssetLink]] = {
        "locations": metadata.locations,
    }
    return [
        adaptation_file_from_link(slug=slug, kind=kind, key=key, link=link)
        for key, link in sorted(groups[kind].items())
        if (root / link.promptPath).is_file()
    ]


def adaptation_file_from_character_record(*, slug: str, record: CharacterRecord) -> AdaptationFileDocument:
    base = record.variants.get("base")
    return AdaptationFileDocument(
        kind="characters",
        key=record.slug,
        promptPath=record.promptPath,
        artifactKind="character-sheet",
        body=record.description,
        mode=base.mode if base else "",
        styleRef=base.styleRef if base else "",
        status=base.status if base else "missing",
    )


def create_adaptation_file(slug: str, kind: AdaptationFileKind, payload: AdaptationFileCreate) -> AdaptationFileDocument:
    path = adaptation_file_path(slug, kind, payload.key)
    if path.exists():
        raise HTTPException(status_code=409, detail=f"{kind} file already exists: {payload.key}")
    path.write_text(
        format_adaptation_file(
            kind,
            payload.key,
            payload.body,
            payload.mode,
            payload.styleRef,
            subject_kind=payload.subjectKind or "",
        )
    )
    metadata = sync_prompt_links(slug, read_metadata(slug))
    write_metadata(slug, metadata)
    files = {item.key: item for item in list_adaptation_files(slug, kind)}
    if payload.key not in files:
        raise HTTPException(status_code=500, detail=f"Failed to register {kind} file: {payload.key}")
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
    subject_kind = ""
    if kind == "characters":
        from adaptation_workflow.character_file import format_character_file, parse_character_file

        parsed = parse_character_file(current_path)
        file_slug = next_key
        if payload.description is not None:
            parsed.description = payload.description
        if payload.variants is not None:
            for variant_key, variant_update in payload.variants.items():
                existing = dict(
                    parsed.variants.get(
                        variant_key,
                        {"mode": "new-image", "style_ref": "", "prompt": ""},
                    )
                )
                if variant_update.prompt is not None:
                    existing["prompt"] = variant_update.prompt
                if variant_update.mode is not None:
                    existing["mode"] = variant_update.mode
                if variant_update.styleRef is not None:
                    existing["style_ref"] = variant_update.styleRef
                parsed.variants[variant_key] = existing
        elif payload.body is not None or payload.mode is not None or payload.styleRef is not None:
            base = dict(parsed.variants.get("base", {"mode": next_mode, "style_ref": next_style_ref, "prompt": ""}))
            if payload.body is not None:
                base["prompt"] = next_body
            if payload.mode is not None:
                base["mode"] = next_mode
            if payload.styleRef is not None:
                base["style_ref"] = next_style_ref
            parsed.variants["base"] = base
        if next_key != key:
            current_path.unlink()
        next_path.write_text(format_character_file(file_slug, parsed.description, parsed.variants))
    else:
        if next_key != key:
            current_path.unlink()
        next_path.write_text(
            format_adaptation_file(
                kind,
                next_key,
                next_body,
                next_mode,
                next_style_ref,
                subject_kind=subject_kind,
            )
        )
    if next_key != key:
        metadata = read_metadata(slug)
        if kind == "characters":
            record = metadata.characters.pop(key, None)
            if record is not None:
                metadata.characters[next_key] = record.model_copy(update={"slug": next_key, "promptPath": relpath(ensure_adaptation(slug), next_path)})
                write_metadata(slug, metadata)
        else:
            groups: dict[AdaptationFileKind, dict[str, AdaptationAssetLink]] = {
                "locations": metadata.locations,
            }
            existing = groups[kind].pop(key, None)
            if existing is not None:
                groups[kind][next_key] = existing
                write_metadata(slug, metadata)
    if payload.userTags is not None and kind in {"characters", "locations"}:
        metadata = sync_prompt_links(slug, read_metadata(slug))
        if kind == "characters":
            record = metadata.characters.get(next_key)
            if record is not None:
                metadata.characters[next_key] = record.model_copy(update={"userTags": list(payload.userTags)})
                write_metadata(slug, metadata)
        else:
            link = metadata.locations.get(next_key)
            if link is not None:
                metadata.locations[next_key] = link.model_copy(update={"userTags": list(payload.userTags)})
                write_metadata(slug, metadata)
    files = {item.key: item for item in list_adaptation_files(slug, kind)}
    return files[next_key]


def delete_adaptation_file(slug: str, kind: AdaptationFileKind, key: str) -> AdaptationStatus:
    current_path = adaptation_file_path(slug, kind, key)
    if not current_path.exists():
        raise HTTPException(status_code=404, detail=f"{kind} file not found: {key}")
    current_path.unlink()
    metadata = sync_prompt_links(slug, read_metadata(slug))
    write_metadata(slug, metadata)
    return status(slug)


def create_image_group(slug: str, payload: ImageGroupNodeCreate) -> ImageGroupNodeResponse:
    from canvas_nodes import create_image_group_node, next_canvas_position
    from models import ImageGroupNodeResponse

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


def character_list_stage_name() -> str:
    return "character-list"


def character_extract_all_stage_name() -> str:
    return "character-extract-all"


def character_extract_stage_name(character_slug: str) -> str:
    from adaptation_workflow.runner import character_extract_stage

    return character_extract_stage(character_slug)


def character_list_status_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{character_list_stage_name()}-status.json"


def character_list_log_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{character_list_stage_name()}.log"


def character_list_launcher_log_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{character_list_stage_name()}-launcher.log"


def character_extract_all_status_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{character_extract_all_stage_name()}-status.json"


def character_extract_all_log_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{character_extract_all_stage_name()}.log"


def character_extract_all_launcher_log_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{character_extract_all_stage_name()}-launcher.log"


def character_extract_status_path(slug: str, character_slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{character_extract_stage_name(character_slug)}-status.json"


def character_extract_log_path(slug: str, character_slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{character_extract_stage_name(character_slug)}.log"


def character_extract_launcher_log_path(slug: str, character_slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{character_extract_stage_name(character_slug)}-launcher.log"


def _require_book_session_for_characters(slug: str) -> None:
    root = ensure_adaptation(slug)
    if not _has_book_session(root):
        raise HTTPException(status_code=409, detail="Load book session before running character workflows")


def start_character_list(slug: str) -> AdaptationWorkflowStatus:
    _require_book_session_for_characters(slug)
    return start_logged_process(
        slug,
        log_path=character_list_log_path(slug),
        launcher_log_path=character_list_launcher_log_path(slug),
        status_path=character_list_status_path(slug),
        start_line=f"Starting character list for {slug}",
        script_command=f'cd api && {workflow_python()} -m adaptation_workflow list-characters "$SLUG"',
    )


def character_list_status(slug: str) -> AdaptationWorkflowStatus:
    return process_status(
        slug,
        character_list_status_path(slug),
        character_list_log_path(slug),
    )


def start_character_extract_all(slug: str) -> AdaptationWorkflowStatus:
    root = ensure_adaptation(slug)
    _require_book_session_for_characters(slug)
    if not (root / "characters" / "list.txt").is_file():
        raise HTTPException(status_code=409, detail="List characters before extract-all")
    return start_logged_process(
        slug,
        log_path=character_extract_all_log_path(slug),
        launcher_log_path=character_extract_all_launcher_log_path(slug),
        status_path=character_extract_all_status_path(slug),
        start_line=f"Starting character extract-all for {slug}",
        script_command=f'cd api && {workflow_python()} -m adaptation_workflow extract-characters "$SLUG"',
    )


def character_extract_all_status(slug: str) -> AdaptationWorkflowStatus:
    return process_status(
        slug,
        character_extract_all_status_path(slug),
        character_extract_all_log_path(slug),
    )


def start_character_extract(slug: str, character_slug: str, *, force: bool = False) -> AdaptationWorkflowStatus:
    root = ensure_adaptation(slug)
    _require_book_session_for_characters(slug)
    if not (root / "characters" / "list.txt").is_file():
        raise HTTPException(status_code=409, detail="List characters before extract")
    from adaptation_workflow.character_file import character_list_lines

    listed = {entry_slug for entry_slug, _line in character_list_lines(root / "characters" / "list.txt")}
    if character_slug not in listed:
        raise HTTPException(status_code=404, detail=f"Character not in list: {character_slug}")
    force_flag = " --force" if force else ""
    return start_logged_process(
        slug,
        log_path=character_extract_log_path(slug, character_slug),
        launcher_log_path=character_extract_launcher_log_path(slug, character_slug),
        status_path=character_extract_status_path(slug, character_slug),
        start_line=f"Starting character extract for {character_slug} in {slug}",
        script_command=(
            f'cd api && {workflow_python()} -m adaptation_workflow extract-character "$SLUG" "{character_slug}"{force_flag}'
        ),
    )


def character_extract_status(slug: str, character_slug: str) -> AdaptationWorkflowStatus:
    return process_status(
        slug,
        character_extract_status_path(slug, character_slug),
        character_extract_log_path(slug, character_slug),
    )


def concept_character_generate_stage_name() -> str:
    from adaptation_workflow.runner import concept_character_generate_stage

    return concept_character_generate_stage()


def concept_character_generate_status_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{concept_character_generate_stage_name()}-status.json"


def concept_character_generate_log_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{concept_character_generate_stage_name()}.log"


def concept_character_generate_launcher_log_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{concept_character_generate_stage_name()}-launcher.log"


def start_generate_concept_character(slug: str) -> AdaptationWorkflowStatus:
    _require_book_session_for_characters(slug)
    current = generate_concept_character_status(slug)
    if current.running:
        raise HTTPException(status_code=409, detail="Process is already running")
    import agent_sessions

    stage = concept_character_generate_stage_name()
    session = agent_sessions.create_session(
        slug,
        kind="concept-character-suggest",
        title="Suggest character concept",
        source={"type": "concept-suggest", "subjectKind": "character", "stage": stage},
        log_files=workflow_log_files(slug, stage),
    )
    return start_logged_process(
        slug,
        log_path=concept_character_generate_log_path(slug),
        launcher_log_path=concept_character_generate_launcher_log_path(slug),
        status_path=concept_character_generate_status_path(slug),
        start_line=f"Starting concept character generation for {slug}",
        script_command=f'cd api && {workflow_python()} -m adaptation_workflow generate-concept-character "$SLUG"',
        extra_env={"AGENT_SESSION_ID": session.id},
    )


def generate_concept_character_status(slug: str) -> AdaptationWorkflowStatus:
    return process_status(
        slug,
        concept_character_generate_status_path(slug),
        concept_character_generate_log_path(slug),
    )


def concept_location_generate_stage_name() -> str:
    from adaptation_workflow.runner import concept_location_generate_stage

    return concept_location_generate_stage()


def concept_location_generate_status_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{concept_location_generate_stage_name()}-status.json"


def concept_location_generate_log_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{concept_location_generate_stage_name()}.log"


def concept_location_generate_launcher_log_path(slug: str) -> Path:
    return adaptation_dir(slug) / "sessions" / f"run-{concept_location_generate_stage_name()}-launcher.log"


def start_generate_concept_location(slug: str) -> AdaptationWorkflowStatus:
    _require_book_session_for_characters(slug)
    current = generate_concept_location_status(slug)
    if current.running:
        raise HTTPException(status_code=409, detail="Process is already running")
    import agent_sessions

    stage = concept_location_generate_stage_name()
    session = agent_sessions.create_session(
        slug,
        kind="concept-location-suggest",
        title="Suggest location concept",
        source={"type": "concept-suggest", "subjectKind": "location", "stage": stage},
        log_files=workflow_log_files(slug, stage),
    )
    return start_logged_process(
        slug,
        log_path=concept_location_generate_log_path(slug),
        launcher_log_path=concept_location_generate_launcher_log_path(slug),
        status_path=concept_location_generate_status_path(slug),
        start_line=f"Starting concept location generation for {slug}",
        script_command=f'cd api && {workflow_python()} -m adaptation_workflow generate-concept-location "$SLUG"',
        extra_env={"AGENT_SESSION_ID": session.id},
    )


def generate_concept_location_status(slug: str) -> AdaptationWorkflowStatus:
    return process_status(
        slug,
        concept_location_generate_status_path(slug),
        concept_location_generate_log_path(slug),
    )


def reset_character_data(slug: str) -> AdaptationStatus:
    root = ensure_adaptation(slug)
    characters_dir = root / "characters"
    if characters_dir.is_dir():
        for path in characters_dir.iterdir():
            if path.is_file():
                path.unlink()
    sessions = adaptation_dir(slug) / "sessions"
    if sessions.is_dir():
        for path in sessions.iterdir():
            name = path.name
            if not path.is_file():
                continue
            if name.startswith("run-character-list") or name.startswith("run-character-extract-"):
                path.unlink()
    metadata = sync_prompt_links(slug, read_metadata(slug))
    library.sync_entity_tags(
        slug,
        character_keys=[],
        location_keys=list(metadata.locations.keys()),
    )
    return status(slug)


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
    subject_raw = section.get("subject", "").strip()
    subject_kind = subject_raw if subject_raw in {"character", "location"} else None
    if subject_kind is None and existing is not None:
        subject_kind = existing.subjectKind
    return AdaptationAssetLink(
        artifactKind=artifact_kind,
        promptPath=prompt_path,
        subjectKind=subject_kind,
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
        userTags=list(existing.userTags) if existing else [],
    )


def sync_prompt_links(slug: str, metadata: AdaptationMetadata) -> AdaptationMetadata:
    from adaptation_workflow.character_file import parse_character_file

    root = ensure_adaptation(slug)
    old_characters = metadata.characters
    new_characters: dict[str, CharacterRecord] = {}
    characters_dir = root / "characters"
    if characters_dir.is_dir():
        for char_file in sorted(characters_dir.glob("*.md")):
            slug_key = char_file.stem
            prompt_path = relpath(root, char_file)
            try:
                parsed = parse_character_file(char_file)
            except ValueError:
                continue
            old_record = old_characters.get(slug_key)
            old_variants = old_record.variants if old_record else {}
            new_variants: dict[str, AdaptationAssetLink] = {}
            for variant_key, section in parsed.variants.items():
                existing = old_variants.get(variant_key)
                new_variants[variant_key] = prompt_link(
                    artifact_kind="character-sheet",
                    prompt_path=prompt_path,
                    section=section,
                    existing=existing,
                )
            user_tags = list(old_record.userTags) if old_record else []
            new_characters[slug_key] = CharacterRecord(
                slug=slug_key,
                promptPath=prompt_path,
                description=parsed.description,
                userTags=user_tags,
                variants=new_variants,
            )
    metadata.characters = new_characters
    old_locations = metadata.locations
    new_locations: dict[str, AdaptationAssetLink] = {}
    for prompt_file in sorted((root / "locations" / "prompts").glob("*.md")):
        prompt_path = relpath(root, prompt_file)
        for key, section in parse_prompt_sections(prompt_file).items():
            existing = old_locations.get(key)
            new_locations[key] = prompt_link(
                artifact_kind="location-prompt",
                prompt_path=prompt_path,
                section=section,
                existing=existing,
            )
    metadata.locations = new_locations
    return write_metadata(slug, metadata)


def status(slug: str) -> AdaptationStatus:
    import concept_cards

    root = ensure_adaptation(slug)
    metadata = sync_prompt_links(slug, read_metadata(slug))
    metadata, changed = clear_stale_style_ref_assets(slug, metadata)
    metadata, artifact_changed = clear_stale_artifact_assets(slug, metadata)
    if changed or artifact_changed:
        metadata = write_metadata(slug, metadata)
    statuses = style_ref_statuses(slug, metadata)

    return AdaptationStatus(
        projectSlug=slug,
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
            "characterFiles": len(list((root / "characters").glob("*.md"))),
            "locationPrompts": len(list((root / "locations" / "prompts").glob("*.md"))),
            "conceptArt": len(concept_cards.list_cards(slug)),
        },
        visualStyles=(styles := read_visual_styles(root)),
        defaultVisualStyleId=resolve_default_visual_style_id(styles),
        characters=metadata.characters,
        locations=metadata.locations,
    )


def count_nonempty_lines(path: Path) -> int:
    return sum(1 for line in read_text(path).splitlines() if line.strip())


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


async def import_book(slug: str, upload: UploadFile) -> AdaptationStatus:
    root = ensure_adaptation(slug)
    if upload.content_type not in {None, "text/plain", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Book import expects a text file")
    with (root / "book.txt").open("wb") as fh:
        shutil.copyfileobj(upload.file, fh)
    return status(slug)


def set_style_ref_asset(slug: str, request: AdaptationStyleRefAssetRequest) -> AdaptationStatus:
    kind = require_style_ref_kind(request.kind)
    library.read_asset(slug, request.assetId)
    metadata = read_metadata(slug)
    set_style_ref_asset_id(metadata, kind, request.assetId)
    write_metadata(slug, metadata)
    library.write_canvas(slug, library.sync_style_ref_canvas_nodes(slug, library.read_stored_canvas(slug), kind))
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
