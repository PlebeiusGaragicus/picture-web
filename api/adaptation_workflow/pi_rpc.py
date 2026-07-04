"""Pi coding agent RPC client — one subprocess per extraction task."""

from __future__ import annotations

import json
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from queue import Empty, Queue
from typing import Any, Callable

from adaptation_workflow.config import AdaptationContext, find_pi_binary, pi_runtime_env
from adaptation_workflow.diagnostics import TaskDiagnostics


@dataclass
class PiTaskResult:
    session_id: str | None = None
    session_file: str | None = None
    stats: dict[str, Any] | None = None


EventCallback = Callable[[dict[str, Any]], None]
StderrCallback = Callable[[str], None]


class PiRpcError(RuntimeError):
    pass


class PiRpcClient:
    def __init__(self, ctx: AdaptationContext, *, task_timeout_s: float = 7200.0) -> None:
        self.ctx = ctx
        self.pi_binary = find_pi_binary()
        self.task_timeout_s = task_timeout_s
        self._stdin: Any = None

    def run_task(
        self,
        *,
        prompt: str,
        task_name: str,
        task: TaskDiagnostics | None = None,
        fork_session_id: str | None = None,
        on_event: EventCallback | None = None,
        on_stderr: StderrCallback | None = None,
    ) -> PiTaskResult:
        argv = [
            self.pi_binary,
            "--mode",
            "rpc",
            "--session-dir",
            str(self.ctx.pi_session_dir),
            "--skill",
            str(self.ctx.skills_dir),
            "--name",
            task_name,
        ]
        if fork_session_id:
            argv.extend(["--fork", fork_session_id])

        if task is not None:
            task.write_meta(argv=argv, cwd=str(self.ctx.pi_workspace), prompt=prompt)

        proc = subprocess.Popen(
            argv,
            cwd=str(self.ctx.pi_workspace),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=pi_runtime_env(),
        )
        if proc.stdin is None or proc.stdout is None or proc.stderr is None:
            raise PiRpcError("Failed to open pi RPC pipes")

        self._stdin = proc.stdin
        line_queue: Queue[str | None] = Queue()
        stderr_lines: list[str] = []

        def read_stdout() -> None:
            for raw_line in proc.stdout:
                line_queue.put(raw_line.rstrip("\n"))
            line_queue.put(None)

        def read_stderr() -> None:
            for raw_line in proc.stderr:
                line = raw_line.rstrip("\n")
                stderr_lines.append(line)
                if on_stderr is not None:
                    on_stderr(line)

        stdout_thread = threading.Thread(target=read_stdout, daemon=True)
        stderr_thread = threading.Thread(target=read_stderr, daemon=True)
        stdout_thread.start()
        stderr_thread.start()

        def send_command(command: dict[str, Any]) -> dict[str, Any]:
            if command.get("id") is None:
                command = {**command, "id": str(uuid.uuid4())}
            proc.stdin.write(json.dumps(command) + "\n")
            proc.stdin.flush()
            command_id = command["id"]
            deadline = time.monotonic() + self.task_timeout_s
            while time.monotonic() < deadline:
                response = self._next_message(line_queue, deadline, on_event=on_event)
                if response is None:
                    continue
                if response.get("type") == "response" and response.get("id") == command_id:
                    if not response.get("success", False):
                        raise PiRpcError(response.get("error") or f"RPC command failed: {command['type']}")
                    return response
            raise PiRpcError(f"Timed out waiting for RPC response to {command['type']}")

        result = PiTaskResult()
        try:
            # Warm up RPC session before the first prompt.
            send_command({"type": "get_state"})

            send_command({"type": "prompt", "message": prompt})

            deadline = time.monotonic() + self.task_timeout_s
            last_heartbeat = time.monotonic()
            while time.monotonic() < deadline:
                message = self._next_message(line_queue, deadline, on_event=on_event)
                if message is None:
                    if on_event is not None and time.monotonic() - last_heartbeat >= 30:
                        last_heartbeat = time.monotonic()
                        on_event({"type": "heartbeat", "waitingSeconds": int(last_heartbeat + self.task_timeout_s - deadline)})
                    continue
                if message.get("type") == "agent_end":
                    break

            state_response = send_command({"type": "get_state"})
            state = state_response.get("data") or {}
            result.session_id = state.get("sessionId")
            result.session_file = state.get("sessionFile")

            try:
                stats_response = send_command({"type": "get_session_stats"})
                result.stats = stats_response.get("data")
            except PiRpcError:
                result.stats = None
        finally:
            self._stdin = None
            try:
                proc.stdin.write(json.dumps({"type": "abort"}) + "\n")
                proc.stdin.flush()
            except OSError:
                pass
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
            stdout_thread.join(timeout=2)
            stderr_thread.join(timeout=2)

        if proc.returncode not in (0, None, -15, -9) and stderr_lines:
            tail = "\n".join(stderr_lines[-20:])
            if tail.strip():
                raise PiRpcError(f"pi RPC exited with code {proc.returncode}: {tail}")

        return result

    def _next_message(
        self,
        line_queue: Queue[str | None],
        deadline: float,
        *,
        on_event: EventCallback | None,
    ) -> dict[str, Any] | None:
        timeout = max(0.05, deadline - time.monotonic())
        try:
            line = line_queue.get(timeout=timeout)
        except Empty:
            return None
        if line is None:
            return None
        line = line.rstrip("\r")
        if not line.strip():
            return None
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            if on_event is not None:
                on_event({"type": "parse_error", "raw": line[:500]})
            return None

        if message.get("type") == "extension_ui_request":
            self._auto_respond_extension_ui(message)
            return None

        if message.get("type") == "response":
            return message

        if on_event is not None:
            on_event(message)
        return message

    def _auto_respond_extension_ui(self, request: dict[str, Any]) -> None:
        method = request.get("method")
        request_id = request.get("id")
        if method not in {"select", "confirm", "input", "editor"} or not request_id:
            return
        if self._stdin is None:
            return
        response = {"type": "extension_ui_response", "id": request_id, "cancelled": True}
        try:
            self._stdin.write(json.dumps(response) + "\n")
            self._stdin.flush()
        except OSError:
            pass
