from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

import pytest
import uvicorn
from fastapi import HTTPException
from fastapi.testclient import TestClient

import adaptation
import adaptation_workflow.config as workflow_config
import gemini
import library
import pi_profiles
import pi_runtime
from main import app
from models import CharacterCreate, CharacterPatch, EntityVariantPatch, LocationCreate, LocationPatch

FAKE_PI = Path(__file__).parent / "testdata" / "fake_pi.py"


def setup_tmp_library(tmp_path, monkeypatch) -> TestClient:
    root = tmp_path / "photo-library"
    monkeypatch.setattr(library, "LIBRARY_ROOT", root)
    monkeypatch.setattr(library, "PROJECTS_ROOT", root / "projects")
    monkeypatch.setattr(library, "SYSTEM_TRASH", tmp_path / "system-trash")
    monkeypatch.setattr(gemini, "LIBRARY_ROOT", root)
    monkeypatch.setattr(workflow_config, "LIBRARY_ROOT", root)
    return TestClient(app)


def setup_project_with_book(tmp_path, monkeypatch) -> tuple[TestClient, Path]:
    client = setup_tmp_library(tmp_path, monkeypatch)
    response = client.post("/api/projects", json={"slug": "farm-comic", "name": "Farm Comic"})
    assert response.status_code == 200
    root = library.project_dir("farm-comic") / "adaptation"
    root.mkdir(parents=True, exist_ok=True)
    (root / "book.txt").write_text("Once upon a time.\n")
    return client, root


def use_fake_pi(monkeypatch) -> pi_runtime.PiSessionManager:
    monkeypatch.setattr(pi_runtime, "_pi_command", lambda: [sys.executable, str(FAKE_PI)])
    manager = pi_runtime.PiSessionManager()
    monkeypatch.setattr(pi_runtime, "MANAGER", manager)
    return manager


@pytest.fixture
def live_api(monkeypatch):
    """Start the (already library-monkeypatched) app over real HTTP.

    Tool-delivery tests need a live port because the fake pi performs the HTTP
    request the photo-web extension would make. Returns a starter callable so
    tests can boot the server after their library setup.
    """
    servers: list[uvicorn.Server] = []

    def start() -> str:
        config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
        server = uvicorn.Server(config)
        servers.append(server)
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        deadline = time.monotonic() + 15
        while not server.started:
            if time.monotonic() > deadline:
                raise AssertionError("uvicorn never started")
            time.sleep(0.02)
        port = server.servers[0].sockets[0].getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        monkeypatch.setenv("PHOTO_WEB_API", origin)
        return origin

    yield start
    for server in servers:
        server.should_exit = True


def wait_for_state(handle: pi_runtime.TaskHandle, states: set[str], timeout: float = 15.0) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if handle.state in states:
            return handle.state
        time.sleep(0.05)
    raise AssertionError(f"Task never reached {states}; state={handle.state} error={handle.error}")


BASE_SHEET_PROMPT = (
    "Character reference sheet. "
    "Layout: top row — front full-body, three-quarter full-body, back full-body, same neutral standing pose, consistent scale. "
    "Bottom row — four head close-ups. White background. No text, no labels, no watermarks. "
    "Expressions: joy, surprise, concern, determination."
)


def register_character(name: str, *, extracted: bool) -> str:
    record = adaptation.create_character("farm-comic", CharacterCreate(name=name, summary=f"{name} of the farm."))
    if extracted:
        adaptation.update_character(
            "farm-comic",
            record.slug,
            CharacterPatch(
                visualDescription="Sturdy.",
                performanceNotes="Kind.",
                variants={"base": EntityVariantPatch(prompt=BASE_SHEET_PROMPT)},
            ),
        )
    return record.slug


LOCATION_SHEET_PROMPT = (
    "Location reference for the barn. Wide establishing shot at eye level, "
    "warm morning light. No characters in frame. No text, no labels, no watermarks."
)


def register_location(name: str, *, extracted: bool) -> str:
    record = adaptation.create_location("farm-comic", LocationCreate(name=name, summary=f"{name} on the farm."))
    if extracted:
        adaptation.update_location(
            "farm-comic",
            record.slug,
            LocationPatch(
                visualDescription="Weathered red planks.",
                variants={"base": EntityVariantPatch(prompt=LOCATION_SHEET_PROMPT)},
            ),
        )
    return record.slug


def write_book_session_manifest(root: Path) -> None:
    pi_session_file = root / "sessions" / "pi" / "root-session.jsonl"
    pi_session_file.parent.mkdir(parents=True, exist_ok=True)
    pi_session_file.write_text("")
    library.write_json(
        root / "sessions" / "book-session.json",
        {
            "sessionFile": str(pi_session_file),
            "sessionId": "root-session",
            "createdAt": "2026-01-01T00:00:00Z",
            "bookPath": str((root / "book.txt").resolve()),
        },
    )


# --- profiles ----------------------------------------------------------------


def test_profiles_prompts_and_flags(tmp_path, monkeypatch):
    _client, _root = setup_project_with_book(tmp_path, monkeypatch)
    ctx = workflow_config.AdaptationContext.for_slug("farm-comic")

    read_book = pi_profiles.get_profile("read-book")
    steps = list(read_book.plan(ctx, pi_profiles.TaskArgs()))
    assert len(steps) == 1
    assert steps[0].build_prompt() == f"/skill:read-book {ctx.book_path}"
    assert steps[0].fork_from_book_session is False

    discover = pi_profiles.get_profile("discover-characters")
    steps = list(discover.plan(ctx, pi_profiles.TaskArgs()))
    assert len(steps) == 1
    assert steps[0].build_prompt() == "/skill:discover-characters\n"
    assert steps[0].fork_from_book_session is True

    with pytest.raises(HTTPException) as exc_info:
        pi_profiles.get_profile("nope")
    assert exc_info.value.status_code == 404


def test_discover_characters_precheck_requires_book_session(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    ctx = workflow_config.AdaptationContext.for_slug("farm-comic")
    with pytest.raises(HTTPException) as exc_info:
        pi_profiles.get_profile("discover-characters").precheck(ctx, pi_profiles.TaskArgs())
    assert exc_info.value.status_code == 409


def test_extract_character_precheck_target_validation(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    root = library.project_dir("farm-comic") / "adaptation"
    write_book_session_manifest(root)
    ctx = workflow_config.AdaptationContext.for_slug("farm-comic")
    profile = pi_profiles.get_profile("extract-character")

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs())
    assert exc_info.value.status_code == 400

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target="hero"))
    assert exc_info.value.status_code == 404  # not registered yet

    register_character("Hero", extracted=False)
    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target="villain"))
    assert exc_info.value.status_code == 404
    profile.precheck(ctx, pi_profiles.TaskArgs(target="hero"))


# --- manager lifecycle -------------------------------------------------------


def test_read_book_task_writes_manifest_and_events(tmp_path, monkeypatch):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "read-book")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    manifest = library.read_json(root / "sessions" / "book-session.json")
    assert manifest["sessionId"] == "fake-session"
    assert Path(manifest["sessionFile"]).is_file()

    event_types = [record["event"]["type"] for record in handle.events_since(0)]
    assert "task_start" in event_types
    assert "assistant_text" in event_types
    assert "tool_start" in event_types
    assert "tool_end" in event_types
    assert event_types[-1] == "task_state"

    # Replay from the middle of the buffer.
    middle_seq = handle.events_since(0)[2]["seq"]
    replayed = handle.events_since(middle_seq)
    assert all(record["seq"] > middle_seq for record in replayed)

    session = client.get(f"/api/projects/farm-comic/agent-sessions/{handle.id}").json()
    assert session["kind"] == "read-book"
    assert session["status"] == "succeeded"
    assert session["piSessionId"] == "fake-session"

    status = manager.get_status("farm-comic", handle.id)
    assert status.state == "done"
    assert status.piSessionId == "fake-session"


def test_abort_cancels_running_task(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    monkeypatch.setenv("FAKE_PI_HANG", "1")
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "read-book")
    wait_for_state(handle, {"running"})
    # Give the fake pi a beat to emit its scripted events.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and handle.seq < 4:
        time.sleep(0.05)

    assert manager.abort("farm-comic", handle.id) is True
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "cancelled"
    assert manager.abort("farm-comic", handle.id) is False


def test_duplicate_profile_run_conflicts(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    monkeypatch.setenv("FAKE_PI_HANG", "1")
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "read-book")
    wait_for_state(handle, {"running"})
    with pytest.raises(HTTPException) as exc_info:
        manager.start_task("farm-comic", "read-book")
    assert exc_info.value.status_code == 409
    manager.abort("farm-comic", handle.id)
    wait_for_state(handle, {"cancelled", "failed", "done"})


def test_discover_characters_forks_book_session_and_registers(tmp_path, monkeypatch, live_api):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    write_book_session_manifest(root)
    live_api()
    monkeypatch.setenv(
        "FAKE_PI_CALL_TOOL",
        json.dumps(
            {
                "tool": "register_character",
                "method": "POST",
                "path": "/api/projects/farm-comic/characters",
                "body": {"name": "Hero", "summary": "A brave farmhand."},
            }
        ),
    )
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "discover-characters")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    argv = json.loads((root / "sessions" / "pi" / "fake-pi-argv.json").read_text())
    assert "--fork" in argv
    assert argv[argv.index("--fork") + 1] == "root-session"
    env = json.loads((root / "sessions" / "pi" / "fake-pi-env.json").read_text())
    assert env["PHOTO_WEB_ALLOWED_TOOLS"] == "register_character,list_characters"

    records = client.get("/api/projects/farm-comic/characters").json()
    assert [record["slug"] for record in records] == ["hero"]
    assert records[0]["summary"] == "A brave farmhand."

    session = client.get(f"/api/projects/farm-comic/agent-sessions/{handle.id}").json()
    assert session["kind"] == "discover-characters"
    assert session["source"]["registeredSlugs"] == ["hero"]


def test_discover_characters_fails_when_tool_never_called(tmp_path, monkeypatch):
    _client, root = setup_project_with_book(tmp_path, monkeypatch)
    write_book_session_manifest(root)
    manager = use_fake_pi(monkeypatch)  # default fake pi makes no tool call

    handle = manager.start_task("farm-comic", "discover-characters")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "failed"
    assert "register_character" in (handle.error or "")


def test_discover_characters_skips_pi_when_records_exist(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    root = library.project_dir("farm-comic") / "adaptation"
    write_book_session_manifest(root)
    register_character("Hero", extracted=False)
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "discover-characters")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    assert not (root / "sessions" / "pi" / "fake-pi-argv.json").exists()
    assert list(adaptation.read_metadata("farm-comic").characters) == ["hero"]


def test_restart_sweep_marks_interrupted_tasks_failed(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    root = library.project_dir("farm-comic") / "adaptation"
    snapshot_dir = root / "sessions" / "pi-tasks"
    library.write_json(
        snapshot_dir / "01STALE.json",
        {
            "taskId": "01STALE",
            "projectSlug": "farm-comic",
            "profile": "read-book",
            "title": "Read book",
            "state": "running",
            "pid": 99999999,
            "processStartTime": "nope",
            "startedAt": "2026-01-01T00:00:00Z",
            "completedAt": None,
            "error": None,
            "piSessionId": None,
        },
    )
    manager = pi_runtime.PiSessionManager()

    statuses = manager.list_statuses("farm-comic")
    assert len(statuses) == 1
    assert statuses[0].state == "failed"
    assert statuses[0].error == "Interrupted by API restart"


def test_extract_all_characters_multi_step_progress(tmp_path, monkeypatch, live_api):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    write_book_session_manifest(root)
    # Hero is already extracted, so its step is a no-op; villain gets filled by the tool.
    register_character("Hero", extracted=True)
    register_character("Villain", extracted=False)
    live_api()
    monkeypatch.setenv(
        "FAKE_PI_CALL_TOOL",
        json.dumps(
            {
                "tool": "update_character",
                "method": "PATCH",
                "path": "/api/projects/farm-comic/characters/{target}",
                "body": {
                    "visualDescription": "A scheming fox.",
                    "variants": {"base": {"prompt": BASE_SHEET_PROMPT}},
                },
            }
        ),
    )
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "extract-all-characters")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    progress = [record["event"] for record in handle.events_since(0) if record["event"]["type"] == "task_progress"]
    assert [event["index"] for event in progress] == [1, 2, 3]
    assert progress[0]["label"] == "discover characters"
    assert progress[1]["label"] == "extract character hero"
    assert progress[2]["label"] == "extract character villain"

    villain = adaptation.read_metadata("farm-comic").characters["villain"]
    assert villain.visualDescription == "A scheming fox."
    assert villain.variants["base"].prompt == BASE_SHEET_PROMPT

    env = json.loads((root / "sessions" / "pi" / "fake-pi-env.json").read_text())
    assert env["PHOTO_WEB_ALLOWED_TOOLS"] == "register_character,update_character,list_characters"


def test_extract_character_fails_when_tool_never_called(tmp_path, monkeypatch):
    _client, root = setup_project_with_book(tmp_path, monkeypatch)
    write_book_session_manifest(root)
    register_character("Villain", extracted=False)
    manager = use_fake_pi(monkeypatch)  # default fake pi makes no tool call

    handle = manager.start_task("farm-comic", "extract-character", target="villain")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "failed"
    assert "update_character" in (handle.error or "")


def test_extract_one_character_skip_and_force(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    root = library.project_dir("farm-comic") / "adaptation"
    write_book_session_manifest(root)
    register_character("Hero", extracted=True)
    manager = use_fake_pi(monkeypatch)

    # Extracted record + no force: pi never runs.
    handle = manager.start_task("farm-comic", "extract-character", target="hero")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"
    assert handle.target == "hero"
    assert not (root / "sessions" / "pi" / "fake-pi-argv.json").exists()

    # Force re-runs pi (the record stays extracted, so delivery validation passes).
    handle = manager.start_task("farm-comic", "extract-character", target="hero", force=True)
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"
    assert (root / "sessions" / "pi" / "fake-pi-argv.json").exists()

    status = manager.get_status("farm-comic", handle.id)
    assert status.target == "hero"


def test_duplicate_target_conflicts_but_other_target_allowed(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    root = library.project_dir("farm-comic") / "adaptation"
    write_book_session_manifest(root)
    register_character("Hero", extracted=False)
    register_character("Villain", extracted=False)
    monkeypatch.setenv("FAKE_PI_HANG", "1")
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "extract-character", target="hero")
    wait_for_state(handle, {"running"})
    with pytest.raises(HTTPException) as exc_info:
        manager.start_task("farm-comic", "extract-character", target="hero")
    assert exc_info.value.status_code == 409

    other = manager.start_task("farm-comic", "extract-character", target="villain")
    manager.abort("farm-comic", handle.id)
    manager.abort("farm-comic", other.id)
    wait_for_state(handle, {"cancelled", "failed", "done"})
    wait_for_state(other, {"cancelled", "failed", "done"})


def test_target_rejected_for_untargeted_profile(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    manager = use_fake_pi(monkeypatch)
    with pytest.raises(HTTPException) as exc_info:
        manager.start_task("farm-comic", "read-book", target="hero")
    assert exc_info.value.status_code == 400


def test_suggest_concept_character_creates_card(tmp_path, monkeypatch, live_api):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    write_book_session_manifest(root)
    live_api()
    monkeypatch.setenv(
        "FAKE_PI_CALL_TOOL",
        json.dumps(
            {
                "tool": "create_concept_card",
                "method": "POST",
                "path": "/api/projects/farm-comic/concept-cards",
                "body": {
                    "subjectKind": "character",
                    "displayName": "Night Watch Pony",
                    "prompt": "Character reference sheet\nA weathered night watch pony with a brass lantern.",
                },
            }
        ),
    )
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "suggest-concept-character")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    cards = client.get("/api/projects/farm-comic/concept-cards").json()
    assert len(cards) == 1
    assert cards[0]["subjectKind"] == "character"
    assert "night watch pony" in cards[0]["prompt"]

    session = client.get(f"/api/projects/farm-comic/agent-sessions/{handle.id}").json()
    assert session["kind"] == "suggest-concept-character"
    assert session["source"]["outputCardId"] == cards[0]["id"]

    # The tool call surfaced as events in the task stream.
    event_types = [record["event"]["type"] for record in handle.events_since(0)]
    assert "tool_start" in event_types

    # Tool profiles load the photo-web extension with a scoped allow-list.
    argv = json.loads((root / "sessions" / "pi" / "fake-pi-argv.json").read_text())
    assert "--extension" in argv
    assert argv[argv.index("--extension") + 1].endswith(".pi/extensions/photo-web.ts")
    env = json.loads((root / "sessions" / "pi" / "fake-pi-env.json").read_text())
    assert env["PHOTO_WEB_ALLOWED_TOOLS"] == "create_concept_card"
    assert env["PHOTO_WEB_PROJECT"] == "farm-comic"
    assert env["PHOTO_WEB_API"].startswith("http://127.0.0.1:")


def test_suggest_concept_fails_when_tool_never_called(tmp_path, monkeypatch):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    write_book_session_manifest(root)
    manager = use_fake_pi(monkeypatch)  # default fake pi run makes no tool call

    handle = manager.start_task("farm-comic", "suggest-concept-character")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "failed"
    assert "create_concept_card" in (handle.error or "")
    assert client.get("/api/projects/farm-comic/concept-cards").json() == []


def test_non_tool_profiles_do_not_load_extension(tmp_path, monkeypatch):
    _client, root = setup_project_with_book(tmp_path, monkeypatch)
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "read-book")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"
    argv = json.loads((root / "sessions" / "pi" / "fake-pi-argv.json").read_text())
    assert "--extension" not in argv


# --- routes -------------------------------------------------------------------


def test_pi_task_routes_end_to_end(tmp_path, monkeypatch):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    manager = use_fake_pi(monkeypatch)

    response = client.post("/api/projects/farm-comic/pi-tasks", json={"profile": "read-book"})
    assert response.status_code == 202
    task_id = response.json()["taskId"]

    handle = manager.get_handle("farm-comic", task_id)
    assert handle is not None
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    status = client.get(f"/api/projects/farm-comic/pi-tasks/{task_id}").json()
    assert status["state"] == "done"
    assert status["profile"] == "read-book"

    listed = client.get("/api/projects/farm-comic/pi-tasks?profile=read-book").json()
    assert [entry["taskId"] for entry in listed] == [task_id]
    assert client.get("/api/projects/farm-comic/pi-tasks?active=true").json() == []

    with client.stream("GET", f"/api/projects/farm-comic/pi-tasks/{task_id}/events") as stream:
        assert stream.headers["content-type"].startswith("text/event-stream")
        payloads = []
        for line in stream.iter_lines():
            if line.startswith("data: "):
                payloads.append(json.loads(line[len("data: "):]))
    event_types = [payload["event"]["type"] for payload in payloads]
    assert "assistant_text" in event_types
    assert event_types[-1] == "task_state"
    assert payloads[-1]["event"]["state"] == "done"

    abort = client.post(f"/api/projects/farm-comic/pi-tasks/{task_id}/abort")
    assert abort.json() == {"cancelled": False}

    assert client.get("/api/projects/farm-comic/pi-tasks/unknown").status_code == 404
    assert (
        client.post("/api/projects/farm-comic/pi-tasks", json={"profile": "nope"}).status_code == 404
    )


# --- panel prompt profiles -----------------------------------------------------


def seed_extracted_character(root) -> None:
    """Panel-prompt drafting is gated on at least one canonical character existing."""
    register_character("Hero", extracted=True)


def make_story_panels(client, story_texts: list[str]) -> list[str]:
    panel_ids: list[str] = []
    last_id: str | None = None
    for text in story_texts:
        response = client.post(
            "/api/projects/farm-comic/story-panels/panels",
            json={"storyText": text, "insertAfterPanelId": last_id, "autoPlace": False},
        )
        assert response.status_code == 200, response.text
        created = next(panel for panel in response.json()["panels"] if panel["storyText"] == text)
        panel_ids.append(created["id"])
        last_id = created["id"]
    return panel_ids


def test_load_prompt_guide(tmp_path, monkeypatch):
    guide = pi_profiles.load_prompt_guide()
    assert "Subject" in guide
    assert "lighting" in guide


def test_draft_panel_prompt_plan_context_and_guide(tmp_path, monkeypatch):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    register_character("Hero", extracted=True)
    panel_ids = make_story_panels(
        client,
        ["The barn at dawn.", "Hero feeds the chickens.", "A fox watches from the fence.", "Rain begins."],
    )
    ctx = workflow_config.AdaptationContext.for_slug("farm-comic")
    args = pi_profiles.TaskArgs(target=panel_ids[2])

    profile = pi_profiles.get_profile("draft-panel-prompt")
    profile.precheck(ctx, args)
    steps = list(profile.plan(ctx, args))
    assert len(steps) == 1
    assert steps[0].fork_from_book_session is False
    prompt = steps[0].build_prompt()
    assert prompt is not None
    assert prompt.startswith(f"/skill:panel-prompt {panel_ids[2]}")
    assert "A fox watches from the fence." in prompt
    assert "The barn at dawn." in prompt  # two panels before
    assert "Rain begins." in prompt  # panel after
    assert "hero:" in prompt  # canonical character look
    assert "Character reference sheet" in prompt
    assert "Imagen prompt guide" in prompt
    assert pi_profiles.load_prompt_guide().rstrip() in prompt


def test_draft_panel_prompt_injects_user_guidance(tmp_path, monkeypatch):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    seed_extracted_character(root)
    (panel_id,) = make_story_panels(client, ["Hero feeds the chickens at dawn."])
    ctx = workflow_config.AdaptationContext.for_slug("farm-comic")
    profile = pi_profiles.get_profile("draft-panel-prompt")

    args = pi_profiles.TaskArgs(target=panel_id, instructions="focus on the rooster in the foreground")
    profile.precheck(ctx, args)
    steps = list(profile.plan(ctx, args))
    prompt = steps[0].build_prompt()
    assert prompt is not None
    assert "User guidance" in prompt
    assert "focus on the rooster in the foreground" in prompt

    # Without instructions there is no guidance block.
    plain = list(profile.plan(ctx, pi_profiles.TaskArgs(target=panel_id)))[0].build_prompt()
    assert plain is not None
    assert "User guidance" not in plain


def test_draft_panel_prompt_prechecks(tmp_path, monkeypatch):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    ctx = workflow_config.AdaptationContext.for_slug("farm-comic")
    profile = pi_profiles.get_profile("draft-panel-prompt")

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs())
    assert exc_info.value.status_code == 400

    # Process gate: no extracted characters yet.
    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target="panel-999"))
    assert exc_info.value.status_code == 409
    assert "Extract characters" in exc_info.value.detail

    seed_extracted_character(root)

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target="panel-999"))
    assert exc_info.value.status_code == 404

    response = client.post(
        "/api/projects/farm-comic/story-panels/panels",
        json={"storyText": "", "autoPlace": False},
    )
    assert response.status_code == 200
    empty_panel_id = next(
        panel["id"]
        for panel in response.json()["panels"]
        if panel["storyText"] == "" and panel["panelKind"] == "image"
    )
    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target=empty_panel_id))
    assert exc_info.value.status_code == 409


def test_refine_panel_prompt_prechecks(tmp_path, monkeypatch):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    ctx = workflow_config.AdaptationContext.for_slug("farm-comic")
    profile = pi_profiles.get_profile("refine-panel-prompt")
    (panel_id,) = make_story_panels(client, ["Hero rests."])

    # Process gate: no extracted characters yet.
    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target=f"{panel_id}:prompt-001", instructions="darker"))
    assert exc_info.value.status_code == 409

    seed_extracted_character(root)

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target=panel_id, instructions="darker"))
    assert exc_info.value.status_code == 400  # missing :promptId

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target=f"{panel_id}:prompt-001"))
    assert exc_info.value.status_code == 400  # missing instructions

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target=f"{panel_id}:prompt-001", instructions="darker"))
    assert exc_info.value.status_code == 404  # prompt does not exist


def test_draft_panel_prompt_end_to_end(tmp_path, monkeypatch, live_api):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    seed_extracted_character(root)
    assert client.post(
        "/api/projects/farm-comic/locations",
        json={"name": "Barnyard", "summary": "The muddy barnyard."},
    ).status_code == 200
    assert client.patch(
        "/api/projects/farm-comic/locations/barnyard",
        json={"visualDescription": "Muddy and fenced.", "variants": {"base": {"prompt": "A muddy barnyard at dawn."}}},
    ).status_code == 200
    (panel_id,) = make_story_panels(client, ["Hero feeds the chickens at dawn."])
    live_api()
    drafted = "A brave farmhand scattering feed to chickens at dawn, wide shot, golden-hour backlight."
    monkeypatch.setenv(
        "FAKE_PI_CALL_TOOL",
        json.dumps(
            {
                "tool": "set_panel_image_prompt",
                "method": "POST",
                "path": f"/api/projects/farm-comic/story-panels/panels/{panel_id}/image-prompts",
                "body": {"text": drafted, "characterSlugs": ["hero"], "locationSlug": "barnyard"},
            }
        ),
    )
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "draft-panel-prompt", target=panel_id)
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    document = client.get("/api/projects/farm-comic/story-panels").json()
    panel = next(item for item in document["panels"] if item["id"] == panel_id)
    assert len(panel["imagePrompts"]) == 1
    assert panel["imagePrompts"][0]["text"] == drafted
    assert panel["characterSlugs"] == ["hero"]
    assert panel["locationSlug"] == "barnyard"

    session = client.get(f"/api/projects/farm-comic/agent-sessions/{handle.id}").json()
    assert session["kind"] == "draft-panel-prompt"
    assert session["source"]["panelId"] == panel_id
    assert session["source"]["promptId"] == panel["imagePrompts"][0]["id"]


def test_draft_panel_prompt_fails_when_tool_never_called(tmp_path, monkeypatch):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    seed_extracted_character(root)
    (panel_id,) = make_story_panels(client, ["Hero feeds the chickens at dawn."])
    manager = use_fake_pi(monkeypatch)  # default fake pi makes no tool call

    handle = manager.start_task("farm-comic", "draft-panel-prompt", target=panel_id)
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "failed"
    assert "set_panel_image_prompt" in (handle.error or "")


def test_refine_panel_prompt_end_to_end(tmp_path, monkeypatch, live_api):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    seed_extracted_character(root)
    (panel_id,) = make_story_panels(client, ["Hero feeds the chickens at dawn."])
    patch = client.patch(
        f"/api/projects/farm-comic/story-panels/panels/{panel_id}",
        json={"imagePrompts": [
            {"id": "prompt-001", "text": "A farmhand with chickens."},
            {"id": "prompt-002", "text": "Keep me unchanged."},
        ]},
    )
    assert patch.status_code == 200
    live_api()
    refined = "A brave farmhand scattering feed to eager chickens, low-angle, soft dawn fog."
    monkeypatch.setenv(
        "FAKE_PI_CALL_TOOL",
        json.dumps(
            {
                "tool": "replace_panel_image_prompt",
                "method": "PUT",
                "path": f"/api/projects/farm-comic/story-panels/panels/{panel_id}/image-prompts/prompt-001",
                "body": {"text": refined},
            }
        ),
    )
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task(
        "farm-comic",
        "refine-panel-prompt",
        target=f"{panel_id}:prompt-001",
        instructions="make it more dynamic and foggy",
    )
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    document = client.get("/api/projects/farm-comic/story-panels").json()
    panel = next(item for item in document["panels"] if item["id"] == panel_id)
    texts = {prompt["id"]: prompt["text"] for prompt in panel["imagePrompts"]}
    assert texts["prompt-001"] == refined
    assert texts["prompt-002"] == "Keep me unchanged."


# --- refine character ------------------------------------------------------------


def test_refine_character_prechecks(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    root = library.project_dir("farm-comic") / "adaptation"
    write_book_session_manifest(root)
    ctx = workflow_config.AdaptationContext.for_slug("farm-comic")
    profile = pi_profiles.get_profile("refine-character")

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(instructions="darker mane"))
    assert exc_info.value.status_code == 400  # missing target

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target="hero"))
    assert exc_info.value.status_code == 400  # missing instructions

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target="hero", instructions="darker mane"))
    assert exc_info.value.status_code == 404  # not registered

    register_character("Hero", extracted=False)
    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target="hero", instructions="darker mane"))
    assert exc_info.value.status_code == 409  # registered but not extracted

    adaptation.update_character(
        "farm-comic",
        "hero",
        CharacterPatch(visualDescription="Sturdy.", variants={"base": EntityVariantPatch(prompt=BASE_SHEET_PROMPT)}),
    )
    profile.precheck(ctx, pi_profiles.TaskArgs(target="hero", instructions="darker mane"))


def test_refine_character_end_to_end(tmp_path, monkeypatch, live_api):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    write_book_session_manifest(root)
    register_character("Hero", extracted=True)
    live_api()
    monkeypatch.setenv(
        "FAKE_PI_CALL_TOOL",
        json.dumps(
            {
                "tool": "update_character",
                "method": "PATCH",
                "path": "/api/projects/farm-comic/characters/hero",
                "body": {
                    "visualDescription": "Sturdy, with a prominent scar over the left eye.",
                    "variants": {
                        "post-duel": {
                            "label": "Post-duel",
                            "storyContext": "After the duel in chapter 2.",
                            "prompt": "Same design as the reference image, add the scar. " + BASE_SHEET_PROMPT,
                        }
                    },
                },
            }
        ),
    )
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task(
        "farm-comic",
        "refine-character",
        target="hero",
        instructions="Make the scar prominent and add a post-duel variant",
    )
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    # Refinement forks the warm book session.
    argv = json.loads((root / "sessions" / "pi" / "fake-pi-argv.json").read_text())
    assert "--fork" in argv
    env = json.loads((root / "sessions" / "pi" / "fake-pi-env.json").read_text())
    assert env["PHOTO_WEB_ALLOWED_TOOLS"] == "update_character,list_characters"

    hero = adaptation.read_metadata("farm-comic").characters["hero"]
    assert "prominent scar" in hero.visualDescription
    assert hero.variants["post-duel"].storyContext == "After the duel in chapter 2."

    session = client.get(f"/api/projects/farm-comic/agent-sessions/{handle.id}").json()
    assert session["kind"] == "refine-character"
    assert session["source"]["characterSlug"] == "hero"


def test_refine_character_fails_when_tool_never_called(tmp_path, monkeypatch):
    _client, root = setup_project_with_book(tmp_path, monkeypatch)
    write_book_session_manifest(root)
    register_character("Hero", extracted=True)
    manager = use_fake_pi(monkeypatch)  # default fake pi makes no tool call

    handle = manager.start_task(
        "farm-comic", "refine-character", target="hero", instructions="darker mane"
    )
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "failed"
    assert "update_character" in (handle.error or "")


# --- location profiles (clones of the character record plumbing) ----------------


def test_extract_location_precheck_target_validation(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    root = library.project_dir("farm-comic") / "adaptation"
    write_book_session_manifest(root)
    ctx = workflow_config.AdaptationContext.for_slug("farm-comic")
    profile = pi_profiles.get_profile("extract-location")

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs())
    assert exc_info.value.status_code == 400

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target="barn"))
    assert exc_info.value.status_code == 404  # not registered yet

    register_location("Barn", extracted=False)
    profile.precheck(ctx, pi_profiles.TaskArgs(target="barn"))


def test_discover_locations_registers_via_tool(tmp_path, monkeypatch, live_api):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    write_book_session_manifest(root)
    live_api()
    monkeypatch.setenv(
        "FAKE_PI_CALL_TOOL",
        json.dumps(
            {
                "tool": "register_location",
                "method": "POST",
                "path": "/api/projects/farm-comic/locations",
                "body": {"name": "Barn", "summary": "The red barn."},
            }
        ),
    )
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "discover-locations")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    env = json.loads((root / "sessions" / "pi" / "fake-pi-env.json").read_text())
    assert env["PHOTO_WEB_ALLOWED_TOOLS"] == "register_location,list_locations"

    records = client.get("/api/projects/farm-comic/locations").json()
    assert [record["slug"] for record in records] == ["barn"]

    session = client.get(f"/api/projects/farm-comic/agent-sessions/{handle.id}").json()
    assert session["kind"] == "discover-locations"
    assert session["source"]["registeredSlugs"] == ["barn"]


def test_discover_locations_skips_pi_when_records_exist(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    root = library.project_dir("farm-comic") / "adaptation"
    write_book_session_manifest(root)
    register_location("Barn", extracted=False)
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "discover-locations")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    assert not (root / "sessions" / "pi" / "fake-pi-argv.json").exists()
    assert list(adaptation.read_metadata("farm-comic").locations) == ["barn"]


def test_extract_all_locations_multi_step_progress(tmp_path, monkeypatch, live_api):
    _client, root = setup_project_with_book(tmp_path, monkeypatch)
    write_book_session_manifest(root)
    register_location("Barn", extracted=True)
    register_location("Field", extracted=False)
    live_api()
    monkeypatch.setenv(
        "FAKE_PI_CALL_TOOL",
        json.dumps(
            {
                "tool": "update_location",
                "method": "PATCH",
                "path": "/api/projects/farm-comic/locations/{target}",
                "body": {
                    "visualDescription": "Open pasture.",
                    "variants": {"base": {"prompt": LOCATION_SHEET_PROMPT}},
                },
            }
        ),
    )
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "extract-all-locations")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    progress = [record["event"] for record in handle.events_since(0) if record["event"]["type"] == "task_progress"]
    assert [event["label"] for event in progress] == [
        "discover locations",
        "extract location barn",
        "extract location field",
    ]

    field = adaptation.read_metadata("farm-comic").locations["field"]
    assert field.visualDescription == "Open pasture."
    assert field.variants["base"].prompt == LOCATION_SHEET_PROMPT

    env = json.loads((root / "sessions" / "pi" / "fake-pi-env.json").read_text())
    assert env["PHOTO_WEB_ALLOWED_TOOLS"] == "register_location,update_location,list_locations"


def test_extract_location_fails_when_tool_never_called(tmp_path, monkeypatch):
    _client, root = setup_project_with_book(tmp_path, monkeypatch)
    write_book_session_manifest(root)
    register_location("Field", extracted=False)
    manager = use_fake_pi(monkeypatch)  # default fake pi makes no tool call

    handle = manager.start_task("farm-comic", "extract-location", target="field")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "failed"
    assert "update_location" in (handle.error or "")


def test_refine_location_end_to_end(tmp_path, monkeypatch, live_api):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    write_book_session_manifest(root)
    register_location("Barn", extracted=True)
    live_api()
    monkeypatch.setenv(
        "FAKE_PI_CALL_TOOL",
        json.dumps(
            {
                "tool": "update_location",
                "method": "PATCH",
                "path": "/api/projects/farm-comic/locations/barn",
                "body": {
                    "visualDescription": "Weathered red planks, charred beams.",
                    "variants": {
                        "after-the-fire": {
                            "label": "After the fire",
                            "storyContext": "After the fire in chapter 5.",
                            "prompt": "Same location as the reference image, charred and half-collapsed.",
                        }
                    },
                },
            }
        ),
    )
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task(
        "farm-comic",
        "refine-location",
        target="barn",
        instructions="Add an after-the-fire variant",
    )
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    env = json.loads((root / "sessions" / "pi" / "fake-pi-env.json").read_text())
    assert env["PHOTO_WEB_ALLOWED_TOOLS"] == "update_location,list_locations"

    barn = adaptation.read_metadata("farm-comic").locations["barn"]
    assert "charred beams" in barn.visualDescription
    assert barn.variants["after-the-fire"].storyContext == "After the fire in chapter 5."

    session = client.get(f"/api/projects/farm-comic/agent-sessions/{handle.id}").json()
    assert session["kind"] == "refine-location"
    assert session["source"]["locationSlug"] == "barn"


# --- image prompt endpoints ------------------------------------------------------


def test_image_prompt_endpoints_validation(tmp_path, monkeypatch):
    client, _root = setup_project_with_book(tmp_path, monkeypatch)
    (panel_id,) = make_story_panels(client, ["Hero rests in the hay."])
    base = f"/api/projects/farm-comic/story-panels/panels/{panel_id}/image-prompts"

    # Append assigns sequential ids.
    first = client.post(base, json={"text": "A farmhand resting in golden hay."})
    assert first.status_code == 200
    assert first.json() == {"promptId": "prompt-001"}
    second = client.post(base, json={"text": "Close-up of a straw hat."})
    assert second.json() == {"promptId": "prompt-002"}

    # Empty and chat-wrapper text are rejected.
    assert client.post(base, json={"text": "   "}).status_code == 400
    assert client.post(base, json={"text": "Sure! Here's the prompt you asked for."}).status_code == 400

    # Unknown panel / prompt are 404.
    assert client.post(
        "/api/projects/farm-comic/story-panels/panels/panel-999/image-prompts",
        json={"text": "x"},
    ).status_code == 404
    assert client.put(f"{base}/prompt-999", json={"text": "revised"}).status_code == 404

    # Replace updates in place.
    replaced = client.put(f"{base}/prompt-001", json={"text": "A farmhand asleep in the hay at dusk."})
    assert replaced.status_code == 200
    document = client.get("/api/projects/farm-comic/story-panels").json()
    panel = next(item for item in document["panels"] if item["id"] == panel_id)
    texts = {prompt["id"]: prompt["text"] for prompt in panel["imagePrompts"]}
    assert texts["prompt-001"] == "A farmhand asleep in the hay at dusk."
    assert texts["prompt-002"] == "Close-up of a straw hat."


def test_instructions_rejected_for_profile_without_instructions(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    manager = use_fake_pi(monkeypatch)
    with pytest.raises(HTTPException) as exc_info:
        manager.start_task("farm-comic", "read-book", instructions="hello")
    assert exc_info.value.status_code == 400


def test_pi_task_start_requires_book(tmp_path, monkeypatch):
    client = setup_tmp_library(tmp_path, monkeypatch)
    response = client.post("/api/projects", json={"slug": "farm-comic", "name": "Farm Comic"})
    assert response.status_code == 200
    use_fake_pi(monkeypatch)

    response = client.post("/api/projects/farm-comic/pi-tasks", json={"profile": "read-book"})
    assert response.status_code == 400
    assert "book.txt" in response.text
