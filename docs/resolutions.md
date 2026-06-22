# Image resolution and aspect ratio

> **Deprecated.** This document is outdated and no longer maintained. See [`AGENTS.md`](../AGENTS.md) and the application source for current behavior.

This project uses Google’s **Nano Banana** image models (Gemini native image generation) via the [Gemini API](https://ai.google.dev/gemini-api/docs/image-generation). Output size is controlled with two fields on `ImageConfig`, not with raw pixel width×height.

## How sizing works

You do **not** request values like `1920×1080`. You choose:

1. **`aspect_ratio`** — shape of the frame (e.g. `16:9` for a wide panel).
2. **`image_size`** — resolution **tier** (`1K`, `2K`, `4K`, and on one model `512`).

The tier sets the **longer side** of the image (for non-square ratios). For example, `image_size: "4K"` with `aspect_ratio: "16:9"` yields roughly **4096×2304** pixels, not a fixed 4K broadcast size.

If you omit `image_size`, the API defaults to **`1K`**.

### API / SDK (Python)

```python
from google.genai import types

config=types.GenerateContentConfig(
    response_modalities=["IMAGE"],
    image_config=types.ImageConfig(
        aspect_ratio="16:9",
        image_size="2K",  # uppercase K required
    ),
)
```

In per-asset library JSON (`generation.aspectRatio`, `generation.imageSize` on `{id}.json`), use the same string values. The API passes them through `api/gemini.py` → `ImageConfig`.

**Important:** Use uppercase `K` (`"2K"`, not `"2k"`). The half-tier on Gemini 3.1 Flash is the string `"512"` (not `"0.5K"`).

---

## Resolution tiers (`image_size`)

| Value | Typical long edge (1:1) | Role |
|-------|-------------------------|------|
| `512` | ~512 px | Smallest / fastest; **Gemini 3.1 Flash Image only** |
| `1K` | ~1024 px | Default; good for drafts and web |
| `2K` | ~2048 px | Sharper panels and reference sheets |
| `4K` | ~4096 px | Maximum detail; higher cost and latency |

Approximate sizes for **16:9** (long side = tier):

| `image_size` | Approximate pixels |
|--------------|-------------------|
| `512` | ~512×288 |
| `1K` | ~1024×576 |
| `2K` | ~2048×1152 |
| `4K` | ~4096×2304 |

Exact output dimensions can vary slightly by model and safety processing. Always inspect the saved PNG if pixel-perfect size matters.

---

## The three Nano Banana models

| Nickname | Model ID | Best for |
|----------|----------|----------|
| **Nano Banana** | `gemini-2.5-flash-image` | Fast, cheap, high-volume drafts |
| **Nano Banana 2** | `gemini-3.1-flash-image` | Speed + newer features (extra ratios, `512`, more refs) |
| **Nano Banana Pro** | `gemini-3-pro-image` | Complex prompts, text in images, highest fidelity |

Set the model in prompt front matter (`model:`) or `NANO_BANANA_MODEL` in `.env`.

---

### `gemini-2.5-flash-image` (Nano Banana)

**Aspect ratios** (10):

`1:1` · `3:2` · `2:3` · `3:4` · `4:3` · `4:5` · `5:4` · `9:16` · `16:9` · `21:9`

**Resolution (`image_size`):**

- Google’s [2.5 Flash Image model card](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-image) documents **aspect ratios** and per-image token use; it does **not** list `1K` / `2K` / `4K` tiers separately.
- The shared Gemini API `ImageConfig` still accepts `image_size` values `1K`, `2K`, `4K`. In practice, treat **2.5 Flash** as optimized for **standard (~1K) output** unless you have verified higher tiers on your account.
- Does **not** support `512`.
- Does **not** support the ultra-wide ratios (`1:4`, `4:1`, `1:8`, `8:1`).

**Other limits:** up to **3** input images per prompt (vs 14 on Gemini 3 image models).

---

### `gemini-3.1-flash-image` (Nano Banana 2)

**Aspect ratios** (14):

`1:1` · `1:4` · `1:8` · `2:3` · `3:2` · `3:4` · `4:1` · `4:3` · `4:5` · `5:4` · `8:1` · `9:16` · `16:9` · `21:9`

(Also listed on Cloud docs as `9:21` in some tables; prefer the values above from the [image generation guide](https://ai.google.dev/gemini-api/docs/image-generation).)

**Resolution (`image_size`):**

`512` · `1K` · `2K` · `4K`

This is the **only** Nano Banana model with **`512`** (0.5K). It is the right default when you want quick iterations or thumbnails before a final `2K`/`4K` pass on Pro.

**Other:** up to **14** reference images; optional [Google Search grounding for images](https://ai.google.dev/gemini-api/docs/image-generation); video-to-image (video + text → image) on this model only.

Cloud reference: [Gemini 3.1 Flash Image](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-image).

---

### `gemini-3-pro-image` (Nano Banana Pro)

**Aspect ratios** (10):

`1:1` · `3:2` · `2:3` · `3:4` · `4:3` · `4:5` · `5:4` · `9:16` · `16:9` · `21:9`

**Resolution (`image_size`):**

`1K` · `2K` · `4K`

No `512`. **2K** and **4K** are the usual choices for character sheets, comic panels with legible text, and print-oriented assets. Pro is aimed at “professional asset production” and complex instruction following.

Cloud reference: [Gemini 3 Pro Image](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-pro-image).

---

## Quick comparison

| | 2.5 Flash | 3.1 Flash | 3 Pro |
|---|-----------|-----------|-------|
| **Model ID** | `gemini-2.5-flash-image` | `gemini-3.1-flash-image` | `gemini-3-pro-image` |
| **`512` tier** | No | Yes | No |
| **`1K` / `2K` / `4K`** | API accepts; model tuned for ~1K | Yes | Yes |
| **Aspect ratios** | 10 | 14 (+ ultra-wide) | 10 |
| **Max input images** | 3 | 14 | 14 |
| **Character ref slots (of 14)** | — | up to 4 | up to 5 |
| **Object ref slots (of 14)** | — | up to 10 | up to 6 |

---

## Choosing settings for this repo

| Goal | Suggested model | `aspect_ratio` | `image_size` |
|------|-----------------|----------------|--------------|
| Quick scene / layout try | `gemini-2.5-flash-image` | `16:9` or `4:3` | `1K` (default) |
| Character reference sheet | `gemini-3-pro-image` | `16:9` or `3:4` | `2K` or `4K` |
| Comic panel with refs | `gemini-3.1-flash-image` or Pro | `4:3` or `16:9` | `2K` |
| Vertical social / phone | any | `9:16` | `1K`–`2K` |
| Ultra-wide banner | `gemini-3.1-flash-image` only | `21:9`, `8:1`, or `4:1` | `2K` |
| Cheap iteration | `gemini-3.1-flash-image` | as needed | `512` |

For `tom-character/` style sheets, **Pro at `2K` or `4K`** usually beats Flash at `1K` for facial detail you will reuse in later panels.

---

## Related `ImageConfig` options

| Field | Values | Notes |
|-------|--------|--------|
| `person_generation` | `ALLOW_ALL`, `ALLOW_ADULT`, `ALLOW_NONE` | Useful when generating people (e.g. character sheets) |

Fields like `output_mime_type` are **not** supported on the Gemini API consumer endpoint (per SDK docs).

---

## Caveats

1. **Not pixel-exact** — Tiers are nominal; always check the file you saved.
2. **Model vs parameter** — Sending `image_size: "4K"` to a model or endpoint that ignores it may still return ~1K output without a hard error. If size matters, confirm on your model and endpoint (Gemini API vs Vertex).
3. **Cost** — Higher tiers and Pro cost more output tokens; see [pricing](https://ai.google.dev/pricing).
4. **This repo** — `api/gemini.py` passes both `aspect_ratio` and `image_size` from asset metadata (with env defaults in `photo-library/.env`).

---

## Official links

- [Image generation (Gemini API)](https://ai.google.dev/gemini-api/docs/image-generation)
- [ImageConfig in the Python SDK](https://googleapis.github.io/python-genai/) (`google.genai.types.ImageConfig`)
- [2.5 Flash Image](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-image)
- [3.1 Flash Image](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-image)
- [3 Pro Image](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-pro-image)
