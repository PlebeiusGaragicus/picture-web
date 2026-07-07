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
from adaptation_workflow.config import AdaptationContext, BookSession
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


# --- character discovery -------------------------------------------------------


def _registered_characters(ctx: AdaptationContext) -> dict[str, CharacterRecord]:
    return adaptation.read_metadata(ctx.project_slug).characters


def _character_record_context(record: CharacterRecord) -> str:
    """Editable-fields-only view of a record for agent prompts (no asset state)."""
    return json.dumps(
        {
            "slug": record.slug,
            "name": record.name,
            "summary": record.summary,
            "visualDescription": record.visualDescription,
            "performanceNotes": record.performanceNotes,
            "continuityNotes": record.continuityNotes,
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


def _discover_characters_step(ctx: AdaptationContext, *, force: bool) -> TaskStep:
    slugs_before: set[str] = set()

    def build_prompt() -> str | None:
        existing = _registered_characters(ctx)
        slugs_before.update(existing)
        if existing and not force:
            return None
        lines = ["/skill:discover-characters"]
        if existing:
            lines.extend(["", "Characters already registered (do NOT register these again):"])
            for slug, record in sorted(existing.items()):
                summary = record.summary.strip()
                lines.append(f"- {record.name or slug}: {summary}" if summary else f"- {record.name or slug}")
        return "\n".join(lines).rstrip() + "\n"

    def on_success(result: PiTaskResultInfo | None) -> dict[str, Any] | None:
        if result is None:
            return None
        new_slugs = set(_registered_characters(ctx)) - slugs_before
        if not new_slugs:
            raise RuntimeError("Agent finished without calling register_character")
        return {"registeredSlugs": sorted(new_slugs)}

    return TaskStep(name="discover characters", build_prompt=build_prompt, on_success=on_success)


def _discover_characters_plan(ctx: AdaptationContext, args: TaskArgs) -> Iterator[TaskStep]:
    yield _discover_characters_step(ctx, force=args.force)


# --- character extract --------------------------------------------------------


def _extract_character_step(ctx: AdaptationContext, character_slug: str, *, force: bool) -> TaskStep:
    def build_prompt() -> str | None:
        record = _registered_characters(ctx).get(character_slug)
        if record is None:
            raise RuntimeError(f"Character not registered: {character_slug}")
        if adaptation.character_is_extracted(record) and not force:
            return None
        payload = "\n".join(
            [
                "Current character record (fill it in with update_character):",
                _character_record_context(record),
            ]
        )
        return write_multiline_prompt(f"/skill:extract-character {character_slug}", payload)

    def on_success(result: PiTaskResultInfo | None) -> None:
        record = _registered_characters(ctx).get(character_slug)
        if record is None:
            raise RuntimeError(f"Character disappeared during extract: {character_slug}")
        if not adaptation.character_is_extracted(record):
            raise RuntimeError(
                f"Agent finished without delivering an extracted record for {character_slug} "
                "(update_character must set visualDescription and a base variant prompt)"
            )

    return TaskStep(name=f"extract character {character_slug}", build_prompt=build_prompt, on_success=on_success)


def _extract_character_precheck(ctx: AdaptationContext, args: TaskArgs) -> None:
    _require_book_session(ctx)
    if not args.target:
        raise HTTPException(status_code=400, detail="extract-character requires a target character slug")
    if args.target not in _registered_characters(ctx):
        raise HTTPException(status_code=404, detail=f"Character not registered: {args.target}")


def _extract_character_plan(ctx: AdaptationContext, args: TaskArgs) -> Iterator[TaskStep]:
    assert args.target is not None
    yield _extract_character_step(ctx, args.target, force=args.force)


def _extract_all_plan(ctx: AdaptationContext, args: TaskArgs) -> Iterator[TaskStep]:
    yield _discover_characters_step(ctx, force=False)
    # Resumed after the discovery step, so records exist (or the task failed).
    for character_slug in sorted(_registered_characters(ctx)):
        yield _extract_character_step(ctx, character_slug, force=False)


# --- character refine -----------------------------------------------------------


def _refine_character_precheck(ctx: AdaptationContext, args: TaskArgs) -> None:
    _require_book_session(ctx)
    if not args.target:
        raise HTTPException(status_code=400, detail="refine-character requires a target character slug")
    if not (args.instructions or "").strip():
        raise HTTPException(status_code=400, detail="refine-character requires feedback instructions")
    record = _registered_characters(ctx).get(args.target)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Character not registered: {args.target}")
    if not adaptation.character_is_extracted(record):
        raise HTTPException(status_code=409, detail=f"Extract {args.target} before refining")


def _refine_character_plan(ctx: AdaptationContext, args: TaskArgs) -> Iterator[TaskStep]:
    assert args.target is not None
    character_slug = args.target
    feedback = (args.instructions or "").strip()
    context_before: dict[str, str] = {}

    def build_prompt() -> str:
        record = _registered_characters(ctx).get(character_slug)
        if record is None:
            raise RuntimeError(f"Character not registered: {character_slug}")
        context_before["record"] = _character_record_context(record)
        lines = [
            f"/skill:refine-character {character_slug}",
            "",
            "Current character record (revise it with update_character):",
            context_before["record"],
            "",
            "User feedback (apply this):",
            feedback,
        ]
        return "\n".join(lines).rstrip() + "\n"

    def on_success(result: PiTaskResultInfo | None) -> dict[str, Any]:
        record = _registered_characters(ctx).get(character_slug)
        if record is None:
            raise RuntimeError(f"Character disappeared while refining: {character_slug}")
        if _character_record_context(record) == context_before.get("record"):
            raise RuntimeError("Agent finished without calling update_character")
        return {"characterSlug": character_slug}

    yield TaskStep(
        name=f"refine character {character_slug}",
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
        if subject_kind == "character":
            characters = _registered_characters(ctx)
            if characters:
                context_lines.extend(["", "Main cast already covered by registered character records:"])
                for slug_key, record in sorted(characters.items()):
                    summary = record.summary.strip()
                    context_lines.append(f"- {record.name or slug_key}: {summary}" if summary else f"- {record.name or slug_key}")
        else:
            locations_index = ctx.book_root_abs / "locations" / "index.md"
            if locations_index.is_file() and locations_index.read_text().strip():
                context_lines.extend(["", "Locations already covered in locations/index.md:", locations_index.read_text().rstrip()])
            prompts_dir = ctx.book_root_abs / "locations" / "prompts"
            if prompts_dir.is_dir():
                prompt_slugs = sorted(path.stem for path in prompts_dir.glob("*.md"))
                if prompt_slugs:
                    context_lines.extend(["", "Existing location prompt slugs:", ", ".join(prompt_slugs)])
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


def _panel_prompt_context_lines(ctx: AdaptationContext, panel: Any, document: Any) -> list[str]:
    """Small assembled context per pi-idea §0.4: panel text, neighbors, cast looks, style, guide."""
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
    look_lines: list[str] = []
    for slug, record in status.characters.items():
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

    location_lines: list[str] = []
    for slug, link in status.locations.items():
        look = link.prompt or link.narration
        entry = f"- {slug}: {_clip(look, 300)}" if look.strip() else f"- {slug}"
        location_lines.append(entry)
    if location_lines:
        lines.append(
            "Canonical locations (the slugs are the ONLY valid locationSlug values; pick the one "
            "that matches this panel's setting, and use its description for the setting portion "
            "of the prompt):"
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
    plan=_discover_characters_plan,
    tools=("register_character", "list_characters"),
)

EXTRACT_CHARACTER = TaskProfile(
    id="extract-character",
    title=lambda target: f"Extract {target}",
    precheck=_extract_character_precheck,
    plan=_extract_character_plan,
    accepts_target=True,
    tools=("update_character", "list_characters"),
)

EXTRACT_ALL_CHARACTERS = TaskProfile(
    id="extract-all-characters",
    title=lambda target: "Extract all characters",
    precheck=_require_book_session,
    plan=_extract_all_plan,
    tools=("register_character", "update_character", "list_characters"),
)

REFINE_CHARACTER = TaskProfile(
    id="refine-character",
    title=lambda target: f"Refine {target}" if target else "Refine character",
    precheck=_refine_character_precheck,
    plan=_refine_character_plan,
    accepts_target=True,
    accepts_instructions=True,
    tools=("update_character", "list_characters"),
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
