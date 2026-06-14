from __future__ import annotations

from pathlib import Path
from io import BytesIO
import base64

import library
import gemini
import chat_sessions
import adaptation
from fastapi.testclient import TestClient
from main import app
from models import AdaptationAssetLink
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


def make_png(path: Path, color: str = "red") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), color=color).save(path)


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
    assert client.get("/api/projects/farm-comic/canvas").json()["nodes"] == {}


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


def test_adaptation_settings_scene_panel_status_and_canvas_import(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    settings = client.patch(
        "/api/projects/farm-comic/adaptation/settings",
        json={"storyKind": "picture-book"},
    )
    assert settings.status_code == 200
    assert settings.json()["settings"]["storyKind"] == "picture-book"

    root = library.project_dir("farm-comic") / "adaptation"
    (root / "scenes" / "artifacts").mkdir(parents=True, exist_ok=True)
    (root / "panels" / "prompts").mkdir(parents=True, exist_ok=True)
    (root / "acts").mkdir(parents=True, exist_ok=True)
    (root / "acts" / "play-by-play.md").write_text("# Play By Play\n\n## act-01\n\nScene Range: 001-001\nPurpose: Test.\nKey Beats:\n- `L001-L002`: Test. \"Quote.\"\n")
    (root / "scenes" / "artifacts" / "001-test-scene.md").write_text(
        "# Test Scene\n\nScene Id: 001-test-scene\nSource Lines: L001-L002\nMajor Act: act-01\nPrimary Location: test-location\n\n## Story Function\n\nTest.\n\n## Visual Continuity\n\n- Characters: test-character-base\n- Locations: test-location\n- Props And Visual Assets: None.\n- Character States: None.\n- Location State: None.\n\n## Dramatic Beats\n\n- `L001-L002`: Test. \"Quote.\"\n\n## Staging Notes\n\nTest.\n\n## Text Candidates\n\n- Narration: None.\n- Dialogue: None.\n- Caption: None.\n\n## Adaptation Notes\n\nNone.\n"
    )
    (root / "panels" / "prompts" / "001-test-scene.md").write_text(
        "## 001-test-scene-panel-01\nmode: story-layout\nrefs: character:test-character-base, location:test-location\n\nComic panel of a test scene. No watermarks.\n"
    )

    status = client.get("/api/projects/farm-comic/adaptation")
    assert status.status_code == 200
    payload = status.json()
    assert payload["counts"]["playByPlay"] == 1
    assert payload["counts"]["sceneArtifacts"] == 1
    assert payload["counts"]["panelPrompts"] == 1
    assert payload["scenes"]["001-test-scene"]["artifactKind"] == "scene-artifact"
    assert payload["panels"]["001-test-scene-panel-01"]["artifactKind"] == "panel-prompt"

    canvas_response = client.post("/api/projects/farm-comic/adaptation/import-drafts-to-canvas")
    assert canvas_response.status_code == 200
    nodes = canvas_response.json()["canvas"]["nodes"]
    artifact_kinds = {node["artifactKind"] for node in nodes.values() if node["type"] == "storyArtifact"}
    assert "scene-artifact" in artifact_kinds
    assert "panel-prompt" in artifact_kinds


def test_adaptation_panel_generation_uses_canonical_semantic_refs(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    (root / "panels" / "prompts").mkdir(parents=True, exist_ok=True)

    for asset_id, title in [
        ("01HSTYLE", "Style"),
        ("01HCHAR", "Character"),
        ("01HLOC", "Location"),
    ]:
        make_png(library.asset_png_path("farm-comic", asset_id), color="green")
        library.write_json(
            library.asset_json_path("farm-comic", asset_id),
            {
                "id": asset_id,
                "kind": "imported",
                "title": title,
                "tags": [],
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
            },
        )

    library.write_json(
        root / "adaptation.json",
        {
            "version": 2,
            "settings": {"storyKind": "comic-book"},
            "styleRefs": {"archetypeSceneAssetId": "01HSTYLE"},
            "characters": {
                "hero-base": {
                    "artifactKind": "character-sheet",
                    "promptPath": "characters/sheets/hero.md",
                    "assetIds": ["01HCHAR"],
                    "canonicalAssetId": "01HCHAR",
                    "status": "generated",
                }
            },
            "locations": {
                "farm": {
                    "artifactKind": "location-prompt",
                    "promptPath": "locations/prompts/farm.md",
                    "assetIds": ["01HLOC"],
                    "canonicalAssetId": "01HLOC",
                    "status": "generated",
                }
            },
            "scenes": {},
            "pages": {},
            "panels": {},
        },
    )
    (root / "panels" / "prompts" / "001-panel.md").write_text(
        "## 001-panel-01\nmode: story-layout\nrefs: character:hero-base, location:farm\n\nHero crosses the farm in a comic panel. No watermarks.\n"
    )

    captured_refs = []

    def fake_generate(**kwargs):
        captured_refs[:] = [path.stem for path in kwargs["parent_png_paths"]]
        make_png(kwargs["output_png"], color="blue")

        class Result:
            provider_response = {"imageFile": kwargs["output_png"].name, "response": {"candidates": [{"finishReason": "STOP"}]}}

        return Result()

    monkeypatch.setattr(gemini, "generate_image", fake_generate)
    response = client.post(
        "/api/projects/farm-comic/adaptation/generate-artifact",
        json={"artifactKind": "panel-prompt", "artifactKey": "001-panel-01"},
    )
    assert response.status_code == 200
    assert captured_refs == ["01HSTYLE", "01HCHAR", "01HLOC"]
    panel_link = client.get("/api/projects/farm-comic/adaptation").json()["panels"]["001-panel-01"]
    assert panel_link["canonicalAssetId"] == response.json()["asset"]["id"]
    assert panel_link["assetIds"] == [response.json()["asset"]["id"]]
    nodes = client.post("/api/projects/farm-comic/adaptation/import-drafts-to-canvas").json()["canvas"]["nodes"]
    source_id = "artifact_panel_prompt_001_panel_01"
    child_id = f"generated_{source_id}"
    assert nodes[source_id]["type"] == "storyArtifact"
    assert nodes[source_id]["role"] == {"type": "artifact-source", "artifactKind": "panel-prompt", "artifactKey": "001-panel-01"}
    assert nodes[child_id]["type"] == "imageGroup"
    assert nodes[child_id]["activeAssetId"] == response.json()["asset"]["id"]
    assert nodes[child_id]["role"] == {"type": "generated-result", "sourceNodeId": source_id}


def test_adaptation_editable_files_without_book_feed_status_and_canvas(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)

    character = client.post(
        "/api/projects/farm-comic/adaptation/files/characters",
        json={
            "key": "hero-base",
            "mode": "new-image",
            "styleRef": "",
            "body": "Full body character sheet for the farm hero.",
        },
    )
    assert character.status_code == 200
    assert character.json()["promptPath"] == "characters/sheets/hero-base.md"

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

    scene = client.post(
        "/api/projects/farm-comic/adaptation/files/scenes",
        json={
            "key": "opening-scene",
            "body": "# Opening Scene\n\nThe hero arrives at the barn.",
        },
    )
    assert scene.status_code == 200
    assert scene.json()["artifactKind"] == "scene-artifact"

    update = client.put(
        "/api/projects/farm-comic/adaptation/files/characters/hero-base",
        json={"key": "hero-primary", "body": "Updated character sheet prompt.", "mode": "new-image", "styleRef": ""},
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
    assert "barn" in payload["locations"]
    assert "opening-scene" in payload["scenes"]

    canvas_response = client.post("/api/projects/farm-comic/adaptation/import-drafts-to-canvas")
    assert canvas_response.status_code == 200
    nodes = canvas_response.json()["canvas"]["nodes"]
    artifact_kinds = {node["artifactKind"] for node in nodes.values() if node["type"] == "storyArtifact"}
    assert {"character-sheet", "location-prompt", "scene-artifact"}.issubset(artifact_kinds)


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

    sync = client.post("/api/projects/farm-comic/adaptation/import-drafts-to-canvas")
    assert sync.status_code == 200
    nodes = sync.json()["canvas"]["nodes"]
    draft = nodes["archetype_archetype_character"]
    assert draft["type"] == "draft"
    assert draft["role"] == {"type": "style-ref-source", "kind": "archetype-character"}
    assert draft["prompt"] == "Character archetype prompt.\n"
    assert "missing" in draft["tags"]
    assert "archetype_archetype_character_image" not in nodes


def test_visual_style_prompt_is_durable_canvas_source_node(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    (root / "style-refs").mkdir(parents=True, exist_ok=True)
    (root / "style-refs" / "visual-style.md").write_text("Soft watercolor, cinematic light.\n")

    sync = client.post("/api/projects/farm-comic/adaptation/import-drafts-to-canvas")
    assert sync.status_code == 200
    visual_style = sync.json()["canvas"]["nodes"]["style_visual_style"]
    assert visual_style["type"] == "draft"
    assert visual_style["displayName"] == "Visual Style"
    assert visual_style["prompt"] == "Soft watercolor, cinematic light.\n"
    assert visual_style["role"] == {"type": "visual-style-source"}
    assert "visual-style" in visual_style["tags"]

    canvas = client.get("/api/projects/farm-comic/canvas").json()
    canvas["nodes"]["style_visual_style"]["x"] = 222
    canvas["nodes"]["style_visual_style"]["y"] = 333
    assert client.put("/api/projects/farm-comic/canvas", json=canvas).status_code == 200

    repaired = client.post("/api/projects/farm-comic/adaptation/import-drafts-to-canvas").json()["canvas"]["nodes"]["style_visual_style"]
    assert repaired["x"] == 222
    assert repaired["y"] == 333
    assert repaired["prompt"] == "Soft watercolor, cinematic light.\n"


def test_style_ref_import_set_generate_share_metadata_and_canvas_contract(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    root = library.project_dir("farm-comic") / "adaptation"
    (root / "style-refs").mkdir(parents=True, exist_ok=True)
    (root / "style-refs" / "archetype-character.md").write_text("Character archetype prompt.\n")
    (root / "style-refs" / "visual-style.md").write_text("Ink wash style.\n")

    imported = client.post(
        "/api/projects/farm-comic/adaptation/import-style-ref",
        data={"kind": "archetype-character"},
        files={"file": ("character.png", png_bytes("green"), "image/png")},
    )
    assert imported.status_code == 200
    imported_asset_id = imported.json()["styleRefStatuses"]["archetype-character"]["assetId"]
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
    generated = client.post(
        "/api/projects/farm-comic/adaptation/generate-style-ref",
        json={"kind": "archetype-character"},
    )
    assert generated.status_code == 200
    generated_asset_id = generated.json()["asset"]["id"]
    assert "Character archetype prompt." in captured["prompt"]
    assert "Ink wash style." in captured["prompt"]
    assert generated.json()["status"]["styleRefStatuses"]["archetype-character"]["assetId"] == generated_asset_id
    canvas_nodes = client.get("/api/projects/farm-comic/canvas").json()["nodes"]
    assert canvas_nodes["archetype_archetype_character"]["type"] == "draft"
    assert canvas_nodes["generated_archetype_archetype_character"]["type"] == "imageGroup"
    assert canvas_nodes["generated_archetype_archetype_character"]["activeAssetId"] == generated_asset_id
    assert "archetype_archetype_character_image" not in canvas_nodes
    first_sync = client.post("/api/projects/farm-comic/adaptation/import-drafts-to-canvas").json()["canvas"]["nodes"]
    second_sync = client.post("/api/projects/farm-comic/adaptation/import-drafts-to-canvas").json()["canvas"]["nodes"]
    assert first_sync == second_sync
    missing_source_canvas = client.get("/api/projects/farm-comic/canvas").json()
    missing_source_canvas["nodes"].pop("archetype_archetype_character")
    assert client.put("/api/projects/farm-comic/canvas", json=missing_source_canvas).status_code == 200
    repaired_nodes = client.post("/api/projects/farm-comic/adaptation/import-drafts-to-canvas").json()["canvas"]["nodes"]
    assert repaired_nodes["archetype_archetype_character"]["type"] == "draft"
    assert repaired_nodes["archetype_archetype_character"]["role"] == {"type": "style-ref-source", "kind": "archetype-character"}

    delete_child = client.delete(f"/api/projects/farm-comic/assets/{generated_asset_id}")
    assert delete_child.status_code == 204
    assert (root / "style-refs" / "archetype-character.md").read_text() == "Character archetype prompt.\n"
    assert client.get("/api/projects/farm-comic/adaptation").json()["styleRefStatuses"]["archetype-character"]["assetId"] is None


def test_story_artifact_generated_asset_projects_to_child_image_group(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    create_project(client)
    asset_id = "01HCHAR"
    make_png(library.asset_png_path("farm-comic", asset_id), color="green")
    library.write_json(
        library.asset_json_path("farm-comic", asset_id),
        {
            "id": asset_id,
            "kind": "generated",
            "title": "Character Sheet: hero",
            "tags": ["comic-adaptation", "character-sheet"],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "prompt": {"text": "hero prompt"},
            "generation": {
                "refs": [],
                "runId": "01HRUN",
                "runIndex": 0,
                "model": "gemini-3.1-flash-image",
                "aspectRatio": "16:9",
                "imageSize": "1K",
                "seed": 1,
            },
            "provider": {"name": "google-genai", "response": {}},
        },
    )
    metadata = adaptation.read_metadata("farm-comic")
    metadata.characters["hero"] = AdaptationAssetLink(
        artifactKind="character-sheet",
        promptPath="characters/sheets/hero.md",
        prompt="hero prompt",
        assetIds=[asset_id],
        canonicalAssetId=asset_id,
        status="generated",
    )
    adaptation.write_metadata("farm-comic", metadata)
    canvas = {
        "version": 2,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "nodes": {
            "artifact_character_sheet_hero": {
                "type": "storyArtifact",
                "displayName": "hero",
                "x": 80,
                "y": 320,
                "width": 240,
                "tags": ["adaptation", "character-sheet", "generated"],
                "artifactKind": "character-sheet",
                "artifactKey": "hero",
                "promptPath": "characters/sheets/hero.md",
                "prompt": "hero prompt",
                "refs": [],
                "generatedAssetIds": [asset_id],
                "generatedAssetId": asset_id,
            },
        },
    }
    assert client.put("/api/projects/farm-comic/canvas", json=canvas).status_code == 200

    nodes = client.post("/api/projects/farm-comic/adaptation/import-drafts-to-canvas").json()["canvas"]["nodes"]
    assert "artifact_character_sheet_hero" in nodes
    assert nodes["artifact_character_sheet_hero"]["type"] == "storyArtifact"
    assert nodes["artifact_character_sheet_hero"]["role"] == {"type": "artifact-source", "artifactKind": "character-sheet", "artifactKey": "hero"}
    assert nodes["generated_artifact_character_sheet_hero"]["type"] == "imageGroup"
    assert nodes["generated_artifact_character_sheet_hero"]["assetIds"] == [asset_id]
    assert nodes["generated_artifact_character_sheet_hero"]["role"] == {"type": "generated-result", "sourceNodeId": "artifact_character_sheet_hero"}

    delete_child = client.delete(f"/api/projects/farm-comic/assets/{asset_id}")
    assert delete_child.status_code == 204
    status = client.get("/api/projects/farm-comic/adaptation").json()
    assert status["characters"]["hero"]["canonicalAssetId"] is None
    assert status["characters"]["hero"]["assetIds"] == []
    assert status["characters"]["hero"]["prompt"] == "hero prompt"
    repaired = client.post("/api/projects/farm-comic/adaptation/import-drafts-to-canvas").json()["canvas"]["nodes"]
    assert repaired["artifact_character_sheet_hero"]["type"] == "storyArtifact"
    assert "generated_artifact_character_sheet_hero" not in repaired


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
    assert client.get("/api/projects/farm-comic/canvas").json()["nodes"] == {}


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
    assert list(next_canvas["nodes"].keys()) == ["draft_1"]
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
    assert list(canvas["nodes"].keys()) == ["node_1"]
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
