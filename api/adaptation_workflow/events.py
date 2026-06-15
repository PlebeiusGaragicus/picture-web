"""Project Pi RPC events into UI-friendly log lines."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from adaptation_workflow.diagnostics import RunDiagnostics, TaskDiagnostics

LIFECYCLE_TYPES = frozenset(
    {
        "agent_start",
        "turn_start",
        "turn_end",
        "agent_end",
        "compaction_start",
        "compaction_end",
    }
)


def clip_text(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "…[+truncated]"


def project_event(event: dict[str, Any]) -> dict[str, Any] | None:
    event_type = event.get("type")
    if event_type == "message_end":
        message = event.get("message") or {}
        if message.get("role") != "assistant":
            return None
        content = message.get("content") or []
        text_parts = [block.get("text", "") for block in content if block.get("type") == "text"]
        text = "\n".join(part for part in text_parts if part)
        if not text:
            return None
        return {"type": "assistant_text", "text": clip_text(text, 4000)}
    if event_type == "tool_execution_start":
        args = event.get("args")
        args_text = clip_text(json.dumps(args, ensure_ascii=False), 500) if args is not None else ""
        return {
            "type": "tool_start",
            "toolName": event.get("toolName", ""),
            "args": args_text,
        }
    if event_type == "tool_execution_end":
        result = event.get("result")
        result_text = json.dumps(result, ensure_ascii=False) if result is not None else ""
        return {
            "type": "tool_end",
            "toolName": event.get("toolName", ""),
            "isError": bool(event.get("isError")),
            "size": len(result_text),
            "result": clip_text(result_text, 600),
        }
    if event_type == "auto_retry_start":
        return {
            "type": "retry",
            "attempt": event.get("attempt", 0),
            "maxAttempts": event.get("maxAttempts", 0),
            "message": clip_text(str(event.get("errorMessage") or ""), 300),
        }
    if event_type in LIFECYCLE_TYPES:
        return {"type": event_type}
    return None


class WorkflowLogger:
    """Writes UI log lines, run-level and per-task raw events."""

    def __init__(self, diagnostics: RunDiagnostics) -> None:
        self.diagnostics = diagnostics
        self.ui_log_path = diagnostics.ui_log_path
        self.events_path = diagnostics.events_path
        self.task_records: list[dict[str, Any]] = []
        self._current_task: TaskDiagnostics | None = None
        self._task_events_file: Any = None
        self._ui_file = diagnostics.ui_log_path.open("w", encoding="utf-8")
        self._events_file = diagnostics.events_path.open("w", encoding="utf-8")

    def close(self) -> None:
        self._end_task_log()
        self._ui_file.close()
        self._events_file.close()

    def write_line(self, line: str = "") -> None:
        self._ui_file.write(line + "\n")
        self._ui_file.flush()

    def write_step_header(self, stage: str, name: str, output: str) -> None:
        self.write_line()
        self.write_line(f"[{stage}] {name}")
        self.write_line(f"    output: {output}")

    def write_skip(self, stage: str, name: str, output: str) -> None:
        self.write_step_header(stage, f"{name} (skip)", output)

    def begin_task(self, name: str) -> TaskDiagnostics:
        self._end_task_log()
        task = self.diagnostics.begin_task(name)
        self._current_task = task
        self._task_events_file = task.events_path.open("w", encoding="utf-8")
        self.write_line(f"    task log: {task.stem}")
        return task

    def _end_task_log(self) -> None:
        if self._task_events_file is not None:
            self._task_events_file.close()
            self._task_events_file = None
        self._current_task = None

    def on_raw_event(self, event: dict[str, Any]) -> None:
        line = json.dumps(event, ensure_ascii=False) + "\n"
        self._events_file.write(line)
        self._events_file.flush()
        if self._task_events_file is not None:
            self._task_events_file.write(line)
            self._task_events_file.flush()
        projected = project_event(event)
        if projected is not None:
            self._ui_file.write(json.dumps(projected, ensure_ascii=False) + "\n")
            self._ui_file.flush()

    def on_task_stderr(self, line: str) -> None:
        if not line.strip():
            return
        if self._current_task is not None:
            with self._current_task.stderr_path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        self.write_line(f"    pi stderr: {line}")

    def record_task(
        self,
        *,
        name: str,
        skipped: bool,
        duration_ms: int,
        session_id: str | None = None,
        error: str | None = None,
        stats: dict[str, Any] | None = None,
        task_paths: dict[str, str] | None = None,
    ) -> None:
        record: dict[str, Any] = {
            "name": name,
            "skipped": skipped,
            "durationMs": duration_ms,
        }
        if session_id:
            record["sessionId"] = session_id
        if error:
            record["error"] = error
        if stats:
            record["stats"] = stats
        if task_paths:
            record["logs"] = task_paths
        self.task_records.append(record)
        self._end_task_log()
