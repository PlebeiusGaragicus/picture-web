"""Startup preflight: verify the system pi agent, Node runtime, and Gemini key.

comic-canvas deliberately uses the *system* pi (the user's own models and
credentials). `preflight()` reports on every dependency; the CLI refuses to
start when pi/node are unusable unless COMIC_CANVAS_SKIP_PI_CHECK=1 is set.
"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass, field

import app_config
import pi_env

# Verified against the pi this release was developed/tested with.
MIN_PI_VERSION = (0, 80, 0)

SKIP_ENV = "COMIC_CANVAS_SKIP_PI_CHECK"


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    hint: str | None = None


@dataclass
class PreflightReport:
    checks: list[Check] = field(default_factory=list)

    @property
    def hard_failures(self) -> list[Check]:
        return [c for c in self.checks if not c.ok and c.name in ("pi", "node")]

    @property
    def ok(self) -> bool:
        return not self.hard_failures

    def render(self) -> str:
        lines = []
        for check in self.checks:
            mark = "ok" if check.ok else "MISSING"
            lines.append(f"  [{mark:>7}] {check.name}: {check.detail}")
            if not check.ok and check.hint:
                lines.append(f"            -> {check.hint}")
        return "\n".join(lines)


def parse_version(raw: str) -> tuple[int, ...] | None:
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", raw)
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def skip_pi_check() -> bool:
    return os.environ.get(SKIP_ENV, "").strip() in ("1", "true", "yes")


def _check_pi() -> Check:
    override = app_config.get_value("piBinary")
    try:
        binary = override or pi_env.find_pi_binary()
    except RuntimeError:
        return Check(
            name="pi",
            ok=False,
            detail="pi binary not found on PATH",
            hint="Install the pi coding agent (comic-canvas drives your own pi models/config): https://github.com/badlogic/pi-mono",
        )
    raw = pi_env.pi_version(binary)
    version = parse_version(raw)
    if version is None:
        return Check(name="pi", ok=False, detail=f"{binary} did not report a version ({raw!r})",
                     hint="Reinstall pi or set piBinary in config.json to a working binary")
    if version < MIN_PI_VERSION:
        wanted = ".".join(map(str, MIN_PI_VERSION))
        return Check(name="pi", ok=False, detail=f"{binary} is v{raw}, need >= {wanted}",
                     hint="Upgrade pi (npm install -g @earendil-works/pi-coding-agent or brew upgrade pi)")
    return Check(name="pi", ok=True, detail=f"{binary} (v{raw})")


def _check_node() -> Check:
    try:
        node, version = pi_env.ensure_node_runtime()
    except RuntimeError as exc:
        return Check(name="node", ok=False, detail=str(exc),
                     hint="Install Node 22+ (e.g. brew install node@22) — pi requires it")
    return Check(name="node", ok=True, detail=f"{node} ({version})")


def _check_gemini_key() -> Check:
    configured = bool(app_config.get_value("geminiApiKey"))
    if configured:
        return Check(name="gemini", ok=True, detail="GOOGLE_API_KEY configured")
    return Check(
        name="gemini",
        ok=False,
        detail="no Gemini API key configured (image generation disabled)",
        hint="Open Settings in the app and paste a Google AI Studio key",
    )


def preflight() -> PreflightReport:
    return PreflightReport(checks=[_check_pi(), _check_node(), _check_gemini_key()])


def rpc_handshake_probe(timeout_s: float = 20.0) -> Check:
    """Doctor-only: spawn `pi --mode rpc` and confirm it starts and exits cleanly."""
    override = app_config.get_value("piBinary")
    try:
        binary = override or pi_env.find_pi_binary()
    except RuntimeError as exc:
        return Check(name="pi-rpc", ok=False, detail=str(exc))
    try:
        proc = subprocess.Popen(
            [binary, "--mode", "rpc"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=pi_env.pi_runtime_env(),
        )
    except OSError as exc:
        return Check(name="pi-rpc", ok=False, detail=f"could not spawn pi: {exc}")
    try:
        # A live RPC process stays up waiting for commands; an immediate exit
        # (bad node, crash) is the failure signal.
        try:
            proc.wait(timeout=3.0)
            stderr = (proc.stderr.read() or "").strip() if proc.stderr else ""
            return Check(name="pi-rpc", ok=False,
                         detail=f"pi --mode rpc exited immediately (rc={proc.returncode}) {stderr[:200]}")
        except subprocess.TimeoutExpired:
            return Check(name="pi-rpc", ok=True, detail="pi --mode rpc starts and stays up")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            proc.kill()
