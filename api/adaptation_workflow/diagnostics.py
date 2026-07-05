"""Per-task diagnostic log paths under each project's adaptation/sessions/."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


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
