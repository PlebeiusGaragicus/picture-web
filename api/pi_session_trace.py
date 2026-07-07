"""Parse Pi v3 session JSONL into UI-facing trace documents."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pi_events import clip_text
from models import (
    PiTraceAssistantStep,
    PiTraceDocument,
    PiTraceInfoBanner,
    PiTraceStats,
    PiTraceToolCall,
    PiTraceUsage,
    PiTraceUserStep,
)

TOOL_RESULT_CLIP = 600
TEXT_CLIP = 4000
THINKING_CLIP = 2000


def _extract_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
            continue
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            parts.append(str(block.get("text") or ""))
    return "\n".join(part for part in parts if part).strip()


def load_jsonl_entries(path: Path) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    header: dict[str, Any] | None = None
    entries: list[dict[str, Any]] = []
    if not path.is_file():
        return None, []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict):
            continue
        if entry.get("type") == "session" and header is None:
            header = entry
            continue
        entries.append(entry)
    return header, entries


def _branch_from_leaf(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not entries:
        return []
    by_id = {entry["id"]: entry for entry in entries if entry.get("id")}
    leaf = entries[-1]
    branch: list[dict[str, Any]] = []
    current: dict[str, Any] | None = leaf
    seen: set[str] = set()
    while current is not None:
        entry_id = current.get("id")
        if not entry_id or entry_id in seen:
            break
        seen.add(entry_id)
        branch.append(current)
        parent_id = current.get("parentId")
        current = by_id.get(parent_id) if parent_id else None
    branch.reverse()
    return branch


def _usage_from_message(message: dict[str, Any]) -> PiTraceUsage | None:
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None
    return PiTraceUsage(
        input=usage.get("input"),
        output=usage.get("output"),
        cacheRead=usage.get("cacheRead"),
        cacheWrite=usage.get("cacheWrite"),
        totalTokens=usage.get("totalTokens"),
    )


def _tool_result_text(content: Any) -> str:
    text = _extract_text(content)
    return clip_text(text, TOOL_RESULT_CLIP) if text else ""


def _tool_result_details(message: dict[str, Any]) -> dict[str, Any] | None:
    details = message.get("details")
    if not isinstance(details, dict):
        return None
    projected: dict[str, Any] = {}
    diff = details.get("diff")
    if isinstance(diff, str) and diff.strip():
        projected["diff"] = clip_text(diff, TOOL_RESULT_CLIP)
    first_changed = details.get("firstChangedLine")
    if first_changed is not None:
        projected["firstChangedLine"] = first_changed
    return projected or None


def project_branch(branch: list[dict[str, Any]]) -> tuple[list[Any], PiTraceStats]:
    steps: list[Any] = []
    stats = PiTraceStats(messageCount=0, toolCount=0, userCount=0, assistantCount=0)
    pending_model: str | None = None
    pending_provider: str | None = None
    pending_thinking_level: str | None = None
    pending_assistant: PiTraceAssistantStep | None = None
    pending_tool_calls: dict[str, PiTraceToolCall] = {}

    def flush_assistant() -> None:
        nonlocal pending_assistant, pending_tool_calls
        if pending_assistant is None:
            return
        pending_assistant.toolCalls = list(pending_tool_calls.values())
        stats.toolCount += len(pending_assistant.toolCalls)
        steps.append(pending_assistant)
        stats.assistantCount += 1
        stats.messageCount += 1
        pending_assistant = None
        pending_tool_calls = {}

    for entry in branch:
        entry_type = entry.get("type")
        timestamp = entry.get("timestamp")

        if entry_type == "model_change":
            pending_provider = entry.get("provider")
            pending_model = entry.get("modelId")
            continue
        if entry_type == "thinking_level_change":
            pending_thinking_level = entry.get("thinkingLevel")
            continue
        if entry_type == "compaction":
            flush_assistant()
            summary = entry.get("summary")
            if isinstance(summary, str) and summary.strip():
                steps.append(
                    PiTraceInfoBanner(
                        kind="compaction",
                        timestamp=timestamp,
                        text=clip_text(summary, TEXT_CLIP),
                        tokensBefore=entry.get("tokensBefore"),
                    )
                )
            continue
        if entry_type == "branch_summary":
            flush_assistant()
            summary = entry.get("summary")
            if isinstance(summary, str) and summary.strip():
                steps.append(
                    PiTraceInfoBanner(
                        kind="branch_summary",
                        timestamp=timestamp,
                        text=clip_text(summary, TEXT_CLIP),
                    )
                )
            continue
        if entry_type != "message":
            continue

        message = entry.get("message") or {}
        role = message.get("role")

        if role == "user":
            flush_assistant()
            text = clip_text(_extract_text(message.get("content")), TEXT_CLIP)
            if text:
                steps.append(PiTraceUserStep(timestamp=timestamp, text=text))
                stats.userCount += 1
                stats.messageCount += 1
            continue

        if role == "toolResult":
            tool_call_id = message.get("toolCallId")
            if not tool_call_id or tool_call_id not in pending_tool_calls:
                continue
            tool = pending_tool_calls[tool_call_id]
            tool.result = _tool_result_text(message.get("content"))
            tool.isError = bool(message.get("isError"))
            tool.details = _tool_result_details(message)
            continue

        if role == "assistant":
            content = message.get("content") or []
            thinking: list[str] = []
            tool_calls: list[PiTraceToolCall] = []
            text_parts: list[str] = []
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    block_type = block.get("type")
                    if block_type == "thinking":
                        thinking_text = str(block.get("thinking") or "").strip()
                        if thinking_text:
                            thinking.append(clip_text(thinking_text, THINKING_CLIP))
                    elif block_type == "toolCall":
                        tool_id = str(block.get("id") or "")
                        args = block.get("arguments")
                        if args is None and block.get("partialJson"):
                            try:
                                args = json.loads(str(block.get("partialJson")))
                            except json.JSONDecodeError:
                                args = block.get("partialJson")
                        tool_calls.append(
                            PiTraceToolCall(
                                id=tool_id,
                                name=str(block.get("name") or ""),
                                arguments=args if isinstance(args, dict) else {"raw": args},
                            )
                        )
                    elif block_type == "text":
                        text_value = str(block.get("text") or "").strip()
                        if text_value:
                            text_parts.append(text_value)

            has_content = bool(thinking or tool_calls or text_parts)
            if not has_content:
                continue

            if pending_assistant is not None and tool_calls and not thinking and not text_parts:
                for tool in tool_calls:
                    pending_tool_calls[tool.id] = tool
                continue

            flush_assistant()
            pending_assistant = PiTraceAssistantStep(
                timestamp=timestamp,
                provider=message.get("provider") or pending_provider,
                model=message.get("model") or pending_model,
                thinkingLevel=pending_thinking_level,
                stopReason=message.get("stopReason"),
                usage=_usage_from_message(message),
                thinking=thinking,
                text=clip_text("\n\n".join(text_parts), TEXT_CLIP) if text_parts else None,
                toolCalls=[],
            )
            pending_tool_calls = {tool.id: tool for tool in tool_calls if tool.id}
            pending_provider = pending_assistant.provider
            pending_model = pending_assistant.model
            continue

    flush_assistant()
    return steps, stats


def parse_session_file(path: Path) -> PiTraceDocument:
    header, entries = load_jsonl_entries(path)
    branch = _branch_from_leaf(entries)
    steps, stats = project_branch(branch)
    return PiTraceDocument(
        sessionId=header.get("id") if header else None,
        cwd=header.get("cwd") if header else None,
        version=header.get("version") if header else None,
        steps=steps,
        stats=stats,
    )


def find_session_file_by_id(session_dir: Path, session_id: str) -> Path | None:
    if not session_dir.is_dir():
        return None
    for path in sorted(session_dir.glob("*.jsonl"), reverse=True):
        header, _ = load_jsonl_entries(path)
        if header and header.get("id") == session_id:
            return path
    for path in sorted(session_dir.glob("*.json"), reverse=True):
        header, _ = load_jsonl_entries(path)
        if header and header.get("id") == session_id:
            return path
    return None


def resolve_session_path(
    *,
    pi_session_dir: Path,
    pi_session_file: str | None,
    pi_session_id: str | None,
) -> Path | None:
    if pi_session_file:
        path = Path(pi_session_file).resolve()
        pi_root = pi_session_dir.resolve()
        if path.is_file() and (path == pi_root or pi_root in path.parents):
            return path
    if pi_session_id:
        return find_session_file_by_id(pi_session_dir, pi_session_id)
    return None
