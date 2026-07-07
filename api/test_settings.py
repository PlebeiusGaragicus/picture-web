"""Tests for the settings routes."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app_config
from main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(app_config, "CONFIG_HOME", tmp_path)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    return TestClient(app)


def test_get_settings_reports_state(client) -> None:
    response = client.get("/api/settings")
    assert response.status_code == 200
    body = response.json()
    assert body["appVersion"]
    assert body["geminiKeyConfigured"] is False
    assert {c["name"] for c in body["checks"]} == {"pi", "node", "gemini"}


def test_get_settings_never_echoes_key(client) -> None:
    app_config.set_value("geminiApiKey", "super-secret")
    body = client.get("/api/settings").json()
    assert body["geminiKeyConfigured"] is True
    assert "super-secret" not in body["homePath"]
    assert "apiKey" not in body and "geminiApiKey" not in body


def test_put_empty_key_rejected(client) -> None:
    response = client.put("/api/settings/gemini-key", json={"apiKey": "   "})
    assert response.status_code == 422


def test_put_key_validates_before_save(client, monkeypatch) -> None:
    from routes import settings as settings_route

    monkeypatch.setattr(settings_route, "_validate_gemini_key", lambda key: None)
    response = client.put("/api/settings/gemini-key", json={"apiKey": "valid-key"})
    assert response.status_code == 200
    assert response.json()["geminiKeyConfigured"] is True
    assert app_config.load_config()["geminiApiKey"] == "valid-key"
