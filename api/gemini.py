"""Nano Banana (Gemini) image generation for photo-library assets."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[1]
LIBRARY_ROOT = REPO_ROOT / "photo-library"

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


def save_response_image(response, out_path: Path) -> None:
    for part in response.parts:
        if part.inline_data is not None:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            part.as_image().save(out_path)
            return
    raise RuntimeError(
        "No image in API response. The prompt may have been blocked, "
        "or the model may not support image output."
    )


def generate_image(
    *,
    prompt_text: str,
    parent_png_paths: list[Path],
    output_png: Path,
    model: str | None = None,
    aspect_ratio: str | None = None,
    image_size: str | None = None,
) -> Path:
    """Call Gemini with prompt text and optional parent PNGs; write output_png."""
    client = load_client()

    contents: list = [prompt_text]
    if parent_png_paths:
        contents.extend(load_parent_images(parent_png_paths))

    response = client.models.generate_content(
        model=model or default_model(),
        contents=contents,
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE"],
            image_config=types.ImageConfig(
                aspect_ratio=aspect_ratio or default_aspect_ratio(),
                image_size=image_size or default_image_size(),
            ),
        ),
    )
    save_response_image(response, output_png)
    return output_png
