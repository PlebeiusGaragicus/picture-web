"""Ingest and character extraction steps."""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Callable

from adaptation_workflow.config import AdaptationContext, BookSession, utc_now
from adaptation_workflow.events import WorkflowLogger
from adaptation_workflow.pi_rpc import PiRpcClient, PiRpcError
from adaptation_workflow.moments import moment_output_path, read_story_kind
from adaptation_workflow.locations import cleanup_staging, merge_staging_into_index, staging_dir
from adaptation_workflow.scene_list import find_scene_list_line
from adaptation_workflow.sections import parse_index_sections_file
from adaptation_workflow.entity_registry import (
    assert_character_registry_ready,
    format_entity_registry_prompt,
    read_metadata_entity_keys,
)
from adaptation_workflow.validate import (
    ValidationError,
    validate_character_file,
    validate_location_prompt,
    validate_moment_file,
    validate_scene_artifact,
)


def write_multiline_prompt(skill_call: str, payload: str) -> str:
    return f"{skill_call}\n\n{payload}\n"


class StepRunner:
    def __init__(
        self,
        ctx: AdaptationContext,
        logger: WorkflowLogger,
        *,
        on_progress: Callable[[], None] | None = None,
    ) -> None:
        self.ctx = ctx
        self.logger = logger
        self.pi = PiRpcClient(ctx)
        self.book_session: BookSession | None = None
        self.on_progress = on_progress

    def load_book_session(self) -> BookSession | None:
        manifest = BookSession.load(self.ctx.book_session_path)
        if manifest is None:
            return None
        expected_book = str(self.ctx.book_path)
        if manifest.book_path and manifest.book_path != expected_book:
            return None
        if not Path(manifest.session_file).is_file():
            return None
        return manifest

    def ensure_book_session(self) -> BookSession:
        existing = self.load_book_session()
        if existing is not None:
            self.book_session = existing
            self.logger.write_line(f"[load] Reusing book session: {existing.session_id}")
            return existing
        return self.load_fresh_book_session()

    def load_fresh_book_session(self) -> BookSession:
        task_name = f"read book {self.ctx.project_slug}"
        self.logger.write_step_header("load", f"Creating clean book-load session from {self.ctx.book_root}/book.txt", str(self.ctx.book_path))
        task = self.logger.begin_task(task_name)
        started = time.monotonic()
        try:
            result = self.pi.run_task(
                prompt=f"/skill:read-book {self.ctx.book_path}",
                task_name=task_name,
                task=task,
                on_event=self.logger.on_raw_event,
                on_stderr=self.logger.on_task_stderr,
            )
        except PiRpcError as exc:
            self.logger.record_task(
                name=task_name,
                skipped=False,
                duration_ms=int((time.monotonic() - started) * 1000),
                error=str(exc),
                task_paths=task.rel_paths(self.ctx.book_root_abs),
            )
            self._notify_progress()
            raise RuntimeError(str(exc)) from exc
        if not result.session_id or not result.session_file:
            raise RuntimeError("Could not capture book session id from Pi")
        session = BookSession(
            session_file=result.session_file,
            session_id=result.session_id,
            created_at=utc_now(),
            book_path=str(self.ctx.book_path),
        )
        session.write(self.ctx.book_session_path)
        self.book_session = session
        self.logger.record_task(
            name=task_name,
            skipped=False,
            duration_ms=int((time.monotonic() - started) * 1000),
            session_id=session.session_id,
            stats=result.stats,
            task_paths=task.rel_paths(self.ctx.book_root_abs),
        )
        self._notify_progress()
        self.logger.write_line(f"[load] Saved session id to {self.ctx.book_session_path}")
        return session

    def _notify_progress(self) -> None:
        if self.on_progress is not None:
            self.on_progress()

    def require_book_session(self) -> BookSession:
        session = self.load_book_session()
        if session is None:
            raise RuntimeError("No book session yet. Run Phase 0 ingest first.")
        self.book_session = session
        self.logger.write_line(f"[load] Reusing book session: {session.session_id}")
        return session

    def run_pi_step(self, stage: str, name: str, output: str, prompt: str) -> None:
        agent_session_id = os.environ.get("AGENT_SESSION_ID")
        session = self.book_session or self.require_book_session()
        self.logger.write_step_header(stage, name, output)
        task = self.logger.begin_task(name)
        started = time.monotonic()
        try:
            result = self.pi.run_task(
                prompt=prompt,
                task_name=name,
                task=task,
                fork_session_id=session.session_id,
                on_event=self.logger.on_raw_event,
                on_stderr=self.logger.on_task_stderr,
            )
        except PiRpcError as exc:
            self.logger.record_task(
                name=name,
                skipped=False,
                duration_ms=int((time.monotonic() - started) * 1000),
                error=str(exc),
                task_paths=task.rel_paths(self.ctx.book_root_abs),
            )
            if agent_session_id:
                import agent_sessions

                agent_sessions.update_session(
                    self.ctx.project_slug,
                    agent_session_id,
                    status="failed",
                    source={"stage": stage, "taskName": name, "output": output},
                    error=str(exc),
                    completed=True,
                )
            self._notify_progress()
            raise RuntimeError(str(exc)) from exc
        self.logger.record_task(
            name=name,
            skipped=False,
            duration_ms=int((time.monotonic() - started) * 1000),
            session_id=result.session_id,
            stats=result.stats,
            task_paths=task.rel_paths(self.ctx.book_root_abs),
        )
        if agent_session_id:
            import agent_sessions

            agent_sessions.update_session(
                self.ctx.project_slug,
                agent_session_id,
                pi_session_id=result.session_id,
                pi_session_file=result.session_file,
                source={"stage": stage, "taskName": name, "output": output},
                stats=result.stats,
            )
        self._notify_progress()

    def step_archetype_prompts(self) -> None:
        style_refs = self.ctx.book_root_abs / "style-refs"
        required = [
            style_refs / "archetype-character.md",
            style_refs / "archetype-scene.md",
        ]
        if all(path.is_file() for path in required):
            self.logger.write_skip("ingest", "archetype prompts", f"{self.ctx.book_root}/style-refs/")
            self.logger.record_task(name="archetype prompts", skipped=True, duration_ms=0)
            self._notify_progress()
            return
        self.run_pi_step(
            "ingest",
            f"archetype prompts {self.ctx.book_root.name}",
            f"{self.ctx.book_root}/style-refs/",
            f"/skill:visual-style {self.ctx.book_root_abs}",
        )

    def step_character_list(self) -> None:
        out = self.ctx.book_root / "characters" / "list.txt"
        if out.is_file():
            self.logger.write_skip("characters", "character list", str(out))
            self.logger.record_task(name="character list", skipped=True, duration_ms=0)
            self._notify_progress()
        else:
            self.run_pi_step(
                "characters",
                f"character list {self.ctx.book_root.name}",
                str(out),
                f"/skill:character-list {self.ctx.book_root_abs}",
            )
        if not out.is_file():
            raise RuntimeError(f"Missing {out}")

    def sync_character_stubs_from_list(self) -> None:
        from adaptation_workflow.character_file import sync_character_stubs_from_list

        written = sync_character_stubs_from_list(self.ctx.book_root_abs)
        for path in written:
            rel_out = f"{self.ctx.book_root}/{path.relative_to(self.ctx.book_root_abs).as_posix()}"
            self.logger.write_line(f"[characters] Created stub {rel_out}")
        self.logger.record_task(name="character stub sync", skipped=not written, duration_ms=0)
        self._notify_progress()

    def step_character_file(self, character_slug: str, *, force: bool = False) -> None:
        from adaptation_workflow.character_file import find_character_list_line

        list_path = self.ctx.book_root_abs / "characters" / "list.txt"
        list_line = find_character_list_line(list_path, character_slug)
        if list_line is None:
            raise RuntimeError(f"Character slug not found in list.txt: {character_slug}")

        out = self.ctx.book_root_abs / "characters" / f"{character_slug}.md"
        rel_out = f"{self.ctx.book_root}/characters/{character_slug}.md"
        if out.is_file() and not force:
            try:
                validate_character_file(out, require_variants=True)
                self.logger.write_skip("characters", f"character file {character_slug}", rel_out)
                self.logger.record_task(name=f"character file {character_slug}", skipped=True, duration_ms=0)
                self._notify_progress()
                return
            except ValidationError:
                self.logger.write_line(f"replacing incomplete character file: {rel_out}")

        prompt = write_multiline_prompt(
            f"/skill:character-file {self.ctx.book_root_abs} {out}",
            list_line,
        )
        if out.is_file() and force:
            out.unlink()
        self.run_pi_step("characters", f"character file {character_slug}", rel_out, prompt)
        try:
            validate_character_file(out, require_variants=True)
        except ValidationError as exc:
            raise RuntimeError(str(exc)) from exc

    def extract_all_characters(self) -> None:
        from adaptation_workflow.character_file import character_list_lines

        list_path = self.ctx.book_root_abs / "characters" / "list.txt"
        if not list_path.is_file():
            self.step_character_list()
        self.sync_character_stubs_from_list()
        slugs = [slug for slug, _line in character_list_lines(list_path)]
        total = len(slugs)
        for index, character_slug in enumerate(slugs, start=1):
            self.logger.write_line(f"[characters] Extract [{index}/{total}] {character_slug}")
            self.step_character_file(character_slug)

    def stage_characters(self) -> None:
        self.extract_all_characters()

    def list_characters(self) -> None:
        self.step_character_list()
        self.sync_character_stubs_from_list()

    def step_scene_list(self) -> None:
        out = self.ctx.book_root_abs / "scenes" / "list.txt"
        rel_out = f"{self.ctx.book_root}/scenes/list.txt"
        if out.is_file() and out.read_text().strip():
            self.logger.write_skip("scene-list", "scene list", rel_out)
            self.logger.record_task(name="scene list", skipped=True, duration_ms=0)
            self._notify_progress()
        else:
            self.run_pi_step(
                "scene-list",
                f"scene list {self.ctx.book_root.name}",
                rel_out,
                f"/skill:scene-list {self.ctx.book_root_abs}",
            )
        if not out.is_file() or not out.read_text().strip():
            raise RuntimeError(f"Missing or empty {out}")

    def ensure_location_prompts(self, new_slugs: list[str]) -> None:
        if not new_slugs:
            return
        book_root = self.ctx.book_root_abs
        index_path = book_root / "locations" / "index.md"
        sections = parse_index_sections_file(index_path)
        for slug in new_slugs:
            out = book_root / "locations" / "prompts" / f"{slug}.md"
            rel_out = f"{self.ctx.book_root}/locations/prompts/{slug}.md"
            if out.is_file():
                self.logger.write_skip("locations", f"location prompt {slug}", rel_out)
                self.logger.record_task(name=f"location prompt {slug}", skipped=True, duration_ms=0)
                self._notify_progress()
                continue
            section = sections.get(slug)
            if not section:
                raise RuntimeError(f"Missing index section for new location slug: {slug}")
            prompt = write_multiline_prompt(
                f"/skill:location-prompt {self.ctx.book_root_abs} {out}",
                section,
            )
            self.run_pi_step("locations", f"location prompt {slug}", rel_out, prompt)
            try:
                validate_location_prompt(out)
            except ValidationError as exc:
                raise RuntimeError(str(exc)) from exc

    def extract_scene(self, scene_slug: str, *, force: bool = False) -> None:
        list_path = self.ctx.book_root_abs / "scenes" / "list.txt"
        if not list_path.is_file():
            raise RuntimeError(f"Missing {list_path}")
        scene_line = find_scene_list_line(list_path, scene_slug)
        if scene_line is None:
            raise RuntimeError(f"Scene slug not found in list.txt: {scene_slug}")

        metadata_characters, metadata_locations = read_metadata_entity_keys(self.ctx.book_root_abs)
        assert_character_registry_ready(self.ctx.book_root_abs, metadata_characters)

        artifact_out = self.ctx.book_root_abs / "scenes" / "artifacts" / f"{scene_slug}.md"
        rel_artifact = f"{self.ctx.book_root}/scenes/artifacts/{scene_slug}.md"
        stage_path = staging_dir(self.ctx.book_root_abs, scene_slug)
        stage_path.mkdir(parents=True, exist_ok=True)

        characters_list = self.ctx.book_root_abs / "characters" / "list.txt"
        locations_index = self.ctx.book_root_abs / "locations" / "index.md"
        registry_block = format_entity_registry_prompt(
            self.ctx.book_root_abs,
            metadata_characters,
            metadata_locations,
        )
        context_lines = [
            f"/skill:scene-extract {self.ctx.book_root_abs} {artifact_out} {stage_path}",
            "",
            scene_line,
        ]
        if characters_list.is_file():
            context_lines.extend(["", f"Existing characters list:\n{characters_list.read_text().rstrip()}"])
        context_lines.extend(["", registry_block.rstrip()])
        if locations_index.is_file():
            context_lines.extend(["", f"Existing location index slugs:\n{locations_index.read_text().rstrip()}"])
        prompt = "\n".join(context_lines).rstrip() + "\n"

        if artifact_out.is_file() and not force:
            self.logger.write_skip("scenes", f"scene extract {scene_slug}", rel_artifact)
            self.logger.record_task(name=f"scene extract {scene_slug}", skipped=True, duration_ms=0)
            self._notify_progress()
        else:
            if artifact_out.is_file() and force:
                artifact_out.unlink()
            self.run_pi_step("scenes", f"scene extract {scene_slug}", rel_artifact, prompt)
            try:
                validate_scene_artifact(artifact_out)
            except ValidationError as exc:
                raise RuntimeError(str(exc)) from exc

        new_slugs = merge_staging_into_index(self.ctx.book_root_abs, scene_slug)
        self.ensure_location_prompts(new_slugs)
        cleanup_staging(self.ctx.book_root_abs, scene_slug)

    def plan_scene(self, scene_slug: str) -> None:
        list_path = self.ctx.book_root_abs / "scenes" / "list.txt"
        if not list_path.is_file():
            raise RuntimeError(f"Missing {list_path}")
        scene_line = find_scene_list_line(list_path, scene_slug)
        if scene_line is None:
            raise RuntimeError(f"Scene slug not found in list.txt: {scene_slug}")

        metadata_characters, metadata_locations = read_metadata_entity_keys(self.ctx.book_root_abs)
        assert_character_registry_ready(self.ctx.book_root_abs, metadata_characters)

        artifact_path = self.ctx.book_root_abs / "scenes" / "artifacts" / f"{scene_slug}.md"
        if not artifact_path.is_file():
            raise RuntimeError(f"Missing scene artifact: {artifact_path}")

        story_kind = read_story_kind(self.ctx.book_root_abs)
        output_path = moment_output_path(self.ctx.book_root_abs, story_kind, scene_slug)
        rel_output = f"{self.ctx.book_root}/{output_path.relative_to(self.ctx.book_root_abs).as_posix()}"
        artifact_text = artifact_path.read_text().rstrip()
        registry_block = format_entity_registry_prompt(
            self.ctx.book_root_abs,
            metadata_characters,
            metadata_locations,
        )
        prompt = (
            f"/skill:story-layout {self.ctx.book_root_abs} {story_kind} {output_path}\n\n"
            f"{registry_block.rstrip()}\n\n"
            "Copy Visual Continuity keys verbatim into panel refs. Do not invent slugs.\n\n"
            f"{artifact_text}\n"
        )

        if output_path.is_file():
            try:
                validate_moment_file(output_path)
                self.logger.write_skip("moments", f"plan scene {scene_slug}", rel_output)
                self.logger.record_task(name=f"plan scene {scene_slug}", skipped=True, duration_ms=0)
                self._notify_progress()
                return
            except ValidationError:
                self.logger.write_line(f"replacing invalid moment file: {rel_output}")

        self.run_pi_step("moments", f"plan scene {scene_slug}", rel_output, prompt)
        if output_path.is_file() and output_path.stat().st_size > 0:
            try:
                validate_moment_file(output_path)
            except ValidationError as exc:
                raise RuntimeError(str(exc)) from exc

    def step_generate_concept_character(self) -> str:
        import concept_cards
        from adaptation_workflow.concept_art import (
            concept_scratch_path,
            next_character_concept_key,
            validate_concept_character_art,
        )

        key = next_character_concept_key(self.ctx.book_root_abs)
        out = concept_scratch_path(self.ctx.book_root_abs, key)
        rel_out = f"{self.ctx.book_root}/.concept-scratch/{key}.md"
        existing_concepts = concept_cards.existing_concept_summaries(self.ctx.project_slug)
        context_lines = [
            f"/skill:concept-character {self.ctx.book_root_abs} {out}",
            "",
            f"File key: {key}",
            "",
            "Existing concept ideas on the canvas (do not duplicate these):",
        ]
        if existing_concepts:
            context_lines.extend(existing_concepts)
        else:
            context_lines.append("(none)")
        list_path = self.ctx.book_root_abs / "characters" / "list.txt"
        if list_path.is_file() and list_path.read_text().strip():
            context_lines.extend(["", "Main cast already covered in characters/list.txt:", list_path.read_text().rstrip()])
        prompt = "\n".join(context_lines).rstrip() + "\n"
        self.run_pi_step("concept-art", f"concept character {key}", rel_out, prompt)
        if not out.is_file():
            raise RuntimeError(f"Missing {out}")
        try:
            validate_concept_character_art(out, key)
        except ValidationError as exc:
            raise RuntimeError(str(exc)) from exc
        return concept_cards.create_concept_card_from_pi_file(
            self.ctx.project_slug,
            "character",
            out,
            expected_key=key,
        )

    def step_generate_concept_location(self) -> str:
        import concept_cards
        from adaptation_workflow.concept_art import (
            concept_scratch_path,
            next_location_concept_key,
            validate_concept_location_art,
        )

        key = next_location_concept_key(self.ctx.book_root_abs)
        out = concept_scratch_path(self.ctx.book_root_abs, key)
        rel_out = f"{self.ctx.book_root}/.concept-scratch/{key}.md"
        existing_concepts = concept_cards.existing_concept_summaries(self.ctx.project_slug)
        context_lines = [
            f"/skill:concept-location {self.ctx.book_root_abs} {out}",
            "",
            f"File key: {key}",
            "",
            "Existing concept ideas on the canvas (do not duplicate these):",
        ]
        if existing_concepts:
            context_lines.extend(existing_concepts)
        else:
            context_lines.append("(none)")
        locations_index = self.ctx.book_root_abs / "locations" / "index.md"
        if locations_index.is_file() and locations_index.read_text().strip():
            context_lines.extend(["", "Locations already covered in locations/index.md:", locations_index.read_text().rstrip()])
        prompts_dir = self.ctx.book_root_abs / "locations" / "prompts"
        if prompts_dir.is_dir():
            prompt_slugs = sorted(path.stem for path in prompts_dir.glob("*.md"))
            if prompt_slugs:
                context_lines.extend(["", "Existing location prompt slugs:", ", ".join(prompt_slugs)])
        prompt = "\n".join(context_lines).rstrip() + "\n"
        self.run_pi_step("concept-art", f"concept location {key}", rel_out, prompt)
        if not out.is_file():
            raise RuntimeError(f"Missing {out}")
        try:
            validate_concept_location_art(out, key)
        except ValidationError as exc:
            raise RuntimeError(str(exc)) from exc
        return concept_cards.create_concept_card_from_pi_file(
            self.ctx.project_slug,
            "location",
            out,
            expected_key=key,
        )
