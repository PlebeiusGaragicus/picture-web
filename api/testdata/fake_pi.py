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
- FAKE_PI_CALL_TOOL    JSON {"tool", "method", "path", "body"} — when prompted,
                       emit tool_execution_start/end for the named tool and
                       perform the HTTP request against PHOTO_WEB_API, exactly
                       as the photo-web extension would. "{target}" in path
                       segments is replaced by the last token of the prompt's
                       first line.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


def call_photo_web_tool(spec: dict, prompt_message: str) -> tuple[bool, str]:
    api = os.environ.get("PHOTO_WEB_API", "").rstrip("/")
    first_line = prompt_message.splitlines()[0] if prompt_message else ""
    target = first_line.split()[-1] if first_line.split() else ""
    path = spec.get("path", "").replace("{target}", target)
    body = json.dumps(spec.get("body", {})).encode("utf-8")
    request = urllib.request.Request(
        f"{api}{path}",
        data=body,
        method=spec.get("method", "POST"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request) as response:
            return False, response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return True, f"photo-web API {exc.code}: {exc.read().decode('utf-8')}"


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
    # Record argv and PHOTO_WEB_* env so tests can assert flags and tool scoping.
    (Path(session_dir) / "fake-pi-argv.json").write_text(json.dumps(args))
    photo_web_env = {key: value for key, value in os.environ.items() if key.startswith("PHOTO_WEB_")}
    (Path(session_dir) / "fake-pi-env.json").write_text(json.dumps(photo_web_env))

    hang = os.environ.get("FAKE_PI_HANG") == "1"
    write_file = os.environ.get("FAKE_PI_WRITE_FILE", "")
    write_from_prompt = os.environ.get("FAKE_PI_WRITE_FROM_PROMPT", "")
    call_tool_raw = os.environ.get("FAKE_PI_CALL_TOOL", "")

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
            if call_tool_raw:
                spec = json.loads(call_tool_raw)
                tool_name = spec.get("tool", "photo_web_tool")
                emit({"type": "tool_execution_start", "toolName": tool_name, "args": spec.get("body", {})})
                is_error, result = call_photo_web_tool(spec, str(message.get("message", "")))
                emit({"type": "tool_execution_end", "toolName": tool_name, "isError": is_error, "result": result})
                if not hang:
                    emit({"type": "agent_end"})
                continue
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
