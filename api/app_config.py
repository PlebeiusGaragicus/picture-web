"""comic-canvas config.json + meta.json in the home dir.

config.json (chmod 600): geminiApiKey, authToken, port, piBinary.
Env vars override file values (GOOGLE_API_KEY, COMIC_CANVAS_TOKEN, API_PORT).
meta.json records the app version that last opened the library (warn-only,
no migrations pre-1.0).
"""

from __future__ import annotations

import json
import logging
import os
import secrets
from pathlib import Path

import paths
from version import APP_VERSION

logger = logging.getLogger(__name__)

# Patchable in tests so settings routes never touch the real home dir.
CONFIG_HOME = paths.HOME

_ENV_OVERRIDES = {
    "geminiApiKey": "GOOGLE_API_KEY",
    "authToken": "COMIC_CANVAS_TOKEN",
    "port": "API_PORT",
}


def config_path() -> Path:
    return CONFIG_HOME / "config.json"


def meta_path() -> Path:
    return CONFIG_HOME / "meta.json"


def load_config() -> dict:
    path = config_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        logger.warning("unreadable config.json at %s; treating as empty", path)
        return {}
    return data if isinstance(data, dict) else {}


def save_config(config: dict) -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2) + "\n")
    path.chmod(0o600)


def get_value(key: str) -> str | None:
    env_name = _ENV_OVERRIDES.get(key)
    if env_name:
        env_value = os.environ.get(env_name, "").strip()
        if env_value:
            return env_value
    value = load_config().get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, int):
        return str(value)
    if env_name:
        # Legacy <home>/.env (gemini.load_client still load_dotenv()s it).
        try:
            from dotenv import dotenv_values

            dotenv_value = (dotenv_values(CONFIG_HOME / ".env").get(env_name) or "").strip()
        except OSError:
            dotenv_value = ""
        if dotenv_value:
            return dotenv_value
    return None


def set_value(key: str, value: str | None) -> None:
    config = load_config()
    if value is None:
        config.pop(key, None)
    else:
        config[key] = value
    save_config(config)


def ensure_auth_token() -> str:
    """Per-install token; created on first packaged launch."""
    token = get_value("authToken")
    if token:
        return token
    token = secrets.token_urlsafe(32)
    set_value("authToken", token)
    return token


def stamp_library() -> str | None:
    """Record APP_VERSION in meta.json; return the previous version if different."""
    path = meta_path()
    previous: str | None = None
    if path.is_file():
        try:
            previous = json.loads(path.read_text()).get("appVersion")
        except (OSError, json.JSONDecodeError):
            previous = None
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"appVersion": APP_VERSION}, indent=2) + "\n")
    if previous and previous != APP_VERSION:
        logger.warning(
            "library at %s was last used with v%s; this is v%s — pre-1.0 schemas may have changed",
            CONFIG_HOME,
            previous,
            APP_VERSION,
        )
        return previous
    return None


def library_version() -> str | None:
    path = meta_path()
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text()).get("appVersion")
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, str) else None
