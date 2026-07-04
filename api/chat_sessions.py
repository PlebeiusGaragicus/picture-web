"""Persistent Gemini chat-session storage for image refinement."""

from __future__ import annotations

import base64
import logging
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from PIL import Image

from ids import new_ulid
from common import utc_now
from models import (
    AssetMetadata,
    ChatProviderState,
    ChatSessionCreate,
    ChatSessionDocument,
    ChatSessionPatch,
    ChatAttachment,
    ChatSource,
    ChatTurn,
    ChatTurnRequest,
    ChatTurnResponse,
    ChatTurnSettings,
    GenerationReceipt,
    Prompt,
    ProviderCapture,
)

logger = logging.getLogger(__name__)


def _library():
    # Import lazily to avoid a module cycle with library.py helpers.
    import library

    return library


def sessions_root(slug: str) -> Path:
    return _library().project_dir(slug) / "chat-sessions"


def session_dir(slug: str, session_id: str) -> Path:
    return sessions_root(slug) / session_id


def session_json_path(slug: str, session_id: str) -> Path:
    return session_dir(slug, session_id) / "session.json"


def blobs_dir(slug: str, session_id: str) -> Path:
    return session_dir(slug, session_id) / "blobs"


def read_session(slug: str, session_id: str) -> ChatSessionDocument:
    path = session_json_path(slug, session_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Chat session not found: {session_id}")
    return ChatSessionDocument.model_validate(_library().read_json(path))


def write_session(slug: str, session: ChatSessionDocument) -> ChatSessionDocument:
    _library().write_json(session_json_path(slug, session.id), session.model_dump(mode="json"))
    return session


def list_sessions(slug: str, include_archived: bool = False) -> list[ChatSessionDocument]:
    _library().require_project(slug)
    root = sessions_root(slug)
    if not root.is_dir():
        return []
    sessions: list[ChatSessionDocument] = []
    for path in sorted(root.glob("*/session.json")):
        session = ChatSessionDocument.model_validate(_library().read_json(path))
        if include_archived or session.archivedAt is None:
            sessions.append(session)
    return sessions


def default_settings_for_source(slug: str, source_asset_id: str) -> ChatTurnSettings:
    import gemini

    asset = _library().read_asset_metadata(slug, source_asset_id)
    generation = asset.generation
    return ChatTurnSettings(
        model=(generation.model if generation is not None else gemini.default_model()),
        aspectRatio=(
            generation.aspectRatio if generation is not None else gemini.default_aspect_ratio()
        ),
        imageSize=(generation.imageSize if generation is not None else gemini.default_image_size()),
        thinkingLevel=None,
        includeThoughts=False,
    )


def create_session(slug: str, payload: ChatSessionCreate) -> ChatSessionDocument:
    library = _library()
    library.require_project(slug)
    source = library.read_asset_metadata(slug, payload.sourceAssetId)
    session_id = new_ulid()
    now = utc_now()
    defaults = default_settings_for_source(slug, source.id)
    title = payload.title or f"Refine {source.title}"
    session = ChatSessionDocument(
        id=session_id,
        projectSlug=slug,
        title=title,
        source=ChatSource(assetId=source.id, canvasNodeId=payload.canvasNodeId),
        createdAt=now,
        updatedAt=now,
        defaults=defaults,
        protectedAssetIds=[source.id],
        provider=ChatProviderState(model=defaults.model),
    )
    return write_session(slug, session)


def patch_session(slug: str, session_id: str, payload: ChatSessionPatch) -> ChatSessionDocument:
    session = read_session(slug, session_id)
    if payload.title is not None:
        session.title = payload.title
    if payload.archived is not None:
        now = utc_now()
        session.archivedAt = now if payload.archived else None
        session.status = "archived" if payload.archived else "active"
    session.updatedAt = utc_now()
    return write_session(slug, session)


def archive_session(slug: str, session_id: str, archived: bool = True) -> ChatSessionDocument:
    return patch_session(slug, session_id, ChatSessionPatch(archived=archived))


def save_blob(
    slug: str,
    session_id: str,
    *,
    data: bytes,
    mime_type: str = "image/png",
) -> str:
    suffix = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
    }.get(mime_type, ".bin")
    blob_id = new_ulid()
    path = blobs_dir(slug, session_id) / f"{blob_id}{suffix}"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return f"blobs/{path.name}"


def read_blob(slug: str, session_id: str, data_ref: str) -> bytes:
    path = session_dir(slug, session_id) / data_ref
    if not path.is_file():
        raise HTTPException(status_code=500, detail=f"Missing chat blob: {data_ref}")
    return path.read_bytes()


def inline_part_with_ref(
    slug: str,
    session_id: str,
    *,
    data: bytes,
    mime_type: str = "image/png",
    thought_signature: str | None = None,
) -> dict[str, Any]:
    part: dict[str, Any] = {
        "inline_data": {
            "mime_type": mime_type,
            "data_ref": save_blob(slug, session_id, data=data, mime_type=mime_type),
        }
    }
    if thought_signature is not None:
        part["thought_signature"] = thought_signature
    return part


def provider_history_for_request(slug: str, session: ChatSessionDocument) -> list[dict[str, Any]]:
    """Return provider history with data refs expanded to base64 data for SDK/REST use."""
    expanded = []
    for content in session.provider.history:
        next_content = {**content, "parts": []}
        for part in content.get("parts", []):
            next_part = dict(part)
            inline_data = next_part.get("inline_data")
            if isinstance(inline_data, dict) and "data_ref" in inline_data:
                data_ref = inline_data["data_ref"]
                next_inline = dict(inline_data)
                next_inline["data"] = base64.b64encode(
                    read_blob(slug, session.id, data_ref)
                ).decode("ascii")
                del next_inline["data_ref"]
                next_part["inline_data"] = next_inline
            next_content["parts"].append(next_part)
        expanded.append(next_content)
    return expanded


def provider_history_with_blob_refs(
    slug: str, session_id: str, content: dict[str, Any]
) -> dict[str, Any]:
    next_content = {**content, "parts": []}
    for part in content.get("parts", []):
        next_part = dict(part)
        inline_data = next_part.get("inline_data") or next_part.get("inlineData")
        if isinstance(inline_data, dict) and "data" in inline_data:
            raw_data = inline_data["data"]
            if isinstance(raw_data, str):
                data = base64.b64decode(raw_data)
            elif isinstance(raw_data, (bytes, bytearray)):
                data = bytes(raw_data)
            else:
                data = b""
            mime_type = inline_data.get("mime_type") or inline_data.get("mimeType") or "image/png"
            key = "inline_data" if "inline_data" in next_part else "inlineData"
            next_inline = {
                "mime_type": mime_type,
                "data_ref": save_blob(slug, session_id, data=data, mime_type=mime_type),
            }
            next_part[key] = next_inline
        next_content["parts"].append(next_part)
    return next_content


def user_provider_content(
    slug: str,
    session: ChatSessionDocument,
    *,
    text: str,
    attachments: list[ChatAttachment],
) -> dict[str, Any]:
    parts: list[dict[str, Any]] = [{"text": text}]
    for attachment in attachments:
        asset_path = _library().asset_png_path(slug, attachment.assetId)
        if not asset_path.is_file():
            raise HTTPException(status_code=404, detail=f"Attachment pixels not found: {attachment.assetId}")
        parts.append(
            inline_part_with_ref(
                slug,
                session.id,
                data=asset_path.read_bytes(),
                mime_type="image/png",
            )
        )
    return {"role": "user", "parts": parts}


def request_parts_from_content(slug: str, session: ChatSessionDocument, content: dict[str, Any]) -> list[dict[str, Any]]:
    expanded = provider_history_for_request(
        slug,
        ChatSessionDocument(
            **{
                **session.model_dump(mode="json"),
                "provider": {
                    **session.provider.model_dump(mode="json"),
                    "history": [content],
                },
            }
        ),
    )
    return expanded[0]["parts"]


def protected_asset_ids(slug: str) -> set[str]:
    protected: set[str] = set()
    for session in list_sessions(slug, include_archived=True):
        protected.update(session.protectedAssetIds)
        protected.add(session.source.assetId)
        for turn in session.turns:
            protected.update(turn.generatedAssetIds)
            for attachment in turn.attachments:
                protected.add(attachment.assetId)
    return protected


def blocking_session_ids(slug: str, asset_id: str) -> list[str]:
    blockers: list[str] = []
    for session in list_sessions(slug, include_archived=True):
        if asset_id == session.source.assetId or asset_id in session.protectedAssetIds:
            blockers.append(session.id)
            continue
        for turn in session.turns:
            if asset_id in turn.generatedAssetIds or any(
                attachment.assetId == asset_id for attachment in turn.attachments
            ):
                blockers.append(session.id)
                break
    return blockers


def append_turn(
    slug: str,
    session_id: str,
    payload: ChatTurnRequest,
    send_one,
) -> ChatTurnResponse:
    import gemini

    library = _library()
    library.require_project(slug)
    session = read_session(slug, session_id)
    if session.archivedAt is not None:
        raise HTTPException(status_code=409, detail="Archived chat sessions cannot receive new turns")

    settings = payload.settings or session.defaults
    attachment_ids = list(dict.fromkeys([session.source.assetId, *payload.attachmentAssetIds]))
    library.validate_refs(slug, attachment_ids)
    attachments = [
        ChatAttachment(
            assetId=asset_id,
            purpose="source" if asset_id == session.source.assetId else "reference",
        )
        for asset_id in attachment_ids
    ]
    user_content = user_provider_content(
        slug,
        session,
        text=payload.text,
        attachments=attachments,
    )
    request_parts = request_parts_from_content(slug, session, user_content)
    try:
        result = send_one(
            history=provider_history_for_request(slug, session),
            message_parts=request_parts,
            model=settings.model,
            aspect_ratio=settings.aspectRatio,
            image_size=settings.imageSize,
            thinking_level=settings.thinkingLevel,
            include_thoughts=settings.includeThoughts,
        )
    except Exception as exc:
        logger.exception("chat turn provider call failed slug=%s session_id=%s", slug, session_id)
        from gemini import ImageGenerationError, http_status_for_generation_error

        if isinstance(exc, ImageGenerationError):
            raise HTTPException(
                status_code=http_status_for_generation_error(exc),
                detail=str(exc),
            ) from exc
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    user_turn_id = new_ulid()
    model_turn_id = new_ulid()
    now = utc_now()
    run_id = model_turn_id
    created_assets = []
    for index, image_part in enumerate(result.images):
        asset_id = new_ulid()
        out_png = library.asset_png_path(slug, asset_id)
        out_png.parent.mkdir(parents=True, exist_ok=True)
        Image.open(__import__("io").BytesIO(image_part.data)).save(out_png, format="PNG")
        metadata = AssetMetadata(
            id=asset_id,
            kind="generated",
            title=f"Refinement {asset_id}",
            tags=[],
            createdAt=now,
            updatedAt=now,
            prompt=Prompt(text=payload.text),
            generation=GenerationReceipt(
                refs=attachment_ids,
                runId=run_id,
                runIndex=index,
                model=settings.model,
                aspectRatio=settings.aspectRatio,
                imageSize=settings.imageSize,
                seed=None,
                chatSessionId=session.id,
                chatTurnId=model_turn_id,
            ),
            provider=ProviderCapture(
                name="google-genai",
                response={
                    "imageFile": out_png.name,
                    "response": result.provider_response,
                },
            ),
        )
        created_assets.append(library.write_asset_metadata(slug, metadata))
    if not created_assets:
        raise HTTPException(
            status_code=502,
            detail=result.text
            or "Gemini returned no image for this refinement. Try a more explicit edit instruction.",
        )

    user_turn = ChatTurn(
        id=user_turn_id,
        role="user",
        createdAt=now,
        text=payload.text,
        settings=settings,
        attachments=attachments,
        generatedAssetIds=[],
    )
    model_turn = ChatTurn(
        id=model_turn_id,
        role="model",
        createdAt=now,
        text=result.text,
        settings=settings,
        attachments=[],
        generatedAssetIds=[asset.id for asset in created_assets],
    )

    session.turns.extend([user_turn, model_turn])
    for asset_id in attachment_ids:
        if asset_id not in session.protectedAssetIds:
            session.protectedAssetIds.append(asset_id)
    for asset in created_assets:
        if asset.id not in session.protectedAssetIds:
            session.protectedAssetIds.append(asset.id)
    session.provider.history.append(user_content)
    session.provider.history.append(provider_history_with_blob_refs(slug, session.id, result.model_content))
    session.provider.model = settings.model
    session.updatedAt = now
    session = write_session(slug, session)
    if created_assets:
        library.attach_chat_assets_to_canvas(slug, session, model_turn, created_assets)
    return ChatTurnResponse(session=session, assets=created_assets)


def append_turn_with_gemini(slug: str, session_id: str, payload: ChatTurnRequest) -> ChatTurnResponse:
    import gemini

    return append_turn(slug, session_id, payload, gemini.send_chat_turn)
