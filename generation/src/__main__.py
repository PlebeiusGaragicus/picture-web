#!/usr/bin/env python3
"""Generate images from prompt files using Google Nano Banana (Gemini image models)."""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv
from google import genai
from google.genai import types
from PIL import Image

ROOT = Path(__file__).resolve().parent
DEFAULT_MODEL = "gemini-3.1-flash-image"
DEFAULT_ASPECT_RATIO = "16:9"
DEFAULT_IMAGE_SIZE = "1K"
FRONT_MATTER_RE = re.compile(r"\A---\s*\r?\n(.*?)\r?\n---\s*\r?\n?", re.DOTALL)
TIMESTAMP_FORMAT = "%Y%m%d-%H%M%S"


@dataclass
class PromptDocument:
    body: str
    meta: dict[str, Any]
    path: Path

    @property
    def bundle_dir(self) -> Path:
        return self.path.parent


def load_client() -> genai.Client:
    load_dotenv(ROOT / ".env")
    api_key = os.environ.get("GOOGLE_API_KEY", "").strip()
    if not api_key:
        sys.exit("GOOGLE_API_KEY is not set. Add it to .env or export it.")
    return genai.Client(api_key=api_key)


def parse_prompt_file(prompt_path: Path) -> PromptDocument:
    text = prompt_path.read_text(encoding="utf-8")
    meta: dict[str, Any] = {}
    body = text.strip()

    match = FRONT_MATTER_RE.match(text)
    if match:
        loaded = yaml.safe_load(match.group(1))
        if loaded is None:
            meta = {}
        elif isinstance(loaded, dict):
            meta = loaded
        else:
            sys.exit(f"YAML front matter must be a mapping in {prompt_path}")
        body = text[match.end() :].strip()

    if not body:
        sys.exit(f"Prompt body is empty in {prompt_path}")
    return PromptDocument(body=body, meta=meta, path=prompt_path)


def meta_refs(meta: dict[str, Any]) -> list[str]:
    for key in ("refs", "references", "reference_images"):
        value = meta.get(key)
        if value is None:
            continue
        if isinstance(value, str):
            return [value]
        if isinstance(value, list) and all(isinstance(item, str) for item in value):
            return value
        sys.exit(
            f"Front matter '{key}' must be a string or list of strings, got {type(value).__name__}"
        )
    return []


def resolve_ref(path_str: str, *, bundle_dir: Path) -> Path:
    path = Path(path_str)
    if not path.is_absolute():
        candidate = bundle_dir / path
        if candidate.is_file():
            path = candidate
        else:
            path = ROOT / path_str
    if not path.is_file():
        sys.exit(f"Reference image not found: {path_str} (resolved to {path})")
    return path


def collect_reference_paths(
    doc: PromptDocument,
    *,
    extra_refs: list[str],
) -> list[Path]:
    seen: set[Path] = set()
    ordered: list[Path] = []

    for ref in meta_refs(doc.meta) + extra_refs:
        resolved = resolve_ref(ref, bundle_dir=doc.bundle_dir)
        if resolved not in seen:
            seen.add(resolved)
            ordered.append(resolved)
    return ordered


def meta_option(
    meta: dict[str, Any],
    key: str,
    cli_value: str | None,
    default: str,
    *,
    aliases: tuple[str, ...] = (),
) -> str:
    if cli_value is not None:
        return cli_value
    value = meta.get(key)
    if value is None:
        for alias in aliases:
            value = meta.get(alias)
            if value is not None:
                break
    if value is None:
        return default
    if not isinstance(value, str):
        sys.exit(f"Front matter '{key}' must be a string, got {type(value).__name__}")
    return value


def load_reference_images(ref_paths: list[Path]) -> list[Image.Image]:
    images: list[Image.Image] = []
    for path in ref_paths:
        try:
            images.append(Image.open(path))
        except OSError as exc:
            sys.exit(f"Could not open reference image {path}: {exc}")
    return images


def output_path_for(doc: PromptDocument, *, output_dir: Path | None) -> Path:
    """Write next to the prompt file unless --output-dir overrides."""
    timestamp = datetime.now(timezone.utc).strftime(TIMESTAMP_FORMAT)
    directory = doc.bundle_dir if output_dir is None else output_dir.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{doc.path.stem}-{timestamp}.png"


def save_response_image(response, out_path: Path) -> None:
    for part in response.parts:
        if part.inline_data is not None:
            part.as_image().save(out_path)
            return
    sys.exit(
        "No image in API response. The prompt may have been blocked, "
        "or the model may not support image output."
    )


def generate(
    doc: PromptDocument,
    *,
    ref_paths: list[Path],
    output_dir: Path | None,
    model: str,
    aspect_ratio: str,
    image_size: str,
) -> Path:
    client = load_client()

    contents: list = [doc.body]
    if ref_paths:
        contents.extend(load_reference_images(ref_paths))

    response = client.models.generate_content(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE"],
            image_config=types.ImageConfig(
                aspect_ratio=aspect_ratio,
                image_size=image_size,
            ),
        ),
    )

    out_path = output_path_for(doc, output_dir=output_dir)
    save_response_image(response, out_path)
    return out_path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate an image from a prompt file with YAML front matter. "
            "Reference images listed in front matter are resolved relative to the prompt file."
        )
    )
    parser.add_argument(
        "prompt",
        type=Path,
        help="Path to prompt file (e.g. prompts/farm-house/prompt.md)",
    )
    parser.add_argument(
        "--refs",
        nargs="*",
        default=[],
        metavar="IMAGE",
        help="Additional reference images (merged with front matter refs)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Override output directory (default: same directory as the prompt file)",
    )
    parser.add_argument(
        "--model",
        default=None,
        help=f"Gemini image model (default: front matter, then {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--aspect-ratio",
        default=None,
        help=f"Output aspect ratio (default: front matter, then {DEFAULT_ASPECT_RATIO})",
    )
    parser.add_argument(
        "--image-size",
        default=None,
        help=f"Output resolution tier (default: front matter, then {DEFAULT_IMAGE_SIZE})",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    prompt_path = args.prompt
    if not prompt_path.is_absolute():
        prompt_path = ROOT / prompt_path
    if not prompt_path.is_file():
        sys.exit(f"Prompt file not found: {prompt_path}")

    doc = parse_prompt_file(prompt_path)
    ref_paths = collect_reference_paths(doc, extra_refs=args.refs)

    model = meta_option(
        doc.meta,
        "model",
        args.model,
        os.environ.get("NANO_BANANA_MODEL", DEFAULT_MODEL),
    )
    aspect_ratio = meta_option(
        doc.meta,
        "aspect_ratio",
        args.aspect_ratio,
        os.environ.get("NANO_BANANA_ASPECT_RATIO", DEFAULT_ASPECT_RATIO),
    )
    image_size = meta_option(
        doc.meta,
        "image_size",
        args.image_size,
        os.environ.get("NANO_BANANA_IMAGE_SIZE", DEFAULT_IMAGE_SIZE),
        aliases=("resolution",),
    )

    out_path = generate(
        doc,
        ref_paths=ref_paths,
        output_dir=args.output_dir,
        model=model,
        aspect_ratio=aspect_ratio,
        image_size=image_size,
    )
    refs_note = f" ({len(ref_paths)} reference image(s))" if ref_paths else ""
    print(f"Wrote {out_path}{refs_note}")


if __name__ == "__main__":
    main()
