"""Persistent Pi agent-session registry and trace access."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import HTTPException

import adaptation
import library
from pi_env import AdaptationContext
from common import utc_now
from ids import new_ulid
from models import (
    AgentSessionDocument,
    AgentSessionKind,
    AgentSessionPatch,
    AgentSessionStatus,
    PiTraceDocument,
)
from pi_session_trace import parse_session_file, resolve_session_path


def _root(slug: str) -> Path:
    return adaptation.ensure_adaptation(slug) / "sessions" / "agent-sessions"


def _session_path(slug: str, session_id: str) -> Path:
    return _root(slug) / session_id / "session.json"


def _ctx(slug: str) -> AdaptationContext:
    try:
        return AdaptationContext.for_slug(slug)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _read_stored_session(slug: str, session_id: str) -> AgentSessionDocument | None:
    path = _session_path(slug, session_id)
    if not path.is_file():
        return None
    return AgentSessionDocument.model_validate(library.read_json(path))


def write_session(slug: str, session: AgentSessionDocument) -> AgentSessionDocument:
    library.write_json(_session_path(slug, session.id), session.model_dump(mode="json"))
    return session


def create_session(
    slug: str,
    *,
    kind: AgentSessionKind,
    title: str,
    session_id: str | None = None,
    status: AgentSessionStatus = "running",
    source: dict[str, Any] | None = None,
    parent_session_id: str | None = None,
    log_files: dict[str, str] | None = None,
) -> AgentSessionDocument:
    root = adaptation.ensure_adaptation(slug)
    if session_id is not None and _read_stored_session(slug, session_id) is not None:
        raise HTTPException(status_code=409, detail=f"Agent session id already exists: {session_id}")
    now = utc_now()
    session = AgentSessionDocument(
        id=session_id or new_ulid(),
        projectSlug=slug,
        title=title,
        kind=kind,
        status=status,
        createdAt=now,
        updatedAt=now,
        parentSessionId=parent_session_id,
        source=dict(source or {}),
        logFiles=dict(log_files or {}),
    )
    # Normalize slugs the same way the adaptation context does when possible.
    try:
        session.projectSlug = AdaptationContext.for_slug(slug).project_slug
    except FileNotFoundError:
        session.projectSlug = root.parent.name if root.name == "adaptation" else slug
    return write_session(slug, session)


def update_session(
    slug: str,
    session_id: str | None,
    *,
    status: AgentSessionStatus | None = None,
    title: str | None = None,
    pi_session_id: str | None = None,
    pi_session_file: str | None = None,
    parent_session_id: str | None = None,
    source: dict[str, Any] | None = None,
    log_files: dict[str, str] | None = None,
    error: str | None = None,
    stats: dict[str, Any] | None = None,
    completed: bool = False,
) -> AgentSessionDocument | None:
    if not session_id:
        return None
    session = _read_stored_session(slug, session_id)
    if session is None:
        return None
    if status is not None:
        session.status = status
    if title is not None:
        session.title = title
    if pi_session_id is not None:
        session.piSessionId = pi_session_id
    if pi_session_file is not None:
        session.piSessionFile = pi_session_file
    if parent_session_id is not None:
        session.parentSessionId = parent_session_id
    if source is not None:
        session.source = {**session.source, **source}
    if log_files is not None:
        session.logFiles = {**session.logFiles, **log_files}
    if error is not None:
        session.error = error
    if stats is not None:
        session.stats = stats
    if completed or status in {"succeeded", "failed"}:
        session.completedAt = utc_now()
    session.updatedAt = utc_now()
    return write_session(slug, session)


def list_sessions(slug: str, include_archived: bool = False) -> list[AgentSessionDocument]:
    root = _root(slug)
    sessions: list[AgentSessionDocument] = []
    if root.is_dir():
        for path in sorted(root.glob("*/session.json")):
            session = AgentSessionDocument.model_validate(library.read_json(path))
            if include_archived or session.archivedAt is None:
                sessions.append(session)
    return sorted(sessions, key=lambda session: session.updatedAt, reverse=True)


def read_session(slug: str, session_id: str) -> AgentSessionDocument:
    session = _read_stored_session(slug, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Agent session not found: {session_id}")
    return session


def patch_session(slug: str, session_id: str, payload: AgentSessionPatch) -> AgentSessionDocument:
    session = _read_stored_session(slug, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Agent session not found: {session_id}")
    if payload.title is not None:
        session.title = payload.title
    if payload.archived is not None:
        now = utc_now()
        if payload.archived:
            session.archivedAt = now
            session.status = "archived"
        else:
            session.archivedAt = None
            session.status = "succeeded" if session.completedAt else "running"
    session.updatedAt = utc_now()
    return write_session(slug, session)


def read_trace(slug: str, session_id: str) -> PiTraceDocument:
    session = read_session(slug, session_id)
    if not session.piSessionId and not session.piSessionFile:
        return PiTraceDocument()
    ctx = _ctx(slug)
    session_path = resolve_session_path(
        pi_session_dir=ctx.pi_session_dir,
        pi_session_file=session.piSessionFile,
        pi_session_id=session.piSessionId,
    )
    if session_path is None:
        raise HTTPException(status_code=409, detail="Pi session file for this agent session is missing.")
    return parse_session_file(session_path)
