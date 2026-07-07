"""Tests for pi_profiles task plans and steps."""

from __future__ import annotations

from pathlib import Path

import pytest

from common import slugify as slugify_name
from models import CharacterRecord, EntityVariant, LocationRecord


def test_slugify_name() -> None:
    assert slugify_name("Butterscotch Jr.") == "butterscotch-jr"


def _make_ctx(tmp_path: Path):
    from pi_env import AdaptationContext, REPO_ROOT, SKILLS_DIR

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


def _registered_record(slug: str, *, extracted: bool) -> CharacterRecord:
    if not extracted:
        return CharacterRecord(slug=slug, name=slug.title(), summary="A yellow filly.")
    return CharacterRecord(
        slug=slug,
        name=slug.title(),
        summary="A yellow filly.",
        visualDescription="Yellow coat.",
        performanceNotes="Shy.",
        continuityNotes="Stay yellow.",
        variants={"base": EntityVariant(prompt="Character reference sheet.")},
    )


def _registered_location(slug: str, *, extracted: bool) -> LocationRecord:
    if not extracted:
        return LocationRecord(slug=slug, name=slug.title(), summary="A sunny barn.")
    return LocationRecord(
        slug=slug,
        name=slug.title(),
        summary="A sunny barn.",
        visualDescription="Red planks.",
        continuityNotes="Keep the weathervane.",
        variants={"base": EntityVariant(prompt="Location reference.")},
    )


def test_discover_characters_step(tmp_path: Path, monkeypatch) -> None:
    from pi_profiles import PiTaskResultInfo, _CHARACTER_KIND, _discover_entities_step

    ctx = _make_ctx(tmp_path)
    records: dict[str, CharacterRecord] = {}
    monkeypatch.setattr("pi_profiles._registered_characters", lambda _ctx: dict(records))

    step = _discover_entities_step(ctx, _CHARACTER_KIND, force=False)
    prompt = step.build_prompt()
    assert prompt is not None
    assert "/skill:discover-characters" in prompt

    # Agent never calls register_character -> on_success fails.
    with pytest.raises(RuntimeError, match="register_character"):
        step.on_success(PiTaskResultInfo())

    records["gilda"] = _registered_record("gilda", extracted=False)
    assert step.on_success(PiTaskResultInfo()) == {"registeredSlugs": ["gilda"]}

    # Existing records without force means there is nothing for pi to do.
    assert _discover_entities_step(ctx, _CHARACTER_KIND, force=False).build_prompt() is None
    force_prompt = _discover_entities_step(ctx, _CHARACTER_KIND, force=True).build_prompt()
    assert force_prompt is not None
    assert "do NOT register these again" in force_prompt
    assert "Gilda: A yellow filly." in force_prompt


def test_discover_locations_step(tmp_path: Path, monkeypatch) -> None:
    from pi_profiles import PiTaskResultInfo, _LOCATION_KIND, _discover_entities_step

    ctx = _make_ctx(tmp_path)
    records: dict[str, LocationRecord] = {}
    monkeypatch.setattr("pi_profiles._registered_locations", lambda _ctx: dict(records))

    step = _discover_entities_step(ctx, _LOCATION_KIND, force=False)
    prompt = step.build_prompt()
    assert prompt is not None
    assert "/skill:discover-locations" in prompt

    with pytest.raises(RuntimeError, match="register_location"):
        step.on_success(PiTaskResultInfo())

    records["sunny-barn"] = _registered_location("sunny-barn", extracted=False)
    assert step.on_success(PiTaskResultInfo()) == {"registeredSlugs": ["sunny-barn"]}
    assert _discover_entities_step(ctx, _LOCATION_KIND, force=False).build_prompt() is None


def test_extract_character_step_uses_record(tmp_path: Path, monkeypatch) -> None:
    from pi_profiles import _CHARACTER_KIND, _extract_entity_step

    ctx = _make_ctx(tmp_path)
    records = {"gilda": _registered_record("gilda", extracted=False)}
    monkeypatch.setattr("pi_profiles._registered_characters", lambda _ctx: dict(records))

    step = _extract_entity_step(ctx, _CHARACTER_KIND, "gilda", force=False)
    prompt = step.build_prompt()
    assert prompt is not None
    assert "/skill:extract-character gilda" in prompt
    assert "A yellow filly." in prompt

    # Agent never delivers -> on_success fails on the still-empty record.
    with pytest.raises(RuntimeError, match="update_character"):
        step.on_success(None)

    records["gilda"] = _registered_record("gilda", extracted=True)
    step.on_success(None)

    # An extracted record without force means there is nothing for pi to do.
    assert _extract_entity_step(ctx, _CHARACTER_KIND, "gilda", force=False).build_prompt() is None
    assert _extract_entity_step(ctx, _CHARACTER_KIND, "gilda", force=True).build_prompt() is not None


def test_extract_location_step_uses_record(tmp_path: Path, monkeypatch) -> None:
    from pi_profiles import _LOCATION_KIND, _extract_entity_step

    ctx = _make_ctx(tmp_path)
    records = {"sunny-barn": _registered_location("sunny-barn", extracted=False)}
    monkeypatch.setattr("pi_profiles._registered_locations", lambda _ctx: dict(records))

    step = _extract_entity_step(ctx, _LOCATION_KIND, "sunny-barn", force=False)
    prompt = step.build_prompt()
    assert prompt is not None
    assert "/skill:extract-location sunny-barn" in prompt
    assert "A sunny barn." in prompt
    # Location record context has no performanceNotes field.
    assert "performanceNotes" not in prompt

    with pytest.raises(RuntimeError, match="update_location"):
        step.on_success(None)

    records["sunny-barn"] = _registered_location("sunny-barn", extracted=True)
    step.on_success(None)
    assert _extract_entity_step(ctx, _LOCATION_KIND, "sunny-barn", force=False).build_prompt() is None


def test_refine_character_plan(tmp_path: Path, monkeypatch) -> None:
    from pi_profiles import TaskArgs, _CHARACTER_KIND, _refine_entity_plan

    ctx = _make_ctx(tmp_path)
    records = {"gilda": _registered_record("gilda", extracted=True)}
    monkeypatch.setattr("pi_profiles._registered_characters", lambda _ctx: dict(records))

    steps = list(_refine_entity_plan(ctx, _CHARACTER_KIND, TaskArgs(target="gilda", instructions="Make the scar prominent")))
    assert len(steps) == 1
    prompt = steps[0].build_prompt()
    assert prompt is not None
    assert "/skill:refine-character gilda" in prompt
    assert "Make the scar prominent" in prompt

    # Unchanged record -> agent never called update_character.
    with pytest.raises(RuntimeError, match="update_character"):
        steps[0].on_success(None)

    records["gilda"] = records["gilda"].model_copy(update={"visualDescription": "Yellow coat, prominent scar."})
    assert steps[0].on_success(None) == {"characterSlug": "gilda"}


def test_refine_location_plan(tmp_path: Path, monkeypatch) -> None:
    from pi_profiles import TaskArgs, _LOCATION_KIND, _refine_entity_plan

    ctx = _make_ctx(tmp_path)
    records = {"sunny-barn": _registered_location("sunny-barn", extracted=True)}
    monkeypatch.setattr("pi_profiles._registered_locations", lambda _ctx: dict(records))

    steps = list(_refine_entity_plan(ctx, _LOCATION_KIND, TaskArgs(target="sunny-barn", instructions="Add the silo")))
    assert len(steps) == 1
    prompt = steps[0].build_prompt()
    assert prompt is not None
    assert "/skill:refine-location sunny-barn" in prompt
    assert "Add the silo" in prompt

    with pytest.raises(RuntimeError, match="update_location"):
        steps[0].on_success(None)

    records["sunny-barn"] = records["sunny-barn"].model_copy(update={"visualDescription": "Red planks, tall silo."})
    assert steps[0].on_success(None) == {"locationSlug": "sunny-barn"}


def test_suggest_concept_character_plan(tmp_path: Path, monkeypatch) -> None:
    from types import SimpleNamespace

    from pi_profiles import _suggest_concept_plan

    ctx = _make_ctx(tmp_path)
    monkeypatch.setattr(
        "pi_profiles._registered_characters",
        lambda _ctx: {"pinkie-pie": _registered_record("pinkie-pie", extracted=False).model_copy(update={"name": "Pinkie Pie", "summary": "Party pony."})},
    )

    cards: list[SimpleNamespace] = []
    monkeypatch.setattr("concept_cards.existing_concept_summaries", lambda _slug: [])
    monkeypatch.setattr("concept_cards.list_cards", lambda _slug, include_archived=False: list(cards))

    steps = list(_suggest_concept_plan(ctx, "character"))
    assert len(steps) == 1
    prompt = steps[0].build_prompt()
    assert prompt is not None
    assert "/skill:concept-character" in prompt
    assert "Pinkie Pie: Party pony." in prompt

    # Agent never calls create_concept_card -> on_success fails.
    with pytest.raises(RuntimeError, match="create_concept_card"):
        steps[0].on_success(None)

    # Simulate the tool creating a card during the run.
    cards.append(SimpleNamespace(id="card-abc", createdAt="2026-01-01T00:00:00Z"))
    update = steps[0].on_success(None)
    assert update == {"outputCardId": "card-abc", "subjectKind": "character"}


def test_suggest_concept_location_plan(tmp_path: Path, monkeypatch) -> None:
    from types import SimpleNamespace

    from pi_profiles import _suggest_concept_plan

    ctx = _make_ctx(tmp_path)
    monkeypatch.setattr(
        "pi_profiles._registered_locations",
        lambda _ctx: {"sunny-barn": _registered_location("sunny-barn", extracted=False).model_copy(update={"name": "Sunny Barn"})},
    )

    cards: list[SimpleNamespace] = []
    monkeypatch.setattr("concept_cards.existing_concept_summaries", lambda _slug: [])
    monkeypatch.setattr("concept_cards.list_cards", lambda _slug, include_archived=False: list(cards))

    steps = list(_suggest_concept_plan(ctx, "location"))
    assert len(steps) == 1
    prompt = steps[0].build_prompt()
    assert prompt is not None
    assert "/skill:concept-location" in prompt
    assert "Sunny Barn: A sunny barn." in prompt

    cards.append(SimpleNamespace(id="card-loc", createdAt="2026-01-01T00:00:00Z"))
    update = steps[0].on_success(None)
    assert update == {"outputCardId": "card-loc", "subjectKind": "location"}
