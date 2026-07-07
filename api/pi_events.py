"""Project Pi RPC events into UI-friendly shapes."""

from __future__ import annotations

import json
from typing import Any

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
