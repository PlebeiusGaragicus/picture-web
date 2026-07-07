"""Packaged single-process entrypoint plumbing.

Takes the dev FastAPI app from `main` and adds what the installed app needs:
static serving of the built web UI, cookie-based token auth (only when a
token is configured), rotating file logs, a free-port picker, a
single-instance lock, and a programmatic uvicorn runner whose shutdown also
stops running pi subprocesses.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import secrets
import socket
import threading
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request
from starlette.responses import PlainTextResponse, RedirectResponse

import app_config
import paths

logger = logging.getLogger(__name__)

COOKIE_NAME = "comic_canvas_token"
LOOPBACK_HOSTNAMES = {"127.0.0.1", "localhost", "::1", "[::1]"}
PORT_SCAN_RANGE = 20


# ---------------------------------------------------------------------------
# App assembly


def _hostname(netloc_or_host: str) -> str:
    host = netloc_or_host.rsplit(":", 1)[0] if not netloc_or_host.startswith("[") else netloc_or_host.split("]")[0] + "]"
    return host.lower()


def _token_supplied(request: Request, token: str) -> bool:
    candidates = [request.cookies.get(COOKIE_NAME)]
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        candidates.append(auth[7:].strip())
    candidates.append(request.query_params.get("token"))
    return any(c and secrets.compare_digest(c, token) for c in candidates)


def install_token_auth(app: FastAPI, token: str) -> None:
    """Loopback-only + token guard for /api; `/?token=` bootstraps a cookie."""

    @app.middleware("http")
    async def token_auth(request: Request, call_next):
        host = _hostname(request.headers.get("host", ""))
        if host not in LOOPBACK_HOSTNAMES:
            return PlainTextResponse("comic-canvas only serves loopback hosts", status_code=403)
        origin = request.headers.get("origin")
        if origin and origin != "null":
            origin_host = (urlsplit(origin).hostname or "").lower()
            if origin_host not in LOOPBACK_HOSTNAMES:
                return PlainTextResponse("cross-origin requests are not allowed", status_code=403)

        if request.url.path == "/" and "token" in request.query_params:
            if secrets.compare_digest(request.query_params["token"], token):
                response = RedirectResponse("/", status_code=302)
                response.set_cookie(COOKIE_NAME, token, httponly=True, samesite="strict")
                return response
            return PlainTextResponse("invalid token", status_code=403)

        path = request.url.path
        if path.startswith("/api") and path != "/api/health" and not _token_supplied(request, token):
            return PlainTextResponse("missing or invalid token", status_code=401)
        return await call_next(request)


def mount_web_ui(app: FastAPI, dist_dir: Path | None = None) -> bool:
    dist = dist_dir or paths.WEB_DIST_DIR
    if not (dist / "index.html").is_file():
        logger.warning("web UI build not found at %s; serving API only", dist)
        return False
    app.mount("/", StaticFiles(directory=dist, html=True), name="ui")
    return True


def build_app(token: str | None) -> FastAPI:
    """The dev app + packaged-mode middleware/static wiring.

    (Pi-subprocess shutdown is handled by the app lifespan in main.py.)
    """
    import main

    app = main.app
    if token:
        install_token_auth(app, token)
    mount_web_ui(app)
    return app


# ---------------------------------------------------------------------------
# Runtime plumbing (port, lock, logging, server)


def configure_file_logging(verbose: bool = False) -> Path:
    logs = paths.logs_dir()
    logs.mkdir(parents=True, exist_ok=True)
    log_path = logs / "comic-canvas.log"
    handler = logging.handlers.RotatingFileHandler(log_path, maxBytes=5_000_000, backupCount=3)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    return log_path


def pick_port(preferred: int) -> int:
    for candidate in range(preferred, preferred + PORT_SCAN_RANGE + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", candidate))
            except OSError:
                continue
            return candidate
    raise RuntimeError(f"No free port in {preferred}..{preferred + PORT_SCAN_RANGE}")


def _lock_path() -> Path:
    return paths.run_dir() / "lock.json"


def _port_path() -> Path:
    return paths.run_dir() / "port"


def read_live_instance() -> dict | None:
    """Return {pid, startTime, port} of a live instance, else None."""
    from pi_runtime import process_start_time

    path = _lock_path()
    if not path.is_file():
        return None
    try:
        info = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    pid, start = info.get("pid"), info.get("startTime")
    if not isinstance(pid, int) or not start:
        return None
    if process_start_time(pid) != start:
        return None
    return info


def write_lock(port: int) -> None:
    import os

    from pi_runtime import process_start_time

    run = paths.run_dir()
    run.mkdir(parents=True, exist_ok=True)
    _lock_path().write_text(
        json.dumps({"pid": os.getpid(), "startTime": process_start_time(os.getpid()), "port": port}, indent=2) + "\n"
    )
    _port_path().write_text(f"{port}\n")


def release_lock() -> None:
    import os

    try:
        info = json.loads(_lock_path().read_text())
        if info.get("pid") == os.getpid():
            _lock_path().unlink()
    except (OSError, json.JSONDecodeError):
        pass


def app_url(port: int, token: str | None) -> str:
    base = f"http://127.0.0.1:{port}/"
    return f"{base}?token={token}" if token else base


def _open_browser_when_ready(port: int, token: str | None) -> None:
    import webbrowser

    def poll() -> None:
        health = f"http://127.0.0.1:{port}/api/health"
        for _ in range(100):
            try:
                with urllib.request.urlopen(health, timeout=0.5):
                    break
            except OSError:
                threading.Event().wait(0.2)
        webbrowser.open(app_url(port, token))

    threading.Thread(target=poll, daemon=True).start()


def run_server(port: int, token: str | None, open_browser: bool, verbose: bool = False) -> None:
    """Run uvicorn in the foreground until interrupted."""
    import os

    # pi_runtime._api_origin reads API_PORT so extension callbacks hit us.
    os.environ["API_PORT"] = str(port)
    # Lets the shared app lifespan stop pi subprocesses on shutdown.
    os.environ["COMIC_CANVAS_MANAGED_SHUTDOWN"] = "1"
    app_config.stamp_library()
    app = build_app(token)
    write_lock(port)
    if open_browser:
        _open_browser_when_ready(port, token)
    try:
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            workers=1,
            log_level="debug" if verbose else "info",
            access_log=verbose,
        )
        uvicorn.Server(config).run()
    finally:
        release_lock()
