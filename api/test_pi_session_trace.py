"""Unit tests for Pi session JSONL trace parsing."""

from __future__ import annotations

import json
from pathlib import Path

from pi_session_trace import load_jsonl_entries, parse_session_file, project_branch


def _write_trace(path: Path) -> None:
    lines = [
        {
            "type": "session",
            "version": 3,
            "id": "trace-session-1",
            "timestamp": "2026-03-12T18:59:01.267Z",
            "cwd": "/tmp/project",
        },
        {
            "type": "model_change",
            "id": "a1",
            "parentId": None,
            "timestamp": "2026-03-12T18:59:01.267Z",
            "provider": "openai",
            "modelId": "gpt-test",
        },
        {
            "type": "message",
            "id": "u1",
            "parentId": "a1",
            "timestamp": "2026-03-12T19:03:58.674Z",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "Who is the fox?"}],
            },
        },
        {
            "type": "message",
            "id": "as1",
            "parentId": "u1",
            "timestamp": "2026-03-12T19:04:05.888Z",
            "message": {
                "role": "assistant",
                "provider": "openai",
                "model": "gpt-test",
                "usage": {"input": 100, "output": 20, "cacheRead": 0},
                "stopReason": "toolUse",
                "content": [
                    {"type": "thinking", "thinking": "**Searching the book**"},
                    {
                        "type": "toolCall",
                        "id": "call-1",
                        "name": "bash",
                        "arguments": {"command": "rg fox book.txt"},
                    },
                ],
            },
        },
        {
            "type": "message",
            "id": "tr1",
            "parentId": "as1",
            "timestamp": "2026-03-12T19:04:05.917Z",
            "message": {
                "role": "toolResult",
                "toolCallId": "call-1",
                "toolName": "bash",
                "content": [{"type": "text", "text": "book.txt:12:the fox"}],
                "isError": False,
            },
        },
        {
            "type": "message",
            "id": "as2",
            "parentId": "tr1",
            "timestamp": "2026-03-12T19:04:19.136Z",
            "message": {
                "role": "assistant",
                "provider": "openai",
                "model": "gpt-test",
                "usage": {"input": 200, "output": 40, "cacheRead": 16},
                "stopReason": "stop",
                "content": [{"type": "text", "text": "The fox is the trickster."}],
            },
        },
    ]
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")


def test_parse_session_file_projects_user_assistant_tools(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    _write_trace(path)
    trace = parse_session_file(path)
    assert trace.sessionId == "trace-session-1"
    assert trace.cwd == "/tmp/project"
    assert trace.stats.userCount == 1
    assert trace.stats.assistantCount == 2
    assert trace.stats.toolCount == 1
    assert len(trace.steps) == 3
    assert trace.steps[0].kind == "user"
    assert trace.steps[0].text == "Who is the fox?"
    assistant = trace.steps[1]
    assert assistant.kind == "assistant"
    assert assistant.thinking == ["**Searching the book**"]
    assert len(assistant.toolCalls) == 1
    assert assistant.toolCalls[0].name == "bash"
    assert assistant.toolCalls[0].result == "book.txt:12:the fox"
    assert trace.steps[2].kind == "assistant"
    assert trace.steps[2].text == "The fox is the trickster."


def test_project_branch_empty() -> None:
    steps, stats = project_branch([])
    assert steps == []
    assert stats.messageCount == 0


def test_load_jsonl_entries_skips_malformed(tmp_path: Path) -> None:
    path = tmp_path / "bad.jsonl"
    path.write_text('{"type":"session","id":"x","version":3}\nnot-json\n', encoding="utf-8")
    header, entries = load_jsonl_entries(path)
    assert header is not None
    assert entries == []
