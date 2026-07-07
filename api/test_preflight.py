"""Tests for the startup preflight."""

from __future__ import annotations

import pytest

import app_config
import preflight


def test_parse_version() -> None:
    assert preflight.parse_version("0.80.3") == (0, 80, 3)
    assert preflight.parse_version("pi v1.2.3 (build 9)") == (1, 2, 3)
    assert preflight.parse_version("unknown") is None


def test_skip_env(monkeypatch) -> None:
    monkeypatch.delenv(preflight.SKIP_ENV, raising=False)
    assert not preflight.skip_pi_check()
    monkeypatch.setenv(preflight.SKIP_ENV, "1")
    assert preflight.skip_pi_check()


@pytest.fixture()
def tmp_config(tmp_path, monkeypatch):
    monkeypatch.setattr(app_config, "CONFIG_HOME", tmp_path)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    return tmp_path


def test_gemini_check_unconfigured_is_soft(tmp_config) -> None:
    check = preflight._check_gemini_key()
    assert not check.ok
    report = preflight.PreflightReport(checks=[check])
    # A missing key never hard-fails startup.
    assert report.ok


def test_gemini_check_configured(tmp_config) -> None:
    app_config.set_value("geminiApiKey", "k")
    assert preflight._check_gemini_key().ok


def test_hard_failure_when_pi_missing(monkeypatch, tmp_config) -> None:
    import pi_env

    monkeypatch.setattr(
        pi_env, "find_pi_binary", lambda: (_ for _ in ()).throw(RuntimeError("missing"))
    )
    report = preflight.preflight()
    assert any(c.name == "pi" and not c.ok for c in report.checks)
    assert not report.ok
    assert "pi" in report.render()
