"""Tests for adaptation_workflow package."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from adaptation_workflow.events import clip_text, project_event
from adaptation_workflow.slugify import slugify_name
from adaptation_workflow.validate import (
    ValidationReport,
    validate_character_artifact,
    validate_character_sheet,
    validate_location_prompt,
    validate_locations,
    validate_style_refs,
)


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


def test_validate_character_artifact_and_sheet(tmp_path: Path) -> None:
    artifact = tmp_path / "hero.md"
    artifact.write_text(
        "## Summary\nx\n## Visual Description\nx\n## Visual Variants\nx\n## Source References\nx\n"
    )
    validate_character_artifact(artifact)

    sheet = tmp_path / "hero-sheet.md"
    sheet.write_text(
        "## hero\nmode: new-image\nstyle_ref: ref\n\nLayout: top row\nExpressions:\n"
    )
    validate_character_sheet(sheet)


def test_validate_style_refs_reports_missing_archetypes(tmp_path: Path) -> None:
    style_refs = tmp_path / "style-refs"
    style_refs.mkdir()
    (style_refs / "archetype-character.md").write_text("character")
    report = ValidationReport()
    validate_style_refs(tmp_path, report)
    assert not report.success
    assert any("archetype-scene.md" in failure for failure in report.failures)


def test_validate_style_refs_passes_with_both_archetypes(tmp_path: Path) -> None:
    style_refs = tmp_path / "style-refs"
    style_refs.mkdir()
    (style_refs / "archetype-character.md").write_text("character")
    (style_refs / "archetype-scene.md").write_text("scene")
    report = ValidationReport()
    validate_style_refs(tmp_path, report)
    assert report.success


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


def test_extract_sections(tmp_path: Path) -> None:
    from adaptation_workflow.sections import extract_sections

    source = tmp_path / "index.md"
    source.write_text(
        "# Locations\n\n"
        "## Barn\nName: Barn\nType: interior\n"
        "Source References:\n- ch1\nVisual Traits:\n- red\n\n"
        "## Field\nName: Field\nType: exterior\n"
        "Source References:\n- ch2\nVisual Traits:\n- green\n"
    )
    out_dir = tmp_path / "entries"
    written = extract_sections(source, out_dir)
    assert len(written) == 2
    assert (out_dir / "Barn.md").read_text().startswith("## Barn")
    assert (out_dir / "Field.md").read_text().startswith("## Field")


def test_validate_location_prompt(tmp_path: Path) -> None:
    prompt = tmp_path / "barn.md"
    prompt.write_text(
        "mode: new-image\nstyle_ref: archetype-scene\n"
        "No characters, no text, no labels, no watermarks.\n"
    )
    validate_location_prompt(prompt)

    bad = tmp_path / "bad.md"
    bad.write_text("Location prompt for barn\nmode: new-image\nstyle_ref: x\nNo characters, no text, no labels, no watermarks.\n")
    with pytest.raises(Exception):
        validate_location_prompt(bad)


def test_validate_locations(tmp_path: Path) -> None:
    locations = tmp_path / "locations"
    prompts = locations / "prompts"
    prompts.mkdir(parents=True)
    (locations / "index.md").write_text(
        "## Barn\nName: Barn\nType: interior\n"
        "Source References:\n- ch1\nVisual Traits:\n- red\n"
    )
    (prompts / "Barn.md").write_text(
        "mode: new-image\nstyle_ref: archetype-scene\n"
        "No characters, no text, no labels, no watermarks.\n"
    )
    report = ValidationReport()
    validate_locations(tmp_path, report)
    assert report.success
    assert any("checked 1 location entries" in message for message in report.passes)
