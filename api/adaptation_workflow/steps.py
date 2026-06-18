"""Ingest and character extraction steps."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Callable

from adaptation_workflow.config import AdaptationContext, BookSession, utc_now
from adaptation_workflow.events import WorkflowLogger
from adaptation_workflow.pi_rpc import PiRpcClient, PiRpcError
from adaptation_workflow.sections import extract_sections
from adaptation_workflow.slugify import slugify_name
from adaptation_workflow.validate import (
    ValidationError,
    validate_character_artifact,
    validate_character_sheet,
    validate_location_prompt,
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

    def step_character_artifacts(self) -> None:
        list_path = self.ctx.book_root_abs / "characters" / "list.txt"
        lines = [line for line in list_path.read_text().splitlines() if line.strip()]
        total = len(lines)
        n = 0
        for character_line in lines:
            if ": See " in character_line:
                continue
            n += 1
            character_name = character_line.split(":", 1)[0]
            slug = slugify_name(character_name)
            out = self.ctx.book_root_abs / "characters" / "artifacts" / f"{slug}.md"
            rel_out = f"{self.ctx.book_root}/characters/artifacts/{slug}.md"
            if out.is_file():
                self.logger.write_skip("characters", f"character artifact [{n}/{total}] {slug}", rel_out)
                self.logger.record_task(name=f"character artifact {slug}", skipped=True, duration_ms=0)
                self._notify_progress()
                continue
            prompt = write_multiline_prompt(
                f"/skill:character-artifact {self.ctx.book_root_abs} {out}",
                character_line,
            )
            self.run_pi_step("characters", f"character artifact {slug}", rel_out, prompt)
            try:
                validate_character_artifact(out)
            except ValidationError as exc:
                raise RuntimeError(str(exc)) from exc

    def step_character_sheets(self) -> None:
        artifacts_dir = self.ctx.book_root_abs / "characters" / "artifacts"
        artifacts = sorted(artifacts_dir.glob("*.md"))
        total = len(artifacts)
        for n, artifact in enumerate(artifacts, start=1):
            slug = artifact.stem
            out = self.ctx.book_root_abs / "characters" / "sheets" / f"{slug}.md"
            rel_out = f"{self.ctx.book_root}/characters/sheets/{slug}.md"
            if out.is_file():
                self.logger.write_skip("characters", f"character sheet [{n}/{total}] {slug}", rel_out)
                self.logger.record_task(name=f"character sheet {slug}", skipped=True, duration_ms=0)
                self._notify_progress()
                continue
            prompt = (
                f"/skill:character-sheet {self.ctx.book_root_abs} {out} @{artifact}"
            )
            self.run_pi_step("characters", f"character sheet {slug}", rel_out, prompt)
            try:
                validate_character_sheet(out)
            except ValidationError as exc:
                raise RuntimeError(str(exc)) from exc

    def stage_characters(self) -> None:
        self.step_character_list()
        self.step_character_artifacts()
        self.step_character_sheets()

    def step_location_index(self) -> None:
        out = self.ctx.book_root_abs / "locations" / "index.md"
        rel_out = f"{self.ctx.book_root}/locations/index.md"
        if out.is_file():
            self.logger.write_skip("locations", "location index", rel_out)
            self.logger.record_task(name="location index", skipped=True, duration_ms=0)
            self._notify_progress()
        else:
            self.run_pi_step(
                "locations",
                f"location index {self.ctx.book_root.name}",
                rel_out,
                f"/skill:location-index {self.ctx.book_root_abs}",
            )
        if not out.is_file():
            raise RuntimeError(f"Missing {out}")

    def step_location_prompts(self) -> None:
        index_path = self.ctx.book_root_abs / "locations" / "index.md"
        tmp_dir = self.ctx.book_root_abs / "locations" / ".entries"
        entries = extract_sections(index_path, tmp_dir)
        total = len(entries)
        for n, entry in enumerate(entries, start=1):
            slug = entry.stem
            out = self.ctx.book_root_abs / "locations" / "prompts" / f"{slug}.md"
            rel_out = f"{self.ctx.book_root}/locations/prompts/{slug}.md"
            if out.is_file():
                self.logger.write_skip("locations", f"location prompt [{n}/{total}] {slug}", rel_out)
                self.logger.record_task(name=f"location prompt {slug}", skipped=True, duration_ms=0)
                self._notify_progress()
                continue
            prompt = write_multiline_prompt(
                f"/skill:location-prompt {self.ctx.book_root_abs} {out}",
                entry.read_text(),
            )
            self.run_pi_step("locations", f"location prompt {slug}", rel_out, prompt)
            try:
                validate_location_prompt(out)
            except ValidationError as exc:
                raise RuntimeError(str(exc)) from exc

    def stage_locations(self) -> None:
        self.step_location_index()
        self.step_location_prompts()
