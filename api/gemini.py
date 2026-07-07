"""Gemini image generation boundary for photo-web."""

from __future__ import annotations

import os
import logging
from io import BytesIO
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from google import genai

import app_config
import paths
from google.genai import types
from PIL import Image

LIBRARY_ROOT = paths.HOME
logger = logging.getLogger(__name__)

DEFAULT_MODEL = "gemini-3.1-flash-image"
DEFAULT_ASPECT_RATIO = "16:9"
DEFAULT_IMAGE_SIZE = "1K"


def library_root() -> Path:
    return LIBRARY_ROOT


def load_client() -> genai.Client:
    load_dotenv(LIBRARY_ROOT / ".env")
    # get_value checks the GOOGLE_API_KEY env (populated by .env above) before config.json.
    api_key = app_config.get_value("geminiApiKey") or ""
    if not api_key:
        raise RuntimeError(
            "GOOGLE_API_KEY is not set. Add it in Settings, or put it in "
            f"{LIBRARY_ROOT / '.env'}, or export it."
        )
    logger.debug("loaded Gemini client api_key_present=%s", bool(api_key))
    return genai.Client(api_key=api_key)


def default_model() -> str:
    return os.environ.get("NANO_BANANA_MODEL", DEFAULT_MODEL)


def default_aspect_ratio() -> str:
    return os.environ.get("NANO_BANANA_ASPECT_RATIO", DEFAULT_ASPECT_RATIO)


def default_image_size() -> str:
    return os.environ.get("NANO_BANANA_IMAGE_SIZE", DEFAULT_IMAGE_SIZE)


def reference_image_limit(model: str) -> int:
    """Max reference/input images per Gemini image-generation prompt for the given model."""
    normalized = model.strip().lower()
    if "2.5-flash-image" in normalized or "2-5-flash-image" in normalized:
        return 3
    if "3-pro-image" in normalized:
        # Documented cap: up to 6 object images + 5 character images.
        return 11
    return 14


class ImageGenerationError(RuntimeError):
    """Raised when Gemini does not return a usable generated image."""

    def __init__(self, message: str, *, category: str = "provider") -> None:
        super().__init__(message)
        self.category = category


def http_status_for_generation_error(exc: ImageGenerationError) -> int:
    if exc.category in {"safety", "blocked", "empty"}:
        return 422
    return 502


def _response_attr(response: Any, snake: str, camel: str | None = None) -> Any:
    if isinstance(response, dict):
        if snake in response:
            return response[snake]
        if camel is not None and camel in response:
            return response[camel]
        return None
    if hasattr(response, snake):
        return getattr(response, snake)
    if camel is not None and hasattr(response, camel):
        return getattr(response, camel)
    return None


def _first_candidate(response: Any) -> Any | None:
    candidates = _response_attr(response, "candidates", "candidates")
    if not candidates:
        return None
    if isinstance(candidates, list):
        return candidates[0] if candidates else None
    return None


def _enum_label(value: Any) -> str:
    if value is None:
        return ""
    name = getattr(value, "name", None)
    if isinstance(name, str) and name:
        return name.replace("_", " ").strip().lower()
    text = str(value).strip()
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    return text.replace("_", " ").strip().lower()


def describe_generation_failure(response: Any) -> tuple[str, str]:
    """Return (category, user-facing message) when no image was produced."""
    prompt_feedback = _response_attr(response, "prompt_feedback", "promptFeedback")
    block_reason = _response_attr(prompt_feedback, "block_reason", "blockReason") if prompt_feedback else None
    block_message = _response_attr(prompt_feedback, "block_reason_message", "blockReasonMessage") if prompt_feedback else None
    if block_reason:
        reason_label = _enum_label(block_reason)
        detail = f" Reason: {reason_label}." if reason_label else ""
        if block_message and isinstance(block_message, str) and block_message.strip():
            detail = f" {block_message.strip()}"
        return (
            "safety",
            "Image generation was blocked by Gemini content safety filters."
            " Soften explicit violence, gore, sexual content, or other restricted details in the prompt, then try again."
            f"{detail}",
        )

    candidate = _first_candidate(response)
    finish_reason = _response_attr(candidate, "finish_reason", "finishReason") if candidate else None
    finish_label = _enum_label(finish_reason)
    if finish_label and any(token in finish_label for token in ("safety", "block", "prohibit", "recitation")):
        detail = f" Finish reason: {finish_label}." if finish_label else ""
        return (
            "safety",
            "Image generation was blocked by Gemini safety filters. Try a less explicit or restrictive prompt."
            f"{detail}",
        )

    return (
        "empty",
        "Gemini returned no image for this prompt. The model may have refused the request, "
        "encountered a content limit, or failed to produce image output. Try rephrasing the prompt "
        "or reducing reference-image complexity.",
    )


def load_parent_images(parent_paths: list[Path]) -> list[Image.Image]:
    images: list[Image.Image] = []
    for path in parent_paths:
        if not path.is_file():
            raise FileNotFoundError(f"Parent image not found: {path}")
        try:
            images.append(Image.open(path))
        except OSError as exc:
            raise OSError(f"Could not open parent image {path}: {exc}") from exc
    return images


@dataclass(frozen=True)
class GeneratedImage:
    output_png: Path
    provider_response: dict[str, Any]


@dataclass(frozen=True)
class ChatImagePart:
    data: bytes
    mime_type: str = "image/png"
    thought_signature: str | None = None


@dataclass(frozen=True)
class ChatTurnResult:
    model_content: dict[str, Any]
    text: str
    images: list[ChatImagePart]
    provider_response: dict[str, Any]


def _safe_json(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return f"<bytes:{len(value)}>"
    if isinstance(value, bytearray):
        return f"<bytes:{len(value)}>"
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_safe_json(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _safe_json(item) for key, item in value.items()}
    if hasattr(value, "model_dump"):
        return _safe_json(value.model_dump(mode="python", exclude_none=True))
    if hasattr(value, "to_json_dict"):
        return _safe_json(value.to_json_dict())
    if hasattr(value, "__dict__"):
        return _safe_json(
            {
                key: item
                for key, item in vars(value).items()
                if not key.startswith("_")
            }
        )
    return str(value)


def _strip_provider_payloads(value: Any) -> Any:
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            normalized_key = key.lower()
            if normalized_key in {"thought_signature", "thoughtsignature"} and isinstance(
                item, str
            ):
                cleaned[key] = f"<thought-signature:{len(item)} chars>"
            elif normalized_key in {"data", "inline_data", "inlinedata"} and isinstance(
                item, str
            ):
                cleaned[key] = f"<inline-image-data:{len(item)} chars>"
            elif normalized_key == "data" and isinstance(item, (bytes, bytearray)):
                cleaned[key] = f"<inline-image-data:{len(item)} bytes>"
            else:
                cleaned[key] = _strip_provider_payloads(item)
        return cleaned
    if isinstance(value, list):
        return [_strip_provider_payloads(item) for item in value]
    return value


def serialize_response_metadata(response: Any, output_png: Path) -> dict[str, Any]:
    """Return JSON-safe response metadata without duplicating image bytes."""
    raw = _safe_json(response)
    return {
        "imageFile": output_png.name,
        "response": _strip_provider_payloads(raw),
    }


def _part_value(part: Any, snake: str, camel: str | None = None) -> Any:
    if isinstance(part, dict):
        if snake in part:
            return part[snake]
        if camel is not None and camel in part:
            return part[camel]
        return None
    if hasattr(part, snake):
        return getattr(part, snake)
    if camel is not None and hasattr(part, camel):
        return getattr(part, camel)
    return None


def _response_parts(response: Any) -> list[Any]:
    if isinstance(response, dict):
        candidates = response.get("candidates") or []
        content = (
            candidates[0].get("content", {})
            if candidates and isinstance(candidates[0], dict)
            else {}
        )
        parts = content.get("parts") or response.get("parts") or []
        return parts if isinstance(parts, list) else []
    parts = getattr(response, "parts", None)
    if parts is not None:
        return list(parts)
    candidates = getattr(response, "candidates", None) or []
    if candidates:
        content = getattr(candidates[0], "content", None)
        parts = getattr(content, "parts", None)
        if parts is not None:
            return list(parts)
    return []


def _response_model_content(response: Any) -> dict[str, Any]:
    if isinstance(response, dict):
        candidates = response.get("candidates") or []
        content = (
            candidates[0].get("content", {})
            if candidates and isinstance(candidates[0], dict)
            else {}
        )
        parts = content.get("parts") or response.get("parts") or []
        return {"role": content.get("role", "model"), "parts": _safe_json(parts)}

    candidates = getattr(response, "candidates", None) or []
    if candidates:
        content = getattr(candidates[0], "content", None)
        role = getattr(content, "role", "model")
    else:
        role = "model"
    return {"role": role, "parts": [_model_history_part(part) for part in _response_parts(response)]}


def _image_bytes_from_part(part: Any) -> tuple[bytes | None, str]:
    inline_data = _part_value(part, "inline_data", "inlineData")
    data, mime_type = _inline_data_bytes(inline_data)
    if data is not None:
        return data, mime_type

    as_image = getattr(part, "as_image", None)
    if callable(as_image):
        try:
            image = as_image()
        except Exception:
            image = None
        if image is not None:
            buffer = BytesIO()
            try:
                image.save(buffer, format="PNG")
            except TypeError:
                image.save(buffer)
            return buffer.getvalue(), "image/png"
    return None, "image/png"


def _model_history_part(part: Any) -> dict[str, Any]:
    import base64

    history_part = _safe_json(part)
    if not isinstance(history_part, dict):
        return {"text": str(history_part)}

    data, mime_type = _image_bytes_from_part(part)
    if data is None or not mime_type.startswith("image/"):
        return history_part

    key = "inline_data" if "inline_data" in history_part else "inlineData"
    inline_data = history_part.get(key)
    if not isinstance(inline_data, dict):
        inline_data = {}
    history_part[key] = {
        **inline_data,
        "mime_type": mime_type,
        "data": base64.b64encode(data).decode("ascii"),
    }
    return history_part


def _inline_data_bytes(inline_data: Any) -> tuple[bytes | None, str]:
    if inline_data is None:
        return None, "image/png"
    if isinstance(inline_data, dict):
        data = inline_data.get("data")
        mime_type = inline_data.get("mime_type") or inline_data.get("mimeType") or "image/png"
    else:
        data = getattr(inline_data, "data", None)
        mime_type = (
            getattr(inline_data, "mime_type", None)
            or getattr(inline_data, "mimeType", None)
            or "image/png"
        )
    if isinstance(data, str):
        import base64

        try:
            return base64.b64decode(data, validate=True), mime_type
        except ValueError:
            return None, mime_type
    if isinstance(data, (bytes, bytearray)):
        return bytes(data), mime_type
    return None, mime_type


def chat_turn_result_from_response(response: Any) -> ChatTurnResult:
    raw = _safe_json(response)
    parts = _response_parts(response)
    model_content = _response_model_content(response)

    text_parts: list[str] = []
    images: list[ChatImagePart] = []
    for part in parts:
        text = _part_value(part, "text")
        if isinstance(text, str):
            text_parts.append(text)
        data, mime_type = _image_bytes_from_part(part)
        if data is not None and mime_type.startswith("image/"):
            thought_signature = _part_value(part, "thought_signature", "thoughtSignature")
            images.append(
                ChatImagePart(
                    data=data,
                    mime_type=mime_type,
                    thought_signature=thought_signature if isinstance(thought_signature, str) else None,
                )
            )
    return ChatTurnResult(
        model_content=model_content,
        text="\n".join(text_parts).strip(),
        images=images,
        provider_response=_strip_provider_payloads(raw),
    )


def send_chat_turn(
    *,
    history: list[dict[str, Any]],
    message_parts: list[Any],
    model: str,
    aspect_ratio: str,
    image_size: str,
    thinking_level: str | None = None,
    include_thoughts: bool = False,
) -> ChatTurnResult:
    """Send one Gemini chat turn using persisted history plus new user parts."""
    client = load_client()
    contents = [*history, {"role": "user", "parts": message_parts}]
    config_kwargs: dict[str, Any] = {
        "response_modalities": ["TEXT", "IMAGE"],
        "image_config": types.ImageConfig(
            aspect_ratio=aspect_ratio,
            image_size=image_size,
        ),
    }
    if thinking_level is not None or include_thoughts:
        config_kwargs["thinking_config"] = types.ThinkingConfig(
            thinking_level=thinking_level,
            include_thoughts=include_thoughts,
        )
    response = client.models.generate_content(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(**config_kwargs),
    )
    return chat_turn_result_from_response(response)


def generate_image(
    *,
    prompt_text: str,
    parent_png_paths: list[Path],
    output_png: Path,
    seed: int,
    model: str | None = None,
    aspect_ratio: str | None = None,
    image_size: str | None = None,
) -> GeneratedImage:
    """Call Gemini with prompt text and optional parent PNGs; write output_png."""
    client = load_client()

    contents: list = [prompt_text]
    if parent_png_paths:
        contents.extend(load_parent_images(parent_png_paths))

    resolved_model = model or default_model()
    resolved_aspect_ratio = aspect_ratio or default_aspect_ratio()
    resolved_image_size = image_size or default_image_size()
    logger.debug(
        "Gemini generate_content model=%s aspect_ratio=%s image_size=%s seed=%s parent_count=%s prompt_chars=%s output=%s",
        resolved_model,
        resolved_aspect_ratio,
        resolved_image_size,
        seed,
        len(parent_png_paths),
        len(prompt_text),
        output_png,
    )
    response = client.models.generate_content(
        model=resolved_model,
        contents=contents,
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE"],
            seed=seed,
            image_config=types.ImageConfig(
                aspect_ratio=resolved_aspect_ratio,
                image_size=resolved_image_size,
            ),
        ),
    )
    for part in _response_parts(response):
        data, mime_type = _image_bytes_from_part(part)
        if data is not None and mime_type.startswith("image/"):
            output_png.parent.mkdir(parents=True, exist_ok=True)
            Image.open(BytesIO(data)).save(output_png, format="PNG")
            logger.debug("Gemini image saved output=%s", output_png)
            return GeneratedImage(
                output_png=output_png,
                provider_response=serialize_response_metadata(response, output_png),
            )
    category, message = describe_generation_failure(response)
    logger.warning("Gemini returned no image category=%s model=%s output=%s", category, resolved_model, output_png)
    raise ImageGenerationError(message, category=category)
