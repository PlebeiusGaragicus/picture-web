#!/usr/bin/env python3
"""Fake `pi --mode rpc` for tests: scripted JSON-lines RPC over stdin/stdout.

Behavior knobs (env vars):
- FAKE_PI_SESSION_ID   session id to report (default "fake-session")
- FAKE_PI_HANG=1       never emit agent_end after a prompt (until abort)
- FAKE_PI_WRITE_FILE   "path::content" — file to write when prompted, so
                       tests can simulate pi's write tool producing output
- FAKE_PI_WRITE_FROM_PROMPT
                       content template written to the out path parsed
                       from the prompt's first line (last whitespace token,
                       e.g. "/skill:character-file <root> <out>"); the
                       "{stem}" placeholder is replaced by the out path stem
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    args = sys.argv[1:]
    session_dir = "."
    for index, arg in enumerate(args):
        if arg == "--session-dir" and index + 1 < len(args):
            session_dir = args[index + 1]

    session_id = os.environ.get("FAKE_PI_SESSION_ID", "fake-session")
    session_file = str(Path(session_dir) / f"{session_id}.jsonl")
    Path(session_file).parent.mkdir(parents=True, exist_ok=True)
    Path(session_file).write_text("")
    # Record argv so tests can assert flags like --fork were passed.
    (Path(session_dir) / "fake-pi-argv.json").write_text(json.dumps(args))

    hang = os.environ.get("FAKE_PI_HANG") == "1"
    write_file = os.environ.get("FAKE_PI_WRITE_FILE", "")
    write_from_prompt = os.environ.get("FAKE_PI_WRITE_FROM_PROMPT", "")

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        message_type = message.get("type")
        message_id = message.get("id")
        if message_type == "get_state":
            emit(
                {
                    "type": "response",
                    "id": message_id,
                    "success": True,
                    "data": {"sessionId": session_id, "sessionFile": session_file},
                }
            )
        elif message_type == "prompt":
            emit({"type": "response", "id": message_id, "success": True})
            emit({"type": "agent_start"})
            emit(
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "Working on it."}],
                    },
                }
            )
            emit({"type": "tool_execution_start", "toolName": "write", "args": {"path": "out.txt"}})
            if write_file:
                path_text, _, content = write_file.partition("::")
                target = Path(path_text)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
            if write_from_prompt:
                first_line = str(message.get("message", "")).splitlines()[0] if message.get("message") else ""
                tokens = first_line.split()
                if len(tokens) >= 2:
                    target = Path(tokens[-1])
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(write_from_prompt.replace("{stem}", target.stem))
            emit({"type": "tool_execution_end", "toolName": "write", "isError": False, "result": "ok"})
            if not hang:
                emit({"type": "agent_end"})
        elif message_type == "abort":
            emit({"type": "response", "id": message_id, "success": True, "data": {"cancelled": True}})
            emit({"type": "agent_end"})
        elif message_type == "get_session_stats":
            emit({"type": "response", "id": message_id, "success": True, "data": {"turns": 1}})
        else:
            emit({"type": "response", "id": message_id, "success": True})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
