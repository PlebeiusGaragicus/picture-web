"""Task profiles for narrow, single-purpose pi agent runs.

A profile is the unit of configuration for a pi task: it prechecks the
request, then plans a sequence of steps. Each step optionally runs one
pi subprocess (prompt built lazily, so later steps can depend on files
produced by earlier ones) and finishes with an `on_success` hook that
validates/lands the result. The runtime (`pi_runtime`) stays generic;
buttons in the UI map to a profile id (+ optional target) and nothing
more.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator

from fastapi import HTTPException

import adaptation
from pi_env import AdaptationContext, BookSession
from common import utc_now
from models import CharacterRecord


PROMPT_GUIDES_DIR = Path(__file__).resolve().parent / "prompt_guides"


def load_prompt_guide(name: str = "imagen") -> str:
    """Model-specific image-prompt guide injected into prompt-authoring profiles."""
    return (PROMPT_GUIDES_DIR / f"{name}.md").read_text()


@dataclass(frozen=True)
class TaskArgs:
    """Per-run arguments a button sends alongside the profile id."""

    target: str | None = None
    force: bool = False
    instructions: str | None = None


@dataclass(frozen=True)
class PiTaskResultInfo:
    """Session identity captured from pi after a step (None when skipped)."""

    session_id: str | None = None
    session_file: str | None = None


@dataclass
class TaskStep:
    """One unit of work inside a task.

    `build_prompt` returning None means there is nothing for pi to do
    (already done / pure bookkeeping); the runtime then only calls
    `on_success(None)`. `on_success` may return a dict merged into the
    agent-session `source` (e.g. `{"outputCardId": ...}`).
    """

    name: str
    build_prompt: Callable[[], str | None]
    on_success: Callable[[PiTaskResultInfo | None], dict[str, Any] | None] = lambda result: None
    fork_from_book_session: bool = True


@dataclass(frozen=True)
class TaskProfile:
    id: str
    title: Callable[[str | None], str]
    # Raise HTTPException when the task must not start.
    precheck: Callable[[AdaptationContext, TaskArgs], None]
    # Lazily yields steps; resumed after each step completes, so it can
    # read state produced by prior steps (extract-all reads the records
    # registered by its discovery step).
    plan: Callable[[AdaptationContext, TaskArgs], Iterator[TaskStep]]
    accepts_target: bool = False
    accepts_instructions: bool = False
    # Domain tools this profile's agent may call. Non-empty means the runtime
    # loads .pi/extensions/photo-web.ts scoped to exactly these tools.
    tools: tuple[str, ...] = ()


def write_multiline_prompt(skill_call: str, payload: str) -> str:
    return f"{skill_call}\n\n{payload}\n"


def _no_precheck(ctx: AdaptationContext, args: TaskArgs) -> None:
    return None


def _require_book_session(ctx: AdaptationContext, args: TaskArgs | None = None) -> None:
    if not adaptation._has_book_session(ctx.book_root_abs):
        raise HTTPException(status_code=409, detail="Load book session before running this task")


# --- read-book -------------------------------------------------------------


def _read_book_plan(ctx: AdaptationContext, args: TaskArgs) -> Iterator[TaskStep]:
    def on_success(result: PiTaskResultInfo | None) -> None:
        if result is None or not result.session_id or not result.session_file:
            raise RuntimeError("Could not capture book session id from Pi")
        BookSession(
            session_file=result.session_file,
            session_id=result.session_id,
            created_at=utc_now(),
            book_path=str(ctx.book_path),
        ).write(ctx.book_session_path)

    yield TaskStep(
        name="read book",
        build_prompt=lambda: f"/skill:read-book {ctx.book_path}",
        on_success=on_success,
        fork_from_book_session=False,
    )


# --- entity record discovery / extract / refine (characters + locations) -------


@dataclass(frozen=True)
class _EntityKind:
    """Parameterizes the record-agent plumbing shared by characters and locations."""

    kind: str  # "character" | "location"
    records: Callable[[AdaptationContext], dict[str, Any]]
    is_extracted: Callable[[Any], bool]
    context_fields: tuple[str, ...]


def _registered_characters(ctx: AdaptationContext) -> dict[str, CharacterRecord]:
    return adaptation.read_metadata(ctx.project_slug).characters


def _registered_locations(ctx: AdaptationContext) -> dict[str, Any]:
    return adaptation.read_metadata(ctx.project_slug).locations


# The records lambdas resolve the module-level functions at call time so tests
# can monkeypatch _registered_characters/_registered_locations.
_CHARACTER_KIND = _EntityKind(
    kind="character",
    records=lambda ctx: _registered_characters(ctx),
    is_extracted=adaptation.character_is_extracted,
    context_fields=("slug", "name", "summary", "visualDescription", "performanceNotes", "continuityNotes"),
)

_LOCATION_KIND = _EntityKind(
    kind="location",
    records=lambda ctx: _registered_locations(ctx),
    is_extracted=adaptation.location_is_extracted,
    context_fields=("slug", "name", "summary", "visualDescription", "continuityNotes"),
)


def _entity_record_context(entity: _EntityKind, record: Any) -> str:
    """Editable-fields-only view of a record for agent prompts (no asset state)."""
    return json.dumps(
        {
            **{field: getattr(record, field) for field in entity.context_fields},
            "variants": {
                key: {
                    "label": variant.label,
                    "storyContext": variant.storyContext,
                    "prompt": variant.prompt,
                }
                for key, variant in record.variants.items()
            },
        },
        indent=2,
    )


def _discover_entities_step(ctx: AdaptationContext, entity: _EntityKind, *, force: bool) -> TaskStep:
    kind = entity.kind
    slugs_before: set[str] = set()

    def build_prompt() -> str | None:
        existing = entity.records(ctx)
        slugs_before.update(existing)
        if existing and not force:
            return None
        lines = [f"/skill:discover-{kind}s"]
        if existing:
            lines.extend(["", f"{kind.capitalize()}s already registered (do NOT register these again):"])
            for slug, record in sorted(existing.items()):
                summary = record.summary.strip()
                lines.append(f"- {record.name or slug}: {summary}" if summary else f"- {record.name or slug}")
        return "\n".join(lines).rstrip() + "\n"

    def on_success(result: PiTaskResultInfo | None) -> dict[str, Any] | None:
        if result is None:
            return None
        new_slugs = set(entity.records(ctx)) - slugs_before
        if not new_slugs:
            raise RuntimeError(f"Agent finished without calling register_{kind}")
        return {"registeredSlugs": sorted(new_slugs)}

    return TaskStep(name=f"discover {kind}s", build_prompt=build_prompt, on_success=on_success)


def _extract_entity_step(ctx: AdaptationContext, entity: _EntityKind, entity_slug: str, *, force: bool) -> TaskStep:
    kind = entity.kind

    def build_prompt() -> str | None:
        record = entity.records(ctx).get(entity_slug)
        if record is None:
            raise RuntimeError(f"{kind.capitalize()} not registered: {entity_slug}")
        if entity.is_extracted(record) and not force:
            return None
        payload = "\n".join(
            [
                f"Current {kind} record (fill it in with update_{kind}):",
                _entity_record_context(entity, record),
            ]
        )
        return write_multiline_prompt(f"/skill:extract-{kind} {entity_slug}", payload)

    def on_success(result: PiTaskResultInfo | None) -> None:
        record = entity.records(ctx).get(entity_slug)
        if record is None:
            raise RuntimeError(f"{kind.capitalize()} disappeared during extract: {entity_slug}")
        if not entity.is_extracted(record):
            raise RuntimeError(
                f"Agent finished without delivering an extracted record for {entity_slug} "
                f"(update_{kind} must set visualDescription and a base variant prompt)"
            )

    return TaskStep(name=f"extract {kind} {entity_slug}", build_prompt=build_prompt, on_success=on_success)


def _extract_entity_precheck(ctx: AdaptationContext, entity: _EntityKind, args: TaskArgs) -> None:
    _require_book_session(ctx)
    if not args.target:
        raise HTTPException(status_code=400, detail=f"extract-{entity.kind} requires a target {entity.kind} slug")
    if args.target not in entity.records(ctx):
        raise HTTPException(status_code=404, detail=f"{entity.kind.capitalize()} not registered: {args.target}")


def _extract_all_entities_plan(ctx: AdaptationContext, entity: _EntityKind) -> Iterator[TaskStep]:
    yield _discover_entities_step(ctx, entity, force=False)
    # Resumed after the discovery step, so records exist (or the task failed).
    for entity_slug in sorted(entity.records(ctx)):
        yield _extract_entity_step(ctx, entity, entity_slug, force=False)


def _refine_entity_precheck(ctx: AdaptationContext, entity: _EntityKind, args: TaskArgs) -> None:
    kind = entity.kind
    _require_book_session(ctx)
    if not args.target:
        raise HTTPException(status_code=400, detail=f"refine-{kind} requires a target {kind} slug")
    if not (args.instructions or "").strip():
        raise HTTPException(status_code=400, detail=f"refine-{kind} requires feedback instructions")
    record = entity.records(ctx).get(args.target)
    if record is None:
        raise HTTPException(status_code=404, detail=f"{kind.capitalize()} not registered: {args.target}")
    if not entity.is_extracted(record):
        raise HTTPException(status_code=409, detail=f"Extract {args.target} before refining")


def _refine_entity_plan(ctx: AdaptationContext, entity: _EntityKind, args: TaskArgs) -> Iterator[TaskStep]:
    assert args.target is not None
    kind = entity.kind
    entity_slug = args.target
    feedback = (args.instructions or "").strip()
    context_before: dict[str, str] = {}

    def build_prompt() -> str:
        record = entity.records(ctx).get(entity_slug)
        if record is None:
            raise RuntimeError(f"{kind.capitalize()} not registered: {entity_slug}")
        context_before["record"] = _entity_record_context(entity, record)
        lines = [
            f"/skill:refine-{kind} {entity_slug}",
            "",
            f"Current {kind} record (revise it with update_{kind}):",
            context_before["record"],
            "",
            "User feedback (apply this):",
            feedback,
        ]
        return "\n".join(lines).rstrip() + "\n"

    def on_success(result: PiTaskResultInfo | None) -> dict[str, Any]:
        record = entity.records(ctx).get(entity_slug)
        if record is None:
            raise RuntimeError(f"{kind.capitalize()} disappeared while refining: {entity_slug}")
        if _entity_record_context(entity, record) == context_before.get("record"):
            raise RuntimeError(f"Agent finished without calling update_{kind}")
        return {f"{kind}Slug": entity_slug}

    yield TaskStep(
        name=f"refine {kind} {entity_slug}",
        build_prompt=build_prompt,
        on_success=on_success,
    )


# --- concept art suggest --------------------------------------------------------


def _concept_context_lines(slug: str) -> list[str]:
    import concept_cards

    lines = ["Existing concept ideas on the canvas (do not duplicate these):"]
    existing = concept_cards.existing_concept_summaries(slug)
    lines.extend(existing if existing else ["(none)"])
    return lines


def _existing_card_ids(slug: str) -> set[str]:
    import concept_cards

    return {card.id for card in concept_cards.list_cards(slug, include_archived=True)}


def _suggest_concept_plan(ctx: AdaptationContext, subject_kind: str) -> Iterator[TaskStep]:
    skill = "concept-character" if subject_kind == "character" else "concept-location"
    cards_before: set[str] = set()

    def build_prompt() -> str:
        cards_before.update(_existing_card_ids(ctx.project_slug))
        context_lines = [
            f"/skill:{skill} {ctx.book_root_abs}",
            "",
            *_concept_context_lines(ctx.project_slug),
        ]
        entity = _CHARACTER_KIND if subject_kind == "character" else _LOCATION_KIND
        covered_intro = (
            "Main cast already covered by registered character records:"
            if subject_kind == "character"
            else "Settings already covered by registered location records:"
        )
        records = entity.records(ctx)
        if records:
            context_lines.extend(["", covered_intro])
            for slug_key, record in sorted(records.items()):
                summary = record.summary.strip()
                context_lines.append(f"- {record.name or slug_key}: {summary}" if summary else f"- {record.name or slug_key}")
        return "\n".join(context_lines).rstrip() + "\n"

    def on_success(result: PiTaskResultInfo | None) -> dict[str, Any]:
        import concept_cards

        new_ids = _existing_card_ids(ctx.project_slug) - cards_before
        if not new_ids:
            raise RuntimeError("Agent finished without calling create_concept_card")
        cards = {card.id: card for card in concept_cards.list_cards(ctx.project_slug, include_archived=True)}
        newest = max(new_ids, key=lambda card_id: cards[card_id].createdAt)
        return {"outputCardId": newest, "subjectKind": subject_kind}

    yield TaskStep(name=f"concept {subject_kind}", build_prompt=build_prompt, on_success=on_success)


# --- panel prompt drafting ------------------------------------------------------


def _panel_story_text(panel: Any) -> str:
    return (panel.storyText or panel.selectedText).strip()


def _find_panel(slug: str, panel_id: str):
    import story_panels

    document = story_panels.read_document(slug)
    panel = next((item for item in document.panels if item.id == panel_id), None)
    return document, panel


def _sorted_story_panels(document: Any) -> list[Any]:
    """Reading order: book-linked panels by offset, then manual panels by order.

    Panels without story text (cover/boilerplate text panels) carry no story
    context and are excluded.
    """
    panels = [
        panel
        for panel in document.panels
        if panel.sourceKind == "panel" and _panel_story_text(panel)
    ]

    def key(panel: Any) -> tuple:
        if panel.startOffset is not None:
            return (0, panel.startOffset, panel.order)
        return (1, panel.order, 0)

    return sorted(panels, key=key)


def _clip(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


def _entity_look_lines(records: dict[str, Any]) -> list[str]:
    """One line per record variant: base look, then flat-key deltas with story context."""
    look_lines: list[str] = []
    for slug, record in records.items():
        base = record.variants.get("base")
        look = (base.prompt if base else "") or record.visualDescription or record.summary
        if look.strip():
            look_lines.append(f"- {slug}: {_clip(look, 400)}")
        for variant_key, variant in record.variants.items():
            if variant_key == "base":
                continue
            flat_key = adaptation.variant_entity_key(slug, variant_key)
            story_context = variant.storyContext.strip()
            delta = variant.prompt.strip() or variant.label.strip() or variant_key
            prefix = f"[{story_context}] " if story_context else ""
            look_lines.append(f"- {flat_key}: {prefix}{_clip(delta, 300)}")
    return look_lines


def _panel_prompt_context_lines(ctx: AdaptationContext, panel: Any, document: Any) -> list[str]:
    """Small assembled context: panel text, neighbors, cast looks, style, guide."""
    lines: list[str] = []

    ordered = _sorted_story_panels(document)
    index = next((i for i, item in enumerate(ordered) if item.id == panel.id), None)
    if index is not None:
        before = ordered[max(0, index - 2):index]
        after = ordered[index + 1:index + 3]
        if before:
            lines.append("Story context — panels just before this one:")
            for neighbor in before:
                lines.append(f"- {_clip(_panel_story_text(neighbor), 400)}")
            lines.append("")
        lines.append("THIS PANEL's story text (draw this moment):")
        lines.append(_panel_story_text(panel))
        lines.append("")
        if after:
            lines.append("Story context — panels just after this one:")
            for neighbor in after:
                lines.append(f"- {_clip(_panel_story_text(neighbor), 400)}")
            lines.append("")
    else:
        lines.extend(["THIS PANEL's story text (draw this moment):", _panel_story_text(panel), ""])

    status = adaptation.status(ctx.project_slug)
    look_lines = _entity_look_lines(status.characters)
    if look_lines:
        lines.append(
            "Canonical characters (the slugs before the colon are the ONLY valid characterSlugs "
            "values; any character visible in the panel must be described using these look "
            "descriptors, never just their name. Variant slugs like hero-young are the same "
            "character in a different durable look — when this panel's story moment matches a "
            "variant's bracketed story context, use the variant slug instead of the base slug):"
        )
        lines.extend(look_lines)
        lines.append("")

    location_lines = _entity_look_lines(status.locations)
    if location_lines:
        lines.append(
            "Canonical locations (the slugs before the colon are the ONLY valid locationSlug "
            "values; pick the one that matches this panel's setting, and use its description for "
            "the setting portion of the prompt. Variant slugs like castle-after-the-fire are the "
            "same place in a different durable state — when this panel's story moment matches a "
            "variant's bracketed story context, use the variant slug instead of the base slug):"
        )
        lines.extend(location_lines)
        lines.append("")

    default_style = next(
        (style for style in status.visualStyles if style.id == status.defaultVisualStyleId),
        None,
    )
    if default_style is not None and default_style.prompt.strip():
        lines.append(
            "Project visual style (appended automatically at generation time — do NOT restate it in the prompt):"
        )
        lines.append(_clip(default_style.prompt, 300))
        lines.append("")

    lines.append("Imagen prompt guide (follow exactly):")
    lines.append(load_prompt_guide().rstrip())
    return lines


def _require_extracted_characters(ctx: AdaptationContext) -> None:
    """Process gate: panel prompts need a canonical cast to reference."""
    status = adaptation.status(ctx.project_slug)
    has_looks = any(
        ((record.variants.get("base").prompt if record.variants.get("base") else "") or record.visualDescription).strip()
        for record in status.characters.values()
    )
    if not has_looks:
        raise HTTPException(
            status_code=409,
            detail="Extract characters (and locations) before drafting panel prompts — there is no canonical cast to reference.",
        )


def _draft_panel_prompt_precheck(ctx: AdaptationContext, args: TaskArgs) -> None:
    if not args.target:
        raise HTTPException(status_code=400, detail="draft-panel-prompt requires a target panel id")
    _require_extracted_characters(ctx)
    _document, panel = _find_panel(ctx.project_slug, args.target)
    if panel is None:
        raise HTTPException(status_code=404, detail=f"Panel not found: {args.target}")
    if not _panel_story_text(panel):
        raise HTTPException(status_code=409, detail="Panel has no story text to draft from")


def _draft_panel_prompt_plan(ctx: AdaptationContext, args: TaskArgs) -> Iterator[TaskStep]:
    assert args.target is not None
    panel_id = args.target
    guidance = (args.instructions or "").strip()
    prompt_ids_before: set[str] = set()

    def build_prompt() -> str:
        document, panel = _find_panel(ctx.project_slug, panel_id)
        if panel is None:
            raise RuntimeError(f"Panel not found: {panel_id}")
        prompt_ids_before.update(prompt.id for prompt in panel.imagePrompts)
        context_lines = [f"/skill:panel-prompt {panel_id}", ""]
        if guidance:
            context_lines.extend([
                "User guidance — an idea or direction for this image (build the prompt around it):",
                guidance,
                "",
            ])
        context_lines.extend(_panel_prompt_context_lines(ctx, panel, document))
        return "\n".join(context_lines).rstrip() + "\n"

    def on_success(result: PiTaskResultInfo | None) -> dict[str, Any]:
        _document, panel = _find_panel(ctx.project_slug, panel_id)
        if panel is None:
            raise RuntimeError(f"Panel disappeared while drafting: {panel_id}")
        new_prompts = [prompt for prompt in panel.imagePrompts if prompt.id not in prompt_ids_before]
        if not new_prompts:
            raise RuntimeError("Agent finished without calling set_panel_image_prompt")
        return {"panelId": panel_id, "promptId": new_prompts[-1].id}

    yield TaskStep(
        name=f"draft prompt {panel_id}",
        build_prompt=build_prompt,
        on_success=on_success,
        fork_from_book_session=False,
    )


def _parse_refine_target(target: str) -> tuple[str, str]:
    panel_id, _, prompt_id = target.partition(":")
    return panel_id, prompt_id


def _refine_panel_prompt_precheck(ctx: AdaptationContext, args: TaskArgs) -> None:
    if not args.target or ":" not in args.target:
        raise HTTPException(
            status_code=400, detail="refine-panel-prompt requires a 'panelId:promptId' target"
        )
    if not (args.instructions or "").strip():
        raise HTTPException(status_code=400, detail="refine-panel-prompt requires feedback instructions")
    _require_extracted_characters(ctx)
    panel_id, prompt_id = _parse_refine_target(args.target)
    _document, panel = _find_panel(ctx.project_slug, panel_id)
    if panel is None:
        raise HTTPException(status_code=404, detail=f"Panel not found: {panel_id}")
    if not any(prompt.id == prompt_id for prompt in panel.imagePrompts):
        raise HTTPException(status_code=404, detail=f"Image prompt not found: {prompt_id}")


def _refine_panel_prompt_plan(ctx: AdaptationContext, args: TaskArgs) -> Iterator[TaskStep]:
    assert args.target is not None
    panel_id, prompt_id = _parse_refine_target(args.target)
    feedback = (args.instructions or "").strip()

    def build_prompt() -> str:
        document, panel = _find_panel(ctx.project_slug, panel_id)
        if panel is None:
            raise RuntimeError(f"Panel not found: {panel_id}")
        current = next((prompt for prompt in panel.imagePrompts if prompt.id == prompt_id), None)
        if current is None:
            raise RuntimeError(f"Image prompt not found: {prompt_id}")
        context_lines = [
            f"/skill:panel-prompt-refine {panel_id} {prompt_id}",
            "",
            "Current prompt (revise this):",
            current.text.strip(),
            "",
            "User feedback (apply this):",
            feedback,
            "",
            *_panel_prompt_context_lines(ctx, panel, document),
        ]
        return "\n".join(context_lines).rstrip() + "\n"

    def on_success(result: PiTaskResultInfo | None) -> dict[str, Any]:
        _document, panel = _find_panel(ctx.project_slug, panel_id)
        if panel is None:
            raise RuntimeError(f"Panel disappeared while refining: {panel_id}")
        current = next((prompt for prompt in panel.imagePrompts if prompt.id == prompt_id), None)
        if current is None or not current.text.strip():
            raise RuntimeError("Refined prompt is missing or empty after the run")
        return {"panelId": panel_id, "promptId": prompt_id}

    yield TaskStep(
        name=f"refine prompt {panel_id}:{prompt_id}",
        build_prompt=build_prompt,
        on_success=on_success,
        fork_from_book_session=False,
    )


READ_BOOK = TaskProfile(
    id="read-book",
    title=lambda target: "Read book",
    precheck=_no_precheck,
    plan=_read_book_plan,
)

DISCOVER_CHARACTERS = TaskProfile(
    id="discover-characters",
    title=lambda target: "Find characters",
    precheck=_require_book_session,
    plan=lambda ctx, args: iter([_discover_entities_step(ctx, _CHARACTER_KIND, force=args.force)]),
    tools=("register_character", "list_characters"),
)

EXTRACT_CHARACTER = TaskProfile(
    id="extract-character",
    title=lambda target: f"Extract {target}",
    precheck=lambda ctx, args: _extract_entity_precheck(ctx, _CHARACTER_KIND, args),
    plan=lambda ctx, args: iter([_extract_entity_step(ctx, _CHARACTER_KIND, args.target, force=args.force)]),
    accepts_target=True,
    tools=("update_character", "list_characters"),
)

EXTRACT_ALL_CHARACTERS = TaskProfile(
    id="extract-all-characters",
    title=lambda target: "Extract all characters",
    precheck=_require_book_session,
    plan=lambda ctx, args: _extract_all_entities_plan(ctx, _CHARACTER_KIND),
    tools=("register_character", "update_character", "list_characters"),
)

REFINE_CHARACTER = TaskProfile(
    id="refine-character",
    title=lambda target: f"Refine {target}" if target else "Refine character",
    precheck=lambda ctx, args: _refine_entity_precheck(ctx, _CHARACTER_KIND, args),
    plan=lambda ctx, args: _refine_entity_plan(ctx, _CHARACTER_KIND, args),
    accepts_target=True,
    accepts_instructions=True,
    tools=("update_character", "list_characters"),
)

DISCOVER_LOCATIONS = TaskProfile(
    id="discover-locations",
    title=lambda target: "Find locations",
    precheck=_require_book_session,
    plan=lambda ctx, args: iter([_discover_entities_step(ctx, _LOCATION_KIND, force=args.force)]),
    tools=("register_location", "list_locations"),
)

EXTRACT_LOCATION = TaskProfile(
    id="extract-location",
    title=lambda target: f"Extract {target}",
    precheck=lambda ctx, args: _extract_entity_precheck(ctx, _LOCATION_KIND, args),
    plan=lambda ctx, args: iter([_extract_entity_step(ctx, _LOCATION_KIND, args.target, force=args.force)]),
    accepts_target=True,
    tools=("update_location", "list_locations"),
)

EXTRACT_ALL_LOCATIONS = TaskProfile(
    id="extract-all-locations",
    title=lambda target: "Extract all locations",
    precheck=_require_book_session,
    plan=lambda ctx, args: _extract_all_entities_plan(ctx, _LOCATION_KIND),
    tools=("register_location", "update_location", "list_locations"),
)

REFINE_LOCATION = TaskProfile(
    id="refine-location",
    title=lambda target: f"Refine {target}" if target else "Refine location",
    precheck=lambda ctx, args: _refine_entity_precheck(ctx, _LOCATION_KIND, args),
    plan=lambda ctx, args: _refine_entity_plan(ctx, _LOCATION_KIND, args),
    accepts_target=True,
    accepts_instructions=True,
    tools=("update_location", "list_locations"),
)

SUGGEST_CONCEPT_CHARACTER = TaskProfile(
    id="suggest-concept-character",
    title=lambda target: "Suggest character concept",
    precheck=_require_book_session,
    plan=lambda ctx, args: _suggest_concept_plan(ctx, "character"),
    tools=("create_concept_card",),
)

SUGGEST_CONCEPT_LOCATION = TaskProfile(
    id="suggest-concept-location",
    title=lambda target: "Suggest location concept",
    precheck=_require_book_session,
    plan=lambda ctx, args: _suggest_concept_plan(ctx, "location"),
    tools=("create_concept_card",),
)

DRAFT_PANEL_PROMPT = TaskProfile(
    id="draft-panel-prompt",
    title=lambda target: "Draft panel prompt",
    precheck=_draft_panel_prompt_precheck,
    plan=_draft_panel_prompt_plan,
    accepts_target=True,
    accepts_instructions=True,
    tools=("set_panel_image_prompt",),
)

REFINE_PANEL_PROMPT = TaskProfile(
    id="refine-panel-prompt",
    title=lambda target: "Refine panel prompt",
    precheck=_refine_panel_prompt_precheck,
    plan=_refine_panel_prompt_plan,
    accepts_target=True,
    accepts_instructions=True,
    tools=("replace_panel_image_prompt",),
)

PROFILES: dict[str, TaskProfile] = {
    profile.id: profile
    for profile in (
        READ_BOOK,
        DISCOVER_CHARACTERS,
        EXTRACT_CHARACTER,
        EXTRACT_ALL_CHARACTERS,
        REFINE_CHARACTER,
        DISCOVER_LOCATIONS,
        EXTRACT_LOCATION,
        EXTRACT_ALL_LOCATIONS,
        REFINE_LOCATION,
        SUGGEST_CONCEPT_CHARACTER,
        SUGGEST_CONCEPT_LOCATION,
        DRAFT_PANEL_PROMPT,
        REFINE_PANEL_PROMPT,
    )
}


def get_profile(profile_id: str) -> TaskProfile:
    profile = PROFILES.get(profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"Unknown pi task profile: {profile_id}")
    return profile
