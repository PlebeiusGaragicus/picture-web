"""In-process pi task runtime.

Runs task profiles (see `pi_profiles`) as sequences of steps, each step
owning one `pi --mode rpc` subprocess (no detached bash, no CLI shims).
Events stream into a per-task ring buffer consumed by the SSE endpoint;
cancellation is the RPC `abort` command with a process terminate
fallback; a status snapshot JSON per task survives API restarts so
interrupted tasks report "failed" instead of a stale "running".
"""

from __future__ import annotations

import atexit
import json
import os
import signal
import subprocess
import threading
import uuid
from collections import deque
from pathlib import Path
from queue import Empty, Queue
from typing import Any

from fastapi import HTTPException

import adaptation
import agent_sessions
import library
from pi_env import (
    AdaptationContext,
    BookSession,
    ensure_node_runtime,
    find_pi_binary,
    pi_runtime_env,
)
from pi_events import project_event
from common import utc_now
from ids import new_ulid
from models import PiTaskStatus
from pi_profiles import PiTaskResultInfo, TaskArgs, TaskProfile, TaskStep, get_profile

ACTIVE_STATES = ("starting", "running", "aborting")
RING_BUFFER_SIZE = 2000
COMMAND_TIMEOUT_S = 120.0
STEP_TIMEOUT_S = 7200.0
ABORT_TERMINATE_AFTER_S = 15.0


def _pi_command() -> list[str]:
    """Base argv for the pi binary. Tests replace this with a fake pi."""
    ensure_node_runtime()
    return [find_pi_binary()]


def _api_origin() -> str:
    """Origin the photo-web extension calls back into."""
    override = os.environ.get("PHOTO_WEB_API")
    if override:
        return override
    port = os.environ.get("API_PORT", "8787")
    return f"http://127.0.0.1:{port}"


def _extension_path() -> Path:
    return Path(__file__).resolve().parent.parent / ".pi" / "extensions" / "photo-web.ts"


def _snapshot_dir(slug: str) -> Path:
    return adaptation.ensure_adaptation(slug) / "sessions" / "pi-tasks"


def _snapshot_path(slug: str, task_id: str) -> Path:
    return _snapshot_dir(slug) / f"{task_id}.json"


def process_start_time(pid: int) -> str | None:
    """Kernel-reported start time for a PID, used to detect PID reuse."""
    try:
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() or None


def process_is_running(pid: int, expected_start_time: str | None = None) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    if expected_start_time:
        return process_start_time(pid) == expected_start_time
    return True


class PiStepProcess:
    """One pi RPC subprocess for a single task step."""

    def __init__(
        self,
        handle: "TaskHandle",
        argv: list[str],
        cwd: str,
        events_file: Any,
        extra_env: dict[str, str] | None = None,
    ) -> None:
        self.handle = handle
        self.stderr_lines: list[str] = []
        self.agent_end = threading.Event()
        self._pending: dict[str, Queue] = {}
        self._stdin_lock = threading.Lock()
        env = pi_runtime_env()
        if extra_env:
            env.update(extra_env)
        self.proc = subprocess.Popen(
            argv,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
        )
        threading.Thread(target=self._read_stdout, args=(events_file,), daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    @property
    def pid(self) -> int | None:
        return self.proc.pid if self.proc.poll() is None else None

    def write_line(self, payload: dict[str, Any]) -> None:
        if self.proc.stdin is None:
            raise RuntimeError("pi process is not running")
        with self._stdin_lock:
            self.proc.stdin.write(json.dumps(payload) + "\n")
            self.proc.stdin.flush()

    def send_command(self, command: dict[str, Any], *, timeout: float = COMMAND_TIMEOUT_S) -> dict[str, Any]:
        command_id = str(uuid.uuid4())
        waiter: Queue = Queue()
        self._pending[command_id] = waiter
        try:
            self.write_line({**command, "id": command_id})
            response = waiter.get(timeout=timeout)
        except Empty as exc:
            raise RuntimeError(f"Timed out waiting for RPC response to {command['type']}") from exc
        finally:
            self._pending.pop(command_id, None)
        if not response.get("success", False):
            raise RuntimeError(response.get("error") or f"RPC command failed: {command['type']}")
        return response

    def send_abort(self) -> None:
        try:
            self.write_line({"type": "abort", "id": str(uuid.uuid4())})
        except (RuntimeError, OSError):
            pass

    def _read_stdout(self, events_file: Any) -> None:
        assert self.proc.stdout is not None
        for raw_line in self.proc.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self.handle.append_event({"type": "parse_error", "raw": line[:500]})
                continue
            message_type = message.get("type")
            if message_type == "extension_ui_request":
                self._auto_cancel_extension_ui(message)
                continue
            if message_type == "response":
                waiter = self._pending.get(message.get("id") or "")
                if waiter is not None:
                    waiter.put(message)
                continue
            try:
                events_file.write(json.dumps(message, ensure_ascii=False) + "\n")
                events_file.flush()
            except (OSError, ValueError):
                pass
            projected = project_event(message)
            if projected is not None:
                self.handle.append_event(projected)
            if message_type == "agent_end":
                self.agent_end.set()
        self.agent_end.set()

    def _read_stderr(self) -> None:
        assert self.proc.stderr is not None
        for raw_line in self.proc.stderr:
            line = raw_line.rstrip("\n")
            if line.strip():
                self.stderr_lines.append(line)

    def _auto_cancel_extension_ui(self, request: dict[str, Any]) -> None:
        method = request.get("method")
        request_id = request.get("id")
        if method not in {"select", "confirm", "input", "editor"} or not request_id:
            return
        try:
            self.write_line({"type": "extension_ui_response", "id": request_id, "cancelled": True})
        except (RuntimeError, OSError):
            pass

    def shutdown(self) -> None:
        self.send_abort()
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass


class TaskHandle:
    def __init__(self, *, slug: str, profile: TaskProfile, ctx: AdaptationContext, args: TaskArgs) -> None:
        self.id = new_ulid()
        self.slug = slug
        self.profile = profile
        self.ctx = ctx
        self.args = args
        self.target = args.target
        self.title = profile.title(args.target)
        self.state = "starting"
        self.error: str | None = None
        self.started_at = utc_now()
        self.completed_at: str | None = None
        self.pi_session_id: str | None = None
        self.pi_session_file: str | None = None

        self.active_process: PiStepProcess | None = None
        self.events: deque[dict[str, Any]] = deque(maxlen=RING_BUFFER_SIZE)
        self.seq = 0
        self.listeners: list[Queue] = []
        self.lock = threading.Lock()
        self.abort_requested = False

    # --- events ---------------------------------------------------------

    def append_event(self, event: dict[str, Any]) -> None:
        with self.lock:
            self.seq += 1
            record = {"seq": self.seq, "ts": utc_now(), "event": event}
            self.events.append(record)
            listeners = list(self.listeners)
        for listener in listeners:
            listener.put(record)

    def events_since(self, since_seq: int) -> list[dict[str, Any]]:
        with self.lock:
            return [record for record in self.events if record["seq"] > since_seq]

    def subscribe(self) -> Queue:
        listener: Queue = Queue()
        with self.lock:
            self.listeners.append(listener)
        return listener

    def unsubscribe(self, listener: Queue) -> None:
        with self.lock:
            if listener in self.listeners:
                self.listeners.remove(listener)

    # --- state ----------------------------------------------------------

    def set_state(self, state: str, *, error: str | None = None) -> None:
        self.state = state
        if error is not None:
            self.error = error
        if state in ("done", "failed", "cancelled"):
            self.completed_at = utc_now()
        self.write_snapshot()
        event: dict[str, Any] = {"type": "task_state", "state": state}
        if error is not None:
            event["error"] = error
        self.append_event(event)

    def to_status(self) -> PiTaskStatus:
        return PiTaskStatus(
            taskId=self.id,
            projectSlug=self.slug,
            profile=self.profile.id,
            title=self.title,
            target=self.target,
            state=self.state,
            startedAt=self.started_at,
            completedAt=self.completed_at,
            error=self.error,
            piSessionId=self.pi_session_id,
            lastSeq=self.seq,
        )

    def write_snapshot(self) -> None:
        process = self.active_process
        pid = process.pid if process is not None else None
        library.write_json(
            _snapshot_path(self.slug, self.id),
            {
                "taskId": self.id,
                "projectSlug": self.slug,
                "profile": self.profile.id,
                "title": self.title,
                "target": self.target,
                "state": self.state,
                "pid": pid,
                "processStartTime": process_start_time(pid) if pid is not None else None,
                "startedAt": self.started_at,
                "completedAt": self.completed_at,
                "error": self.error,
                "piSessionId": self.pi_session_id,
            },
        )

    def request_abort(self) -> bool:
        with self.lock:
            if self.state not in ACTIVE_STATES:
                return False
            self.abort_requested = True
        self.set_state("aborting")
        process = self.active_process
        if process is not None:
            process.send_abort()

            def _terminate_fallback() -> None:
                if process.proc.poll() is None and self.state == "aborting":
                    process.proc.terminate()

            threading.Timer(ABORT_TERMINATE_AFTER_S, _terminate_fallback).start()
        return True

    def shutdown_process(self) -> None:
        process = self.active_process
        if process is not None:
            process.shutdown()


class PiSessionManager:
    def __init__(self) -> None:
        self._handles: dict[str, TaskHandle] = {}
        self._lock = threading.Lock()
        self._swept_slugs: set[str] = set()
        atexit.register(self.shutdown)

    # --- public API -------------------------------------------------------

    def start_task(
        self,
        slug: str,
        profile_id: str,
        *,
        target: str | None = None,
        force: bool = False,
        instructions: str | None = None,
    ) -> TaskHandle:
        profile = get_profile(profile_id)
        try:
            ctx = AdaptationContext.for_slug(slug)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        self._sweep(slug)
        if target is not None and not profile.accepts_target:
            raise HTTPException(status_code=400, detail=f"Profile '{profile_id}' does not take a target")
        if instructions is not None and not profile.accepts_instructions:
            raise HTTPException(status_code=400, detail=f"Profile '{profile_id}' does not take instructions")
        args = TaskArgs(target=target, force=force, instructions=instructions)
        profile.precheck(ctx, args)
        with self._lock:
            for handle in self._handles.values():
                if (
                    handle.slug == slug
                    and handle.profile.id == profile_id
                    and handle.target == target
                    and handle.state in ACTIVE_STATES
                ):
                    raise HTTPException(status_code=409, detail=f"A '{profile_id}' task is already running")
            handle = TaskHandle(slug=slug, profile=profile, ctx=ctx, args=args)
            self._handles[handle.id] = handle
        source: dict[str, Any] = {"type": "pi-task", "profile": profile.id}
        if target is not None:
            source["target"] = target
        agent_sessions.create_session(
            slug,
            kind=profile.id,
            title=handle.title,
            session_id=handle.id,
            source=source,
        )
        handle.write_snapshot()
        handle.append_event({"type": "task_start", "profile": profile.id, "title": handle.title})
        worker = threading.Thread(target=self._run_task, args=(handle,), daemon=True)
        worker.start()
        return handle

    def get_status(self, slug: str, task_id: str) -> PiTaskStatus:
        handle = self._handles.get(task_id)
        if handle is not None and handle.slug == slug:
            return handle.to_status()
        self._sweep(slug)
        snapshot = _snapshot_path(slug, task_id)
        if snapshot.is_file():
            return _status_from_snapshot(library.read_json(snapshot))
        raise HTTPException(status_code=404, detail=f"Pi task not found: {task_id}")

    def list_statuses(
        self, slug: str, *, profile: str | None = None, active: bool | None = None
    ) -> list[PiTaskStatus]:
        self._sweep(slug)
        statuses: dict[str, PiTaskStatus] = {}
        root = _snapshot_dir(slug)
        if root.is_dir():
            for path in root.glob("*.json"):
                try:
                    status = _status_from_snapshot(library.read_json(path))
                except (json.JSONDecodeError, OSError, ValueError):
                    continue
                statuses[status.taskId] = status
        with self._lock:
            for handle in self._handles.values():
                if handle.slug == slug:
                    statuses[handle.id] = handle.to_status()
        results = list(statuses.values())
        if profile is not None:
            results = [status for status in results if status.profile == profile]
        if active is not None:
            results = [status for status in results if (status.state in ACTIVE_STATES) == active]
        return sorted(results, key=lambda status: status.startedAt, reverse=True)

    def abort(self, slug: str, task_id: str) -> bool:
        handle = self._handles.get(task_id)
        if handle is None or handle.slug != slug:
            return False
        return handle.request_abort()

    def get_handle(self, slug: str, task_id: str) -> TaskHandle | None:
        handle = self._handles.get(task_id)
        if handle is not None and handle.slug == slug:
            return handle
        return None

    def shutdown(self) -> None:
        with self._lock:
            handles = list(self._handles.values())
        for handle in handles:
            if handle.state in ACTIVE_STATES:
                handle.request_abort()
        for handle in handles:
            handle.shutdown_process()

    # --- restart recovery ---------------------------------------------------

    def _sweep(self, slug: str) -> None:
        with self._lock:
            if slug in self._swept_slugs:
                return
            self._swept_slugs.add(slug)
        root = _snapshot_dir(slug)
        if not root.is_dir():
            return
        for path in root.glob("*.json"):
            try:
                data = library.read_json(path)
            except (json.JSONDecodeError, OSError):
                continue
            if data.get("state") not in ACTIVE_STATES:
                continue
            if data.get("taskId") in self._handles:
                continue
            pid = data.get("pid")
            if isinstance(pid, int) and process_is_running(pid, data.get("processStartTime")):
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
            data["state"] = "failed"
            data["error"] = data.get("error") or "Interrupted by API restart"
            data["completedAt"] = data.get("completedAt") or utc_now()
            data["pid"] = None
            library.write_json(path, data)
            agent_sessions.update_session(
                slug,
                data.get("taskId"),
                status="failed",
                error=data["error"],
                completed=True,
            )

    # --- worker ---------------------------------------------------------

    def _run_task(self, handle: TaskHandle) -> None:
        ctx = handle.ctx
        source_updates: dict[str, Any] = {}
        try:
            plan = handle.profile.plan(ctx, handle.args)
            handle.set_state("running")
            index = 0
            for step in plan:
                index += 1
                if handle.abort_requested:
                    self._finish(handle, "cancelled", error="Cancelled")
                    return
                handle.append_event({"type": "task_progress", "index": index, "label": step.name})
                result = self._run_step(handle, step)
                if handle.abort_requested:
                    self._finish(handle, "cancelled", error="Cancelled")
                    return
                update = step.on_success(result)
                if update:
                    source_updates.update(update)
            self._finish(handle, "done", source=source_updates or None)
        except Exception as exc:  # noqa: BLE001 — task boundary; error lands in status
            self._finish(
                handle,
                "cancelled" if handle.abort_requested else "failed",
                error=str(exc),
                source=source_updates or None,
            )
        finally:
            handle.shutdown_process()
            handle.active_process = None
            handle.write_snapshot()

    def _run_step(self, handle: TaskHandle, step: TaskStep) -> PiTaskResultInfo | None:
        ctx = handle.ctx
        prompt = step.build_prompt()
        if prompt is None:
            return None

        fork_session_id: str | None = None
        if step.fork_from_book_session:
            manifest = BookSession.load(ctx.book_session_path)
            if manifest is None or not Path(manifest.session_file).is_file():
                raise RuntimeError("No usable read-book session. Run read-book first.")
            fork_session_id = manifest.session_id

        argv = _pi_command() + [
            "--mode",
            "rpc",
            "--session-dir",
            str(ctx.pi_session_dir),
            "--skill",
            str(ctx.skills_dir),
            "--name",
            f"{step.name} {ctx.project_slug}",
        ]
        if fork_session_id:
            argv.extend(["--fork", fork_session_id])

        extra_env: dict[str, str] | None = None
        tools = handle.profile.tools
        if tools:
            argv.extend(["--extension", str(_extension_path())])
            extra_env = {
                "PHOTO_WEB_API": _api_origin(),
                "PHOTO_WEB_PROJECT": ctx.project_slug,
                "PHOTO_WEB_TASK": handle.id,
                "PHOTO_WEB_ALLOWED_TOOLS": ",".join(tools),
            }

        events_path = _snapshot_dir(handle.slug) / f"{handle.id}.events.jsonl"
        with events_path.open("a", encoding="utf-8") as events_file:
            process = PiStepProcess(handle, argv, str(ctx.pi_workspace), events_file, extra_env)
            handle.active_process = process
            # An abort requested before the process existed had nothing to
            # signal; deliver it now so hanging prompts still get cancelled.
            if handle.abort_requested:
                process.send_abort()
            handle.write_snapshot()
            try:
                process.send_command({"type": "get_state"})
                process.send_command({"type": "prompt", "message": prompt})

                if not process.agent_end.wait(timeout=STEP_TIMEOUT_S):
                    raise RuntimeError(f"pi step timed out after {int(STEP_TIMEOUT_S)}s")

                try:
                    state_response = process.send_command({"type": "get_state"}, timeout=30)
                    state = state_response.get("data") or {}
                    handle.pi_session_id = state.get("sessionId") or handle.pi_session_id
                    handle.pi_session_file = state.get("sessionFile") or handle.pi_session_file
                    return PiTaskResultInfo(
                        session_id=state.get("sessionId"), session_file=state.get("sessionFile")
                    )
                except RuntimeError:
                    if handle.abort_requested:
                        return None
                    tail = "\n".join(process.stderr_lines[-20:])
                    raise RuntimeError(
                        f"pi exited before reporting its session{': ' + tail if tail.strip() else ''}"
                    ) from None
            finally:
                process.shutdown()
                handle.active_process = None

    def _finish(
        self, handle: TaskHandle, state: str, *, error: str | None = None, source: dict[str, Any] | None = None
    ) -> None:
        handle.set_state(state, error=error)
        agent_sessions.update_session(
            handle.slug,
            handle.id,
            status="succeeded" if state == "done" else "failed",
            pi_session_id=handle.pi_session_id,
            pi_session_file=handle.pi_session_file,
            source=source,
            error=error,
            completed=True,
        )


MANAGER = PiSessionManager()


def _status_from_snapshot(data: dict[str, Any]) -> PiTaskStatus:
    return PiTaskStatus(
        taskId=str(data.get("taskId", "")),
        projectSlug=str(data.get("projectSlug", "")),
        profile=str(data.get("profile", "")),
        title=str(data.get("title", "")),
        target=data.get("target"),
        state=str(data.get("state", "failed")),
        startedAt=str(data.get("startedAt", "")),
        completedAt=data.get("completedAt"),
        error=data.get("error"),
        piSessionId=data.get("piSessionId"),
        lastSeq=None,
    )
