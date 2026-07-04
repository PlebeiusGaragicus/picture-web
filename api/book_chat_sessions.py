"""Pi-backed book chat sessions forked from the read-book adaptation session."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import HTTPException

import library
from adaptation_workflow.config import AdaptationContext, BookSession
from common import utc_now
from adaptation_workflow.events import project_event
from adaptation_workflow.pi_rpc import PiRpcClient, PiRpcError
from ids import new_ulid
from models import (
    BookChatSessionCreate,
    BookChatSessionDocument,
    BookChatSessionPatch,
    BookChatTurn,
    BookChatTurnRequest,
    PiTraceDocument,
)
from pi_session_trace import parse_session_file, resolve_session_path

logger = logging.getLogger(__name__)


def _ctx(slug: str) -> AdaptationContext:
    try:
        return AdaptationContext.for_slug(slug)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _book_session(ctx: AdaptationContext) -> BookSession:
    session = BookSession.load(ctx.book_session_path)
    if session is None:
        raise HTTPException(status_code=409, detail="No read-book session yet. Load the book from Chat first.")
    if not Path(session.session_file).is_file():
        raise HTTPException(status_code=409, detail="The read-book Pi session file is missing. Rebuild the book session.")
    return session


def _sessions_root(ctx: AdaptationContext) -> Path:
    return ctx.book_root_abs / "sessions" / "book-chats"


def _session_path(ctx: AdaptationContext, session_id: str) -> Path:
    return _sessions_root(ctx) / session_id / "session.json"


def read_session(slug: str, session_id: str) -> BookChatSessionDocument:
    ctx = _ctx(slug)
    path = _session_path(ctx, session_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Book chat session not found: {session_id}")
    return BookChatSessionDocument.model_validate(library.read_json(path))


def write_session(slug: str, session: BookChatSessionDocument) -> BookChatSessionDocument:
    ctx = _ctx(slug)
    library.write_json(_session_path(ctx, session.id), session.model_dump(mode="json"))
    return session


def list_sessions(slug: str, include_archived: bool = False) -> list[BookChatSessionDocument]:
    ctx = _ctx(slug)
    root = _sessions_root(ctx)
    if not root.is_dir():
        return []
    sessions: list[BookChatSessionDocument] = []
    for path in sorted(root.glob("*/session.json")):
        session = BookChatSessionDocument.model_validate(library.read_json(path))
        if include_archived or session.archivedAt is None:
            sessions.append(session)
    return sessions


def create_session(slug: str, payload: BookChatSessionCreate) -> BookChatSessionDocument:
    ctx = _ctx(slug)
    root_session = _book_session(ctx)
    now = utc_now()
    session = BookChatSessionDocument(
        id=new_ulid(),
        projectSlug=ctx.project_slug,
        title=payload.title or "Book chat",
        createdAt=now,
        updatedAt=now,
        forkRootSessionId=root_session.session_id,
        piSessionId=None,
    )
    saved = write_session(slug, session)
    import agent_sessions

    agent_sessions.create_session(
        slug,
        kind="book-chat",
        title=saved.title,
        session_id=saved.id,
        status="succeeded",
        parent_session_id=saved.forkRootSessionId,
        source={"type": "book-chat", "bookChatSessionId": saved.id},
    )
    return saved


def _validate_pi_session_file(ctx: AdaptationContext, session_file: str | None) -> str | None:
    if not session_file:
        return None
    path = Path(session_file).resolve()
    pi_root = ctx.pi_session_dir.resolve()
    if not path.is_file() or (path != pi_root and pi_root not in path.parents):
        raise HTTPException(status_code=409, detail="Pi session file is outside the project session directory.")
    return str(path)


def read_trace(slug: str, session_id: str) -> PiTraceDocument:
    ctx = _ctx(slug)
    session = read_session(slug, session_id)
    if not session.turns:
        return PiTraceDocument()
    session_path = resolve_session_path(
        pi_session_dir=ctx.pi_session_dir,
        pi_session_file=session.piSessionFile,
        pi_session_id=session.piSessionId,
    )
    if session_path is None:
        raise HTTPException(
            status_code=409,
            detail="Pi session file for this chat is missing. Send a new message or create a new chat.",
        )
    return parse_session_file(session_path)


def patch_session(slug: str, session_id: str, payload: BookChatSessionPatch) -> BookChatSessionDocument:
    session = read_session(slug, session_id)
    if payload.title is not None:
        session.title = payload.title
    if payload.archived is not None:
        now = utc_now()
        session.archivedAt = now if payload.archived else None
        session.status = "archived" if payload.archived else "active"
    session.updatedAt = utc_now()
    saved = write_session(slug, session)
    import agent_sessions

    agent_sessions.update_session(
        slug,
        saved.id,
        title=saved.title,
        status="archived" if saved.archivedAt is not None else "succeeded",
        completed=saved.archivedAt is not None,
    )
    return saved


def _assistant_text(events: list[dict]) -> str:
    text_parts = [event.get("text", "") for event in events if event.get("type") == "assistant_text"]
    return "\n\n".join(part for part in text_parts if part).strip()


def append_turn(slug: str, session_id: str, payload: BookChatTurnRequest) -> BookChatSessionDocument:
    ctx = _ctx(slug)
    root_session = _book_session(ctx)
    session = read_session(slug, session_id)
    if session.archivedAt is not None:
        raise HTTPException(status_code=409, detail="Archived book chat sessions cannot receive new turns")
    if session.forkRootSessionId != root_session.session_id:
        raise HTTPException(status_code=409, detail="This chat was forked from an older book session. Create a new chat.")

    now = utc_now()
    user_turn = BookChatTurn(
        id=new_ulid(),
        role="user",
        createdAt=now,
        text=payload.text,
    )
    session.turns.append(user_turn)
    session.updatedAt = now
    session = write_session(slug, session)
    import agent_sessions

    agent_sessions.update_session(
        slug,
        session.id,
        status="running",
        title=session.title,
        source={"type": "book-chat", "bookChatSessionId": session.id},
    )

    events: list[dict] = []

    def on_event(event: dict) -> None:
        projected = project_event(event)
        if projected is not None:
            events.append(projected)

    fork_session_id = session.piSessionId or session.forkRootSessionId
    try:
        result = PiRpcClient(ctx).run_task(
            prompt=payload.text,
            task_name=f"book chat {session.id}",
            fork_session_id=fork_session_id,
            on_event=on_event,
            on_stderr=lambda line: events.append({"type": "stderr", "text": line}),
        )
    except PiRpcError as exc:
        logger.exception("Pi book chat turn failed slug=%s session_id=%s", slug, session_id)
        assistant_turn = BookChatTurn(
            id=new_ulid(),
            role="assistant",
            createdAt=utc_now(),
            text="",
            events=events,
            error=str(exc),
        )
        session.turns.append(assistant_turn)
        session.updatedAt = assistant_turn.createdAt
        write_session(slug, session)
        agent_sessions.update_session(
            slug,
            session.id,
            status="failed",
            error=str(exc),
            completed=True,
        )
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    assistant_turn = BookChatTurn(
        id=new_ulid(),
        role="assistant",
        createdAt=utc_now(),
        text=_assistant_text(events),
        piSessionId=result.session_id,
        events=events,
    )
    session.piSessionId = result.session_id or session.piSessionId
    session.piSessionFile = _validate_pi_session_file(ctx, result.session_file)
    if len(session.turns) == 1 and session.title.startswith("Book chat"):
        session.title = clip_user_title(payload.text)
    session.turns.append(assistant_turn)
    session.updatedAt = assistant_turn.createdAt
    saved = write_session(slug, session)
    agent_sessions.update_session(
        slug,
        saved.id,
        status="succeeded",
        title=saved.title,
        pi_session_id=saved.piSessionId,
        pi_session_file=saved.piSessionFile,
        parent_session_id=saved.forkRootSessionId,
        source={"type": "book-chat", "bookChatSessionId": saved.id},
        completed=True,
    )
    return saved


def clip_user_title(text: str, limit: int = 72) -> str:
    cleaned = " ".join(text.split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1].rstrip() + "…"
