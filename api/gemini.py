"""Gemini image generation boundary for photo-web."""

from __future__ import annotations

import os
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from google import genai
from google.genai import types
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[1]
LIBRARY_ROOT = REPO_ROOT / "photo-library"
logger = logging.getLogger(__name__)

DEFAULT_MODEL = "gemini-3.1-flash-image"
DEFAULT_ASPECT_RATIO = "16:9"
DEFAULT_IMAGE_SIZE = "1K"


def library_root() -> Path:
    return LIBRARY_ROOT


def load_client() -> genai.Client:
    load_dotenv(LIBRARY_ROOT / ".env")
    api_key = os.environ.get("GOOGLE_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "GOOGLE_API_KEY is not set. Add it to photo-library/.env or export it."
        )
    logger.debug("loaded Gemini client api_key_present=%s", bool(api_key))
    return genai.Client(api_key=api_key)


def default_model() -> str:
    return os.environ.get("NANO_BANANA_MODEL", DEFAULT_MODEL)


def default_aspect_ratio() -> str:
    return os.environ.get("NANO_BANANA_ASPECT_RATIO", DEFAULT_ASPECT_RATIO)


def default_image_size() -> str:
    return os.environ.get("NANO_BANANA_IMAGE_SIZE", DEFAULT_IMAGE_SIZE)


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
        return _safe_json(value.model_dump(mode="json", exclude_none=True))
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
    for part in response.parts:
        if part.inline_data is not None:
            output_png.parent.mkdir(parents=True, exist_ok=True)
            part.as_image().save(output_png)
            logger.debug("Gemini image saved output=%s", output_png)
            return GeneratedImage(
                output_png=output_png,
                provider_response=serialize_response_metadata(response, output_png),
            )
    raise RuntimeError(
        "No image in API response. The prompt may have been blocked, "
        "or the model may not support image output."
    )
