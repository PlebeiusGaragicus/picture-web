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


def _make_ctx(tmp_path: Path):
    from adaptation_workflow.config import AdaptationContext, REPO_ROOT, SKILLS_DIR

    book_root = tmp_path / "proj" / "adaptation"
    book_root.mkdir(parents=True, exist_ok=True)
    return AdaptationContext(
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


VALID_CHARACTER_FILE = (
    "# {stem}\n\n"
    "## Summary\n\nA yellow filly.\n\n"
    "## Visual Description\n\nYellow coat.\n\n"
    "## Behaviour, mannerisms and personality\n\nShy.\n\n"
    "## Continuity Notes\n\nStay yellow.\n\n"
    "## Source References\n\n- `L001`: \"Hi.\"\n\n"
    "# base\n"
    "mode: new-image\n"
    "style_ref: style-refs/archetype-character.png\n\n"
    "Character reference sheet. "
    "Layout: top row — front full-body, three-quarter full-body, back full-body, same neutral standing pose, consistent scale. "
    "Bottom row — four head close-ups. White background. No text, no labels, no watermarks. "
    "Expressions: joy, surprise, concern, determination.\n"
)


def test_extract_character_step_uses_list_line(tmp_path: Path) -> None:
    from adaptation_workflow.character_file import format_character_stub
    from pi_profiles import _extract_character_step

    ctx = _make_ctx(tmp_path)
    characters = ctx.book_root_abs / "characters"
    characters.mkdir(parents=True)
    (characters / "list.txt").write_text("Gilda: A yellow filly.\n")
    (characters / "gilda.md").write_text(format_character_stub("gilda", "Gilda: A yellow filly."))

    step = _extract_character_step(ctx, "gilda", force=False)
    prompt = step.build_prompt()
    assert prompt is not None
    assert "/skill:character-file" in prompt
    assert "Gilda: A yellow filly." in prompt

    (characters / "gilda.md").write_text(VALID_CHARACTER_FILE.format(stem="gilda"))
    step.on_success(None)

    # A valid file without force means there is nothing for pi to do.
    assert _extract_character_step(ctx, "gilda", force=False).build_prompt() is None
    assert _extract_character_step(ctx, "gilda", force=True).build_prompt() is not None


def test_suggest_concept_character_plan(tmp_path: Path, monkeypatch) -> None:
    from adaptation_workflow.character_file import CHARACTER_SHEET_LAYOUT_BLOCK
    from adaptation_workflow.concept_art import concept_scratch_path
    from pi_profiles import _suggest_concept_plan

    ctx = _make_ctx(tmp_path)
    characters = ctx.book_root_abs / "characters"
    characters.mkdir(parents=True)
    (characters / "list.txt").write_text("Pinkie Pie: Party pony.\n")

    created: dict[str, str] = {}

    def fake_create_from_pi(slug: str, subject_kind: str, path: Path, *, expected_key: str) -> str:
        assert slug == "proj"
        assert subject_kind == "character"
        assert path.is_file()
        created["key"] = expected_key
        path.unlink()
        return f"draft_{expected_key}"

    monkeypatch.setattr("concept_cards.create_concept_card_from_pi_file", fake_create_from_pi)
    monkeypatch.setattr("concept_cards.existing_concept_summaries", lambda _slug: [])

    steps = list(_suggest_concept_plan(ctx, "character"))
    assert len(steps) == 1
    prompt = steps[0].build_prompt()
    assert prompt is not None
    assert "/skill:concept-character" in prompt
    assert "Pinkie Pie: Party pony." in prompt
    key = prompt.split("File key: ", 1)[1].split("\n", 1)[0].strip()
    assert f"File key: {key}" in prompt

    concept_scratch_path(ctx.book_root_abs, key).write_text(
        f"## {key}\n"
        "subject: character\n"
        "mode: new-image\n"
        "style_ref:\n\n"
        "Character reference sheet\n"
        "A weathered night watch pony with a brass lantern and navy cloak.\n"
        f"{CHARACTER_SHEET_LAYOUT_BLOCK}\n"
        "Expressions: alert, tired, stern, amused.\n"
    )
    update = steps[0].on_success(None)
    assert update == {"outputCardId": f"draft_{key}", "subjectKind": "character"}
    assert created["key"] == key


def test_suggest_concept_location_plan(tmp_path: Path, monkeypatch) -> None:
    from adaptation_workflow.concept_art import concept_scratch_path
    from pi_profiles import _suggest_concept_plan

    ctx = _make_ctx(tmp_path)
    locations_dir = ctx.book_root_abs / "locations"
    locations_dir.mkdir(parents=True)
    (locations_dir / "index.md").write_text("## sunny-barn\nName: Sunny Barn\n")

    def fake_create_from_pi(slug: str, subject_kind: str, path: Path, *, expected_key: str) -> str:
        assert subject_kind == "location"
        path.unlink()
        return f"draft_{expected_key}"

    monkeypatch.setattr("concept_cards.create_concept_card_from_pi_file", fake_create_from_pi)
    monkeypatch.setattr("concept_cards.existing_concept_summaries", lambda _slug: [])

    steps = list(_suggest_concept_plan(ctx, "location"))
    assert len(steps) == 1
    prompt = steps[0].build_prompt()
    assert prompt is not None
    assert "/skill:concept-location" in prompt
    assert "sunny-barn" in prompt
    key = prompt.split("File key: ", 1)[1].split("\n", 1)[0].strip()

    concept_scratch_path(ctx.book_root_abs, key).write_text(
        f"## {key}\n"
        "subject: location\n"
        "mode: new-image\n"
        "style_ref:\n\n"
        "A weathered hillside stone bridge over a shallow creek at dusk. "
        "No characters, no text, no labels, no watermarks.\n"
    )
    update = steps[0].on_success(None)
    assert update == {"outputCardId": f"draft_{key}", "subjectKind": "location"}


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
