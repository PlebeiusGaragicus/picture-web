"""App settings: Gemini key (write-only), pi diagnostics, versions, data location."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import app_config
import paths
import preflight
from version import APP_VERSION

router = APIRouter()


class SettingsCheck(BaseModel):
    name: str
    ok: bool
    detail: str
    hint: str | None = None


class SettingsInfo(BaseModel):
    appVersion: str
    libraryVersion: str | None
    homePath: str
    geminiKeyConfigured: bool
    checks: list[SettingsCheck]


class GeminiKeyUpdate(BaseModel):
    apiKey: str


@router.get("/api/settings", response_model=SettingsInfo)
def get_settings() -> SettingsInfo:
    report = preflight.preflight()
    return SettingsInfo(
        appVersion=APP_VERSION,
        libraryVersion=app_config.library_version(),
        homePath=str(app_config.CONFIG_HOME),
        geminiKeyConfigured=bool(app_config.get_value("geminiApiKey")),
        checks=[SettingsCheck(name=c.name, ok=c.ok, detail=c.detail, hint=c.hint) for c in report.checks],
    )


@router.put("/api/settings/gemini-key", response_model=SettingsInfo)
def put_gemini_key(payload: GeminiKeyUpdate) -> SettingsInfo:
    key = payload.apiKey.strip()
    if not key:
        raise HTTPException(status_code=422, detail="API key is empty")
    _validate_gemini_key(key)
    app_config.set_value("geminiApiKey", key)
    return get_settings()


def _validate_gemini_key(key: str) -> None:
    """Cheap round-trip so a typo'd key fails at save time, not at first generation."""
    from google import genai

    try:
        client = genai.Client(api_key=key)
        # Listing models is the cheapest authenticated call.
        next(iter(client.models.list()), None)
    except Exception as exc:  # genai raises provider-specific error types
        raise HTTPException(status_code=422, detail=f"Gemini rejected the key: {exc}") from exc
