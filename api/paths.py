"""Path resolution: the comic-canvas home dir and bundled (repo or frozen) resources."""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def bundle_root() -> Path:
    """Root under which read-only app resources live.

    Frozen (PyInstaller onedir): the _internal dir, where `datas` land with
    repo-identical relative paths. Dev: the repo checkout.
    """
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return REPO_ROOT


def resource_path(*parts: str) -> Path:
    return bundle_root().joinpath(*parts)


def default_home() -> Path:
    env = os.environ.get("COMIC_CANVAS_HOME") or os.environ.get("PHOTO_WEB_LIBRARY_ROOT")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".comic-canvas"


# User data (read-write). Modules keep their own patchable constants derived
# from HOME; see library.py / pi_env.py / gemini.py.
HOME = default_home()

# App resources (read-only, ship inside the frozen bundle with these paths).
SEED_DEFAULTS_DIR = resource_path("prompts", "seed-defaults")
PI_SKILLS_DIR = resource_path(".pi", "skills")
PI_EXTENSION_PATH = resource_path(".pi", "extensions", "photo-web.ts")
PROMPT_GUIDES_DIR = resource_path("api", "prompt_guides")
WEB_DIST_DIR = resource_path("webui", "dist")


def projects_root(home: Path | None = None) -> Path:
    return (home or HOME) / "projects"


def run_dir(home: Path | None = None) -> Path:
    return (home or HOME) / "run"


def logs_dir(home: Path | None = None) -> Path:
    return (home or HOME) / "logs"
