"""Path resolution and adaptation workspace configuration."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_DIR = REPO_ROOT / ".pi" / "skills"
LIBRARY_ROOT = REPO_ROOT / "photo-library"

WORKFLOW_STAGES = ("ingest", "characters", "all")
STYLE_TEMPLATE = "Style:\nColor palette:\nRealism:\nLighting:\n"
NODE22_BIN_CANDIDATES = (
    Path("/opt/homebrew/opt/node@22/bin"),
    Path("/usr/local/opt/node@22/bin"),
)
MIN_NODE_MAJOR = 22


@dataclass(frozen=True)
class BookSession:
    session_file: str
    session_id: str
    created_at: str
    book_path: str

    @classmethod
    def load(cls, path: Path) -> BookSession | None:
        if not path.is_file():
            return None
        data = json.loads(path.read_text())
        session_id = data.get("sessionId")
        session_file = data.get("sessionFile")
        if not session_id or not session_file:
            return None
        return cls(
            session_file=str(session_file),
            session_id=str(session_id),
            created_at=str(data.get("createdAt", "")),
            book_path=str(data.get("bookPath", "")),
        )

    def write(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "sessionFile": self.session_file,
                    "sessionId": self.session_id,
                    "createdAt": self.created_at,
                    "bookPath": self.book_path,
                },
                indent=2,
            )
            + "\n"
        )


@dataclass
class AdaptationContext:
    repo_root: Path
    project_slug: str
    book_root: Path
    book_root_abs: Path
    pi_workspace: Path
    pi_session_dir: Path
    skills_dir: Path
    book_session_path: Path
    book_path: Path

    @classmethod
    def for_slug(cls, project_slug: str) -> AdaptationContext:
        slug = project_slug.strip().strip("/")
        if slug.startswith("books/"):
            book_root = REPO_ROOT / slug
            project_slug = Path(slug).name.lower()
            project_slug = slugify_path_segment(project_slug)
        elif slug.startswith("photo-library/projects/") and slug.endswith("/adaptation"):
            book_root = REPO_ROOT / slug
            project_slug = slug.removeprefix("photo-library/projects/").removesuffix("/adaptation")
        else:
            book_root = LIBRARY_ROOT / "projects" / slug / "adaptation"
            project_path = LIBRARY_ROOT / "projects" / slug / "project.json"
            if not project_path.is_file():
                raise FileNotFoundError(f"Project not found: {slug}")

        book_root_abs = book_root.resolve()
        sessions = book_root_abs / "sessions"
        pi_workspace = sessions / "pi-workspace"
        pi_session_dir = sessions / "pi"
        pi_workspace.mkdir(parents=True, exist_ok=True)
        pi_session_dir.mkdir(parents=True, exist_ok=True)
        ensure_adaptation_dirs(book_root_abs)

        if not SKILLS_DIR.is_dir():
            raise FileNotFoundError(f"Missing Pi skills directory: {SKILLS_DIR}")

        book_path = book_root_abs / "book.txt"
        if not book_path.is_file():
            raise FileNotFoundError(f"Missing book.txt: {book_path}")

        return cls(
            repo_root=REPO_ROOT,
            project_slug=project_slug,
            book_root=book_root,
            book_root_abs=book_root_abs,
            pi_workspace=pi_workspace,
            pi_session_dir=pi_session_dir,
            skills_dir=SKILLS_DIR,
            book_session_path=sessions / "book-session.json",
            book_path=book_path,
        )


def slugify_path_segment(value: str) -> str:
    import re

    lowered = value.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered)
    return slug.strip("-")


def ensure_adaptation_dirs(book_root: Path) -> None:
    for relative in [
        "sessions",
        "style-refs",
        "characters/artifacts",
        "characters/sheets",
        "acts",
        "scenes/artifacts",
        "pages/plans",
        "panels/prompts",
        "locations/prompts",
    ]:
        (book_root / relative).mkdir(parents=True, exist_ok=True)
    visual_style = book_root / "style-refs" / "visual-style.md"
    if not visual_style.exists():
        visual_style.write_text(STYLE_TEMPLATE)
    metadata = book_root / "adaptation.json"
    if not metadata.exists():
        metadata.write_text(json.dumps({"version": 2, "settings": {"storyKind": "comic-book"}}, indent=2) + "\n")


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def find_pi_binary() -> str:
    pi = shutil.which("pi", path=pi_runtime_env().get("PATH"))
    if not pi:
        pi = shutil.which("pi")
    if not pi:
        raise RuntimeError("Missing required command: pi (install Pi coding agent and ensure it is on PATH)")
    return pi


def pi_runtime_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """Environment for Pi subprocesses, preferring Homebrew node@22 on PATH."""
    env = dict(os.environ if base is None else base)
    for candidate in NODE22_BIN_CANDIDATES:
        if (candidate / "node").is_file():
            env["PATH"] = f"{candidate}{os.pathsep}{env.get('PATH', '')}"
            break
    return env


def resolve_node_path(env: dict[str, str] | None = None) -> str | None:
    runtime_env = pi_runtime_env() if env is None else env
    return shutil.which("node", path=runtime_env.get("PATH"))


def node_major(version: str) -> int:
    major_str = version.lstrip("v").split(".", 1)[0]
    try:
        return int(major_str)
    except ValueError:
        return 0


def ensure_node_runtime() -> tuple[str, str]:
    """Return (node_path, version). Raises RuntimeError when Node 22+ is unavailable."""
    env = pi_runtime_env()
    node = resolve_node_path(env)
    if not node:
        raise RuntimeError(
            "Pi requires Node 22+, but node was not found. "
            "Install Node 22 (e.g. brew install node@22) and ensure "
            "/opt/homebrew/opt/node@22/bin is available."
        )
    try:
        version = subprocess.check_output([node, "--version"], text=True, env=env).strip()
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"Could not run node at {node}") from exc
    if node_major(version) < MIN_NODE_MAJOR:
        raise RuntimeError(
            f"Pi requires Node {MIN_NODE_MAJOR}+, but found {version} at {node}. "
            "Pi fails on older Node with 'Invalid regular expression flags' (/v). "
            "Install Node 22: brew install node@22"
        )
    return node, version


def node_version() -> str:
    node = resolve_node_path(pi_runtime_env())
    if not node:
        return "missing"
    try:
        return subprocess.check_output([node, "--version"], text=True, env=pi_runtime_env()).strip()
    except subprocess.CalledProcessError:
        return "unknown"


def pi_version(pi_binary: str) -> str:
    try:
        return subprocess.check_output(
            [pi_binary, "--version"],
            text=True,
            stderr=subprocess.STDOUT,
            env=pi_runtime_env(),
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"
