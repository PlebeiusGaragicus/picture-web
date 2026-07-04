"""Tests for adaptation_workflow package."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from adaptation_workflow.events import clip_text, project_event
from common import slugify as slugify_name
from adaptation_workflow.validate import ValidationError, validate_character_file


def test_slugify_name() -> None:
    assert slugify_name("Butterscotch Jr.") == "butterscotch-jr"


def test_clip_text_truncates() -> None:
    assert clip_text("hello", 10) == "hello"
    assert clip_text("x" * 20, 10) == ("x" * 10) + "…[+truncated]"


def test_project_event_assistant_text() -> None:
    projected = project_event(
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Done."}],
            },
        }
    )
    assert projected == {"type": "assistant_text", "text": "Done."}


def test_project_event_tool_end() -> None:
    projected = project_event(
        {
            "type": "tool_execution_end",
            "toolName": "read",
            "isError": False,
            "result": {"content": [{"type": "text", "text": "ok"}]},
        }
    )
    assert projected is not None
    assert projected["type"] == "tool_end"
    assert projected["toolName"] == "read"
    assert projected["isError"] is False


def test_step_character_file_uses_list_line(tmp_path: Path) -> None:
    from adaptation_workflow.character_file import format_character_stub
    from adaptation_workflow.config import AdaptationContext, REPO_ROOT, SKILLS_DIR
    from adaptation_workflow.steps import StepRunner

    book_root = tmp_path / "proj" / "adaptation"
    characters = book_root / "characters"
    characters.mkdir(parents=True)
    (characters / "list.txt").write_text("Gilda: A yellow filly.\n")
    (characters / "gilda.md").write_text(format_character_stub("gilda", "Gilda: A yellow filly."))

    ctx = AdaptationContext(
        repo_root=REPO_ROOT,
        project_slug="proj",
        book_root=Path("photo-library/projects/proj/adaptation"),
        book_root_abs=book_root,
        pi_workspace=book_root / "sessions" / "pi-workspace",
        pi_session_dir=book_root / "sessions" / "pi",
        skills_dir=SKILLS_DIR,
        book_session_path=book_root / "sessions" / "book-session.json",
        book_path=book_root / "book.txt",
    )

    captured: dict[str, str] = {}

    class FakeLogger:
        def write_line(self, *_args, **_kwargs) -> None:
            return None

        def write_skip(self, *_args, **_kwargs) -> None:
            return None

        def record_task(self, **_kwargs) -> None:
            return None

    steps = StepRunner(ctx, FakeLogger())  # type: ignore[arg-type]

    def fake_run_pi_step(_stage: str, _name: str, _rel_out: str, prompt: str) -> None:
        captured["prompt"] = prompt
        (characters / "gilda.md").write_text(
            "# gilda\n\n"
            "## Summary\n\nGilda: A yellow filly.\n\n"
            "## Visual Description\n\nYellow coat.\n\n"
            "## Behaviour, mannerisms and personality\n\nShy.\n\n"
            "## Continuity Notes\n\nStay yellow.\n\n"
            "## Source References\n\n- `L001`: \"Hi.\"\n\n"
            "# base\n"
            "mode: new-image\n"
            "style_ref: style-refs/archetype-character.png\n\n"
            "Character reference sheet for Gilda. "
            "Layout: top row — front full-body, three-quarter full-body, back full-body, same neutral standing pose, consistent scale. "
            "Bottom row — four head close-ups. White background. No text, no labels, no watermarks. "
            "Expressions: joy, surprise, concern, determination.\n"
        )

    steps.run_pi_step = fake_run_pi_step  # type: ignore[method-assign]
    steps.step_character_file("gilda")
    assert "Gilda: A yellow filly." in captured["prompt"]


def test_step_generate_concept_character_writes_file(tmp_path: Path, monkeypatch) -> None:
    from adaptation_workflow.character_file import CHARACTER_SHEET_LAYOUT_BLOCK
    from adaptation_workflow.concept_art import concept_scratch_path, next_character_concept_key
    from adaptation_workflow.config import AdaptationContext, REPO_ROOT, SKILLS_DIR
    from adaptation_workflow.steps import StepRunner

    book_root = tmp_path / "proj" / "adaptation"
    book_root.mkdir(parents=True)
    (book_root / "characters" / "list.txt").parent.mkdir(parents=True, exist_ok=True)
    (book_root / "characters" / "list.txt").write_text("Pinkie Pie: Party pony.\n")

    ctx = AdaptationContext(
        repo_root=REPO_ROOT,
        project_slug="proj",
        book_root=Path("photo-library/projects/proj/adaptation"),
        book_root_abs=book_root,
        pi_workspace=book_root / "sessions" / "pi-workspace",
        pi_session_dir=book_root / "sessions" / "pi",
        skills_dir=SKILLS_DIR,
        book_session_path=book_root / "sessions" / "book-session.json",
        book_path=book_root / "book.txt",
    )

    captured: dict[str, str] = {}

    class FakeLogger:
        def write_line(self, *_args, **_kwargs) -> None:
            return None

        def write_skip(self, *_args, **_kwargs) -> None:
            return None

        def record_task(self, **_kwargs) -> None:
            return None

    steps = StepRunner(ctx, FakeLogger())  # type: ignore[arg-type]
    key = next_character_concept_key(book_root)

    def fake_run_pi_step(_stage: str, _name: str, _rel_out: str, prompt: str) -> None:
        captured["prompt"] = prompt
        out = concept_scratch_path(book_root, key)
        out.write_text(
            f"## {key}\n"
            "subject: character\n"
            "mode: new-image\n"
            "style_ref:\n\n"
            "Character reference sheet\n"
            "A weathered night watch pony with a brass lantern and navy cloak.\n"
            f"{CHARACTER_SHEET_LAYOUT_BLOCK}\n"
            "Expressions: alert, tired, stern, amused.\n"
        )

    def fake_create_from_pi(slug: str, subject_kind: str, path: Path, *, expected_key: str) -> str:
        assert slug == "proj"
        assert subject_kind == "character"
        assert expected_key == key
        assert path.is_file()
        path.unlink()
        return f"draft_{expected_key}"

    steps.run_pi_step = fake_run_pi_step  # type: ignore[method-assign]
    monkeypatch.setattr("concept_cards.create_concept_card_from_pi_file", fake_create_from_pi)
    monkeypatch.setattr("concept_cards.existing_concept_summaries", lambda _slug: [])
    node_id = steps.step_generate_concept_character()
    assert node_id == f"draft_{key}"
    assert "/skill:concept-character" in captured["prompt"]
    assert "Pinkie Pie: Party pony." in captured["prompt"]
    assert f"File key: {key}" in captured["prompt"]


def test_step_generate_concept_location_writes_file(tmp_path: Path, monkeypatch) -> None:
    from adaptation_workflow.concept_art import concept_scratch_path, next_location_concept_key
    from adaptation_workflow.config import AdaptationContext, REPO_ROOT, SKILLS_DIR
    from adaptation_workflow.steps import StepRunner

    book_root = tmp_path / "proj" / "adaptation"
    book_root.mkdir(parents=True)
    locations_dir = book_root / "locations"
    locations_dir.mkdir(parents=True)
    (locations_dir / "index.md").write_text("## sunny-barn\nName: Sunny Barn\n")

    ctx = AdaptationContext(
        repo_root=REPO_ROOT,
        project_slug="proj",
        book_root=Path("photo-library/projects/proj/adaptation"),
        book_root_abs=book_root,
        pi_workspace=book_root / "sessions" / "pi-workspace",
        pi_session_dir=book_root / "sessions" / "pi",
        skills_dir=SKILLS_DIR,
        book_session_path=book_root / "sessions" / "book-session.json",
        book_path=book_root / "book.txt",
    )

    captured: dict[str, str] = {}

    class FakeLogger:
        def write_line(self, *_args, **_kwargs) -> None:
            return None

        def write_skip(self, *_args, **_kwargs) -> None:
            return None

        def record_task(self, **_kwargs) -> None:
            return None

    steps = StepRunner(ctx, FakeLogger())  # type: ignore[arg-type]
    key = next_location_concept_key(book_root)

    def fake_run_pi_step(_stage: str, _name: str, _rel_out: str, prompt: str) -> None:
        captured["prompt"] = prompt
        out = concept_scratch_path(book_root, key)
        out.write_text(
            f"## {key}\n"
            "subject: location\n"
            "mode: new-image\n"
            "style_ref:\n\n"
            "A weathered hillside stone bridge over a shallow creek at dusk, with mossy railings "
            "and distant farm roofs visible through mist. Match the reference image's environmental "
            "rendering, palette, lighting, and detail level. No characters, no text, no labels, no watermarks.\n"
        )

    def fake_create_from_pi(slug: str, subject_kind: str, path: Path, *, expected_key: str) -> str:
        assert slug == "proj"
        assert subject_kind == "location"
        assert expected_key == key
        path.unlink()
        return f"draft_{expected_key}"

    steps.run_pi_step = fake_run_pi_step  # type: ignore[method-assign]
    monkeypatch.setattr("concept_cards.create_concept_card_from_pi_file", fake_create_from_pi)
    monkeypatch.setattr("concept_cards.existing_concept_summaries", lambda _slug: [])
    node_id = steps.step_generate_concept_location()
    assert node_id == f"draft_{key}"
    assert "/skill:concept-location" in captured["prompt"]
    assert "sunny-barn" in captured["prompt"]
    assert f"File key: {key}" in captured["prompt"]


def test_validate_character_file_stub_and_full(tmp_path: Path) -> None:
    from adaptation_workflow.character_file import format_character_stub
    from adaptation_workflow.validate import (
        ValidationError,
        validate_character_file,
        validate_character_stub,
    )

    stub = tmp_path / "hero.md"
    stub.write_text(format_character_stub("hero", "Hero: A hero."))
    validate_character_stub(stub)

    full = tmp_path / "pinkie-pie.md"
    full.write_text(
        "# pinkie-pie\n\n"
        "## Summary\n\nPinkie Pie summary.\n\n"
        "## Visual Description\n\nPink body.\n\n"
        "## Behaviour, mannerisms and personality\n\nBouncy.\n\n"
        "## Continuity Notes\n\nStay pink.\n\n"
        "## Source References\n\n- `L001`: \"Hi.\"\n\n"
        "# base\n"
        "mode: new-image\n"
        "style_ref: style-refs/archetype-character.png\n\n"
        "Character reference sheet for Pinkie Pie. "
        "Layout: top row — front full-body, three-quarter full-body, back full-body, same neutral standing pose, consistent scale. "
        "Bottom row — four head close-ups. White background. No text, no labels, no watermarks. "
        "Expressions: joy, surprise, concern, determination.\n"
    )
    validate_character_file(full, require_variants=True)

    bad = tmp_path / "bad.md"
    bad.write_text("# bad\n\n## Summary\n\nOnly summary.\n")
    with pytest.raises(ValidationError):
        validate_character_file(bad, require_variants=False)


def test_project_event_lifecycle_passthrough() -> None:
    assert project_event({"type": "agent_end"}) == {"type": "agent_end"}


def test_node_major() -> None:
    from adaptation_workflow.config import node_major

    assert node_major("v22.1.0") == 22
    assert node_major("v18.16.1") == 18
    assert node_major("invalid") == 0


def test_pi_runtime_env_prefers_node22(tmp_path: Path, monkeypatch) -> None:
    from adaptation_workflow.config import pi_runtime_env, resolve_node_path

    fake_node22 = tmp_path / "node22" / "bin"
    fake_node22.mkdir(parents=True)
    (fake_node22 / "node").write_text("#!/bin/sh\necho v22.0.0\n")
    (fake_node22 / "node").chmod(0o755)

    monkeypatch.setattr(
        "adaptation_workflow.config.NODE22_BIN_CANDIDATES",
        (fake_node22,),
    )
    env = pi_runtime_env({"PATH": "/usr/bin"})
    node = resolve_node_path(env)
    assert node == str(fake_node22 / "node")


def test_run_diagnostics_manifest(tmp_path: Path) -> None:
    from adaptation_workflow.diagnostics import RunDiagnostics

    book_root = tmp_path / "adaptation"
    book_root.mkdir()
    diag = RunDiagnostics.create(book_root, "ingest", validation=False)
    diag.write_manifest(book_root, extra={"project": "cup"})
    manifest = json.loads(diag.manifest_path.read_text())
    assert manifest["stage"] == "ingest"
    assert manifest["project"] == "cup"
    assert manifest["tasksDir"] == "sessions/tasks"


def test_book_session_roundtrip(tmp_path: Path) -> None:
    from adaptation_workflow.config import BookSession

    manifest = tmp_path / "book-session.json"
    session = BookSession(
        session_file="/tmp/session.jsonl",
        session_id="abc123",
        created_at="2026-01-01T00:00:00Z",
        book_path="/tmp/book.txt",
    )
    session.write(manifest)
    loaded = BookSession.load(manifest)
    assert loaded is not None
    assert loaded.session_id == "abc123"
    assert json.loads(manifest.read_text())["bookPath"] == "/tmp/book.txt"
