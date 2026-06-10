from __future__ import annotations

from pathlib import Path
from io import BytesIO
import base64

import library
import gemini
import chat_sessions
from fastapi.testclient import TestClient
from main import app
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
