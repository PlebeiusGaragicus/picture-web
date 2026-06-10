"""Project-backed comic adaptation helpers."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile

import gemini
import library
from models import (
    AdaptationGenerateArtifactRequest,
    AdaptationAssetLink,
    AdaptationGenerateResponse,
    AdaptationMetadata,
    AdaptationStatus,
    ArtifactKind,
    AssetSummary,
    GenerateRequest,
)


STYLE_TEMPLATE = "Style:\nColor palette:\nRealism:\nLighting:\n"


def adaptation_dir(slug: str) -> Path:
    library.require_project(slug)
    return library.project_dir(slug) / "adaptation"


def metadata_path(slug: str) -> Path:
    return adaptation_dir(slug) / "adaptation.json"


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
