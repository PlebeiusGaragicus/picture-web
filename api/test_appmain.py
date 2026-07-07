"""Tests for packaged-mode plumbing: token auth middleware, port picking, config."""

from __future__ import annotations

import socket

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app_config
import appmain

TOKEN = "test-token-123"


def make_client() -> TestClient:
    app = FastAPI()

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/secret")
    def secret():
        return {"ok": True}

    @app.get("/")
    def index():
        return {"page": "index"}

    appmain.install_token_auth(app, TOKEN)
    return TestClient(app, base_url="http://127.0.0.1")


def test_api_requires_token() -> None:
    client = make_client()
    assert client.get("/api/secret").status_code == 401


def test_api_health_is_exempt() -> None:
    client = make_client()
    assert client.get("/api/health").status_code == 200


def test_bearer_token_accepted() -> None:
    client = make_client()
    response = client.get("/api/secret", headers={"Authorization": f"Bearer {TOKEN}"})
    assert response.status_code == 200


def test_query_token_accepted() -> None:
    client = make_client()
    assert client.get(f"/api/secret?token={TOKEN}").status_code == 200


def test_cookie_token_accepted() -> None:
    client = make_client()
    client.cookies.set(appmain.COOKIE_NAME, TOKEN)
    assert client.get("/api/secret").status_code == 200


def test_wrong_token_rejected() -> None:
    client = make_client()
    response = client.get("/api/secret", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401


def test_root_token_bootstrap_sets_cookie() -> None:
    client = make_client()
    response = client.get(f"/?token={TOKEN}", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == "/"
    assert appmain.COOKIE_NAME in response.headers.get("set-cookie", "")
    # The cookie now authorizes API calls.
    assert client.get("/api/secret").status_code == 200


def test_root_bad_token_rejected() -> None:
    client = make_client()
    assert client.get("/?token=wrong", follow_redirects=False).status_code == 403


def test_non_loopback_host_rejected() -> None:
    client = make_client()
    response = client.get("/api/health", headers={"Host": "evil.example.com"})
    assert response.status_code == 403


def test_cross_origin_rejected() -> None:
    client = make_client()
    response = client.get(
        f"/api/secret?token={TOKEN}", headers={"Origin": "https://evil.example.com"}
    )
    assert response.status_code == 403


def test_loopback_origin_allowed() -> None:
    client = make_client()
    response = client.get(
        f"/api/secret?token={TOKEN}", headers={"Origin": "http://127.0.0.1:8787"}
    )
    assert response.status_code == 200


def test_pick_port_skips_taken_port() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        taken = sock.getsockname()[1]
        picked = appmain.pick_port(taken)
        assert picked != taken
        assert picked > taken


@pytest.fixture()
def tmp_config(tmp_path, monkeypatch):
    monkeypatch.setattr(app_config, "CONFIG_HOME", tmp_path)
    return tmp_path


def test_config_chmod_600(tmp_config) -> None:
    app_config.set_value("geminiApiKey", "abc")
    mode = app_config.config_path().stat().st_mode & 0o777
    assert mode == 0o600
    assert app_config.get_value("geminiApiKey") == "abc"


def test_config_env_override(tmp_config, monkeypatch) -> None:
    app_config.set_value("geminiApiKey", "from-file")
    monkeypatch.setenv("GOOGLE_API_KEY", "from-env")
    assert app_config.get_value("geminiApiKey") == "from-env"


def test_ensure_auth_token_persists(tmp_config, monkeypatch) -> None:
    monkeypatch.delenv("COMIC_CANVAS_TOKEN", raising=False)
    token = app_config.ensure_auth_token()
    assert token
    assert app_config.ensure_auth_token() == token


def test_stamp_library_reports_version_change(tmp_config) -> None:
    assert app_config.stamp_library() is None
    app_config.meta_path().write_text('{"appVersion": "0.0.1"}\n')
    assert app_config.stamp_library() == "0.0.1"
    assert app_config.library_version() == app_config.APP_VERSION
