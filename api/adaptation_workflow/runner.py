"""Workflow and validation orchestration."""

from __future__ import annotations

import json
import sys

from adaptation_workflow.config import (
    WORKFLOW_STAGES,
    AdaptationContext,
    ensure_node_runtime,
    find_pi_binary,
    node_version,
    pi_version,
    utc_now,
)
from adaptation_workflow.diagnostics import RunDiagnostics
from adaptation_workflow.events import WorkflowLogger
from adaptation_workflow.steps import StepRunner
from adaptation_workflow.validate import run_validation


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


RUN_WORKFLOW_STAGES = ("ingest", "characters", "scene-list", "all")


def run_workflow(project_slug: str, stage: str) -> int:
    if stage not in RUN_WORKFLOW_STAGES:
        print(f"error: Unknown workflow stage: {stage}", file=sys.stderr)
        return 2

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
            extra={
                "project": ctx.project_slug,
                "returnCode": return_code,
                "running": running,
                "error": error,
            },
        )

    logger.write_line(f"[start] pi: {pi_binary} ({pi_version(pi_binary)})")
    logger.write_line(f"[start] node: {node_ver} ({node_path})")
    logger.write_line(f"[start] project: {ctx.project_slug}")
    logger.write_line(f"[start] stage: {stage}")
    logger.write_line(f"[start] log: {diagnostics.rel(diagnostics.ui_log_path, ctx.book_root_abs)}")
    logger.write_line(f"[start] manifest: {diagnostics.rel(diagnostics.manifest_path, ctx.book_root_abs)}")
    flush_progress(running=True)

    return_code = 0
    error: str | None = None
    try:
        steps = StepRunner(ctx, logger, on_progress=lambda: flush_progress(running=True))
        if stage in {"ingest", "all"}:
            steps.ensure_book_session()
            steps.step_archetype_prompts()
            if stage == "ingest":
                logger.write_line()
                logger.write_line(f"[ingest] Book session and archetype prompts ready for {ctx.project_slug}")
                logger.write_line(f"Session:   {steps.book_session.session_id if steps.book_session else ''}")
        if stage in {"characters", "all"}:
            steps.require_book_session()
            steps.stage_characters()
            if stage == "characters":
                logger.write_line()
                logger.write_line(f"[characters] Done. Character sheets are under {ctx.book_root}/characters/sheets.")
        if stage in {"scene-list", "all"}:
            steps.require_book_session()
            steps.step_scene_list()
            if stage == "scene-list":
                logger.write_line()
                logger.write_line(f"[scene-list] Done. Scene list is at {ctx.book_root}/scenes/list.txt.")
        if stage == "all":
            logger.write_line()
            logger.write_line(f"Book root: {ctx.book_root}")
            logger.write_line(f"Project:   {ctx.project_slug}")
            if steps.book_session:
                logger.write_line(f"Session:   {steps.book_session.session_id}")
            logger.write_line()
            logger.write_line(f"Done. Current outputs are under {ctx.book_root}.")
    except Exception as exc:
        return_code = 1
        error = str(exc)
        logger.write_line(f"error: {error}")
        print(f"error: {error}", file=sys.stderr)
    finally:
        logger.close()
        flush_progress(error=error, return_code=return_code, running=False)

    return return_code


def scene_extract_stage(scene_slug: str) -> str:
    return f"scene-extract-{scene_slug}"


def run_extract_scene(project_slug: str, scene_slug: str) -> int:
    stage = scene_extract_stage(scene_slug)
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
        diagnostics.write_manifest(ctx.book_root_abs, extra={"project": ctx.project_slug, "sceneSlug": scene_slug, "error": str(exc)})
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
                "sceneSlug": scene_slug,
                "returnCode": return_code,
                "running": running,
                "error": error,
            },
        )

    logger.write_line(f"[start] pi: {pi_binary} ({pi_version(pi_binary)})")
    logger.write_line(f"[start] node: {node_ver} ({node_path})")
    logger.write_line(f"[start] project: {ctx.project_slug}")
    logger.write_line(f"[start] scene: {scene_slug}")
    logger.write_line(f"[start] log: {diagnostics.rel(diagnostics.ui_log_path, ctx.book_root_abs)}")
    flush_progress(running=True)

    return_code = 0
    error: str | None = None
    try:
        steps = StepRunner(ctx, logger, on_progress=lambda: flush_progress(running=True))
        steps.require_book_session()
        steps.extract_scene(scene_slug)
        logger.write_line()
        logger.write_line(f"[scenes] Done. Scene artifact and locations updated for {scene_slug}.")
    except Exception as exc:
        return_code = 1
        error = str(exc)
        logger.write_line(f"error: {error}")
        print(f"error: {error}", file=sys.stderr)
    finally:
        logger.close()
        flush_progress(error=error, return_code=return_code, running=False)

    return return_code


def run_validate(project_slug: str, stage: str) -> int:
    if stage not in WORKFLOW_STAGES:
        print(f"error: Unknown validation stage: {stage}", file=sys.stderr)
        return 2

    try:
        ctx = AdaptationContext.for_slug(project_slug)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    diagnostics = RunDiagnostics.create(ctx.book_root_abs, stage, validation=True)
    logger = WorkflowLogger(diagnostics)
    pi_binary = find_pi_binary()
    report = run_validation(ctx.book_root_abs, stage)
    for message in report.passes:
        logger.write_line(f"OK:   {message}")
    for message in report.failures:
        logger.write_line(f"FAIL: {message}")
    logger.write_line()
    if report.success:
        logger.write_line("Validation passed.")
        return_code = 0
        error = None
    else:
        logger.write_line(f"Validation failed with {len(report.failures)} issue(s).")
        return_code = 1
        error = f"{len(report.failures)} validation failures"
    logger.close()
    write_summary(
        diagnostics,
        stage=stage,
        return_code=return_code,
        tasks=[],
        pi_binary=pi_binary,
        error=error,
        running=False,
    )
    diagnostics.write_manifest(
        ctx.book_root_abs,
        extra={"project": ctx.project_slug, "returnCode": return_code, "running": False, "error": error},
    )
    return return_code
