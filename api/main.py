"""photo-web API: library CRUD, canvas storage, image generation, and pi agent jobs."""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import app_config
from routes import adaptation, canvas, characters, concept_art, locations, projects, sessions, settings, story_panels
from version import APP_VERSION

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    force=True,
)

from contextlib import asynccontextmanager


@asynccontextmanager
async def _lifespan(_: FastAPI):
    yield
    # Stop pi subprocesses on server shutdown (atexit alone is unreliable
    # under signal-driven exits). Only in packaged mode: test servers share
    # this app object and must not shut down the current global MANAGER.
    if os.environ.get("COMIC_CANVAS_MANAGED_SHUTDOWN") == "1":
        import pi_runtime

        pi_runtime.MANAGER.shutdown()


app = FastAPI(
    title="comic-canvas",
    version=APP_VERSION,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=_lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str | None]:
    return {
        "status": "ok",
        "version": APP_VERSION,
        "libraryVersion": app_config.library_version(),
    }


app.include_router(projects.router)
app.include_router(canvas.router)
app.include_router(adaptation.router)
app.include_router(characters.router)
app.include_router(locations.router)
app.include_router(concept_art.router)
app.include_router(sessions.router)
app.include_router(settings.router)
app.include_router(story_panels.router)
