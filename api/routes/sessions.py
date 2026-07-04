"""Pi agent sessions, book chats, and image refinement chat routes."""

from __future__ import annotations

from fastapi import APIRouter, Query

import agent_sessions
import book_chat_sessions
import book_session_load
import chat_sessions
from models import (
    AdaptationWorkflowStatus,
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
    PiTraceDocument,
)

router = APIRouter()

@router.get("/api/projects/{slug}/adaptation/book-session/load", response_model=AdaptationWorkflowStatus)
def get_book_session_load(slug: str) -> AdaptationWorkflowStatus:
    return book_session_load.book_session_load_status(slug)


@router.post("/api/projects/{slug}/adaptation/book-session/load", response_model=AdaptationWorkflowStatus)
def start_book_session_load(slug: str) -> AdaptationWorkflowStatus:
    return book_session_load.start_book_session_load(slug)


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


@router.post("/api/projects/{slug}/chat-sessions/{session_id}/fork", response_model=ChatSessionDocument)
def fork_chat_session(slug: str, session_id: str, sourceAssetId: str | None = None) -> ChatSessionDocument:
    return chat_sessions.fork_session(slug, session_id, source_asset_id=sourceAssetId)


@router.post("/api/projects/{slug}/chat-sessions/{session_id}/turns", response_model=ChatTurnResponse)
def send_chat_turn(slug: str, session_id: str, payload: ChatTurnRequest) -> ChatTurnResponse:
    return chat_sessions.append_turn_with_gemini(slug, session_id, payload)
