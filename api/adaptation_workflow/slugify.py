"""Character name slugification matching scripts/comic-adaptation/run."""

from __future__ import annotations

import re


def slugify_name(name: str) -> str:
    lowered = name.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered)
    return slug.strip("-")

