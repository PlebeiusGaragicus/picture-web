"""photo-web API: library CRUD, canvas storage, image generation, and pi agent jobs."""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes import adaptation, canvas, characters, concept_art, locations, projects, sessions, story_panels

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    force=True,
)

app = FastAPI(title="photo-web", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(projects.router)
app.include_router(canvas.router)
app.include_router(adaptation.router)
app.include_router(characters.router)
app.include_router(locations.router)
app.include_router(concept_art.router)
app.include_router(sessions.router)
app.include_router(story_panels.router)
