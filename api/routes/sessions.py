"""Pi tasks, agent sessions, book chats, and image refinement chat routes."""

from __future__ import annotations

import json
from queue import Empty
from typing import Iterator

from fastapi import APIRouter, Header, Query
from fastapi.responses import StreamingResponse

import agent_sessions
import book_chat_sessions
import chat_sessions
import pi_runtime
from models import (
    AgentSessionDocument,
    AgentSessionPatch,
    BookChatSessionCreate,
    BookChatSessionDocument,
    BookChatSessionPatch,
    BookChatTurnRequest,
    ChatSessionCreate,
    ChatSessionDocument,
    ChatSessionPatch,
    ChatTurnRequest,
    ChatTurnResponse,
    PiTaskAbortResponse,
    PiTaskStartRequest,
    PiTaskStatus,
    PiTraceDocument,
)

router = APIRouter()

@router.post("/api/projects/{slug}/pi-tasks", response_model=PiTaskStatus, status_code=202)
def start_pi_task(slug: str, payload: PiTaskStartRequest) -> PiTaskStatus:
    return pi_runtime.MANAGER.start_task(
        slug,
        payload.profile,
        target=payload.target,
        force=payload.force,
        instructions=payload.instructions,
    ).to_status()


@router.get("/api/projects/{slug}/pi-tasks", response_model=list[PiTaskStatus])
def list_pi_tasks(
    slug: str,
    profile: str | None = Query(default=None),
    active: bool | None = Query(default=None),
) -> list[PiTaskStatus]:
    return pi_runtime.MANAGER.list_statuses(slug, profile=profile, active=active)


@router.get("/api/projects/{slug}/pi-tasks/{task_id}", response_model=PiTaskStatus)
def get_pi_task(slug: str, task_id: str) -> PiTaskStatus:
    return pi_runtime.MANAGER.get_status(slug, task_id)


@router.post("/api/projects/{slug}/pi-tasks/{task_id}/abort", response_model=PiTaskAbortResponse)
def abort_pi_task(slug: str, task_id: str) -> PiTaskAbortResponse:
    return PiTaskAbortResponse(cancelled=pi_runtime.MANAGER.abort(slug, task_id))


@router.get("/api/projects/{slug}/pi-tasks/{task_id}/events")
def stream_pi_task_events(
    slug: str,
    task_id: str,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    lastEventId: int | None = Query(default=None),
) -> StreamingResponse:
    since_seq = 0
    if last_event_id is not None:
        try:
            since_seq = int(last_event_id)
        except ValueError:
            since_seq = 0
    elif lastEventId is not None:
        since_seq = lastEventId

    handle = pi_runtime.MANAGER.get_handle(slug, task_id)
    status = pi_runtime.MANAGER.get_status(slug, task_id)  # 404s early for unknown tasks

    def sse_record(record: dict) -> str:
        return f"id: {record['seq']}\ndata: {json.dumps(record, ensure_ascii=False)}\n\n"

    def generate() -> Iterator[str]:
        if handle is None:
            # Task is not live; emit the terminal snapshot state and close.
            terminal = {
                "seq": since_seq + 1,
                "ts": status.completedAt or status.startedAt,
                "event": {"type": "task_state", "state": status.state, "error": status.error},
            }
            yield sse_record(terminal)
            return
        listener = handle.subscribe()
        try:
            last_seq = since_seq
            for record in handle.events_since(since_seq):
                last_seq = record["seq"]
                yield sse_record(record)
            while True:
                if handle.state not in pi_runtime.ACTIVE_STATES and not handle.events_since(last_seq):
                    return
                try:
                    record = listener.get(timeout=15)
                except Empty:
                    yield ": keep-alive\n\n"
                    continue
                if record["seq"] <= last_seq:
                    continue
                last_seq = record["seq"]
                yield sse_record(record)
        finally:
            handle.unsubscribe(listener)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/api/projects/{slug}/adaptation/book-chats", response_model=list[BookChatSessionDocument])
def list_book_chats(slug: str, includeArchived: bool = Query(default=False)) -> list[BookChatSessionDocument]:
    return book_chat_sessions.list_sessions(slug, include_archived=includeArchived)


@router.post("/api/projects/{slug}/adaptation/book-chats", response_model=BookChatSessionDocument)
def create_book_chat(slug: str, payload: BookChatSessionCreate = BookChatSessionCreate()) -> BookChatSessionDocument:
    return book_chat_sessions.create_session(slug, payload)


@router.get("/api/projects/{slug}/adaptation/book-chats/{session_id}", response_model=BookChatSessionDocument)
def get_book_chat(slug: str, session_id: str) -> BookChatSessionDocument:
    return book_chat_sessions.read_session(slug, session_id)


@router.patch("/api/projects/{slug}/adaptation/book-chats/{session_id}", response_model=BookChatSessionDocument)
def patch_book_chat(slug: str, session_id: str, payload: BookChatSessionPatch) -> BookChatSessionDocument:
    return book_chat_sessions.patch_session(slug, session_id, payload)


@router.post("/api/projects/{slug}/adaptation/book-chats/{session_id}/turns", response_model=BookChatSessionDocument)
def send_book_chat_turn(slug: str, session_id: str, payload: BookChatTurnRequest) -> BookChatSessionDocument:
    return book_chat_sessions.append_turn(slug, session_id, payload)


@router.get("/api/projects/{slug}/adaptation/book-chats/{session_id}/trace", response_model=PiTraceDocument)
def get_book_chat_trace(slug: str, session_id: str) -> PiTraceDocument:
    return book_chat_sessions.read_trace(slug, session_id)


@router.get("/api/projects/{slug}/agent-sessions", response_model=list[AgentSessionDocument])
def list_agent_sessions(slug: str, includeArchived: bool = Query(default=False)) -> list[AgentSessionDocument]:
    return agent_sessions.list_sessions(slug, include_archived=includeArchived)


@router.get("/api/projects/{slug}/agent-sessions/{session_id}", response_model=AgentSessionDocument)
def get_agent_session(slug: str, session_id: str) -> AgentSessionDocument:
    return agent_sessions.read_session(slug, session_id)


@router.patch("/api/projects/{slug}/agent-sessions/{session_id}", response_model=AgentSessionDocument)
def patch_agent_session(slug: str, session_id: str, payload: AgentSessionPatch) -> AgentSessionDocument:
    return agent_sessions.patch_session(slug, session_id, payload)


@router.get("/api/projects/{slug}/agent-sessions/{session_id}/trace", response_model=PiTraceDocument)
def get_agent_session_trace(slug: str, session_id: str) -> PiTraceDocument:
    return agent_sessions.read_trace(slug, session_id)


@router.get("/api/projects/{slug}/chat-sessions", response_model=list[ChatSessionDocument])
def list_chat_sessions(
    slug: str, includeArchived: bool = Query(default=False)
) -> list[ChatSessionDocument]:
    return chat_sessions.list_sessions(slug, include_archived=includeArchived)


@router.post("/api/projects/{slug}/chat-sessions", response_model=ChatSessionDocument)
def create_chat_session(slug: str, payload: ChatSessionCreate) -> ChatSessionDocument:
    return chat_sessions.create_session(slug, payload)


@router.get("/api/projects/{slug}/chat-sessions/{session_id}", response_model=ChatSessionDocument)
def get_chat_session(slug: str, session_id: str) -> ChatSessionDocument:
    return chat_sessions.read_session(slug, session_id)


@router.patch("/api/projects/{slug}/chat-sessions/{session_id}", response_model=ChatSessionDocument)
def patch_chat_session(
    slug: str, session_id: str, payload: ChatSessionPatch
) -> ChatSessionDocument:
    return chat_sessions.patch_session(slug, session_id, payload)


@router.post("/api/projects/{slug}/chat-sessions/{session_id}/turns", response_model=ChatTurnResponse)
def send_chat_turn(slug: str, session_id: str, payload: ChatTurnRequest) -> ChatTurnResponse:
    return chat_sessions.append_turn_with_gemini(slug, session_id, payload)
