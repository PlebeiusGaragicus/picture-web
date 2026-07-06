from __future__ import annotations

from pathlib import Path
from io import BytesIO
import base64

import library
import gemini
import chat_sessions
import adaptation
import adaptation_workflow.config as workflow_config
import story_panels
import story_panels_print
from fastapi.testclient import TestClient
from main import app
from models import (
    AdaptationAssetLink,
    CharacterRecord,
    DEFAULT_AUTO_PLACE_H,
    DEFAULT_AUTO_PLACE_W,
    LAYOUT_PAGE_ROWS,
    StoryPanel,
    StoryPanelImageCrop,
    StoryPanelRect,
)
from pydantic import ValidationError
import pytest
from PIL import Image


def setup_tmp_library(tmp_path, monkeypatch):
    root = tmp_path / "photo-library"
    monkeypatch.setattr(library, "LIBRARY_ROOT", root)
    monkeypatch.setattr(library, "PROJECTS_ROOT", root / "projects")
    monkeypatch.setattr(library, "SYSTEM_TRASH", tmp_path / "system-trash")
    monkeypatch.setattr(gemini, "LIBRARY_ROOT", root)
    return TestClient(app)


def create_project(client: TestClient) -> None:
    response = client.post("/api/projects", json={"slug": "farm-comic", "name": "Farm Comic"})
    assert response.status_code == 200


def visual_style_id_by_name(styles: list[dict], name: str) -> str:
    return next(style["id"] for style in styles if style["name"] == name)


def make_png(path: Path, color: str = "red") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), color=color).save(path)


def character_record_metadata(
    slug: str,
    *,
    prompt: str = "Character reference sheet prompt.",
    asset_ids: list[str] | None = None,
    user_tags: list[str] | None = None,
    status: str | None = None,
) -> dict:
    asset_ids = list(asset_ids or [])
    link_status = status or ("generated" if asset_ids else "ready")
    return {
        "slug": slug,
        "promptPath": f"characters/{slug}.md",
        "description": f"## Summary\n\n{slug}\n",
        "userTags": user_tags or [],
        "variants": {
            "base": {
                "artifactKind": "character-sheet",
                "promptPath": f"characters/{slug}.md",
                "mode": "new-image",
                "styleRef": "style-refs/archetype-character.png",
                "prompt": prompt,
                "assetIds": asset_ids,
                "activeAssetId": asset_ids[-1] if asset_ids else None,
                "status": link_status,
            }
        },
    }


def write_unified_character_file(
    path: Path,
    slug: str,
    *,
    prompt: str = "Character reference sheet for the hero.",
    variant_key: str | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = (
        f"# {slug}\n\n"
        "## Summary\n\n"
        f"{slug} summary.\n\n"
        "## Visual Description\n\n"
        "Visual details.\n\n"
        "## Behaviour, mannerisms and personality\n\n"
        "Behaviour notes.\n\n"
        "## Continuity Notes\n\n"
        "Continuity.\n\n"
        "## Source References\n\n"
        '- `L001`: "quote"\n\n'
        "# base\n"
        "mode: new-image\n"
        "style_ref: style-refs/archetype-character.png\n\n"
        f"{prompt} Layout: top row — front full-body, three-quarter full-body, back full-body, "
        "same neutral standing pose, consistent scale. Bottom row — four head close-ups. "
        "White background. No text, no labels, no watermarks. Expressions: neutral, happy, sad, angry.\n"
    )
    if variant_key:
        content += (
            f"\n# {variant_key}\n"
            "mode: edit-reference\n"
            f"style_ref: characters/{slug}/base.png\n\n"
            "Variant sheet. Layout: top row — front full-body, three-quarter full-body, back full-body, "
            "same neutral standing pose, consistent scale. Bottom row — four head close-ups. "
            "White background. No text, no labels, no watermarks. Expressions: neutral, happy, sad, angry.\n"
        )
    path.write_text(content)


def png_bytes(color: str = "red") -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (16, 16), color=color).save(buffer, format="PNG")
    return buffer.getvalue()


def test_provider_metadata_strips_large_payloads(tmp_path):
    output_png = tmp_path / "generated.png"
    response = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {
                            "inline_data": {"data": "abc123", "mime_type": "image/png"},
                            "thought_signature": "secret" * 300,
                        }
                    ]
                }
            }
        ]
    }

    metadata = gemini.serialize_response_metadata(response, output_png)
    part = metadata["response"]["candidates"][0]["content"]["parts"][0]

    assert metadata["imageFile"] == "generated.png"
    assert part["inline_data"]["data"] == "<inline-image-data:6 chars>"
    assert part["thought_signature"] == "<thought-signature:1800 chars>"


def test_chat_turn_response_preserves_sdk_image_bytes_for_history():
    class InlineData:
        def __init__(self):
            self.data = png_bytes("blue")
            self.mime_type = "image/png"

    class Part:
        def __init__(self):
            self.text = None
            self.inline_data = InlineData()
            self.thought_signature = "sig-image"

    class Response:
        def __init__(self):
            self.parts = [Part()]

    result = gemini.chat_turn_result_from_response(Response())

    assert result.images[0].data.startswith(b"\x89PNG")
    assert result.model_content["parts"][0]["inline_data"]["data"].startswith("iVBOR")
    assert result.provider_response["parts"][0]["inline_data"]["data"].startswith("<inline-image-data:")


def test_chat_turn_response_handles_sdk_image_save_without_format():
    class SdkImage:
        def save(self, buffer):
            buffer.write(png_bytes("blue"))

    class Part:
        text = None
        inline_data = None
        thought_signature = "sig-image"

        def as_image(self):
            return SdkImage()

    class Response:
        parts = [Part()]

    result = gemini.chat_turn_result_from_response(Response())

    assert result.images[0].data.startswith(b"\x89PNG")
    assert result.model_content["parts"][0]["inlineData"]["data"].startswith("iVBOR")


def test_project_and_canvas_round_trip(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    response = client.get("/api/projects")
    assert response.status_code == 200
    assert response.json()[0]["slug"] == "farm-comic"

    canvas_response = client.get("/api/projects/farm-comic/canvas")
    assert canvas_response.status_code == 200
    starter_draft = canvas_response.json()["nodes"][library.DEFAULT_STARTER_DRAFT_NODE_ID]
    assert starter_draft["type"] == "draft"
    seed_prompts = {prompt for _, prompt in library.list_seed_default_prompts()}
    assert seed_prompts
    assert starter_draft["prompt"] in seed_prompts
    assert starter_draft["refs"] == []

    canvas = {"version": 2, "viewport": {"x": 1, "y": 2, "zoom": 1}, "nodes": {}}
    response = client.put("/api/projects/farm-comic/canvas", json=canvas)
    assert response.status_code == 200
    assert response.json()["viewport"]["x"] == 1


def test_project_cover_asset_round_trip(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    asset_id = "01HCOVER"
    make_png(library.asset_png_path("farm-comic", asset_id))
    library.write_json(
        library.asset_json_path("farm-comic", asset_id),
        {
            "id": asset_id,
            "kind": "imported",
            "title": "Cover",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )

    response = client.patch("/api/projects/farm-comic", json={"coverAssetId": asset_id})
    assert response.status_code == 200
    body = response.json()
    assert body["coverAssetId"] == asset_id
    assert body["coverThumbnailUrl"] == f"/api/projects/farm-comic/assets/{asset_id}/thumb"

    response = client.get("/api/projects")
    assert response.json()[0]["coverThumbnailUrl"] == f"/api/projects/farm-comic/assets/{asset_id}/thumb"

    response = client.delete(f"/api/projects/farm-comic/assets/{asset_id}")
    assert response.status_code == 204

    response = client.get("/api/projects/farm-comic")
    assert response.json()["project"]["coverAssetId"] is None


def test_project_tags_registry_and_asset_assignment(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    asset_id = "01HTAGS"
    make_png(library.asset_png_path("farm-comic", asset_id), color="red")
    library.write_json(
        library.asset_json_path("farm-comic", asset_id),
        {
            "id": asset_id,
            "kind": "imported",
            "title": "Tagged image",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )

    registry_response = client.put(
        "/api/projects/farm-comic/tags",
        json={"tags": [{"id": "red4repo", "name": "Red4Repo", "color": "#ef4444"}]},
    )
    assert registry_response.status_code == 200
    saved_tag = registry_response.json()["tags"][0]
    assert saved_tag["id"] == "red4repo"
    assert saved_tag["name"] == "Red4Repo"
    assert saved_tag["color"] == "#ef4444"
    listed_tag = client.get("/api/projects/farm-comic/tags").json()[0]
    assert listed_tag["id"] == "red4repo"
    assert listed_tag["name"] == "Red4Repo"
    assert listed_tag["color"] == "#ef4444"

    patch_response = client.patch(
        f"/api/projects/farm-comic/assets/{asset_id}/display",
        json={"title": "Tagged image", "tags": ["red4repo"]},
    )
    assert patch_response.status_code == 200
    assert patch_response.json()["tags"] == ["red4repo"]
    detail = client.get("/api/projects/farm-comic").json()
    detail_tag = detail["tags"][0]
    assert detail_tag["id"] == "red4repo"
    assert detail_tag["name"] == "Red4Repo"
    assert detail_tag["color"] == "#ef4444"
    assert detail["assets"][0]["tags"] == ["red4repo"]


def test_project_tag_rename_preserves_asset_assignments(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    asset_id = "01HTAG2"
    make_png(library.asset_png_path("farm-comic", asset_id), color="blue")
    library.write_json(
        library.asset_json_path("farm-comic", asset_id),
        {
            "id": asset_id,
            "kind": "imported",
            "title": "Tagged image",
            "tags": ["red4repo"],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )
    client.put(
        "/api/projects/farm-comic/tags",
        json={"tags": [{"id": "red4repo", "name": "Red4Repo", "color": "#ef4444"}]},
    )

    rename_response = client.put(
        "/api/projects/farm-comic/tags",
        json={"tags": [{"id": "red4repo", "name": "Renamed Tag", "color": "#22c55e"}]},
    )
    assert rename_response.status_code == 200
    renamed_tag = rename_response.json()["tags"][0]
    assert renamed_tag["id"] == "red4repo"
    assert renamed_tag["name"] == "Renamed Tag"
    assert renamed_tag["color"] == "#22c55e"

    asset = client.get(f"/api/projects/farm-comic/assets/{asset_id}").json()
    assert asset["tags"] == ["red4repo"]


def test_project_tag_delete_removes_id_from_assets(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    asset_id = "01HTAG3"
    make_png(library.asset_png_path("farm-comic", asset_id), color="green")
    library.write_json(
        library.asset_json_path("farm-comic", asset_id),
        {
            "id": asset_id,
            "kind": "imported",
            "title": "Tagged image",
            "tags": ["red4repo"],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )
    client.put(
        "/api/projects/farm-comic/tags",
        json={"tags": [{"id": "red4repo", "name": "Red4Repo", "color": "#ef4444"}]},
    )

    delete_response = client.put("/api/projects/farm-comic/tags", json={"tags": []})
    assert delete_response.status_code == 200
    assert delete_response.json()["tags"] == []

    patch_response = client.patch(
        f"/api/projects/farm-comic/assets/{asset_id}/display",
        json={"title": "Tagged image", "tags": []},
    )
    assert patch_response.status_code == 200
    assert patch_response.json()["tags"] == []


def test_project_tag_registry_reads_legacy_name_shape(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    library.write_json(
        library.tags_json_path("farm-comic"),
        {"tags": [{"name": "legacy-tag", "color": "#3b82f6"}]},
    )

    tags = client.get("/api/projects/farm-comic/tags").json()
    legacy_tag = tags[0]
    assert legacy_tag["id"] == "legacy-tag"
    assert legacy_tag["name"] == "legacy-tag"
    assert legacy_tag["color"] == "#3b82f6"


def test_persistent_draft_canvas_round_trip(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    parent_id = "01HPARENT"
    make_png(library.asset_png_path("farm-comic", parent_id))
    library.write_json(
        library.asset_json_path("farm-comic", parent_id),
        {
            "id": parent_id,
            "kind": "imported",
            "title": "Parent",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )
    canvas = {
        "version": 2,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "nodes": {
            "draft_1": {
                "type": "draft",
                "displayName": "Blue square candidates",
                "x": 10,
                "y": 20,
                "refs": [parent_id],
                "prompt": "make it blue",
                "params": {"model": "gemini-3.1-flash-image", "aspectRatio": "16:9", "imageSize": "1K", "seed": None, "batchCount": 1},
            }
        },
    }

    response = client.put("/api/projects/farm-comic/canvas", json=canvas)
    assert response.status_code == 200
    assert response.json()["nodes"]["draft_1"]["prompt"] == "make it blue"


def test_display_patch_does_not_mutate_generation(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    asset_id = "01HAAA"
    make_png(library.asset_png_path("farm-comic", asset_id))
    library.write_json(
        library.asset_json_path("farm-comic", asset_id),
        {
            "id": asset_id,
            "kind": "generated",
            "title": "Old",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "prompt": {"text": "original"},
            "generation": {
                "refs": [],
                "runId": "01HRUN",
                "runIndex": 0,
                "model": "gemini-3.1-flash-image",
                "aspectRatio": "16:9",
                "imageSize": "1K",
                "seed": 1,
            },
            "provider": {"name": "google-genai", "response": {"usageMetadata": {"totalTokenCount": 1}}},
        },
    )

    response = client.patch(
        f"/api/projects/farm-comic/assets/{asset_id}/display",
        json={"title": "New", "tags": ["scene"]},
    )
    assert response.status_code == 200
    metadata = library.read_json(library.asset_json_path("farm-comic", asset_id))
    assert metadata["title"] == "New"
    assert metadata["prompt"]["text"] == "original"
    assert metadata["generation"]["seed"] == 1
    assert metadata["provider"]["response"]["usageMetadata"]["totalTokenCount"] == 1


def test_full_image_endpoint_serves_pixels(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    asset_id = "01HIMG"
    make_png(library.asset_png_path("farm-comic", asset_id), color="green")
    library.write_json(
        library.asset_json_path("farm-comic", asset_id),
        {
            "id": asset_id,
            "kind": "imported",
            "title": "Image",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )

    response = client.get(f"/api/projects/farm-comic/assets/{asset_id}/image")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content.startswith(b"\x89PNG")


def test_delete_imported_asset_removes_canvas_node_and_pixels(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    asset_id = "01HIMAGE"
    make_png(library.asset_png_path("farm-comic", asset_id), color="red")
    library.write_json(
        library.asset_json_path("farm-comic", asset_id),
        {
            "id": asset_id,
            "kind": "imported",
            "title": "Image",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )
    canvas = client.get("/api/projects/farm-comic/canvas").json()
    assert canvas["nodes"]

    response = client.delete(f"/api/projects/farm-comic/assets/{asset_id}")
    assert response.status_code == 204
    assert not library.asset_json_path("farm-comic", asset_id).exists()
    assert not library.asset_png_path("farm-comic", asset_id).exists()
    assert (library.SYSTEM_TRASH / f"{asset_id}.json").exists()
    assert (library.SYSTEM_TRASH / f"{asset_id}.png").exists()
    nodes = client.get("/api/projects/farm-comic/canvas").json()["nodes"]
    assert set(nodes) == {library.DEFAULT_STARTER_DRAFT_NODE_ID}


def test_import_duplicate_file_returns_conflict(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    image = png_bytes("red")

    first = client.post(
        "/api/projects/farm-comic/assets/import",
        files={"file": ("same.png", image, "image/png")},
    )
    assert first.status_code == 200

    second = client.post(
        "/api/projects/farm-comic/assets/import",
        files={"file": ("same-again.png", image, "image/png")},
    )
    assert second.status_code == 409
    assert "Already imported" in second.text
    assert len(client.get("/api/projects/farm-comic/assets").json()) == 1


def test_adaptation_editable_files_without_book_feed_status_and_canvas(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    character = client.post(
        "/api/projects/farm-comic/adaptation/files/characters",
        json={
            "key": "hero",
            "mode": "new-image",
            "styleRef": "",
            "body": "Full body character sheet for the farm hero.",
        },
    )
    assert character.status_code == 200
    assert character.json()["promptPath"] == "characters/hero.md"

    location = client.post(
        "/api/projects/farm-comic/adaptation/files/locations",
        json={
            "key": "barn",
            "mode": "new-image",
            "styleRef": "",
            "body": "Wide establishing image prompt for a red barn.",
        },
    )
    assert location.status_code == 200

    update = client.put(
        "/api/projects/farm-comic/adaptation/files/characters/hero",
        json={
            "key": "hero-primary",
            "body": "Updated character sheet prompt.",
            "mode": "new-image",
            "styleRef": "",
            "userTags": ["farm", "protagonist"],
        },
    )
    assert update.status_code == 200
    assert update.json()["key"] == "hero-primary"

    characters = client.get("/api/projects/farm-comic/adaptation/files/characters")
    assert characters.status_code == 200
    assert [item["key"] for item in characters.json()] == ["hero-primary"]

    status = client.get("/api/projects/farm-comic/adaptation")
    assert status.status_code == 200
    payload = status.json()
    assert payload["hasBook"] is False
    assert "hero-primary" in payload["characters"]
    assert payload["characters"]["hero-primary"]["userTags"] == ["farm", "protagonist"]
    assert "barn" in payload["locations"]

    deleted = client.delete("/api/projects/farm-comic/adaptation/files/characters/hero-primary")
    assert deleted.status_code == 200
    assert "hero-primary" not in deleted.json()["characters"]

    status_after_delete = client.get("/api/projects/farm-comic/adaptation")
    assert status_after_delete.status_code == 200
    assert "hero-primary" not in status_after_delete.json()["characters"]


def test_character_update_description_and_variants(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    character_path = tmp_path / "photo-library" / "projects" / "farm-comic" / "adaptation" / "characters" / "hero.md"
    character_path.parent.mkdir(parents=True, exist_ok=True)
    character_path.write_text(
        "# hero\n\n"
        "## Summary\n\nHero summary.\n\n"
        "## Visual Description\n\nTall.\n\n"
        "## Behaviour, mannerisms and personality\n\nBrave.\n\n"
        "## Continuity Notes\n\nNone.\n\n"
        "## Source References\n\n- `L001`: \"Hi.\"\n\n"
        "# base\n"
        "mode: new-image\n"
        "style_ref: style-refs/archetype-character.png\n\n"
        "Base prompt.\n\n"
        "# winter-coat\n"
        "mode: new-image\n"
        "style_ref: style-refs/archetype-character.png\n\n"
        "Winter coat prompt.\n"
    )

    updated = client.put(
        "/api/projects/farm-comic/adaptation/files/characters/hero",
        json={
            "description": "## Summary\n\nUpdated summary.\n",
            "variants": {
                "base": {"prompt": "Updated base prompt."},
                "winter-coat": {"prompt": "Updated winter prompt."},
            },
        },
    )
    assert updated.status_code == 200

    text = character_path.read_text()
    assert "## Summary\n\nUpdated summary." in text
    assert "Updated base prompt." in text
    assert "Updated winter prompt." in text

    status = client.get("/api/projects/farm-comic/adaptation").json()
    assert status["characters"]["hero"]["description"].startswith("## Summary")
    assert status["characters"]["hero"]["variants"]["base"]["prompt"] == "Updated base prompt."
    assert status["characters"]["hero"]["variants"]["winter-coat"]["prompt"] == "Updated winter prompt."


def test_reset_character_data_clears_files_metadata_and_entity_tags(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    created = client.post(
        "/api/projects/farm-comic/adaptation/files/characters",
        json={
            "key": "hero",
            "mode": "new-image",
            "styleRef": "",
            "body": "Full body character sheet for the farm hero.",
        },
    )
    assert created.status_code == 200

    tags = client.get("/api/projects/farm-comic/tags").json()
    assert [tag["id"] for tag in tags] == ["hero"]

    reset = client.post("/api/projects/farm-comic/adaptation/characters/reset")
    assert reset.status_code == 200
    assert reset.json()["characters"] == {}

    tags = client.get("/api/projects/farm-comic/tags").json()
    assert tags == []

    characters = client.get("/api/projects/farm-comic/adaptation/files/characters")
    assert characters.status_code == 200
    assert characters.json() == []


def test_character_rename_drops_stale_entity_tag(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    created = client.post(
        "/api/projects/farm-comic/adaptation/files/characters",
        json={
            "key": "new-character-1",
            "mode": "new-image",
            "styleRef": "",
            "body": "A new character.",
        },
    )
    assert created.status_code == 200

    tags = client.get("/api/projects/farm-comic/tags").json()
    assert [tag["id"] for tag in tags] == ["new-character-1"]
    assert tags[0]["name"] == "New Character 1"

    renamed = client.put(
        "/api/projects/farm-comic/adaptation/files/characters/new-character-1",
        json={
            "key": "hero",
            "body": "A new character.",
            "mode": "new-image",
            "styleRef": "",
            "userTags": [],
        },
    )
    assert renamed.status_code == 200
    assert renamed.json()["key"] == "hero"

    tags = client.get("/api/projects/farm-comic/tags").json()
    assert [tag["id"] for tag in tags] == ["hero"]
    assert tags[0]["name"] == "Hero"

    status = client.get("/api/projects/farm-comic/adaptation").json()
    assert list(status["characters"]) == ["hero"]
    assert "new-character-1" not in status["characters"]


def test_import_single_character_and_location_artifact_to_canvas(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    character = client.post(
        "/api/projects/farm-comic/adaptation/files/characters",
        json={
            "key": "hero",
            "mode": "new-image",
            "styleRef": "",
            "body": "Full body character sheet for the farm hero.",
        },
    )
    assert character.status_code == 200

    updated = client.put(
        "/api/projects/farm-comic/adaptation/files/characters/hero",
        json={
            "body": "Full body character sheet for the farm hero.",
            "mode": "new-image",
            "styleRef": "",
        },
    )
    assert updated.status_code == 200

    location = client.post(
        "/api/projects/farm-comic/adaptation/files/locations",
        json={
            "key": "barn",
            "mode": "new-image",
            "styleRef": "",
            "body": "Wide establishing image prompt for a red barn.",
        },
    )
    assert location.status_code == 200

    first = client.post(
        "/api/projects/farm-comic/adaptation/import-artifact-to-canvas",
        json={"artifactKind": "character-sheet", "artifactKey": "hero"},
    )
    assert first.status_code == 200
    assert first.json()["importedNodeCount"] == 1
    first_node_id = first.json()["nodeId"]
    nodes = first.json()["canvas"]["nodes"]
    first_node = nodes[first_node_id]
    assert first_node["type"] == "imageGroup"
    assert "hero" in first_node["tags"]
    assert first_node["assetIds"] == []
    assert "Full body character sheet" in first_node["prompt"]

    second = client.post(
        "/api/projects/farm-comic/adaptation/import-artifact-to-canvas",
        json={"artifactKind": "character-sheet", "artifactKey": "hero"},
    )
    assert second.status_code == 200
    assert second.json()["importedNodeCount"] == 1
    second_node_id = second.json()["nodeId"]
    assert second_node_id != first_node_id
    character_nodes = [
        node
        for node in second.json()["canvas"]["nodes"].values()
        if node.get("type") == "imageGroup" and "hero" in node.get("tags", [])
    ]
    assert len(character_nodes) == 2

    location_import = client.post(
        "/api/projects/farm-comic/adaptation/import-artifact-to-canvas",
        json={"artifactKind": "location-prompt", "artifactKey": "barn"},
    )
    assert location_import.status_code == 200
    assert location_import.json()["importedNodeCount"] == 1
    location_node_id = location_import.json()["nodeId"]
    location_node = location_import.json()["canvas"]["nodes"][location_node_id]
    assert location_node["type"] == "imageGroup"
    assert "barn" in location_node["tags"]
    assert location_node["assetIds"] == []


def test_story_panels_document_and_panel_api(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Alpha opens the door. Beta crosses the room. Gamma watches.\n")

    empty = client.get("/api/projects/farm-comic/story-panels")
    assert empty.status_code == 200
    assert [page["pageKind"] for page in empty.json()["pages"]] == [
        "cover",
        "inside-cover",
        "story",
        "story",
        "story",
        "story",
        "inside-back-cover",
        "back-cover",
    ]
    assert [page["id"] for page in empty.json()["pages"][2:6]] == ["page-001", "page-002", "page-003", "page-004"]
    assert [
        (panel["pageId"], panel["sourceKind"], panel["panelKind"], panel["visibleText"], panel["storyText"])
        for panel in empty.json()["panels"]
    ] == [
        ("cover", "panel", "text", "Title goes here", ""),
        ("inside-front-cover", "panel", "text", "Copyright information goes here.", ""),
        ("inside-back-cover", "panel", "text", "About this comic, acknowledgements, or bonus notes go here.", ""),
    ]

    book = client.get("/api/projects/farm-comic/story-panels/book")
    assert book.status_code == 200
    assert book.json()["text"].startswith("Alpha opens")

    created = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 0, "endOffset": 21, "selectedText": "Alpha opens the door."},
    )
    assert created.status_code == 200
    panel = next(panel for panel in created.json()["panels"] if panel["sourceKind"] == "panel" and panel["selectedText"] == "Alpha opens the door.")
    assert panel["sourceKind"] == "panel"
    assert panel["selectedText"] == "Alpha opens the door."
    assert panel["rect"] == {"x": 0, "y": 0, "w": DEFAULT_AUTO_PLACE_W, "h": DEFAULT_AUTO_PLACE_H}
    alpha_panel_id = panel["id"]

    unplaced = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={
            "startOffset": 22,
            "endOffset": 44,
            "selectedText": "Beta crosses the room.",
            "autoPlace": False,
        },
    )
    assert unplaced.status_code == 200
    beta_panel = next(panel for panel in unplaced.json()["panels"] if panel["selectedText"] == "Beta crosses the room.")
    assert beta_panel["pageId"] is None

    overlap = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 6, "endOffset": 25, "selectedText": "opens the door. Be"},
    )
    assert overlap.status_code == 400

    patched = client.patch(
        f"/api/projects/farm-comic/story-panels/panels/{alpha_panel_id}",
        json={"rect": {"x": 0, "y": 2, "w": 6, "h": 6}, "layer": 1, "finalized": True},
    )
    assert patched.status_code == 200
    panel = next(candidate for candidate in patched.json()["panels"] if candidate["id"] == alpha_panel_id)
    assert panel["rect"] == {"x": 0, "y": 2, "w": 6, "h": 6}
    assert panel["layer"] == 1
    assert panel["finalized"] is True

    document = patched.json()
    story_panel = next(panel for panel in document["panels"] if panel["id"] == alpha_panel_id)
    story_panel["pageId"] = "page-002"
    saved = client.put("/api/projects/farm-comic/story-panels", json=document)
    assert saved.status_code == 200
    assert next(panel for panel in saved.json()["panels"] if panel["id"] == alpha_panel_id)["pageId"] == "page-002"

    deleted = client.delete(f"/api/projects/farm-comic/story-panels/panels/{alpha_panel_id}")
    assert deleted.status_code == 200
    assert not any(panel["id"] == alpha_panel_id for panel in deleted.json()["panels"])
    assert any(panel["selectedText"] == "Beta crosses the room." for panel in deleted.json()["panels"])


def test_story_panels_delete_default_fixed_page_text_persists(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    loaded = client.get("/api/projects/farm-comic/story-panels")
    assert loaded.status_code == 200
    copyright_panel_id = next(
        panel["id"]
        for panel in loaded.json()["panels"]
        if panel["pageId"] == "inside-front-cover" and panel["sourceKind"] == "panel"
    )

    deleted = client.delete(f"/api/projects/farm-comic/story-panels/panels/{copyright_panel_id}")
    assert deleted.status_code == 200
    assert not any(panel["id"] == copyright_panel_id for panel in deleted.json()["panels"])
    assert not any(
        panel["pageId"] == "inside-front-cover" and panel["sourceKind"] == "panel"
        for panel in deleted.json()["panels"]
    )

    reloaded = client.get("/api/projects/farm-comic/story-panels")
    assert reloaded.status_code == 200
    assert not any(
        panel["pageId"] == "inside-front-cover" and panel["sourceKind"] == "panel"
        for panel in reloaded.json()["panels"]
    )


def test_story_panels_reset_layout_keeps_chunks(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Alpha opens the door. Beta crosses the room.\n")

    created = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 0, "endOffset": 21, "selectedText": "Alpha opens the door."},
    )
    assert created.status_code == 200
    alpha_panel_id = next(panel for panel in created.json()["panels"] if panel["sourceKind"] == "panel" and panel["selectedText"] == "Alpha opens the door.")["id"]

    client.patch(
        f"/api/projects/farm-comic/story-panels/panels/{alpha_panel_id}",
        json={"rect": {"x": 0, "y": 2, "w": 6, "h": 6}, "layer": 1, "finalized": True},
    )

    reset = client.post("/api/projects/farm-comic/story-panels/reset-layout")
    assert reset.status_code == 200
    body = reset.json()
    alpha = next(panel for panel in body["panels"] if panel["id"] == alpha_panel_id)
    assert alpha["selectedText"] == "Alpha opens the door."
    assert alpha["pageId"] is None
    assert alpha["rect"] == {"x": 0, "y": 0, "w": DEFAULT_AUTO_PLACE_W, "h": DEFAULT_AUTO_PLACE_H}
    assert alpha["layer"] == 0
    assert alpha["finalized"] is False
    assert any(panel["sourceKind"] == "panel" and panel["pageId"] == "cover" for panel in body["panels"])


def test_story_panels_reset_chunks_clears_story_panels(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Alpha opens the door.\n")

    created = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 0, "endOffset": 21, "selectedText": "Alpha opens the door."},
    )
    assert created.status_code == 200
    assert any(panel["sourceKind"] == "panel" and panel["selectedText"] == "Alpha opens the door." for panel in created.json()["panels"])

    reset = client.post("/api/projects/farm-comic/story-panels/reset-chunks")
    assert reset.status_code == 200
    body = reset.json()
    assert not any(panel["sourceKind"] == "bookmark" for panel in body["panels"])
    assert any(panel["sourceKind"] == "panel" and panel["panelKind"] == "text" for panel in body["panels"])
    assert (library.project_dir("farm-comic") / "canvas.json").is_file()
    assert (root / "book.txt").is_file()


def test_story_panels_reset_recovers_invalid_document(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    panels_path = library.project_dir("farm-comic") / "story-panels" / "panels.json"
    panels_path.parent.mkdir(parents=True, exist_ok=True)
    panels_path.write_text('{"version": 1, "panels": [{"id": "bad", "sourceKind": "bad-kind"}]}')

    reset_layout = client.post("/api/projects/farm-comic/story-panels/reset-layout")
    assert reset_layout.status_code == 200
    recovered = client.get("/api/projects/farm-comic/story-panels")
    assert recovered.status_code == 200
    assert not any(panel["id"] == "bad" for panel in recovered.json()["panels"])

    panels_path.write_text('{"version": 1, "panels": [{"id": "bad", "sourceKind": "bad-kind"}]}')

    reset_chunks = client.post("/api/projects/farm-comic/story-panels/reset-chunks")
    assert reset_chunks.status_code == 200
    assert client.get("/api/projects/farm-comic/story-panels").status_code == 200


def test_story_panels_panel_image_assignment(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Alpha opens the door.\n")

    created = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 0, "endOffset": 21, "selectedText": "Alpha opens the door."},
    )
    assert created.status_code == 200
    panel = next(candidate for candidate in created.json()["panels"] if candidate["sourceKind"] == "panel" and candidate["selectedText"] == "Alpha opens the door.")

    asset_id = "01HPANELIMG"
    make_png(library.asset_png_path("farm-comic", asset_id), color="blue")
    library.write_json(
        library.asset_json_path("farm-comic", asset_id),
        {
            "id": asset_id,
            "kind": "imported",
            "title": "Panel art",
            "tags": ["scene"],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )

    assigned = client.patch(
        f"/api/projects/farm-comic/story-panels/panels/{panel['id']}",
        json={"assetIds": [asset_id], "activeAssetId": asset_id},
    )
    assert assigned.status_code == 200
    updated = next(candidate for candidate in assigned.json()["panels"] if candidate["id"] == panel["id"])
    assert updated["assetIds"] == [asset_id]
    assert updated["activeAssetId"] == asset_id

    ratio_patch = client.patch(
        f"/api/projects/farm-comic/story-panels/panels/{panel['id']}",
        json={"aspectRatio": "16:9", "aspectRatioLocked": True},
    )
    assert ratio_patch.status_code == 200
    ratio_panel = next(candidate for candidate in ratio_patch.json()["panels"] if candidate["id"] == panel["id"])
    assert ratio_panel["aspectRatio"] == "16:9"
    assert ratio_panel["aspectRatioLocked"] is True

    crop_patch = client.patch(
        f"/api/projects/farm-comic/story-panels/panels/{panel['id']}",
        json={"imageCrop": {"focalX": 0.25, "focalY": 0.75, "scale": 2}},
    )
    assert crop_patch.status_code == 200
    crop_panel = next(candidate for candidate in crop_patch.json()["panels"] if candidate["id"] == panel["id"])
    assert crop_panel["imageCrop"] == {"focalX": 0.25, "focalY": 0.75, "scale": 2}

    with pytest.raises(ValidationError, match="activeAssetId must be attached"):
        StoryPanel.model_validate({**updated, "assetIds": [], "activeAssetId": asset_id})


def test_story_panels_unplace_story_panel(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Alpha opens the door.\n")

    created = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 0, "endOffset": 21, "selectedText": "Alpha opens the door."},
    )
    assert created.status_code == 200
    panel = next(candidate for candidate in created.json()["panels"] if candidate["sourceKind"] == "panel" and candidate["selectedText"] == "Alpha opens the door.")
    assert panel["pageId"] is not None

    unplaced = client.patch(
        f"/api/projects/farm-comic/story-panels/panels/{panel['id']}",
        json={"pageId": None},
    )
    assert unplaced.status_code == 200
    updated = next(candidate for candidate in unplaced.json()["panels"] if candidate["id"] == panel["id"])
    assert updated["pageId"] is None

    with pytest.raises(ValidationError):
        StoryPanel.model_validate({
            "id": "free-image-block",
            "order": 0,
            "sourceKind": "bad-kind",
            "startOffset": None,
            "endOffset": None,
            "pageId": None,
            "panelKind": "image",
            "rect": {"x": 0, "y": 0, "w": DEFAULT_AUTO_PLACE_W, "h": DEFAULT_AUTO_PLACE_H},
            "layer": 0,
            "finalized": False,
        })


def test_story_panels_caption_panel_assignment(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Alpha opens the door.\n")

    created = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 0, "endOffset": 21, "selectedText": "Alpha opens the door."},
    )
    assert created.status_code == 200
    parent = next(panel for panel in created.json()["panels"] if panel["sourceKind"] == "panel" and panel["selectedText"] == "Alpha opens the door.")

    patched = client.patch(
        f"/api/projects/farm-comic/story-panels/panels/{parent['id']}",
        json={
            "pageId": parent["pageId"],
            "rect": parent["rect"],
        },
    )
    assert patched.status_code == 200

    document = patched.json()
    for panel in document["panels"]:
        if panel["id"] == parent["id"]:
            panel["captions"] = [
                {
                    "id": "panel-caption-001",
                    "visibleText": "Ponyville was busy.",
                    "richText": "",
                    "textStyle": {"fontFamily": "serif", "fontSize": 7, "align": "center"},
                    "rect": {"x": parent["rect"]["x"], "y": parent["rect"]["y"] + parent["rect"]["h"] + 0.25, "w": parent["rect"]["w"], "h": 1},
                    "layer": 1,
                }
            ]
    saved = client.put("/api/projects/farm-comic/story-panels", json=document)
    assert saved.status_code == 200
    saved_body = saved.json()
    saved_parent = next(panel for panel in saved_body["panels"] if panel["id"] == parent["id"])
    caption = saved_parent["captions"][0]
    assert caption["visibleText"] == "Ponyville was busy."

    saved_parent["captions"][0]["textStyle"] = {
        "fontFamily": "sans",
        "fontSize": 9,
        "align": "left",
        "speechKind": "narration",
        "background": "transparent",
        "color": "#1e40af",
        "outlineColor": "#eab308",
    }
    styled = client.put("/api/projects/farm-comic/story-panels", json=saved_body)
    assert styled.status_code == 200
    updated_parent = next(panel for panel in styled.json()["panels"] if panel["id"] == parent["id"])
    updated = updated_parent["captions"][0]["textStyle"]
    assert updated["speechKind"] == "narration"
    assert updated["background"] == "transparent"
    assert updated["color"] == "#1e40af"
    assert updated["outlineColor"] == "#eab308"


def test_story_panels_missing_book(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    response = client.get("/api/projects/farm-comic/story-panels/book")
    assert response.status_code == 200
    assert response.json()["text"] == ""

    document = client.get("/api/projects/farm-comic/story-panels").json()
    assert document["pages"]

    create = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 0, "endOffset": 5, "selectedText": "Alpha"},
    )
    assert create.status_code == 404

    draft = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "A brave pony stepped into the sun."},
    ).json()
    assert draft["panels"][-1]["sourceKind"] == "panel"
    assert draft["panels"][-1]["storyText"] == "A brave pony stepped into the sun."

    saved = client.put("/api/projects/farm-comic/story-panels", json=draft)
    assert saved.status_code == 200


def test_story_panels_draft_insert_after_panel(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    first = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "First panel."},
    ).json()
    first_panel = next(panel for panel in first["panels"] if panel["sourceKind"] == "panel" and panel["storyText"] == "First panel.")

    second = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "Second panel."},
    ).json()
    second_panel = next(panel for panel in second["panels"] if panel["storyText"] == "Second panel.")

    inserted = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "Between.", "insertAfterPanelId": first_panel["id"]},
    ).json()
    inserted_panel = next(panel for panel in inserted["panels"] if panel["storyText"] == "Between.")

    ordered = sorted(
        [panel for panel in inserted["panels"] if panel["sourceKind"] == "panel" and panel["storyText"] in {"First panel.", "Between.", "Second panel."}],
        key=lambda panel: panel["order"],
    )
    assert [panel["storyText"] for panel in ordered] == ["First panel.", "Between.", "Second panel."]
    assert inserted_panel["order"] == first_panel["order"] + 1
    assert second_panel["order"] + 1 == next(panel for panel in inserted["panels"] if panel["id"] == second_panel["id"])["order"]


def test_story_panels_draft_auto_place(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    unplaced = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "First panel.", "autoPlace": False},
    )
    assert unplaced.status_code == 200
    first = next(panel for panel in unplaced.json()["panels"] if panel["storyText"] == "First panel.")
    assert first["pageId"] is None

    placed = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "Second panel.", "autoPlace": True},
    )
    assert placed.status_code == 200
    second = next(panel for panel in placed.json()["panels"] if panel["storyText"] == "Second panel.")
    assert second["pageId"] == "page-001"
    assert second["rect"] == {"x": 0, "y": 0, "w": DEFAULT_AUTO_PLACE_W, "h": DEFAULT_AUTO_PLACE_H}

    stacked = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "Third panel.", "autoPlace": True},
    )
    assert stacked.status_code == 200
    third = next(panel for panel in stacked.json()["panels"] if panel["storyText"] == "Third panel.")
    assert third["pageId"] == "page-001"
    assert third["rect"] == {"x": DEFAULT_AUTO_PLACE_W, "y": 0, "w": DEFAULT_AUTO_PLACE_W, "h": DEFAULT_AUTO_PLACE_H}

    fourth = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "Fourth panel.", "autoPlace": True},
    )
    assert fourth.status_code == 200
    fourth_panel = next(panel for panel in fourth.json()["panels"] if panel["storyText"] == "Fourth panel.")
    assert fourth_panel["rect"] == {"x": DEFAULT_AUTO_PLACE_W * 2, "y": 0, "w": DEFAULT_AUTO_PLACE_W, "h": DEFAULT_AUTO_PLACE_H}

    fifth = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "Fifth panel.", "autoPlace": True},
    )
    assert fifth.status_code == 200
    fifth_panel = next(panel for panel in fifth.json()["panels"] if panel["storyText"] == "Fifth panel.")
    assert fifth_panel["rect"] == {"x": 0, "y": DEFAULT_AUTO_PLACE_H, "w": DEFAULT_AUTO_PLACE_W, "h": DEFAULT_AUTO_PLACE_H}

    sixth = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "Sixth panel.", "autoPlace": True},
    )
    assert sixth.status_code == 200
    sixth_panel = next(panel for panel in sixth.json()["panels"] if panel["storyText"] == "Sixth panel.")
    assert sixth_panel["rect"]["y"] == pytest.approx(DEFAULT_AUTO_PLACE_H)

    seventh = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "Seventh panel.", "autoPlace": True},
    )
    assert seventh.status_code == 200

    eighth = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "Eighth panel.", "autoPlace": True},
    )
    assert eighth.status_code == 200
    eighth_panel = next(panel for panel in eighth.json()["panels"] if panel["storyText"] == "Eighth panel.")
    assert eighth_panel["rect"]["y"] == pytest.approx(DEFAULT_AUTO_PLACE_H * 2)
    assert eighth_panel["rect"]["y"] + eighth_panel["rect"]["h"] == pytest.approx(LAYOUT_PAGE_ROWS)

    ninth = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "Ninth panel.", "autoPlace": True},
    )
    assert ninth.status_code == 200
    ninth_panel = next(panel for panel in ninth.json()["panels"] if panel["storyText"] == "Ninth panel.")
    assert ninth_panel["pageId"] == "page-001"
    assert ninth_panel["rect"]["x"] == pytest.approx(DEFAULT_AUTO_PLACE_W)
    assert ninth_panel["rect"]["y"] == pytest.approx(DEFAULT_AUTO_PLACE_H * 2)

    tenth = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "Tenth panel.", "autoPlace": True},
    )
    assert tenth.status_code == 200
    tenth_panel = next(panel for panel in tenth.json()["panels"] if panel["storyText"] == "Tenth panel.")
    assert tenth_panel["pageId"] == "page-001"
    assert tenth_panel["rect"]["x"] == pytest.approx(DEFAULT_AUTO_PLACE_W * 2)
    assert tenth_panel["rect"]["y"] == pytest.approx(DEFAULT_AUTO_PLACE_H * 2)
    assert tenth_panel["rect"]["y"] + tenth_panel["rect"]["h"] == pytest.approx(LAYOUT_PAGE_ROWS)

    eleventh = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "Eleventh panel.", "autoPlace": True},
    )
    assert eleventh.status_code == 200
    eleventh_panel = next(panel for panel in eleventh.json()["panels"] if panel["storyText"] == "Eleventh panel.")
    assert eleventh_panel["pageId"] == "page-002"
    assert eleventh_panel["rect"] == {"x": 0, "y": 0, "w": DEFAULT_AUTO_PLACE_W, "h": DEFAULT_AUTO_PLACE_H}


def test_story_panels_auto_place_existing_panel(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    first = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "First panel.", "autoPlace": True},
    )
    assert first.status_code == 200
    first_panel = next(panel for panel in first.json()["panels"] if panel["storyText"] == "First panel.")
    assert first_panel["pageId"] == "page-001"

    second = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "Second panel.", "autoPlace": False},
    )
    assert second.status_code == 200
    second_panel = next(panel for panel in second.json()["panels"] if panel["storyText"] == "Second panel.")
    assert second_panel["pageId"] is None

    placed = client.post(f"/api/projects/farm-comic/story-panels/panels/{second_panel['id']}/auto-place")
    assert placed.status_code == 200
    updated = next(panel for panel in placed.json()["panels"] if panel["id"] == second_panel["id"])
    assert updated["pageId"] == "page-001"
    assert updated["rect"] == {
        "x": DEFAULT_AUTO_PLACE_W,
        "y": 0,
        "w": DEFAULT_AUTO_PLACE_W,
        "h": DEFAULT_AUTO_PLACE_H,
    }

    already = client.post(f"/api/projects/farm-comic/story-panels/panels/{second_panel['id']}/auto-place")
    assert already.status_code == 400


def test_story_panels_create_panel_note_and_bookmark(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    book_text = "Chapter One\n\nThe air was warm.\n"
    (root / "book.txt").write_text(book_text)

    panel = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={
            "startOffset": 13,
            "endOffset": 30,
            "selectedText": "The air was warm.",
            "imagePrompts": [{"id": "prompt-001", "text": "Warm opening line."}],
        },
    )
    assert panel.status_code == 200
    story_panel = next(item for item in panel.json()["panels"] if item["sourceKind"] == "panel" and item["selectedText"] == "The air was warm.")
    assert story_panel["selectedText"] == "The air was warm."
    assert story_panel["storyText"] == "The air was warm."
    assert story_panel["imagePrompts"][0]["text"] == "Warm opening line."

    overlap = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={
            "startOffset": 13,
            "endOffset": 20,
            "selectedText": "The air",
        },
    )
    assert overlap.status_code == 400

    bookmark = client.post(
        "/api/projects/farm-comic/story-panels/panels/bookmark",
        json={
            "startOffset": 0,
            "endOffset": 11,
            "selectedText": "Chapter One",
        },
    )
    assert bookmark.status_code == 200
    bookmark_panel = next(item for item in bookmark.json()["panels"] if item["sourceKind"] == "bookmark")
    assert bookmark_panel["title"] == "Chapter One"
    assert bookmark_panel["pageId"] is None


def test_story_panels_legacy_note_loads_as_story(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Alpha.\n")
    document = client.get("/api/projects/farm-comic/story-panels").json()
    document["panels"].append(
        {
            "id": "panel-legacy-note",
            "order": 20,
            "sourceKind": "note",
            "startOffset": 0,
            "endOffset": 6,
            "selectedText": "Alpha.",
            "customText": "Legacy note.",
            "pageId": None,
            "panelKind": "text",
            "rect": {"x": 0, "y": 0, "w": DEFAULT_AUTO_PLACE_W, "h": DEFAULT_AUTO_PLACE_H},
            "layer": 0,
            "assetIds": [],
            "finalized": False,
        }
    )
    panels_path = library.project_dir("farm-comic") / "story-panels" / "panels.json"
    library.write_json(panels_path, document)
    loaded = client.get("/api/projects/farm-comic/story-panels").json()
    legacy = next(panel for panel in loaded["panels"] if panel["id"] == "panel-legacy-note")
    assert legacy["sourceKind"] == "panel"
    assert legacy["storyText"] == "Alpha."
    assert legacy["visibleText"] == "Legacy note."


def test_story_panels_insert_after_reorders_items(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Alpha. Beta. Gamma.\n")

    first = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 0, "endOffset": 6, "selectedText": "Alpha."},
    ).json()
    first_panel = next(panel for panel in first["panels"] if panel["sourceKind"] == "panel" and panel["selectedText"] == "Alpha.")

    second = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 7, "endOffset": 12, "selectedText": "Beta."},
    ).json()
    second_panel = next(panel for panel in second["panels"] if panel["sourceKind"] == "panel" and panel["id"] != first_panel["id"] and panel["selectedText"] == "Beta.")

    inserted = client.post(
        "/api/projects/farm-comic/story-panels/panels/bookmark",
        json={
            "startOffset": 13,
            "endOffset": 19,
            "selectedText": "Gamma.",
            "insertAfterPanelId": first_panel["id"],
        },
    )
    assert inserted.status_code == 200
    bookmark_panel = next(panel for panel in inserted.json()["panels"] if panel["title"] == "Gamma.")
    assert bookmark_panel["order"] == first_panel["order"] + 1
    assert next(panel for panel in inserted.json()["panels"] if panel["id"] == second_panel["id"])["order"] == second_panel["order"] + 1


def test_story_panels_create_uses_story_neighbor_page(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Alpha opens the door. Beta crosses the room. Gamma watches.\n")

    first = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 0, "endOffset": 21, "selectedText": "Alpha opens the door."},
    ).json()
    document = first
    story_panel = next(panel for panel in document["panels"] if panel["sourceKind"] == "panel" and panel["selectedText"] == "Alpha opens the door.")
    story_panel["pageId"] = "page-002"
    story_panel["rect"] = {"x": 0, "y": 4, "w": 6, "h": 3}
    saved = client.put("/api/projects/farm-comic/story-panels", json=document)
    assert saved.status_code == 200

    second = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 22, "endOffset": 44, "selectedText": "Beta crosses the room."},
    )
    assert second.status_code == 200
    created = next(panel for panel in second.json()["panels"] if panel["startOffset"] == 22)
    assert created["pageId"] == "page-002"
    assert created["rect"] == {
        "x": 6,
        "y": 4,
        "w": DEFAULT_AUTO_PLACE_W,
        "h": DEFAULT_AUTO_PLACE_H,
    }


def test_story_panels_allow_book_linked_panels_on_front_matter(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Alpha opens the door.\n")

    response = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 0, "endOffset": 21, "selectedText": "Alpha opens the door.", "pageId": "cover"},
    )
    assert response.status_code == 200
    panel = next(candidate for candidate in response.json()["panels"] if candidate["selectedText"] == "Alpha opens the door.")
    assert panel["pageId"] == "cover"


def test_story_panel_rect_rejects_layout_past_page_height():
    with pytest.raises(ValueError, match="page height grid"):
        StoryPanelRect(x=0, y=8, w=4, h=3)

    rect = StoryPanelRect(x=0, y=LAYOUT_PAGE_ROWS - 2, w=4, h=2)
    assert rect.y + rect.h == LAYOUT_PAGE_ROWS


def test_story_panels_caption_outline_offsets_match_css_shadow():
    offsets = story_panels_print._caption_outline_offsets()

    assert len(offsets) == 8
    assert set(offsets) == {
        (-0.75, 0.75),
        (0.75, 0.75),
        (-0.75, -0.75),
        (0.75, -0.75),
        (0, 0.75),
        (0, -0.75),
        (-0.75, 0),
        (0.75, 0),
    }


def test_story_panels_image_crop_box_matches_object_position():
    crop = StoryPanelImageCrop(focalX=0.25, focalY=0.75, scale=2)
    # Wide source on a square panel: cover window 800×800, zoom 2× → 400×400.
    assert story_panels_print._source_crop_box(crop, 1200, 800, 1.0) == (200, 300, 600, 700)

    centered = StoryPanelImageCrop(focalX=0.5, focalY=0.5, scale=1)
    # Same as centering when focal is 0.5.
    assert story_panels_print._source_crop_box(centered, 1000, 800, 1.0) == (100, 0, 900, 800)


def test_story_panels_booklet_imposition_order():
    # Reading order: 1=cover ... 5=back cover. Padding must keep 5 last for saddle stitch.
    pages = [story_panels_print.PrintPage(page=None, number=index) for index in range(1, 6)]
    padded = story_panels_print.padded_booklet_pages(pages)
    assert [page.number for page in padded] == [1, 2, 3, 4, None, None, None, 5]

    sheets = story_panels_print.impose_booklet_pages(pages)
    assert len(sheets) == 2
    assert (
        sheets[0].front_left.number,
        sheets[0].front_right.number,
        sheets[0].back_left.number,
        sheets[0].back_right.number,
    ) == (5, 1, 2, None)
    assert (
        sheets[1].front_left.number,
        sheets[1].front_right.number,
        sheets[1].back_left.number,
        sheets[1].back_right.number,
    ) == (None, 3, 4, None)


def test_story_panels_booklet_imposition_keeps_back_cover_outside():
    document = story_panels.empty_document()
    pages = story_panels_print.story_pages(document)
    assert len(pages) == 8
    padded = story_panels_print.padded_booklet_pages(pages)
    assert len(padded) == 8
    assert padded[-1].page is not None and padded[-1].page.pageKind == "back-cover"
    assert padded[0].page is not None and padded[0].page.pageKind == "cover"
    outer = story_panels_print.impose_booklet_pages(pages)[0]
    assert outer.front_right.page is not None and outer.front_right.page.pageKind == "cover"
    assert outer.front_left.page is not None and outer.front_left.page.pageKind == "back-cover"


def test_story_panels_booklet_pdf_page_border_options(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Alpha opens the door.\n")

    for border in ("black", "grey", "none"):
        response = client.get(f"/api/projects/farm-comic/story-panels/print/booklet.pdf?pageBorder={border}")
        assert response.status_code == 200
        assert response.content.startswith(b"%PDF")

    rejected = client.get("/api/projects/farm-comic/story-panels/print/booklet.pdf?pageBorder=purple")
    assert rejected.status_code == 422


def test_story_panels_booklet_pdf_endpoint(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Alpha opens the door. Beta crosses the room. Gamma watches.\n")

    created = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"startOffset": 0, "endOffset": 21, "selectedText": "Alpha opens the door."},
    )
    assert created.status_code == 200
    document = created.json()
    story_panel = next(panel for panel in document["panels"] if panel["sourceKind"] == "panel" and panel["selectedText"] == "Alpha opens the door.")
    story_panel["panelKind"] = "text"
    story_panel["visibleText"] = "Custom caption text."
    story_panel["richText"] = "<strong>Custom</strong> <em>caption</em> <u>text.</u>"
    story_panel["textStyle"] = {"fontFamily": "sans", "fontSize": 10, "align": "center"}
    saved = client.put("/api/projects/farm-comic/story-panels", json=document)
    assert saved.status_code == 200

    response = client.get("/api/projects/farm-comic/story-panels/print/booklet.pdf")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert "farm-comic-comic-booklet.pdf" in response.headers["content-disposition"]
    assert response.content.startswith(b"%PDF")


def test_style_ref_status_clears_stale_asset_and_repairs_canvas(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    (root / "style-refs").mkdir(parents=True, exist_ok=True)
    (root / "style-refs" / "archetype-character.md").write_text("Character archetype prompt.\n")
    stale_asset_id = "01HSTALE"
    library.write_json(
        root / "adaptation.json",
        {
            "version": 2,
            "settings": {"storyKind": "comic-book"},
            "styleRefs": {"archetypeCharacterAssetId": stale_asset_id},
            "characters": {},
            "locations": {},
            "scenes": {},
            "pages": {},
            "panels": {},
        },
    )
    canvas = {
        "version": 2,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "nodes": {
            "archetype_archetype_character": {
                "type": "imageGroup",
                "displayName": "Old wrong node",
                "x": 1,
                "y": 2,
                "assetIds": [stale_asset_id],
                "activeAssetId": stale_asset_id,
                "tags": ["adaptation", "archetype", "character-style"],
            },
            "archetype_archetype_character_image": {
                "type": "imageGroup",
                "displayName": "Stale image",
                "x": 1,
                "y": 320,
                "assetIds": [stale_asset_id],
                "activeAssetId": stale_asset_id,
                "tags": ["adaptation", "archetype", "character-style"],
            },
        },
    }
    library.write_json(library.canvas_json_path("farm-comic"), canvas)

    status = client.get("/api/projects/farm-comic/adaptation")
    assert status.status_code == 200
    assert status.json()["styleRefStatuses"]["archetype-character"]["assetId"] is None

    sync = client.put(
        "/api/projects/farm-comic/adaptation/style-ref-prompt",
        json={"kind": "archetype-character", "prompt": "Character archetype prompt."},
    )
    assert sync.status_code == 200
    nodes = client.get("/api/projects/farm-comic/canvas").json()["nodes"]
    draft = nodes["archetype_archetype_character"]
    assert draft["type"] == "draft"
    assert draft["role"] == {"type": "style-ref-source", "kind": "archetype-character"}
    assert draft["prompt"] == "Character archetype prompt.\n"
    assert "missing" in draft["tags"]
    assert "archetype_archetype_character_image" not in nodes


def test_new_project_seeds_default_crayons_visual_style(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    status = client.get("/api/projects/farm-comic/adaptation")
    assert status.status_code == 200
    styles = status.json()["visualStyles"]
    assert len(styles) == 1
    assert styles[0]["id"] == "crayons"
    assert styles[0]["name"] == "crayons"
    assert styles[0]["default"] is True
    assert status.json()["defaultVisualStyleId"] == "crayons"
    assert "hand-drawn crayon" in styles[0]["prompt"].lower()


def test_visual_styles_crud_and_generate_composition(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    created = client.post(
        "/api/projects/farm-comic/adaptation/visual-styles",
        json={"name": "Watercolor", "prompt": "Style: soft wash\nColor palette: pastels\n"},
    )
    assert created.status_code == 200
    styles = created.json()["visualStyles"]
    assert len(styles) == 2
    style_id = visual_style_id_by_name(styles, "Watercolor")
    assert styles[0]["name"] == "crayons"
    assert next(style for style in styles if style["name"] == "Watercolor")["default"] is False
    assert created.json()["defaultVisualStyleId"] == "crayons"

    updated = client.patch(
        f"/api/projects/farm-comic/adaptation/visual-styles/{style_id}",
        json={"name": "Soft Watercolor"},
    )
    assert updated.status_code == 200
    assert visual_style_id_by_name(updated.json()["visualStyles"], "Soft Watercolor") == style_id
    assert updated.json()["defaultVisualStyleId"] == "crayons"

    second = client.post(
        "/api/projects/farm-comic/adaptation/visual-styles",
        json={"name": "Ink", "prompt": "Style: ink lines\n"},
    )
    assert second.status_code == 200
    ink_id = next(style["id"] for style in second.json()["visualStyles"] if style["name"] == "Ink")
    assert second.json()["defaultVisualStyleId"] == "crayons"

    set_default = client.patch(
        f"/api/projects/farm-comic/adaptation/visual-styles/{ink_id}",
        json={"default": True},
    )
    assert set_default.status_code == 200
    assert set_default.json()["defaultVisualStyleId"] == ink_id
    assert sum(1 for style in set_default.json()["visualStyles"] if style.get("default")) == 1

    captured = {}

    def fake_generate(**kwargs):
        captured["prompt_text"] = kwargs["prompt_text"]
        make_png(kwargs["output_png"], color="blue")

        class Result:
            provider_response = {"imageFile": kwargs["output_png"].name, "response": {"candidates": [{"finishReason": "STOP"}]}}

        return Result()

    monkeypatch.setattr(gemini, "generate_image", fake_generate)
    generated = client.post(
        "/api/projects/farm-comic/generate",
        json={
            "prompt": "A red barn",
            "refs": [],
            "seed": 7,
            "batchCount": 1,
            "tags": [],
            "visualStyleId": style_id,
        },
    )
    assert generated.status_code == 200
    assert "A red barn" in captured["prompt_text"]
    assert "soft wash" in captured["prompt_text"].lower()
    asset = generated.json()["assets"][0]
    assert asset["prompt"]["text"] == "A red barn"
    assert asset["generation"]["visualStyleId"] == style_id

    deleted = client.delete(f"/api/projects/farm-comic/adaptation/visual-styles/{style_id}")
    assert deleted.status_code == 200
    assert len(deleted.json()["visualStyles"]) == 2
    assert deleted.json()["defaultVisualStyleId"] == ink_id

    deleted_ink = client.delete(f"/api/projects/farm-comic/adaptation/visual-styles/{ink_id}")
    assert deleted_ink.status_code == 200
    assert len(deleted_ink.json()["visualStyles"]) == 1
    assert deleted_ink.json()["visualStyles"][0]["name"] == "crayons"
    assert deleted_ink.json()["defaultVisualStyleId"] == "crayons"

    missing = client.post(
        "/api/projects/farm-comic/generate",
        json={"prompt": "no style", "refs": [], "batchCount": 1, "tags": [], "visualStyleId": style_id},
    )
    assert missing.status_code == 404


def test_style_ref_import_set_generate_share_metadata_and_canvas_contract(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    (root / "style-refs").mkdir(parents=True, exist_ok=True)
    (root / "style-refs" / "archetype-character.md").write_text("Character archetype prompt.\n")

    imported_asset_id = "01HIMPORT"
    make_png(library.asset_png_path("farm-comic", imported_asset_id), color="green")
    library.write_json(
        library.asset_json_path("farm-comic", imported_asset_id),
        {
            "id": imported_asset_id,
            "kind": "imported",
            "title": "Character archetype",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )
    imported = client.post(
        "/api/projects/farm-comic/adaptation/style-ref-asset",
        json={"kind": "archetype-character", "assetId": imported_asset_id},
    )
    assert imported.status_code == 200
    assert imported.json()["styleRefStatuses"]["archetype-character"]["assetId"] == imported_asset_id
    canvas_nodes = client.get("/api/projects/farm-comic/canvas").json()["nodes"]
    assert imported.json()["styleRefStatuses"]["archetype-character"]["canvasDraftNodeId"] == "archetype_archetype_character"
    assert imported.json()["styleRefStatuses"]["archetype-character"]["canvasImageNodeId"] == "generated_archetype_archetype_character"
    assert canvas_nodes["archetype_archetype_character"]["type"] == "draft"
    assert canvas_nodes["archetype_archetype_character"]["role"] == {"type": "style-ref-source", "kind": "archetype-character"}
    assert canvas_nodes["generated_archetype_archetype_character"]["type"] == "imageGroup"
    assert canvas_nodes["generated_archetype_archetype_character"]["activeAssetId"] == imported_asset_id
    assert canvas_nodes["generated_archetype_archetype_character"]["role"] == {"type": "generated-result", "sourceNodeId": "archetype_archetype_character"}
    assert "archetype_archetype_character_image" not in canvas_nodes

    replacement_asset_id = "01HREPLACE"
    make_png(library.asset_png_path("farm-comic", replacement_asset_id), color="blue")
    library.write_json(
        library.asset_json_path("farm-comic", replacement_asset_id),
        {
            "id": replacement_asset_id,
            "kind": "imported",
            "title": "Replacement",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )
    selected = client.post(
        "/api/projects/farm-comic/adaptation/style-ref-asset",
        json={"kind": "archetype-character", "assetId": replacement_asset_id},
    )
    assert selected.status_code == 200
    assert selected.json()["styleRefStatuses"]["archetype-character"]["assetId"] == replacement_asset_id
    canvas_nodes = client.get("/api/projects/farm-comic/canvas").json()["nodes"]
    assert canvas_nodes["archetype_archetype_character"]["type"] == "draft"
    assert canvas_nodes["generated_archetype_archetype_character"]["activeAssetId"] == replacement_asset_id
    assert "archetype_archetype_character_image" not in canvas_nodes

    captured = {}

    def fake_generate(**kwargs):
        captured["prompt"] = kwargs["prompt_text"]
        make_png(kwargs["output_png"], color="purple")

        class Result:
            provider_response = {"imageFile": kwargs["output_png"].name, "response": {"candidates": [{"finishReason": "STOP"}]}}

        return Result()

    monkeypatch.setattr(gemini, "generate_image", fake_generate)
    style_created = client.post(
        "/api/projects/farm-comic/adaptation/visual-styles",
        json={"name": "Ink wash", "prompt": "Style: Ink wash style.\n"},
    )
    assert style_created.status_code == 200
    style_id = visual_style_id_by_name(style_created.json()["visualStyles"], "Ink wash")
    missing_style = client.post(
        "/api/projects/farm-comic/adaptation/generate-style-ref",
        json={"kind": "archetype-character"},
    )
    assert missing_style.status_code == 400
    generated = client.post(
        "/api/projects/farm-comic/adaptation/generate-style-ref",
        json={"kind": "archetype-character", "visualStyleId": style_id},
    )
    assert generated.status_code == 200
    generated_asset_id = generated.json()["asset"]["id"]
    assert "Character archetype prompt." in captured["prompt"]
    assert "ink wash" in captured["prompt"].lower()
    assert generated.json()["status"]["styleRefStatuses"]["archetype-character"]["assetId"] == generated_asset_id
    canvas_nodes = client.get("/api/projects/farm-comic/canvas").json()["nodes"]
    assert canvas_nodes["archetype_archetype_character"]["type"] == "draft"
    assert canvas_nodes["generated_archetype_archetype_character"]["type"] == "imageGroup"
    assert canvas_nodes["generated_archetype_archetype_character"]["activeAssetId"] == generated_asset_id
    assert "archetype_archetype_character_image" not in canvas_nodes
    def sync_via_prompt_put():
        response = client.put(
            "/api/projects/farm-comic/adaptation/style-ref-prompt",
            json={"kind": "archetype-character", "prompt": "Character archetype prompt."},
        )
        assert response.status_code == 200
        return client.get("/api/projects/farm-comic/canvas").json()["nodes"]

    first_sync = sync_via_prompt_put()
    second_sync = sync_via_prompt_put()
    assert first_sync == second_sync
    missing_source_canvas = client.get("/api/projects/farm-comic/canvas").json()
    missing_source_canvas["nodes"].pop("archetype_archetype_character")
    assert client.put("/api/projects/farm-comic/canvas", json=missing_source_canvas).status_code == 200
    repaired_nodes = sync_via_prompt_put()
    assert repaired_nodes["archetype_archetype_character"]["type"] == "draft"
    assert repaired_nodes["archetype_archetype_character"]["role"] == {"type": "style-ref-source", "kind": "archetype-character"}

    delete_child = client.delete(f"/api/projects/farm-comic/assets/{generated_asset_id}")
    assert delete_child.status_code == 204
    assert (root / "style-refs" / "archetype-character.md").read_text() == "Character archetype prompt.\n"
    assert client.get("/api/projects/farm-comic/adaptation").json()["styleRefStatuses"]["archetype-character"]["assetId"] is None


def test_style_ref_sync_preserves_visual_style_selection(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    (root / "style-refs").mkdir(parents=True, exist_ok=True)
    (root / "style-refs" / "archetype-character.md").write_text("Character archetype prompt.\n")
    style_id = visual_style_id_by_name(
        client.post(
            "/api/projects/farm-comic/adaptation/visual-styles",
            json={"name": "Crayon", "prompt": "Style: crayon\n"},
        ).json()["visualStyles"],
        "Crayon",
    )
    synced = client.put(
        "/api/projects/farm-comic/adaptation/style-ref-prompt",
        json={"kind": "archetype-character", "prompt": "Character archetype prompt."},
    )
    assert synced.status_code == 200
    canvas = client.get("/api/projects/farm-comic/canvas").json()
    assert canvas["nodes"]["archetype_archetype_character"]["type"] == "draft"
    canvas["nodes"]["archetype_archetype_character"]["visualStyleId"] = style_id
    assert client.put("/api/projects/farm-comic/canvas", json=canvas).status_code == 200
    resynced = client.put(
        "/api/projects/farm-comic/adaptation/style-ref-prompt",
        json={"kind": "archetype-character", "prompt": "Character archetype prompt."},
    )
    assert resynced.status_code == 200
    nodes = client.get("/api/projects/farm-comic/canvas").json()["nodes"]
    assert nodes["archetype_archetype_character"]["visualStyleId"] == style_id


def test_import_artifact_to_canvas_creates_empty_image_group(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    style_ref_id = "01HARCH"
    make_png(library.asset_png_path("farm-comic", style_ref_id), color="blue")
    library.write_json(
        library.asset_json_path("farm-comic", style_ref_id),
        {
            "id": style_ref_id,
            "kind": "imported",
            "title": "Archetype character",
            "tags": ["archetype", "character-style"],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )
    metadata = adaptation.read_metadata("farm-comic")
    metadata.styleRefs.archetypeCharacterAssetId = style_ref_id
    adaptation.write_metadata("farm-comic", metadata)

    character = client.post(
        "/api/projects/farm-comic/adaptation/files/characters",
        json={
            "key": "hero",
            "mode": "new-image",
            "styleRef": "",
            "body": "Full body character sheet for the farm hero.",
        },
    )
    assert character.status_code == 200

    updated = client.put(
        "/api/projects/farm-comic/adaptation/files/characters/hero",
        json={
            "body": "Full body character sheet for the farm hero.",
            "mode": "new-image",
            "styleRef": "",
        },
    )
    assert updated.status_code == 200

    imported = client.post(
        "/api/projects/farm-comic/adaptation/import-artifact-to-canvas",
        json={"artifactKind": "character-sheet", "artifactKey": "hero"},
    )
    assert imported.status_code == 200
    node_id = imported.json()["nodeId"]
    assert imported.json()["canvas"]["nodes"][node_id]["type"] == "imageGroup"
    assert imported.json()["canvas"]["nodes"][node_id]["assetIds"] == []


def test_chat_session_create_list_archive_and_protect_source(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    asset_id = "01HSOURCE"
    make_png(library.asset_png_path("farm-comic", asset_id), color="green")
    library.write_json(
        library.asset_json_path("farm-comic", asset_id),
        {
            "id": asset_id,
            "kind": "imported",
            "title": "Source",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )

    response = client.post(
        "/api/projects/farm-comic/chat-sessions",
        json={"sourceAssetId": asset_id, "canvasNodeId": "node_source", "title": "Jacket refinements"},
    )
    assert response.status_code == 200
    session = response.json()
    assert session["source"]["assetId"] == asset_id
    assert session["protectedAssetIds"] == [asset_id]
    assert session["provider"]["history"] == []
    assert chat_sessions.session_json_path("farm-comic", session["id"]).is_file()

    assets = client.get("/api/projects/farm-comic/assets").json()
    assert assets[0]["isProtected"] is True
    delete_response = client.delete(f"/api/projects/farm-comic/assets/{asset_id}")
    assert delete_response.status_code == 409
    assert session["id"] in delete_response.text

    archive_response = client.patch(
        f"/api/projects/farm-comic/chat-sessions/{session['id']}",
        json={"archived": True},
    )
    assert archive_response.status_code == 200
    assert archive_response.json()["archivedAt"] is not None
    assert client.get("/api/projects/farm-comic/chat-sessions").json() == []
    assert len(client.get("/api/projects/farm-comic/chat-sessions?includeArchived=true").json()) == 1


def test_agent_sessions_empty_without_book(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    response = client.get("/api/projects/farm-comic/agent-sessions")

    assert response.status_code == 200
    assert response.json() == []


def test_agent_sessions_trace_and_archive(tmp_path, monkeypatch):
    import agent_sessions

    client = setup_tmp_library(tmp_path, monkeypatch)
    monkeypatch.setattr(workflow_config, "LIBRARY_ROOT", library.LIBRARY_ROOT)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Once upon a time.\n")
    pi_session_file = root / "sessions" / "pi" / "agent-trace.jsonl"
    pi_session_file.parent.mkdir(parents=True, exist_ok=True)
    pi_session_file.write_text(
        "\n".join(
            [
                '{"type":"session","version":3,"id":"agent-trace-session","timestamp":"2026-03-12T18:59:01.267Z","cwd":"/tmp"}',
                '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-03-12T19:03:58.674Z","message":{"role":"user","content":[{"type":"text","text":"Who is the fox?"}]}}',
                '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-03-12T19:04:05.888Z","message":{"role":"assistant","provider":"openai","model":"gpt-test","usage":{"input":10,"output":5},"content":[{"type":"text","text":"The fox."}]}}',
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    created = agent_sessions.create_session(
        "farm-comic", kind="read-book", title="Read book", status="succeeded"
    )
    agent_sessions.update_session(
        "farm-comic",
        created.id,
        pi_session_id="agent-trace-session",
        pi_session_file=str(pi_session_file.resolve()),
    )

    sessions = client.get("/api/projects/farm-comic/agent-sessions")
    assert sessions.status_code == 200
    session = sessions.json()[0]
    assert session["id"] == created.id
    assert session["kind"] == "read-book"
    assert session["piSessionId"] == "agent-trace-session"

    trace = client.get(f"/api/projects/farm-comic/agent-sessions/{created.id}/trace")
    assert trace.status_code == 200
    assert trace.json()["sessionId"] == "agent-trace-session"
    assert trace.json()["steps"][1]["text"] == "The fox."

    archived = client.patch(f"/api/projects/farm-comic/agent-sessions/{created.id}", json={"archived": True})
    assert archived.status_code == 200
    assert archived.json()["status"] == "archived"
    assert client.get("/api/projects/farm-comic/agent-sessions").json() == []
    assert len(client.get("/api/projects/farm-comic/agent-sessions?includeArchived=true").json()) == 1


def test_asset_archive_hides_from_default_lists_and_canvas(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    asset_id = "01HARCHIVE"
    make_png(library.asset_png_path("farm-comic", asset_id), color="red")
    library.write_json(
        library.asset_json_path("farm-comic", asset_id),
        {
            "id": asset_id,
            "kind": "imported",
            "title": "Archive me",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )

    response = client.patch(
        f"/api/projects/farm-comic/assets/{asset_id}/archive",
        json={"archived": True},
    )
    assert response.status_code == 200
    assert response.json()["archivedAt"] is not None
    assert client.get("/api/projects/farm-comic/assets").json() == []
    assert len(client.get("/api/projects/farm-comic/assets?includeArchived=true").json()) == 1
    nodes = client.get("/api/projects/farm-comic/canvas").json()["nodes"]
    assert set(nodes) == {library.DEFAULT_STARTER_DRAFT_NODE_ID}
    archived_canvas_nodes = client.get("/api/projects/farm-comic/canvas?includeArchived=true").json()["nodes"]
    assert any(asset_id in node.get("assetIds", []) for node in archived_canvas_nodes.values())

    restore_response = client.patch(
        f"/api/projects/farm-comic/assets/{asset_id}/archive",
        json={"archived": False},
    )
    assert restore_response.status_code == 200
    assert restore_response.json()["archivedAt"] is None
    restored_nodes = client.get("/api/projects/farm-comic/canvas").json()["nodes"]
    assert any(asset_id in node.get("assetIds", []) for node in restored_nodes.values())


def test_archive_preserves_canvas_group_name_and_cover(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    asset_id = "01HGROUPNAME"
    make_png(library.asset_png_path("farm-comic", asset_id), color="blue")
    library.write_json(
        library.asset_json_path("farm-comic", asset_id),
        {
            "id": asset_id,
            "kind": "imported",
            "title": "Asset title",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )
    node_id = library.canvas_node_id(asset_id)
    canvas = client.get("/api/projects/farm-comic/canvas").json()
    canvas["nodes"][node_id] = {
        "type": "imageGroup",
        "displayName": "My scene board",
        "x": 420,
        "y": 180,
        "tags": ["panel"],
        "assetIds": [asset_id],
        "activeAssetId": asset_id,
    }
    assert client.put("/api/projects/farm-comic/canvas", json=canvas).status_code == 200
    assert client.patch("/api/projects/farm-comic", json={"coverAssetId": asset_id}).status_code == 200

    archive_response = client.patch(
        f"/api/projects/farm-comic/assets/{asset_id}/archive",
        json={"archived": True},
    )
    assert archive_response.status_code == 200

    stored_canvas = library.read_stored_canvas("farm-comic")
    stored_node = stored_canvas.nodes[node_id]
    assert stored_node.displayName == "My scene board"
    assert stored_node.assetIds == [asset_id]
    assert client.get("/api/projects/farm-comic").json()["project"]["coverAssetId"] == asset_id

    restore_response = client.patch(
        f"/api/projects/farm-comic/assets/{asset_id}/archive",
        json={"archived": False},
    )
    assert restore_response.status_code == 200

    restored_canvas = library.read_stored_canvas("farm-comic")
    restored_node = restored_canvas.nodes[node_id]
    assert restored_node.displayName == "My scene board"
    assert restored_node.assetIds == [asset_id]
    assert client.get("/api/projects/farm-comic").json()["project"]["coverAssetId"] == asset_id
    visible_nodes = client.get("/api/projects/farm-comic/canvas").json()["nodes"]
    assert visible_nodes[node_id]["displayName"] == "My scene board"


def test_chat_turn_persists_history_blobs_and_generated_asset(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    source_id = "01HSOURCE"
    make_png(library.asset_png_path("farm-comic", source_id), color="green")
    library.write_json(
        library.asset_json_path("farm-comic", source_id),
        {
            "id": source_id,
            "kind": "imported",
            "title": "Source",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
        },
    )
    canvas = client.get("/api/projects/farm-comic/canvas").json()
    source_node_id = next(iter(canvas["nodes"]))
    session = client.post(
        "/api/projects/farm-comic/chat-sessions",
        json={"sourceAssetId": source_id, "canvasNodeId": source_node_id},
    ).json()

    def fake_chat(**kwargs):
        assert kwargs["history"] == []
        assert kwargs["message_parts"][0]["text"] == "make it cinematic"
        assert "data" in kwargs["message_parts"][1]["inline_data"]
        image_data = png_bytes("blue")
        encoded = base64.b64encode(image_data).decode("ascii")
        response = {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [
                            {"text": "Done", "thought_signature": "sig-text"},
                            {
                                "inline_data": {
                                    "mime_type": "image/png",
                                    "data": encoded,
                                },
                                "thought_signature": "sig-image",
                            },
                        ],
                    }
                }
            ]
        }
        return gemini.chat_turn_result_from_response(response)

    monkeypatch.setattr(gemini, "send_chat_turn", fake_chat)
    response = client.post(
        f"/api/projects/farm-comic/chat-sessions/{session['id']}/turns",
        json={"text": "make it cinematic"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert len(payload["assets"]) == 1
    asset = payload["assets"][0]
    assert asset["generation"]["chatSessionId"] == session["id"]
    assert asset["generation"]["chatTurnId"] == payload["session"]["turns"][1]["id"]
    stripped_data = asset["provider"]["response"]["response"]["candidates"][0]["content"]["parts"][1]["inline_data"]["data"]
    assert stripped_data.startswith("<inline-image-data:")
    assert stripped_data.endswith(" chars>")
    stored = chat_sessions.read_session("farm-comic", session["id"])
    assert stored.provider.history[1]["parts"][0]["thought_signature"] == "sig-text"
    image_part = stored.provider.history[1]["parts"][1]
    assert image_part["thought_signature"] == "sig-image"
    assert image_part["inline_data"]["data_ref"].startswith("blobs/")
    assert chat_sessions.read_blob("farm-comic", session["id"], image_part["inline_data"]["data_ref"]).startswith(b"\x89PNG")
    canvas_after = client.get("/api/projects/farm-comic/canvas").json()
    chat_nodes = [node for node in canvas_after["nodes"].values() if node["type"] == "imageGroup" and asset["id"] in node["assetIds"]]
    assert len(chat_nodes) == 1


def test_generate_rejects_unsupported_model_image_size(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    response = client.post(
        "/api/projects/farm-comic/generate",
        json={
            "prompt": "blue square",
            "refs": [],
            "model": "gemini-3-pro-image",
            "aspectRatio": "16:9",
            "imageSize": "512",
            "batchCount": 1,
            "tags": [],
        },
    )
    assert response.status_code == 422
    assert "Unsupported image size" in response.text


def test_generate_with_mocked_boundary_persists_receipt(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    def fake_generate(**kwargs):
        make_png(kwargs["output_png"], color="blue")

        class Result:
            provider_response = {
                "imageFile": kwargs["output_png"].name,
                "response": {"candidates": [{"finishReason": "STOP"}]},
            }

        return Result()

    monkeypatch.setattr(gemini, "generate_image", fake_generate)
    response = client.post(
        "/api/projects/farm-comic/generate",
        json={
            "prompt": "blue square",
            "refs": [],
            "seed": 42,
            "batchCount": 2,
            "tags": ["test"],
        },
    )
    assert response.status_code == 200
    assets = response.json()["assets"]
    assert len(assets) == 2
    assert assets[0]["generation"]["seed"] == 42
    assert assets[1]["generation"]["seed"] == 43
    assert assets[0]["generation"]["runId"] == assets[1]["generation"]["runId"]
    assert assets[0]["provider"]["response"]["response"]["candidates"][0]["finishReason"] == "STOP"


def test_generate_from_draft_updates_canvas_group(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    canvas = {
        "version": 2,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "nodes": {
            "draft_1": {
                "type": "draft",
                "displayName": "Blue square candidates",
                "x": 10,
                "y": 20,
                "refs": [],
                "prompt": "blue square",
                "params": {"aspectRatio": "1:1", "imageSize": "1K", "seed": 7, "batchCount": 2},
            }
        },
    }
    assert client.put("/api/projects/farm-comic/canvas", json=canvas).status_code == 200

    def fake_generate(**kwargs):
        make_png(kwargs["output_png"], color="blue")

        class Result:
            provider_response = {"imageFile": kwargs["output_png"].name, "response": {"candidates": [{"finishReason": "STOP"}]}}

        return Result()

    monkeypatch.setattr(gemini, "generate_image", fake_generate)
    response = client.post(
        "/api/projects/farm-comic/generate",
        json={"prompt": "blue square", "refs": [], "seed": 7, "batchCount": 2, "tags": [], "canvasNodeId": "draft_1"},
    )
    assert response.status_code == 200
    canvas_response = client.get("/api/projects/farm-comic/canvas").json()
    node = canvas_response["nodes"]["draft_1"]
    assert node["type"] == "imageGroup"
    assert node["displayName"] == "Blue square candidates"
    assert len(node["assetIds"]) == 2
    assert node["activeAssetId"] == node["assetIds"][0]
    assert list(canvas_response["nodes"].keys()) == ["draft_1"]


def test_generate_matching_prompt_and_refs_merges_into_existing_group(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    def fake_generate(**kwargs):
        make_png(kwargs["output_png"], color="blue")

        class Result:
            provider_response = {"imageFile": kwargs["output_png"].name, "response": {"candidates": [{"finishReason": "STOP"}]}}

        return Result()

    monkeypatch.setattr(gemini, "generate_image", fake_generate)
    first = client.post(
        "/api/projects/farm-comic/generate",
        json={"prompt": "same scene", "refs": [], "seed": 1, "batchCount": 1, "tags": [], "canvasNodeId": "draft_1"},
    )
    assert first.status_code == 200

    canvas = client.get("/api/projects/farm-comic/canvas").json()
    canvas["nodes"]["draft_2"] = {
        "type": "draft",
        "displayName": "Draft",
        "x": 50,
        "y": 60,
        "refs": [],
        "prompt": "same scene",
        "params": {"aspectRatio": "4:3", "imageSize": "1K", "seed": 2, "batchCount": 1},
    }
    assert client.put("/api/projects/farm-comic/canvas", json=canvas).status_code == 200

    second = client.post(
        "/api/projects/farm-comic/generate",
        json={"prompt": "same scene", "refs": [], "seed": 2, "batchCount": 1, "tags": [], "canvasNodeId": "draft_2"},
    )
    assert second.status_code == 200

    next_canvas = client.get("/api/projects/farm-comic/canvas").json()
    assert "draft_1" in next_canvas["nodes"]
    assert "draft_2" not in next_canvas["nodes"]
    node = next_canvas["nodes"]["draft_1"]
    assert node["type"] == "imageGroup"
    assert len(node["assetIds"]) == 2


def test_generate_variants_appends_to_existing_image_group(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    def fake_generate(**kwargs):
        make_png(kwargs["output_png"], color="blue")

        class Result:
            provider_response = {"imageFile": kwargs["output_png"].name, "response": {"candidates": [{"finishReason": "STOP"}]}}

        return Result()

    monkeypatch.setattr(gemini, "generate_image", fake_generate)
    first = client.post(
        "/api/projects/farm-comic/generate",
        json={"prompt": "same child", "refs": [], "seed": 1, "batchCount": 1, "tags": [], "canvasNodeId": "node_1", "title": "Child"},
    )
    assert first.status_code == 200
    first_asset = first.json()["assets"][0]["id"]

    second = client.post(
        "/api/projects/farm-comic/generate",
        json={"prompt": "same child", "refs": [], "seed": 2, "batchCount": 2, "tags": [], "canvasNodeId": "node_1", "title": "Child"},
    )
    assert second.status_code == 200

    canvas = client.get("/api/projects/farm-comic/canvas").json()
    assert "node_1" in canvas["nodes"]
    node = canvas["nodes"]["node_1"]
    assert node["displayName"] == "Child"
    assert len(node["assetIds"]) == 3
    assert node["assetIds"][0] == first_asset
    assert node["activeAssetId"] == node["assetIds"][1]


def test_read_canvas_normalizes_stale_duplicate_variant_nodes(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    first_id = "01HGEN1"
    second_id = "01HGEN2"
    for asset_id, seed in [(first_id, 1), (second_id, 2)]:
        make_png(library.asset_png_path("farm-comic", asset_id), color="blue")
        library.write_json(
            library.asset_json_path("farm-comic", asset_id),
            {
                "id": asset_id,
                "kind": "generated",
                "title": f"Generated {asset_id}",
                "tags": [],
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "prompt": {"text": "same scene"},
                "generation": {
                    "refs": [],
                    "runId": f"01HRUN{seed}",
                    "runIndex": 0,
                    "model": "gemini-3.1-flash-image",
                    "aspectRatio": "16:9" if seed == 1 else "4:3",
                    "imageSize": "1K",
                    "seed": seed,
                },
                "provider": {"name": "google-genai", "response": {}},
            },
        )
    library.write_json(
        library.canvas_json_path("farm-comic"),
        {
            "version": 2,
            "viewport": {"x": 0, "y": 0, "zoom": 1},
            "nodes": {
                "node_a": {
                    "type": "imageGroup",
                    "displayName": "Generated 1",
                    "x": 10,
                    "y": 20,
                    "assetIds": [first_id],
                    "activeAssetId": first_id,
                },
                "node_b": {
                    "type": "imageGroup",
                    "displayName": "Generated 2",
                    "x": 30,
                    "y": 40,
                    "assetIds": [second_id],
                    "activeAssetId": second_id,
                },
            },
        },
    )

    response = client.get("/api/projects/farm-comic/canvas")
    assert response.status_code == 200
    nodes = response.json()["nodes"]
    assert list(nodes.keys()) == ["node_a"]
    assert nodes["node_a"]["assetIds"] == [first_id, second_id]


def test_read_canvas_preserves_generated_result_child_nodes_when_normalizing_variants(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    first_id = "01HCHILD1"
    second_id = "01HCHILD2"
    for asset_id, seed in [(first_id, 1), (second_id, 2)]:
        make_png(library.asset_png_path("farm-comic", asset_id), color="blue")
        library.write_json(
            library.asset_json_path("farm-comic", asset_id),
            {
                "id": asset_id,
                "kind": "generated",
                "title": f"Generated {seed}",
                "tags": ["comic-adaptation"],
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "prompt": {"text": "same graph child"},
                "generation": {
                    "refs": [],
                    "runId": f"01HRUN{seed}",
                    "runIndex": 0,
                    "model": "gemini-3.1-flash-image",
                    "aspectRatio": "16:9",
                    "imageSize": "1K",
                    "seed": seed,
                },
                "provider": {"name": "google-genai", "response": {}},
            },
        )
    library.write_json(
        library.canvas_json_path("farm-comic"),
        {
            "version": 2,
            "viewport": {"x": 0, "y": 0, "zoom": 1},
            "nodes": {
                "source_prompt": {
                    "type": "draft",
                    "displayName": "Source",
                    "x": 10,
                    "y": 20,
                    "tags": ["adaptation"],
                    "role": {"type": "style-ref-source", "kind": "archetype-character"},
                    "refs": [],
                    "prompt": "source prompt",
                    "params": {"batchCount": 1},
                },
                "generated_source_prompt": {
                    "type": "imageGroup",
                    "displayName": "Child result",
                    "x": 300,
                    "y": 20,
                    "assetIds": [first_id],
                    "activeAssetId": first_id,
                    "role": {"type": "generated-result", "sourceNodeId": "source_prompt"},
                },
                "node_b": {
                    "type": "imageGroup",
                    "displayName": "Generic generated",
                    "x": 30,
                    "y": 40,
                    "assetIds": [second_id],
                    "activeAssetId": second_id,
                },
            },
        },
    )

    response = client.get("/api/projects/farm-comic/canvas")
    assert response.status_code == 200
    nodes = response.json()["nodes"]
    assert nodes["generated_source_prompt"]["assetIds"] == [first_id]
    assert nodes["generated_source_prompt"]["role"] == {"type": "generated-result", "sourceNodeId": "source_prompt"}
    assert nodes["node_b"]["assetIds"] == [second_id]


def test_describe_generation_failure_safety_block():
    from gemini import ImageGenerationError, describe_generation_failure, http_status_for_generation_error

    category, message = describe_generation_failure(
        {
            "promptFeedback": {
                "blockReason": "SAFETY",
                "blockReasonMessage": "Prompt blocked for violent content.",
            }
        }
    )
    assert category == "safety"
    assert "content safety filters" in message
    assert "violent content" in message

    exc = ImageGenerationError(message, category=category)
    assert http_status_for_generation_error(exc) == 422


def test_describe_generation_failure_empty_response():
    from gemini import describe_generation_failure

    category, message = describe_generation_failure({"candidates": []})
    assert category == "empty"
    assert "returned no image" in message


def test_create_generated_assets_surfaces_image_generation_error(tmp_path, monkeypatch):
    from gemini import ImageGenerationError

    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic")
    make_png(root / "assets" / "01HPARENT.png")

    def blocked_generate(**kwargs):
        raise ImageGenerationError(
            "Image generation was blocked by Gemini content safety filters.",
            category="safety",
        )

    monkeypatch.setattr("gemini.generate_image", blocked_generate)

    response = client.post(
        "/api/projects/farm-comic/generate",
        json={
            "prompt": "Blocked prompt",
            "refs": [],
            "model": "gemini-3.1-flash-image",
            "aspectRatio": "16:9",
            "imageSize": "1K",
            "batchCount": 1,
        },
    )
    assert response.status_code == 422
    assert "content safety filters" in response.json()["detail"]


def test_concept_cards_draft_to_canvas(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    character = client.post(
        "/api/projects/farm-comic/concept-cards",
        json={"subjectKind": "character", "prompt": "A friendly farm hero in soft watercolor style."},
    )
    assert character.status_code == 200
    character_payload = character.json()
    character_id = character_payload["id"]
    character_tag = f"concept-card-{character_id.lower()}"
    assert character_payload["subjectKind"] == "character"
    assert "A friendly farm hero" in character_payload["prompt"]
    canvas_nodes = client.get("/api/projects/farm-comic/canvas").json()["nodes"]
    assert not [node for node in canvas_nodes.values() if "concept" in node.get("tags", [])]

    updated = client.patch(
        f"/api/projects/farm-comic/concept-cards/{character_id}",
        json={"displayName": "Farm Hero", "prompt": "Updated character prompt"},
    )
    assert updated.status_code == 200
    assert updated.json()["displayName"] == "Farm Hero"
    assert updated.json()["prompt"] == "Updated character prompt"

    draft = client.post(f"/api/projects/farm-comic/concept-cards/{character_id}/draft")
    assert draft.status_code == 200
    draft_payload = draft.json()
    character_node = draft_payload["canvas"]["nodes"][draft_payload["nodeId"]]
    assert character_node["type"] == "imageGroup"
    assert character_node["assetIds"] == []
    assert "concept" in character_node["tags"]
    assert "concept-character" in character_node["tags"]
    assert character_tag in character_node["tags"]
    assert character_node["displayName"] == "Farm Hero"
    assert character_node["prompt"] == "Updated character prompt"
    assert character_node["sourceConceptCardId"] == character_id

    node_deleted_canvas = draft_payload["canvas"]
    node_deleted_canvas["nodes"].pop(draft_payload["nodeId"])
    assert client.put("/api/projects/farm-comic/canvas", json=node_deleted_canvas).status_code == 200
    cards_after_node_delete = client.get("/api/projects/farm-comic/concept-cards").json()
    assert any(card["id"] == character_id for card in cards_after_node_delete)

    redraft = client.post(f"/api/projects/farm-comic/concept-cards/{character_id}/draft")
    assert redraft.status_code == 200
    redraft_node_id = redraft.json()["nodeId"]
    assert client.delete(f"/api/projects/farm-comic/concept-cards/{character_id}").status_code == 204
    cards_after_card_delete = client.get("/api/projects/farm-comic/concept-cards").json()
    assert not any(card["id"] == character_id for card in cards_after_card_delete)
    canvas_after_card_delete = client.get("/api/projects/farm-comic/canvas").json()
    assert redraft_node_id in canvas_after_card_delete["nodes"]
    assert canvas_after_card_delete["nodes"][redraft_node_id]["sourceConceptCardId"] == character_id

    location = client.post(
        "/api/projects/farm-comic/concept-cards",
        json={"subjectKind": "location", "prompt": "A sunny red barn on rolling hills."},
    )
    assert location.status_code == 200
    location_draft = client.post(f"/api/projects/farm-comic/concept-cards/{location.json()['id']}/draft")
    location_node = location_draft.json()["canvas"]["nodes"][location_draft.json()["nodeId"]]
    assert "concept-location" in location_node["tags"]

    blank_character = client.post(
        "/api/projects/farm-comic/concept-cards",
        json={"subjectKind": "character"},
    )
    assert blank_character.status_code == 200
    assert "Character reference sheet" in blank_character.json()["prompt"]

    status = client.get("/api/projects/farm-comic/adaptation").json()
    assert status["counts"]["conceptArt"] == 2


def test_concept_card_upload_and_subject_patch(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    created = client.post(
        "/api/projects/farm-comic/concept-cards",
        json={"subjectKind": "character", "displayName": "Night Watch", "prompt": "A night watch pony."},
    )
    assert created.status_code == 200
    card_id = created.json()["id"]
    card_tag = f"concept-card-{card_id.lower()}"

    # Upload attaches an image to the existing card.
    uploaded = client.post(
        f"/api/projects/farm-comic/concept-cards/{card_id}/upload",
        files={"file": ("upload.png", png_bytes("purple"), "image/png")},
    )
    assert uploaded.status_code == 200
    upload_payload = uploaded.json()
    assert upload_payload["id"] == card_id
    assert len(upload_payload["assetIds"]) == 1
    assert upload_payload["activeAssetId"] == upload_payload["assetIds"][0]
    upload_asset = client.get(f"/api/projects/farm-comic/assets/{upload_payload['assetIds'][0]}").json()
    assert card_tag in upload_asset["tags"]
    assert "concept-character" in upload_asset["tags"]

    # A second upload appends and becomes the active image.
    second = client.post(
        f"/api/projects/farm-comic/concept-cards/{card_id}/upload",
        files={"file": ("upload2.png", png_bytes("green"), "image/png")},
    )
    assert second.status_code == 200
    assert len(second.json()["assetIds"]) == 2
    assert second.json()["activeAssetId"] == second.json()["assetIds"][1]

    # Upload to an unknown card 404s.
    missing = client.post(
        "/api/projects/farm-comic/concept-cards/nope/upload",
        files={"file": ("upload.png", png_bytes("red"), "image/png")},
    )
    assert missing.status_code == 404

    # The old global upload endpoint is gone.
    assert client.post(
        "/api/projects/farm-comic/adaptation/concept-art/upload",
        files={"file": ("upload.png", png_bytes("red"), "image/png")},
    ).status_code in {404, 405}

    # subjectKind patch retags linked assets and canvas nodes.
    draft = client.post(f"/api/projects/farm-comic/concept-cards/{card_id}/draft")
    assert draft.status_code == 200
    node_id = draft.json()["nodeId"]
    patched = client.patch(
        f"/api/projects/farm-comic/concept-cards/{card_id}",
        json={"subjectKind": "location"},
    )
    assert patched.status_code == 200
    assert patched.json()["subjectKind"] == "location"
    retagged_asset = client.get(f"/api/projects/farm-comic/assets/{upload_payload['assetIds'][0]}").json()
    assert "concept-location" in retagged_asset["tags"]
    assert "concept-character" not in retagged_asset["tags"]
    canvas = client.get("/api/projects/farm-comic/canvas").json()
    assert "concept-location" in canvas["nodes"][node_id]["tags"]
    assert "concept-character" not in canvas["nodes"][node_id]["tags"]

    # Archive hides the card from the default list.
    archived = client.patch(
        f"/api/projects/farm-comic/concept-cards/{card_id}",
        json={"archived": True},
    )
    assert archived.status_code == 200
    assert archived.json()["archivedAt"] is not None
    assert client.get("/api/projects/farm-comic/concept-cards").json() == []
    assert len(client.get("/api/projects/farm-comic/concept-cards?includeArchived=true").json()) == 1
