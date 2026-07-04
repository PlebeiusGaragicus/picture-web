"""Persistent Pi agent-session registry and trace access.

Book chats are bridged into this registry ON PURPOSE under the same id:
a stored session with kind "book-chat" is hydrated from the book-chat
store, and book chats without a stored session are listed virtually.
All ids are ULIDs; create_session refuses to overwrite an existing id so
the two stores can never silently shadow each other.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import HTTPException

import adaptation
import library
from adaptation_workflow.config import AdaptationContext
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
    if session_id is not None and kind != "book-chat" and _read_stored_session(slug, session_id) is not None:
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


def _session_from_book_chat(slug: str, chat: Any) -> AgentSessionDocument:
    source = {"type": "book-chat", "bookChatSessionId": chat.id}
    status: AgentSessionStatus = "archived" if chat.archivedAt is not None else "succeeded"
    return AgentSessionDocument(
        id=chat.id,
        projectSlug=chat.projectSlug,
        title=chat.title,
        kind="book-chat",
        status=status,
        createdAt=chat.createdAt,
        updatedAt=chat.updatedAt,
        completedAt=chat.updatedAt if chat.turns else None,
        archivedAt=chat.archivedAt,
        piSessionId=chat.piSessionId,
        piSessionFile=chat.piSessionFile,
        parentSessionId=chat.forkRootSessionId,
        source=source,
        stats={"messageCount": len(chat.turns)},
    )


def _hydrate_book_chat_session(slug: str, session: AgentSessionDocument) -> AgentSessionDocument:
    if session.kind != "book-chat":
        return session
    import book_chat_sessions

    try:
        chat = book_chat_sessions.read_session(slug, session.id)
    except HTTPException:
        return session
    bridged = _session_from_book_chat(slug, chat)
    return bridged.model_copy(
        update={
            "source": {**session.source, **bridged.source},
            "logFiles": session.logFiles,
            "error": session.error,
        }
    )


def _book_chat_sessions(slug: str, include_archived: bool) -> list[AgentSessionDocument]:
    import book_chat_sessions

    bridged: list[AgentSessionDocument] = []
    try:
        chats = book_chat_sessions.list_sessions(slug, include_archived=include_archived)
    except HTTPException:
        return bridged
    for chat in chats:
        if _read_stored_session(slug, chat.id) is None:
            bridged.append(_session_from_book_chat(slug, chat))
    return bridged


def list_sessions(slug: str, include_archived: bool = False) -> list[AgentSessionDocument]:
    root = _root(slug)
    sessions: list[AgentSessionDocument] = []
    if root.is_dir():
        for path in sorted(root.glob("*/session.json")):
            session = AgentSessionDocument.model_validate(library.read_json(path))
            session = _hydrate_book_chat_session(slug, session)
            if include_archived or session.archivedAt is None:
                sessions.append(session)
    sessions.extend(_book_chat_sessions(slug, include_archived))
    return sorted(sessions, key=lambda session: session.updatedAt, reverse=True)


def read_session(slug: str, session_id: str) -> AgentSessionDocument:
    session = _read_stored_session(slug, session_id)
    if session is not None:
        return _hydrate_book_chat_session(slug, session)
    for bridged in _book_chat_sessions(slug, include_archived=True):
        if bridged.id == session_id:
            return bridged
    raise HTTPException(status_code=404, detail=f"Agent session not found: {session_id}")


def patch_session(slug: str, session_id: str, payload: AgentSessionPatch) -> AgentSessionDocument:
    session = _read_stored_session(slug, session_id)
    if session is None:
        source = read_session(slug, session_id)
        if source.kind == "book-chat" and payload.archived is not None:
            import book_chat_sessions
            from models import BookChatSessionPatch

            patched = book_chat_sessions.patch_session(
                slug,
                session_id,
                BookChatSessionPatch(title=payload.title, archived=payload.archived),
            )
            return _session_from_book_chat(slug, patched)
        raise HTTPException(status_code=404, detail=f"Agent session not found: {session_id}")
    if session.kind == "book-chat" and (payload.archived is not None or payload.title is not None):
        import book_chat_sessions
        from models import BookChatSessionPatch

        patched = book_chat_sessions.patch_session(
            slug,
            session_id,
            BookChatSessionPatch(title=payload.title, archived=payload.archived),
        )
        hydrated = _session_from_book_chat(slug, patched).model_copy(
            update={"logFiles": session.logFiles, "error": session.error}
        )
        write_session(slug, hydrated)
        return hydrated
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
