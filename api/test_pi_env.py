"""Tests for pi_env (paths, node/pi discovery) and pi_events (event projection)."""

from __future__ import annotations

import json
from pathlib import Path

from pi_env import BookSession, node_major, pi_runtime_env, resolve_node_path
from pi_events import clip_text, project_event


def test_clip_text_truncates() -> None:
    assert clip_text("hello", 10) == "hello"
    assert clip_text("x" * 20, 10) == ("x" * 10) + "…[+truncated]"


def test_project_event_assistant_text() -> None:
    projected = project_event(
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Done."}],
            },
        }
    )
    assert projected == {"type": "assistant_text", "text": "Done."}


def test_project_event_tool_end() -> None:
    projected = project_event(
        {
            "type": "tool_execution_end",
            "toolName": "read",
            "isError": False,
            "result": {"content": [{"type": "text", "text": "ok"}]},
        }
    )
    assert projected is not None
    assert projected["type"] == "tool_end"
    assert projected["toolName"] == "read"
    assert projected["isError"] is False


def test_project_event_lifecycle_passthrough() -> None:
    assert project_event({"type": "agent_end"}) == {"type": "agent_end"}


def test_node_major() -> None:
    assert node_major("v22.1.0") == 22
    assert node_major("v18.16.1") == 18
    assert node_major("invalid") == 0


def test_pi_runtime_env_prefers_node22(tmp_path: Path, monkeypatch) -> None:
    fake_node22 = tmp_path / "node22" / "bin"
    fake_node22.mkdir(parents=True)
    (fake_node22 / "node").write_text("#!/bin/sh\necho v22.0.0\n")
    (fake_node22 / "node").chmod(0o755)

    monkeypatch.setattr(
        "pi_env.NODE22_BIN_CANDIDATES",
        (fake_node22,),
    )
    env = pi_runtime_env({"PATH": "/usr/bin"})
    node = resolve_node_path(env)
    assert node == str(fake_node22 / "node")


def test_book_session_roundtrip(tmp_path: Path) -> None:
    manifest = tmp_path / "book-session.json"
    session = BookSession(
        session_file="/tmp/session.jsonl",
        session_id="abc123",
        created_at="2026-01-01T00:00:00Z",
        book_path="/tmp/book.txt",
    )
    session.write(manifest)
    loaded = BookSession.load(manifest)
    assert loaded is not None
    assert loaded.session_id == "abc123"
    assert json.loads(manifest.read_text())["bookPath"] == "/tmp/book.txt"
