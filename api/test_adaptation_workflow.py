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


def test_step_generate_concept_character_writes_file(tmp_path: Path) -> None:
    from adaptation_workflow.character_file import CHARACTER_SHEET_LAYOUT_BLOCK
    from adaptation_workflow.config import AdaptationContext, REPO_ROOT, SKILLS_DIR
    from adaptation_workflow.steps import StepRunner

    book_root = tmp_path / "proj" / "adaptation"
    concept_dir = book_root / "concept-art"
    concept_dir.mkdir(parents=True)
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

    def fake_run_pi_step(_stage: str, _name: str, _rel_out: str, prompt: str) -> None:
        captured["prompt"] = prompt
        out = concept_dir / "character-concept-1.md"
        out.write_text(
            "## character-concept-1\n"
            "subject: character\n"
            "mode: new-image\n"
            "style_ref:\n\n"
            "Character reference sheet\n"
            "A weathered night watch pony with a brass lantern and navy cloak.\n"
            f"{CHARACTER_SHEET_LAYOUT_BLOCK}\n"
            "Expressions: alert, tired, stern, amused.\n"
        )

    steps.run_pi_step = fake_run_pi_step  # type: ignore[method-assign]
    key = steps.step_generate_concept_character()
    assert key == "character-concept-1"
    assert "/skill:concept-character" in captured["prompt"]
    assert "Pinkie Pie: Party pony." in captured["prompt"]
    assert "File key: character-concept-1" in captured["prompt"]


def test_step_generate_concept_location_writes_file(tmp_path: Path) -> None:
    from adaptation_workflow.config import AdaptationContext, REPO_ROOT, SKILLS_DIR
    from adaptation_workflow.steps import StepRunner

    book_root = tmp_path / "proj" / "adaptation"
    concept_dir = book_root / "concept-art"
    concept_dir.mkdir(parents=True)
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

    def fake_run_pi_step(_stage: str, _name: str, _rel_out: str, prompt: str) -> None:
        captured["prompt"] = prompt
        out = concept_dir / "location-concept-1.md"
        out.write_text(
            "## location-concept-1\n"
            "subject: location\n"
            "mode: new-image\n"
            "style_ref:\n\n"
            "A weathered hillside stone bridge over a shallow creek at dusk, with mossy railings "
            "and distant farm roofs visible through mist. Match the reference image's environmental "
            "rendering, palette, lighting, and detail level. No characters, no text, no labels, no watermarks.\n"
        )

    steps.run_pi_step = fake_run_pi_step  # type: ignore[method-assign]
    key = steps.step_generate_concept_location()
    assert key == "location-concept-1"
    assert "/skill:concept-location" in captured["prompt"]
    assert "sunny-barn" in captured["prompt"]
    assert "File key: location-concept-1" in captured["prompt"]


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


def test_parse_scene_list_and_reorder(tmp_path: Path) -> None:
    from adaptation_workflow.scene_list import SceneListEntry, parse_scene_list, reorder_scene_list, write_scene_list

    path = tmp_path / "scenes" / "list.txt"
    write_scene_list(
        path,
        [
            SceneListEntry(slug="001-alpha", description="First.", line_no=1),
            SceneListEntry(slug="002-beta", description="Second.", line_no=2),
        ],
    )
    entries = parse_scene_list(path)
    assert [entry.slug for entry in entries] == ["001-alpha", "002-beta"]
    reorder_scene_list(path, ["002-beta", "001-alpha"])
    assert [entry.slug for entry in parse_scene_list(path)] == ["002-beta", "001-alpha"]


def test_merge_staging_into_index(tmp_path: Path) -> None:
    from adaptation_workflow.locations import merge_staging_into_index

    book_root = tmp_path
    (book_root / "locations").mkdir()
    (book_root / "locations" / "index.md").write_text(
        "## barn\nName: Barn\nType: location\nBase Location: none\nSource References:\n- `L1`: \"x\"\nVisual Traits:\n- red\n"
    )
    staging = book_root / "locations" / "staging" / "001-scene"
    staging.mkdir(parents=True)
    (staging / "garden.md").write_text(
        "## garden\nName: Garden\nType: location\nBase Location: none\nSource References:\n- `L2`: \"y\"\nVisual Traits:\n- green\n"
    )
    (staging / "barn.md").write_text("## barn\nName: Barn duplicate\nType: location\n")
    new_slugs = merge_staging_into_index(book_root, "001-scene")
    assert new_slugs == ["garden"]
    text = (book_root / "locations" / "index.md").read_text()
    assert "## garden" in text
    assert "duplicate" not in text


def test_validate_scene_list(tmp_path: Path) -> None:
    from adaptation_workflow.validate import validate_scene_list

    scenes = tmp_path / "scenes"
    scenes.mkdir()
    (scenes / "list.txt").write_text("001-alpha: First scene.\n002-beta: Second scene.\n")
    report = ValidationReport()
    validate_scene_list(tmp_path, report)
    assert report.success
