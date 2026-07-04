"""Detached pi-agent job launching and status tracking.

Jobs run as detached subprocesses (`python -m adaptation_workflow ...` or
`python -m book_session_load`) that drive the pi CLI over RPC. Status is
persisted as JSON next to the job logs so it survives API restarts.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from fastapi import HTTPException

import adaptation
import library
from common import utc_now
from models import AdaptationWorkflowStatus


def workflow_status_path(slug: str, stage: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{stage}-status.json"


def workflow_log_path(slug: str, stage: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{stage}.log"


def workflow_launcher_log_path(slug: str, stage: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{stage}-launcher.log"


def workflow_python() -> str:
    venv_python = library.REPO_ROOT / ".venv" / "bin" / "python"
    if venv_python.is_file():
        return venv_python.as_posix()
    return "python3"


def workflow_log_files(slug: str, stage: str) -> dict[str, str]:
    root = adaptation.adaptation_dir(slug)
    prefix = "run"
    sessions = root / "sessions"
    files = {
        "log": (sessions / f"{prefix}-{stage}.log").relative_to(root).as_posix(),
        "events": (sessions / f"{prefix}-{stage}.events.jsonl").relative_to(root).as_posix(),
        "summary": (sessions / f"{prefix}-{stage}.summary.json").relative_to(root).as_posix(),
        "manifest": (sessions / f"{prefix}-{stage}-manifest.json").relative_to(root).as_posix(),
        "launcher": (sessions / f"{prefix}-{stage}-launcher.log").relative_to(root).as_posix(),
        "tasksDir": (sessions / "tasks").relative_to(root).as_posix(),
    }
    manifest_path = sessions / f"{prefix}-{stage}-manifest.json"
    if manifest_path.is_file():
        try:
            manifest = library.read_json(manifest_path)
            for key in ("log", "events", "summary", "tasksDir"):
                if key in manifest:
                    files[key] = str(manifest[key])
        except (json.JSONDecodeError, OSError):
            pass
    return files


def process_status(slug: str, status_path: Path, log_path: Path) -> AdaptationWorkflowStatus:
    adaptation.ensure_adaptation(slug)
    data: dict[str, Any] = {}
    if status_path.is_file():
        data = library.read_json(status_path)
    running = False
    pid = data.get("pid")
    if data.get("running") and isinstance(pid, int):
        running = process_is_running(pid, data.get("processStartTime"))
    log = adaptation.read_text(log_path)
    log_limit = 400000
    if len(log) > log_limit:
        log = log[-log_limit:]
        # Drop a partial first line so the UI never tries to parse a truncated event.
        newline = log.find("\n")
        if newline != -1:
            log = log[newline + 1 :]
    if data.get("running") and not running:
        data["running"] = False
        data["completedAt"] = data.get("completedAt") or utc_now()
        library.write_json(status_path, data)
    stage_name = log_path.name.removeprefix("run-").removesuffix(".log")
    return AdaptationWorkflowStatus(
        running=running,
        returnCode=data.get("returnCode"),
        startedAt=data.get("startedAt"),
        completedAt=data.get("completedAt"),
        log=log,
        logFiles=workflow_log_files(slug, stage_name),
    )


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


def start_logged_process(
    slug: str,
    *,
    log_path: Path,
    launcher_log_path: Path,
    status_path: Path,
    start_line: str,
    script_command: str,
    extra_env: dict[str, str] | None = None,
) -> AdaptationWorkflowStatus:
    root = adaptation.ensure_adaptation(slug)
    current = process_status(slug, status_path, log_path)
    if current.running:
        raise HTTPException(status_code=409, detail="Process is already running")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    launcher_file = launcher_log_path.open("w")
    launcher_file.write(f"[{utc_now()}] {start_line}\n")
    launcher_file.flush()
    python_bin = workflow_python()
    launcher_file.write(f"[{utc_now()}] python: {python_bin}\n")
    launcher_file.flush()
    command = [
        "bash",
        "-lc",
        (
            f"{script_command}; code=$?; "
            "python3 - \"$STATUS_PATH\" \"$code\" <<'PY'\n"
            "import json\n"
            "import sys\n"
            "from datetime import datetime, timezone\n"
            "from pathlib import Path\n"
            "path = Path(sys.argv[1])\n"
            "data = json.loads(path.read_text())\n"
            "data['running'] = False\n"
            "data['returnCode'] = int(sys.argv[2])\n"
            "data['completedAt'] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')\n"
            "path.write_text(json.dumps(data, indent=2) + '\\n')\n"
            "PY\n"
            "exit $code"
        ),
    ]
    env = os.environ.copy()
    from adaptation_workflow.config import pi_runtime_env

    env = pi_runtime_env(env)
    env["SLUG"] = slug
    env["STATUS_PATH"] = str(status_path)
    if extra_env:
        env.update(extra_env)
    process = subprocess.Popen(
        command,
        cwd=library.REPO_ROOT,
        stdout=launcher_file,
        stderr=subprocess.STDOUT,
        env=env,
        start_new_session=True,
    )
    library.write_json(
        status_path,
        {
            "running": True,
            "pid": process.pid,
            "processStartTime": process_start_time(process.pid),
            "returnCode": None,
            "startedAt": utc_now(),
            "completedAt": None,
        },
    )
    launcher_file.close()
    return process_status(slug, status_path, log_path)


def character_list_stage_name() -> str:
    return "character-list"


def character_extract_all_stage_name() -> str:
    return "character-extract-all"


def character_extract_stage_name(character_slug: str) -> str:
    from adaptation_workflow.runner import character_extract_stage

    return character_extract_stage(character_slug)


def character_list_status_path(slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{character_list_stage_name()}-status.json"


def character_list_log_path(slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{character_list_stage_name()}.log"


def character_list_launcher_log_path(slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{character_list_stage_name()}-launcher.log"


def character_extract_all_status_path(slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{character_extract_all_stage_name()}-status.json"


def character_extract_all_log_path(slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{character_extract_all_stage_name()}.log"


def character_extract_all_launcher_log_path(slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{character_extract_all_stage_name()}-launcher.log"


def character_extract_status_path(slug: str, character_slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{character_extract_stage_name(character_slug)}-status.json"


def character_extract_log_path(slug: str, character_slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{character_extract_stage_name(character_slug)}.log"


def character_extract_launcher_log_path(slug: str, character_slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{character_extract_stage_name(character_slug)}-launcher.log"


def _require_book_session_for_characters(slug: str) -> None:
    root = adaptation.ensure_adaptation(slug)
    if not adaptation._has_book_session(root):
        raise HTTPException(status_code=409, detail="Load book session before running character workflows")


def start_character_list(slug: str) -> AdaptationWorkflowStatus:
    _require_book_session_for_characters(slug)
    return start_logged_process(
        slug,
        log_path=character_list_log_path(slug),
        launcher_log_path=character_list_launcher_log_path(slug),
        status_path=character_list_status_path(slug),
        start_line=f"Starting character list for {slug}",
        script_command=f'cd api && {workflow_python()} -m adaptation_workflow list-characters "$SLUG"',
    )


def character_list_status(slug: str) -> AdaptationWorkflowStatus:
    return process_status(
        slug,
        character_list_status_path(slug),
        character_list_log_path(slug),
    )


def start_character_extract_all(slug: str) -> AdaptationWorkflowStatus:
    root = adaptation.ensure_adaptation(slug)
    _require_book_session_for_characters(slug)
    if not (root / "characters" / "list.txt").is_file():
        raise HTTPException(status_code=409, detail="List characters before extract-all")
    return start_logged_process(
        slug,
        log_path=character_extract_all_log_path(slug),
        launcher_log_path=character_extract_all_launcher_log_path(slug),
        status_path=character_extract_all_status_path(slug),
        start_line=f"Starting character extract-all for {slug}",
        script_command=f'cd api && {workflow_python()} -m adaptation_workflow extract-characters "$SLUG"',
    )


def character_extract_all_status(slug: str) -> AdaptationWorkflowStatus:
    return process_status(
        slug,
        character_extract_all_status_path(slug),
        character_extract_all_log_path(slug),
    )


def start_character_extract(slug: str, character_slug: str, *, force: bool = False) -> AdaptationWorkflowStatus:
    root = adaptation.ensure_adaptation(slug)
    _require_book_session_for_characters(slug)
    if not (root / "characters" / "list.txt").is_file():
        raise HTTPException(status_code=409, detail="List characters before extract")
    from adaptation_workflow.character_file import character_list_lines

    listed = {entry_slug for entry_slug, _line in character_list_lines(root / "characters" / "list.txt")}
    if character_slug not in listed:
        raise HTTPException(status_code=404, detail=f"Character not in list: {character_slug}")
    force_flag = " --force" if force else ""
    return start_logged_process(
        slug,
        log_path=character_extract_log_path(slug, character_slug),
        launcher_log_path=character_extract_launcher_log_path(slug, character_slug),
        status_path=character_extract_status_path(slug, character_slug),
        start_line=f"Starting character extract for {character_slug} in {slug}",
        script_command=(
            f'cd api && {workflow_python()} -m adaptation_workflow extract-character "$SLUG" "{character_slug}"{force_flag}'
        ),
    )


def character_extract_status(slug: str, character_slug: str) -> AdaptationWorkflowStatus:
    return process_status(
        slug,
        character_extract_status_path(slug, character_slug),
        character_extract_log_path(slug, character_slug),
    )


def concept_character_generate_stage_name() -> str:
    from adaptation_workflow.runner import concept_character_generate_stage

    return concept_character_generate_stage()


def concept_character_generate_status_path(slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{concept_character_generate_stage_name()}-status.json"


def concept_character_generate_log_path(slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{concept_character_generate_stage_name()}.log"


def concept_character_generate_launcher_log_path(slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{concept_character_generate_stage_name()}-launcher.log"


def start_generate_concept_character(slug: str) -> AdaptationWorkflowStatus:
    _require_book_session_for_characters(slug)
    current = generate_concept_character_status(slug)
    if current.running:
        raise HTTPException(status_code=409, detail="Process is already running")
    import agent_sessions

    stage = concept_character_generate_stage_name()
    session = agent_sessions.create_session(
        slug,
        kind="concept-character-suggest",
        title="Suggest character concept",
        source={"type": "concept-suggest", "subjectKind": "character", "stage": stage},
        log_files=workflow_log_files(slug, stage),
    )
    return start_logged_process(
        slug,
        log_path=concept_character_generate_log_path(slug),
        launcher_log_path=concept_character_generate_launcher_log_path(slug),
        status_path=concept_character_generate_status_path(slug),
        start_line=f"Starting concept character generation for {slug}",
        script_command=f'cd api && {workflow_python()} -m adaptation_workflow generate-concept-character "$SLUG"',
        extra_env={"AGENT_SESSION_ID": session.id},
    )


def generate_concept_character_status(slug: str) -> AdaptationWorkflowStatus:
    return process_status(
        slug,
        concept_character_generate_status_path(slug),
        concept_character_generate_log_path(slug),
    )


def concept_location_generate_stage_name() -> str:
    from adaptation_workflow.runner import concept_location_generate_stage

    return concept_location_generate_stage()


def concept_location_generate_status_path(slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{concept_location_generate_stage_name()}-status.json"


def concept_location_generate_log_path(slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{concept_location_generate_stage_name()}.log"


def concept_location_generate_launcher_log_path(slug: str) -> Path:
    return adaptation.adaptation_dir(slug) / "sessions" / f"run-{concept_location_generate_stage_name()}-launcher.log"


def start_generate_concept_location(slug: str) -> AdaptationWorkflowStatus:
    _require_book_session_for_characters(slug)
    current = generate_concept_location_status(slug)
    if current.running:
        raise HTTPException(status_code=409, detail="Process is already running")
    import agent_sessions

    stage = concept_location_generate_stage_name()
    session = agent_sessions.create_session(
        slug,
        kind="concept-location-suggest",
        title="Suggest location concept",
        source={"type": "concept-suggest", "subjectKind": "location", "stage": stage},
        log_files=workflow_log_files(slug, stage),
    )
    return start_logged_process(
        slug,
        log_path=concept_location_generate_log_path(slug),
        launcher_log_path=concept_location_generate_launcher_log_path(slug),
        status_path=concept_location_generate_status_path(slug),
        start_line=f"Starting concept location generation for {slug}",
        script_command=f'cd api && {workflow_python()} -m adaptation_workflow generate-concept-location "$SLUG"',
        extra_env={"AGENT_SESSION_ID": session.id},
    )


def generate_concept_location_status(slug: str) -> AdaptationWorkflowStatus:
    return process_status(
        slug,
        concept_location_generate_status_path(slug),
        concept_location_generate_log_path(slug),
    )
