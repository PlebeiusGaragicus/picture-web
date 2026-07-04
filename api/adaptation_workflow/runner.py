"""Workflow and validation orchestration."""

from __future__ import annotations

import json
import os
import sys

from adaptation_workflow.config import (
    AdaptationContext,
    ensure_node_runtime,
    find_pi_binary,
    node_version,
    pi_version,
)
from common import utc_now
from adaptation_workflow.diagnostics import RunDiagnostics
from adaptation_workflow.events import WorkflowLogger
from adaptation_workflow.steps import StepRunner


def write_summary(
    diagnostics: RunDiagnostics,
    *,
    stage: str,
    return_code: int,
    tasks: list[dict],
    pi_binary: str,
    error: str | None = None,
    running: bool = False,
) -> None:
    payload = {
        "stage": stage,
        "returnCode": return_code,
        "running": running,
        "completedAt": utc_now(),
        "pi": pi_binary,
        "piVersion": pi_version(pi_binary),
        "nodeVersion": node_version(),
        "tasks": tasks,
    }
    if error:
        payload["error"] = error
    diagnostics.summary_path.parent.mkdir(parents=True, exist_ok=True)
    diagnostics.summary_path.write_text(json.dumps(payload, indent=2) + "\n")


def character_extract_stage(character_slug: str) -> str:
    return f"character-extract-{character_slug}"


def run_list_characters(project_slug: str) -> int:
    stage = "character-list"
    try:
        ctx = AdaptationContext.for_slug(project_slug)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    diagnostics = RunDiagnostics.create(ctx.book_root_abs, stage, validation=False)
    logger = WorkflowLogger(diagnostics)

    try:
        node_path, node_ver = ensure_node_runtime()
    except RuntimeError as exc:
        logger.write_line(f"error: {exc}")
        logger.close()
        write_summary(
            diagnostics,
            stage=stage,
            return_code=1,
            tasks=[],
            pi_binary="missing",
            error=str(exc),
            running=False,
        )
        diagnostics.write_manifest(ctx.book_root_abs, extra={"project": ctx.project_slug, "error": str(exc)})
        print(f"error: {exc}", file=sys.stderr)
        return 1

    pi_binary = find_pi_binary()

    def flush_progress(*, error: str | None = None, return_code: int = 0, running: bool = True) -> None:
        write_summary(
            diagnostics,
            stage=stage,
            return_code=return_code,
            tasks=logger.task_records,
            pi_binary=pi_binary,
            error=error,
            running=running,
        )
        diagnostics.write_manifest(
            ctx.book_root_abs,
            extra={"project": ctx.project_slug, "returnCode": return_code, "running": running, "error": error},
        )

    logger.write_line(f"[start] pi: {pi_binary} ({pi_version(pi_binary)})")
    logger.write_line(f"[start] node: {node_ver} ({node_path})")
    logger.write_line(f"[start] project: {ctx.project_slug}")
    logger.write_line(f"[start] log: {diagnostics.rel(diagnostics.ui_log_path, ctx.book_root_abs)}")
    flush_progress(running=True)

    return_code = 0
    error: str | None = None
    try:
        steps = StepRunner(ctx, logger, on_progress=lambda: flush_progress(running=True))
        steps.require_book_session()
        steps.list_characters()
        logger.write_line()
        logger.write_line(f"[characters] Done. List and stubs are under {ctx.book_root}/characters/.")
    except Exception as exc:
        return_code = 1
        error = str(exc)
        logger.write_line(f"error: {error}")
        print(f"error: {error}", file=sys.stderr)
    finally:
        logger.close()
        flush_progress(error=error, return_code=return_code, running=False)

    return return_code


def concept_character_generate_stage() -> str:
    return "concept-character-generate"


def run_generate_concept_character(project_slug: str) -> int:
    agent_session_id = os.environ.get("AGENT_SESSION_ID")
    stage = concept_character_generate_stage()
    try:
        ctx = AdaptationContext.for_slug(project_slug)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    diagnostics = RunDiagnostics.create(ctx.book_root_abs, stage, validation=False)
    logger = WorkflowLogger(diagnostics)

    try:
        node_path, node_ver = ensure_node_runtime()
    except RuntimeError as exc:
        logger.write_line(f"error: {exc}")
        logger.close()
        write_summary(
            diagnostics,
            stage=stage,
            return_code=1,
            tasks=[],
            pi_binary="missing",
            error=str(exc),
            running=False,
        )
        diagnostics.write_manifest(ctx.book_root_abs, extra={"project": ctx.project_slug, "error": str(exc)})
        if agent_session_id:
            import agent_sessions

            agent_sessions.update_session(
                ctx.project_slug,
                agent_session_id,
                status="failed",
                error=str(exc),
                log_files={"log": diagnostics.rel(diagnostics.ui_log_path, ctx.book_root_abs)},
                completed=True,
            )
        print(f"error: {exc}", file=sys.stderr)
        return 1

    pi_binary = find_pi_binary()

    def flush_progress(*, error: str | None = None, return_code: int = 0, running: bool = True) -> None:
        write_summary(
            diagnostics,
            stage=stage,
            return_code=return_code,
            tasks=logger.task_records,
            pi_binary=pi_binary,
            error=error,
            running=running,
        )
        diagnostics.write_manifest(
            ctx.book_root_abs,
            extra={"project": ctx.project_slug, "returnCode": return_code, "running": running, "error": error},
        )

    logger.write_line(f"[start] pi: {pi_binary} ({pi_version(pi_binary)})")
    logger.write_line(f"[start] node: {node_ver} ({node_path})")
    logger.write_line(f"[start] project: {ctx.project_slug}")
    logger.write_line(f"[start] log: {diagnostics.rel(diagnostics.ui_log_path, ctx.book_root_abs)}")
    flush_progress(running=True)

    return_code = 0
    error: str | None = None
    created_key = ""
    try:
        steps = StepRunner(ctx, logger, on_progress=lambda: flush_progress(running=True))
        steps.require_book_session()
        created_key = steps.step_generate_concept_character()
        if agent_session_id:
            import agent_sessions

            agent_sessions.update_session(
                ctx.project_slug,
                agent_session_id,
                status="succeeded",
                source={"outputCardId": created_key},
                log_files={
                    "log": diagnostics.rel(diagnostics.ui_log_path, ctx.book_root_abs),
                    "events": diagnostics.rel(diagnostics.events_path, ctx.book_root_abs),
                    "summary": diagnostics.rel(diagnostics.summary_path, ctx.book_root_abs),
                    "manifest": diagnostics.rel(diagnostics.manifest_path, ctx.book_root_abs),
                    "tasksDir": diagnostics.rel(diagnostics.tasks_dir, ctx.book_root_abs),
                },
                completed=True,
            )
        logger.write_line()
        logger.write_line(f"[concept-art] Done. Created concept card {created_key}")
    except Exception as exc:
        return_code = 1
        error = str(exc)
        if agent_session_id:
            import agent_sessions

            agent_sessions.update_session(
                ctx.project_slug,
                agent_session_id,
                status="failed",
                error=error,
                log_files={
                    "log": diagnostics.rel(diagnostics.ui_log_path, ctx.book_root_abs),
                    "events": diagnostics.rel(diagnostics.events_path, ctx.book_root_abs),
                    "summary": diagnostics.rel(diagnostics.summary_path, ctx.book_root_abs),
                    "manifest": diagnostics.rel(diagnostics.manifest_path, ctx.book_root_abs),
                    "tasksDir": diagnostics.rel(diagnostics.tasks_dir, ctx.book_root_abs),
                },
                completed=True,
            )
        logger.write_line(f"error: {error}")
        print(f"error: {error}", file=sys.stderr)
    finally:
        logger.close()
        flush_progress(error=error, return_code=return_code, running=False)

    return return_code


def concept_location_generate_stage() -> str:
    return "concept-location-generate"


def run_generate_concept_location(project_slug: str) -> int:
    agent_session_id = os.environ.get("AGENT_SESSION_ID")
    stage = concept_location_generate_stage()
    try:
        ctx = AdaptationContext.for_slug(project_slug)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    diagnostics = RunDiagnostics.create(ctx.book_root_abs, stage, validation=False)
    logger = WorkflowLogger(diagnostics)

    try:
        node_path, node_ver = ensure_node_runtime()
    except RuntimeError as exc:
        logger.write_line(f"error: {exc}")
        logger.close()
        write_summary(
            diagnostics,
            stage=stage,
            return_code=1,
            tasks=[],
            pi_binary="missing",
            error=str(exc),
            running=False,
        )
        diagnostics.write_manifest(ctx.book_root_abs, extra={"project": ctx.project_slug, "error": str(exc)})
        if agent_session_id:
            import agent_sessions

            agent_sessions.update_session(
                ctx.project_slug,
                agent_session_id,
                status="failed",
                error=str(exc),
                log_files={"log": diagnostics.rel(diagnostics.ui_log_path, ctx.book_root_abs)},
                completed=True,
            )
        print(f"error: {exc}", file=sys.stderr)
        return 1

    pi_binary = find_pi_binary()

    def flush_progress(*, error: str | None = None, return_code: int = 0, running: bool = True) -> None:
        write_summary(
            diagnostics,
            stage=stage,
            return_code=return_code,
            tasks=logger.task_records,
            pi_binary=pi_binary,
            error=error,
            running=running,
        )
        diagnostics.write_manifest(
            ctx.book_root_abs,
            extra={"project": ctx.project_slug, "returnCode": return_code, "running": running, "error": error},
        )

    logger.write_line(f"[start] pi: {pi_binary} ({pi_version(pi_binary)})")
    logger.write_line(f"[start] node: {node_ver} ({node_path})")
    logger.write_line(f"[start] project: {ctx.project_slug}")
    logger.write_line(f"[start] log: {diagnostics.rel(diagnostics.ui_log_path, ctx.book_root_abs)}")
    flush_progress(running=True)

    return_code = 0
    error: str | None = None
    created_key = ""
    try:
        steps = StepRunner(ctx, logger, on_progress=lambda: flush_progress(running=True))
        steps.require_book_session()
        created_key = steps.step_generate_concept_location()
        if agent_session_id:
            import agent_sessions

            agent_sessions.update_session(
                ctx.project_slug,
                agent_session_id,
                status="succeeded",
                source={"outputCardId": created_key},
                log_files={
                    "log": diagnostics.rel(diagnostics.ui_log_path, ctx.book_root_abs),
                    "events": diagnostics.rel(diagnostics.events_path, ctx.book_root_abs),
                    "summary": diagnostics.rel(diagnostics.summary_path, ctx.book_root_abs),
                    "manifest": diagnostics.rel(diagnostics.manifest_path, ctx.book_root_abs),
                    "tasksDir": diagnostics.rel(diagnostics.tasks_dir, ctx.book_root_abs),
                },
                completed=True,
            )
        logger.write_line()
        logger.write_line(f"[concept-art] Done. Created concept card {created_key}")
    except Exception as exc:
        return_code = 1
        error = str(exc)
        if agent_session_id:
            import agent_sessions

            agent_sessions.update_session(
                ctx.project_slug,
                agent_session_id,
                status="failed",
                error=error,
                log_files={
                    "log": diagnostics.rel(diagnostics.ui_log_path, ctx.book_root_abs),
                    "events": diagnostics.rel(diagnostics.events_path, ctx.book_root_abs),
                    "summary": diagnostics.rel(diagnostics.summary_path, ctx.book_root_abs),
                    "manifest": diagnostics.rel(diagnostics.manifest_path, ctx.book_root_abs),
                    "tasksDir": diagnostics.rel(diagnostics.tasks_dir, ctx.book_root_abs),
                },
                completed=True,
            )
        logger.write_line(f"error: {error}")
        print(f"error: {error}", file=sys.stderr)
    finally:
        logger.close()
        flush_progress(error=error, return_code=return_code, running=False)

    return return_code


def run_extract_character(project_slug: str, character_slug: str, *, force: bool = False) -> int:
    stage = character_extract_stage(character_slug)
    try:
        ctx = AdaptationContext.for_slug(project_slug)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    diagnostics = RunDiagnostics.create(ctx.book_root_abs, stage, validation=False)
    logger = WorkflowLogger(diagnostics)

    try:
        node_path, node_ver = ensure_node_runtime()
    except RuntimeError as exc:
        logger.write_line(f"error: {exc}")
        logger.close()
        write_summary(
            diagnostics,
            stage=stage,
            return_code=1,
            tasks=[],
            pi_binary="missing",
            error=str(exc),
            running=False,
        )
        diagnostics.write_manifest(
            ctx.book_root_abs,
            extra={"project": ctx.project_slug, "characterSlug": character_slug, "error": str(exc)},
        )
        print(f"error: {exc}", file=sys.stderr)
        return 1

    pi_binary = find_pi_binary()

    def flush_progress(*, error: str | None = None, return_code: int = 0, running: bool = True) -> None:
        write_summary(
            diagnostics,
            stage=stage,
            return_code=return_code,
            tasks=logger.task_records,
            pi_binary=pi_binary,
            error=error,
            running=running,
        )
        diagnostics.write_manifest(
            ctx.book_root_abs,
            extra={
                "project": ctx.project_slug,
                "characterSlug": character_slug,
                "returnCode": return_code,
                "running": running,
                "error": error,
            },
        )

    logger.write_line(f"[start] pi: {pi_binary} ({pi_version(pi_binary)})")
    logger.write_line(f"[start] node: {node_ver} ({node_path})")
    logger.write_line(f"[start] project: {ctx.project_slug}")
    logger.write_line(f"[start] character: {character_slug}")
    logger.write_line(f"[start] log: {diagnostics.rel(diagnostics.ui_log_path, ctx.book_root_abs)}")
    flush_progress(running=True)

    return_code = 0
    error: str | None = None
    try:
        steps = StepRunner(ctx, logger, on_progress=lambda: flush_progress(running=True))
        steps.require_book_session()
        steps.step_character_file(character_slug, force=force)
        logger.write_line()
        logger.write_line(f"[characters] Done. Character file updated for {character_slug}.")
    except Exception as exc:
        return_code = 1
        error = str(exc)
        logger.write_line(f"error: {error}")
        print(f"error: {error}", file=sys.stderr)
    finally:
        logger.close()
        flush_progress(error=error, return_code=return_code, running=False)

    return return_code


def run_extract_characters(project_slug: str) -> int:
    stage = "character-extract-all"
    try:
        ctx = AdaptationContext.for_slug(project_slug)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    diagnostics = RunDiagnostics.create(ctx.book_root_abs, stage, validation=False)
    logger = WorkflowLogger(diagnostics)

    try:
        node_path, node_ver = ensure_node_runtime()
    except RuntimeError as exc:
        logger.write_line(f"error: {exc}")
        logger.close()
        write_summary(
            diagnostics,
            stage=stage,
            return_code=1,
            tasks=[],
            pi_binary="missing",
            error=str(exc),
            running=False,
        )
        diagnostics.write_manifest(ctx.book_root_abs, extra={"project": ctx.project_slug, "error": str(exc)})
        print(f"error: {exc}", file=sys.stderr)
        return 1

    pi_binary = find_pi_binary()

    def flush_progress(*, error: str | None = None, return_code: int = 0, running: bool = True) -> None:
        write_summary(
            diagnostics,
            stage=stage,
            return_code=return_code,
            tasks=logger.task_records,
            pi_binary=pi_binary,
            error=error,
            running=running,
        )
        diagnostics.write_manifest(
            ctx.book_root_abs,
            extra={"project": ctx.project_slug, "returnCode": return_code, "running": running, "error": error},
        )

    logger.write_line(f"[start] pi: {pi_binary} ({pi_version(pi_binary)})")
    logger.write_line(f"[start] node: {node_ver} ({node_path})")
    logger.write_line(f"[start] project: {ctx.project_slug}")
    logger.write_line(f"[start] log: {diagnostics.rel(diagnostics.ui_log_path, ctx.book_root_abs)}")
    flush_progress(running=True)

    return_code = 0
    error: str | None = None
    try:
        steps = StepRunner(ctx, logger, on_progress=lambda: flush_progress(running=True))
        steps.require_book_session()
        steps.extract_all_characters()
        logger.write_line()
        logger.write_line(f"[characters] Done. Character files are under {ctx.book_root}/characters/.")
    except Exception as exc:
        return_code = 1
        error = str(exc)
        logger.write_line(f"error: {error}")
        print(f"error: {error}", file=sys.stderr)
    finally:
        logger.close()
        flush_progress(error=error, return_code=return_code, running=False)

    return return_code

