"""Per-task and run-level diagnostic log paths under each project's adaptation/sessions/."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from adaptation_workflow.config import utc_now


def slugify_task_name(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower())
    return slug.strip("-") or "task"


@dataclass
class RunDiagnostics:
    stage: str
    sessions_dir: Path
    ui_log_path: Path
    events_path: Path
    summary_path: Path
    manifest_path: Path
    tasks_dir: Path
    started_at: str = field(default_factory=utc_now)
    _task_index: int = 0

    @classmethod
    def create(cls, book_root: Path, stage: str, *, validation: bool = False) -> RunDiagnostics:
        prefix = "validate" if validation else "run"
        sessions = book_root / "sessions"
        tasks_dir = sessions / "tasks"
        tasks_dir.mkdir(parents=True, exist_ok=True)
        return cls(
            stage=stage,
            sessions_dir=sessions,
            ui_log_path=sessions / f"{prefix}-{stage}.log",
            events_path=sessions / f"{prefix}-{stage}.events.jsonl",
            summary_path=sessions / f"{prefix}-{stage}.summary.json",
            manifest_path=sessions / f"{prefix}-{stage}-manifest.json",
            tasks_dir=tasks_dir,
        )

    def rel(self, path: Path, book_root: Path) -> str:
        try:
            return path.relative_to(book_root).as_posix()
        except ValueError:
            return path.as_posix()

    def begin_task(self, name: str) -> TaskDiagnostics:
        self._task_index += 1
        slug = slugify_task_name(name)
        stem = f"{self._task_index:03d}-{slug}"
        return TaskDiagnostics(
            index=self._task_index,
            name=name,
            stem=stem,
            dir=self.tasks_dir,
            started_at=utc_now(),
        )

    def manifest_payload(self, book_root: Path, *, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "stage": self.stage,
            "startedAt": self.started_at,
            "updatedAt": utc_now(),
            "log": self.rel(self.ui_log_path, book_root),
            "events": self.rel(self.events_path, book_root),
            "summary": self.rel(self.summary_path, book_root),
            "tasksDir": self.rel(self.tasks_dir, book_root),
        }
        if extra:
            payload.update(extra)
        return payload

    def write_manifest(self, book_root: Path, *, extra: dict[str, Any] | None = None) -> None:
        self.manifest_path.write_text(json.dumps(self.manifest_payload(book_root, extra=extra), indent=2) + "\n")


@dataclass
class TaskDiagnostics:
    index: int
    name: str
    stem: str
    dir: Path
    started_at: str

    @property
    def events_path(self) -> Path:
        return self.dir / f"{self.stem}.events.jsonl"

    @property
    def stderr_path(self) -> Path:
        return self.dir / f"{self.stem}.stderr.log"

    @property
    def meta_path(self) -> Path:
        return self.dir / f"{self.stem}.meta.json"

    def write_meta(self, *, argv: list[str], cwd: str, prompt: str) -> None:
        self.meta_path.write_text(
            json.dumps(
                {
                    "name": self.name,
                    "index": self.index,
                    "startedAt": self.started_at,
                    "argv": argv,
                    "cwd": cwd,
                    "promptPreview": prompt[:500] + ("…" if len(prompt) > 500 else ""),
                },
                indent=2,
            )
            + "\n"
        )

    def rel_paths(self, book_root: Path) -> dict[str, str]:
        return {
            "events": self.events_path.relative_to(book_root).as_posix(),
            "stderr": self.stderr_path.relative_to(book_root).as_posix(),
            "meta": self.meta_path.relative_to(book_root).as_posix(),
        }
