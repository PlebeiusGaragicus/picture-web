"""photo-web API: library CRUD, canvas storage, and image generation."""

from __future__ import annotations

import logging

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette import status

import library
from models import (
    AssetSummary,
    CanvasDocument,
    DisplayPatch,
    GenerateRequest,
    GenerateResponse,
    ProjectCreate,
    ProjectDetail,
    ProjectMetadata,
)

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    force=True,
)
logger = logging.getLogger(__name__)

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


@app.get("/api/projects", response_model=list[ProjectMetadata])
def list_projects() -> list[ProjectMetadata]:
    return library.list_projects()


@app.post("/api/projects", response_model=ProjectMetadata)
def create_project(payload: ProjectCreate) -> ProjectMetadata:
    return library.create_project(payload)


@app.get("/api/projects/{slug}", response_model=ProjectDetail)
def get_project(slug: str) -> ProjectDetail:
    return library.get_project_detail(slug)


@app.get("/api/projects/{slug}/assets", response_model=list[AssetSummary])
def list_assets(slug: str) -> list[AssetSummary]:
    return library.list_assets(slug)


@app.get("/api/projects/{slug}/assets/{asset_id}", response_model=AssetSummary)
def get_asset(slug: str, asset_id: str) -> AssetSummary:
    return library.read_asset(slug, asset_id)


@app.patch("/api/projects/{slug}/assets/{asset_id}/display", response_model=AssetSummary)
def patch_display(slug: str, asset_id: str, payload: DisplayPatch) -> AssetSummary:
    return library.patch_display(slug, asset_id, payload)


@app.delete("/api/projects/{slug}/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(slug: str, asset_id: str) -> None:
    library.delete_asset(slug, asset_id)


@app.post("/api/projects/{slug}/assets/import", response_model=AssetSummary)
async def import_asset(
    slug: str,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
) -> AssetSummary:
    return await library.import_asset(slug, file, title=title)


@app.get("/api/projects/{slug}/canvas", response_model=CanvasDocument)
def get_canvas(slug: str) -> CanvasDocument:
    return library.read_canvas(slug)


@app.put("/api/projects/{slug}/canvas", response_model=CanvasDocument)
def put_canvas(slug: str, canvas: CanvasDocument) -> CanvasDocument:
    return library.write_canvas(slug, canvas)


@app.get("/api/projects/{slug}/assets/{asset_id}/thumb")
def get_thumb(slug: str, asset_id: str) -> FileResponse:
    return FileResponse(library.thumbnail_path(slug, asset_id))


@app.get("/api/projects/{slug}/assets/{asset_id}/image")
def get_image(slug: str, asset_id: str) -> FileResponse:
    return FileResponse(library.image_path(slug, asset_id), media_type="image/png")


@app.post("/api/projects/{slug}/generate", response_model=GenerateResponse)
def generate(slug: str, payload: GenerateRequest) -> GenerateResponse:
    import gemini

    logger.debug(
        "generate request slug=%s canvas_node=%s refs=%s model=%s aspect_ratio=%s image_size=%s seed=%s batch_count=%s prompt_chars=%s",
        slug,
        payload.canvasNodeId,
        payload.refs,
        payload.model,
        payload.aspectRatio,
        payload.imageSize,
        payload.seed,
        payload.batchCount,
        len(payload.prompt),
    )
    return library.create_generated_assets(slug, payload, gemini.generate_image)
