from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import adaptation_workflow.config as workflow_config
import gemini
import library
import pi_profiles
import pi_runtime
from main import app

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


def wait_for_state(handle: pi_runtime.TaskHandle, states: set[str], timeout: float = 15.0) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if handle.state in states:
            return handle.state
        time.sleep(0.05)
    raise AssertionError(f"Task never reached {states}; state={handle.state} error={handle.error}")


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

    character_list = pi_profiles.get_profile("extract-character-list")
    steps = list(character_list.plan(ctx, pi_profiles.TaskArgs()))
    assert len(steps) == 1
    assert steps[0].build_prompt() == f"/skill:character-list {ctx.book_root_abs}"
    assert steps[0].fork_from_book_session is True

    with pytest.raises(HTTPException) as exc_info:
        pi_profiles.get_profile("nope")
    assert exc_info.value.status_code == 404


def test_character_list_precheck_requires_book_session(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    ctx = workflow_config.AdaptationContext.for_slug("farm-comic")
    with pytest.raises(HTTPException) as exc_info:
        pi_profiles.get_profile("extract-character-list").precheck(ctx, pi_profiles.TaskArgs())
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
    assert exc_info.value.status_code == 409  # no list.txt yet

    (root / "characters").mkdir(parents=True, exist_ok=True)
    (root / "characters" / "list.txt").write_text("Hero: a brave farmhand\n")
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


def test_character_list_forks_book_session_and_syncs_stubs(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    root = library.project_dir("farm-comic") / "adaptation"
    write_book_session_manifest(root)
    list_path = (root / "characters" / "list.txt").resolve()
    monkeypatch.setenv("FAKE_PI_WRITE_FILE", f"{list_path}::Hero: a brave farmhand\n")
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "extract-character-list")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    argv = json.loads((root / "sessions" / "pi" / "fake-pi-argv.json").read_text())
    assert "--fork" in argv
    assert argv[argv.index("--fork") + 1] == "root-session"

    assert list_path.is_file()
    assert (root / "characters" / "hero.md").is_file()


def test_character_list_skips_pi_when_list_exists(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    root = library.project_dir("farm-comic") / "adaptation"
    write_book_session_manifest(root)
    (root / "characters").mkdir(parents=True, exist_ok=True)
    (root / "characters" / "list.txt").write_text("Hero: a brave farmhand\n")
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "extract-character-list")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    assert not (root / "sessions" / "pi" / "fake-pi-argv.json").exists()
    assert (root / "characters" / "hero.md").is_file()


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


VALID_CHARACTER_FILE = (
    "# {stem}\n\n"
    "## Summary\n\nA farmhand.\n\n"
    "## Visual Description\n\nSturdy.\n\n"
    "## Behaviour, mannerisms and personality\n\nKind.\n\n"
    "## Continuity Notes\n\nKeep hat.\n\n"
    "## Source References\n\n- `L001`: \"Hi.\"\n\n"
    "# base\n"
    "mode: new-image\n"
    "style_ref: style-refs/archetype-character.png\n\n"
    "Character reference sheet. "
    "Layout: top row — front full-body, three-quarter full-body, back full-body, same neutral standing pose, consistent scale. "
    "Bottom row — four head close-ups. White background. No text, no labels, no watermarks. "
    "Expressions: joy, surprise, concern, determination.\n"
)


def test_extract_all_characters_multi_step_progress(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    root = library.project_dir("farm-comic") / "adaptation"
    write_book_session_manifest(root)
    (root / "characters").mkdir(parents=True, exist_ok=True)
    (root / "characters" / "list.txt").write_text("Hero: a brave farmhand\nVillain: a scheming fox\n")
    # Hero already has a valid file, so its step is a no-op.
    (root / "characters" / "hero.md").write_text(VALID_CHARACTER_FILE.format(stem="hero"))
    monkeypatch.setenv("FAKE_PI_WRITE_FROM_PROMPT", VALID_CHARACTER_FILE)
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "extract-all-characters")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    progress = [record["event"] for record in handle.events_since(0) if record["event"]["type"] == "task_progress"]
    assert [event["index"] for event in progress] == [1, 2, 3]
    assert progress[0]["label"] == "character list"
    assert progress[1]["label"] == "character file hero"
    assert progress[2]["label"] == "character file villain"
    assert (root / "characters" / "villain.md").read_text().startswith("# villain")


def test_extract_one_character_skip_and_force(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    root = library.project_dir("farm-comic") / "adaptation"
    write_book_session_manifest(root)
    (root / "characters").mkdir(parents=True, exist_ok=True)
    (root / "characters" / "list.txt").write_text("Hero: a brave farmhand\n")
    (root / "characters" / "hero.md").write_text(VALID_CHARACTER_FILE.format(stem="hero"))
    monkeypatch.setenv("FAKE_PI_WRITE_FROM_PROMPT", VALID_CHARACTER_FILE)
    manager = use_fake_pi(monkeypatch)

    # Valid file + no force: pi never runs.
    handle = manager.start_task("farm-comic", "extract-character", target="hero")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"
    assert handle.target == "hero"
    assert not (root / "sessions" / "pi" / "fake-pi-argv.json").exists()

    # Force re-runs pi.
    handle = manager.start_task("farm-comic", "extract-character", target="hero", force=True)
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"
    assert (root / "sessions" / "pi" / "fake-pi-argv.json").exists()

    status = manager.get_status("farm-comic", handle.id)
    assert status.target == "hero"


def test_duplicate_target_conflicts_but_other_target_allowed(tmp_path, monkeypatch):
    setup_project_with_book(tmp_path, monkeypatch)
    root = library.project_dir("farm-comic") / "adaptation"
    write_book_session_manifest(root)
    (root / "characters").mkdir(parents=True, exist_ok=True)
    (root / "characters" / "list.txt").write_text("Hero: a brave farmhand\nVillain: a scheming fox\n")
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


def test_suggest_concept_character_creates_card(tmp_path, monkeypatch):
    from adaptation_workflow.character_file import CHARACTER_SHEET_LAYOUT_BLOCK

    client, root = setup_project_with_book(tmp_path, monkeypatch)
    write_book_session_manifest(root)
    scratch_content = (
        "## {stem}\n"
        "subject: character\n"
        "mode: new-image\n"
        "style_ref:\n\n"
        "Character reference sheet\n"
        "A weathered night watch pony with a brass lantern.\n"
        f"{CHARACTER_SHEET_LAYOUT_BLOCK}\n"
        "Expressions: alert, tired, stern, amused.\n"
    )
    monkeypatch.setenv("FAKE_PI_WRITE_FROM_PROMPT", scratch_content)
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "suggest-concept-character")
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    cards = client.get("/api/projects/farm-comic/concept-cards").json()
    assert len(cards) == 1
    assert cards[0]["subjectKind"] == "character"
    assert "night watch pony" in cards[0]["prompt"]
    # Scratch file is consumed on card creation.
    assert not list((root / ".concept-scratch").glob("*.md"))

    session = client.get(f"/api/projects/farm-comic/agent-sessions/{handle.id}").json()
    assert session["kind"] == "suggest-concept-character"
    assert session["source"]["outputCardId"] == cards[0]["id"]


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
    (root / "characters").mkdir(parents=True, exist_ok=True)
    (root / "characters" / "list.txt").write_text("Hero: a brave farmhand\n")
    (root / "characters" / "hero.md").write_text(VALID_CHARACTER_FILE.format(stem="hero"))
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
    assert prompt.startswith(f"/skill:panel-prompt {root / '.prompt-scratch' / panel_ids[2]}.md")
    assert "A fox watches from the fence." in prompt
    assert "The barn at dawn." in prompt  # two panels before
    assert "Rain begins." in prompt  # panel after
    assert "hero:" in prompt  # canonical character look
    assert "Character reference sheet" in prompt
    assert "Imagen prompt guide" in prompt
    assert pi_profiles.load_prompt_guide().rstrip() in prompt


def test_draft_panel_prompt_injects_user_guidance(tmp_path, monkeypatch):
    client, _root = setup_project_with_book(tmp_path, monkeypatch)
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
    client, _root = setup_project_with_book(tmp_path, monkeypatch)
    ctx = workflow_config.AdaptationContext.for_slug("farm-comic")
    profile = pi_profiles.get_profile("draft-panel-prompt")

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs())
    assert exc_info.value.status_code == 400

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
    client, _root = setup_project_with_book(tmp_path, monkeypatch)
    ctx = workflow_config.AdaptationContext.for_slug("farm-comic")
    profile = pi_profiles.get_profile("refine-panel-prompt")
    (panel_id,) = make_story_panels(client, ["Hero rests."])

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target=panel_id, instructions="darker"))
    assert exc_info.value.status_code == 400  # missing :promptId

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target=f"{panel_id}:prompt-001"))
    assert exc_info.value.status_code == 400  # missing instructions

    with pytest.raises(HTTPException) as exc_info:
        profile.precheck(ctx, pi_profiles.TaskArgs(target=f"{panel_id}:prompt-001", instructions="darker"))
    assert exc_info.value.status_code == 404  # prompt does not exist


def test_draft_panel_prompt_end_to_end(tmp_path, monkeypatch):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    (panel_id,) = make_story_panels(client, ["Hero feeds the chickens at dawn."])
    drafted = "A brave farmhand scattering feed to chickens at dawn, wide shot, golden-hour backlight.\n"
    monkeypatch.setenv("FAKE_PI_WRITE_FROM_PROMPT", drafted)
    manager = use_fake_pi(monkeypatch)

    handle = manager.start_task("farm-comic", "draft-panel-prompt", target=panel_id)
    assert wait_for_state(handle, {"done", "failed", "cancelled"}) == "done"

    document = client.get("/api/projects/farm-comic/story-panels").json()
    panel = next(item for item in document["panels"] if item["id"] == panel_id)
    assert len(panel["imagePrompts"]) == 1
    assert panel["imagePrompts"][0]["text"] == drafted.strip()
    # Scratch file consumed on success.
    assert not list((root / ".prompt-scratch").glob("*.md"))

    session = client.get(f"/api/projects/farm-comic/agent-sessions/{handle.id}").json()
    assert session["kind"] == "draft-panel-prompt"
    assert session["source"]["panelId"] == panel_id
    assert session["source"]["promptId"] == panel["imagePrompts"][0]["id"]


def test_refine_panel_prompt_end_to_end(tmp_path, monkeypatch):
    client, root = setup_project_with_book(tmp_path, monkeypatch)
    (panel_id,) = make_story_panels(client, ["Hero feeds the chickens at dawn."])
    patch = client.patch(
        f"/api/projects/farm-comic/story-panels/panels/{panel_id}",
        json={"imagePrompts": [
            {"id": "prompt-001", "text": "A farmhand with chickens."},
            {"id": "prompt-002", "text": "Keep me unchanged."},
        ]},
    )
    assert patch.status_code == 200
    refined = "A brave farmhand scattering feed to eager chickens, low-angle, soft dawn fog.\n"
    monkeypatch.setenv("FAKE_PI_WRITE_FROM_PROMPT", refined)
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
    assert texts["prompt-001"] == refined.strip()
    assert texts["prompt-002"] == "Keep me unchanged."
    assert not list((root / ".prompt-scratch").glob("*.md"))


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
