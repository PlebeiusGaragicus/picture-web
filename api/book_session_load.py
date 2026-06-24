"""Load book.txt into a fresh Pi read-book session and persist book-session.json."""

from __future__ import annotations

import sys

from fastapi import HTTPException

import adaptation
import library
from adaptation_workflow.config import AdaptationContext, ensure_node_runtime, find_pi_binary, pi_version
from adaptation_workflow.diagnostics import RunDiagnostics
from adaptation_workflow.events import WorkflowLogger
from adaptation_workflow.runner import write_summary
from adaptation_workflow.steps import StepRunner
from models import AdaptationWorkflowStatus

BOOK_SESSION_LOAD_STAGE = "book-session"


def book_session_load_status_path(slug: str):
    return adaptation.workflow_status_path(slug, BOOK_SESSION_LOAD_STAGE)


def book_session_load_log_path(slug: str):
    return adaptation.workflow_log_path(slug, BOOK_SESSION_LOAD_STAGE)


def book_session_load_launcher_log_path(slug: str):
    return adaptation.workflow_launcher_log_path(slug, BOOK_SESSION_LOAD_STAGE)


def book_session_load_status(slug: str) -> AdaptationWorkflowStatus:
    return adaptation.process_status(
        slug,
        book_session_load_status_path(slug),
        book_session_load_log_path(slug),
        validation=False,
    )


def start_book_session_load(slug: str) -> AdaptationWorkflowStatus:
    root = adaptation.ensure_adaptation(slug)
    if not (root / "book.txt").is_file():
        raise HTTPException(status_code=400, detail="Upload book.txt before loading the book session")
    return adaptation.start_logged_process(
        slug,
        log_path=book_session_load_log_path(slug),
        launcher_log_path=book_session_load_launcher_log_path(slug),
        status_path=book_session_load_status_path(slug),
        start_line=f"Starting read-book session load for {slug}",
        script_command=f"cd api && {adaptation.workflow_python()} -m book_session_load \"$SLUG\"",
        validation=False,
    )


def run_load(project_slug: str) -> int:
    try:
        ctx = AdaptationContext.for_slug(project_slug)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    diagnostics = RunDiagnostics.create(ctx.book_root_abs, BOOK_SESSION_LOAD_STAGE, validation=False)
    logger = WorkflowLogger(diagnostics)

    try:
        node_path, node_ver = ensure_node_runtime()
    except RuntimeError as exc:
        logger.write_line(f"error: {exc}")
        logger.close()
        write_summary(
            diagnostics,
            stage=BOOK_SESSION_LOAD_STAGE,
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
            stage=BOOK_SESSION_LOAD_STAGE,
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
    logger.write_line(f"[start] book: {ctx.book_path}")
    flush_progress(running=True)

    return_code = 0
    error: str | None = None
    try:
        steps = StepRunner(ctx, logger, on_progress=lambda: flush_progress(running=True))
        session = steps.load_fresh_book_session()
        logger.write_line()
        logger.write_line(f"[load] Read-book session ready for {ctx.project_slug}")
        logger.write_line(f"Session:   {session.session_id}")
        logger.write_line(f"Manifest:  {ctx.book_session_path}")
    except Exception as exc:
        return_code = 1
        error = str(exc)
        logger.write_line(f"error: {error}")
        print(f"error: {error}", file=sys.stderr)
    finally:
        flush_progress(error=error, return_code=return_code, running=False)
        logger.close()

    return return_code


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        print("Usage: python -m book_session_load <project-slug>", file=sys.stderr)
        return 2
    library.require_project(args[0])
    return run_load(args[0])


if __name__ == "__main__":
    raise SystemExit(main())
