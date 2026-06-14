"""photo-web API: library CRUD, canvas storage, and image generation."""

from __future__ import annotations

import logging

from fastapi import FastAPI, File, Form, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette import status

import adaptation
import library
import chat_sessions
from models import (
    ArchivePatch,
    AdaptationCanvasImportResponse,
    AdaptationFileCreate,
    AdaptationFileDocument,
    AdaptationFileKind,
    AdaptationFileUpdate,
    AssetSummary,
    CanvasDocument,
    ChatSessionCreate,
    ChatSessionDocument,
    ChatSessionPatch,
    ChatTurnRequest,
    ChatTurnResponse,
    AdaptationGenerateArtifactRequest,
    AdaptationGenerateStyleRefRequest,
    AdaptationGenerateResponse,
    AdaptationSettingsPatch,
    AdaptationStatus,
    AdaptationStyleRefAssetRequest,
    AdaptationStylePatch,
    AdaptationStylePromptPatch,
    AdaptationWorkflowStartRequest,
    AdaptationWorkflowStatus,
    DisplayPatch,
    GenerateRequest,
    GenerateResponse,
    ProjectCreate,
    ProjectCoverPatch,
    ProjectDetail,
    ProjectMetadata,
    TagDefinition,
    TagRegistryDocument,
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
def get_project(slug: str, includeArchived: bool = Query(default=False)) -> ProjectDetail:
    if includeArchived:
        return ProjectDetail(project=library.get_project(slug), assets=library.list_assets(slug, include_archived=True), tags=library.list_project_tags(slug))
    return library.get_project_detail(slug)


@app.patch("/api/projects/{slug}", response_model=ProjectMetadata)
def patch_project(slug: str, payload: ProjectCoverPatch) -> ProjectMetadata:
    return library.patch_project_cover(slug, payload.coverAssetId)


@app.get("/api/projects/{slug}/tags", response_model=list[TagDefinition])
def list_tags(slug: str) -> list[TagDefinition]:
    return library.list_project_tags(slug)


@app.put("/api/projects/{slug}/tags", response_model=TagRegistryDocument)
def put_tags(slug: str, payload: TagRegistryDocument) -> TagRegistryDocument:
    return library.write_tag_registry(slug, payload)


@app.delete("/api/projects/{slug}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(slug: str) -> None:
    library.delete_project(slug)


@app.get("/api/projects/{slug}/assets", response_model=list[AssetSummary])
def list_assets(slug: str, includeArchived: bool = Query(default=False)) -> list[AssetSummary]:
    return library.list_assets(slug, include_archived=includeArchived)


@app.get("/api/projects/{slug}/assets/{asset_id}", response_model=AssetSummary)
def get_asset(slug: str, asset_id: str) -> AssetSummary:
    return library.read_asset(slug, asset_id)


@app.patch("/api/projects/{slug}/assets/{asset_id}/display", response_model=AssetSummary)
def patch_display(slug: str, asset_id: str, payload: DisplayPatch) -> AssetSummary:
    return library.patch_display(slug, asset_id, payload)


@app.patch("/api/projects/{slug}/assets/{asset_id}/archive", response_model=AssetSummary)
def patch_archive(slug: str, asset_id: str, payload: ArchivePatch) -> AssetSummary:
    return library.patch_archive(slug, asset_id, payload)


@app.delete("/api/projects/{slug}/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(slug: str, asset_id: str) -> None:
    library.delete_asset(slug, asset_id)


@app.post("/api/projects/{slug}/assets/import", response_model=AssetSummary)
async def import_asset(
    slug: str,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    canvasX: float | None = Form(default=None),
    canvasY: float | None = Form(default=None),
) -> AssetSummary:
    return await library.import_asset(slug, file, title=title, canvas_x=canvasX, canvas_y=canvasY)


@app.get("/api/projects/{slug}/canvas", response_model=CanvasDocument)
def get_canvas(slug: str, includeArchived: bool = Query(default=False)) -> CanvasDocument:
    return library.read_canvas(slug, include_archived=includeArchived)


@app.put("/api/projects/{slug}/canvas", response_model=CanvasDocument)
def put_canvas(slug: str, canvas: CanvasDocument) -> CanvasDocument:
    return library.write_canvas(slug, canvas)


@app.get("/api/projects/{slug}/adaptation", response_model=AdaptationStatus)
def get_adaptation(slug: str) -> AdaptationStatus:
    return adaptation.status(slug)


@app.put("/api/projects/{slug}/adaptation/style", response_model=AdaptationStatus)
def put_adaptation_style(slug: str, payload: AdaptationStylePatch) -> AdaptationStatus:
    return adaptation.write_visual_style(slug, payload.visualStyle)


@app.put("/api/projects/{slug}/adaptation/style-ref-prompt", response_model=AdaptationStatus)
def put_adaptation_style_ref_prompt(slug: str, payload: AdaptationStylePromptPatch) -> AdaptationStatus:
    return adaptation.write_style_ref_prompt(slug, payload)


@app.patch("/api/projects/{slug}/adaptation/settings", response_model=AdaptationStatus)
def patch_adaptation_settings(slug: str, payload: AdaptationSettingsPatch) -> AdaptationStatus:
    return adaptation.write_settings(slug, payload)


@app.get("/api/projects/{slug}/adaptation/files/{kind}", response_model=list[AdaptationFileDocument])
def list_adaptation_files(slug: str, kind: AdaptationFileKind) -> list[AdaptationFileDocument]:
    return adaptation.list_adaptation_files(slug, kind)


@app.post("/api/projects/{slug}/adaptation/files/{kind}", response_model=AdaptationFileDocument)
def create_adaptation_file(slug: str, kind: AdaptationFileKind, payload: AdaptationFileCreate) -> AdaptationFileDocument:
    return adaptation.create_adaptation_file(slug, kind, payload)


@app.put("/api/projects/{slug}/adaptation/files/{kind}/{key}", response_model=AdaptationFileDocument)
def update_adaptation_file(slug: str, kind: AdaptationFileKind, key: str, payload: AdaptationFileUpdate) -> AdaptationFileDocument:
    return adaptation.update_adaptation_file(slug, kind, key, payload)


@app.get("/api/projects/{slug}/adaptation/workflow", response_model=AdaptationWorkflowStatus)
def get_adaptation_workflow(slug: str, stage: str = "all") -> AdaptationWorkflowStatus:
    return adaptation.workflow_status(slug, stage)


@app.post("/api/projects/{slug}/adaptation/workflow/start", response_model=AdaptationWorkflowStatus)
def start_adaptation_workflow(
    slug: str, payload: AdaptationWorkflowStartRequest = AdaptationWorkflowStartRequest()
) -> AdaptationWorkflowStatus:
    return adaptation.start_workflow(slug, payload.stage)


@app.get("/api/projects/{slug}/adaptation/validation", response_model=AdaptationWorkflowStatus)
def get_adaptation_validation(slug: str, stage: str = "all") -> AdaptationWorkflowStatus:
    return adaptation.validation_status(slug, stage)


@app.post("/api/projects/{slug}/adaptation/validation/start", response_model=AdaptationWorkflowStatus)
def start_adaptation_validation(slug: str, payload: AdaptationWorkflowStartRequest = AdaptationWorkflowStartRequest()) -> AdaptationWorkflowStatus:
    return adaptation.start_validation(slug, payload.stage)


@app.post("/api/projects/{slug}/adaptation/import-drafts-to-canvas", response_model=AdaptationCanvasImportResponse)
def import_adaptation_drafts_to_canvas(slug: str) -> AdaptationCanvasImportResponse:
    return adaptation.import_drafts_to_canvas(slug)


@app.post("/api/projects/{slug}/adaptation/import-book", response_model=AdaptationStatus)
async def import_adaptation_book(slug: str, file: UploadFile = File(...)) -> AdaptationStatus:
    return await adaptation.import_book(slug, file)


@app.get("/api/projects/{slug}/adaptation/book")
def get_adaptation_book(slug: str) -> dict[str, str]:
    return {"text": adaptation.read_book(slug)}


@app.post("/api/projects/{slug}/adaptation/import-style-ref", response_model=AdaptationStatus)
async def import_adaptation_style_ref(
    slug: str,
    kind: str = Form(...),
    file: UploadFile = File(...),
) -> AdaptationStatus:
    return await adaptation.import_style_ref(slug, kind, file)


@app.post("/api/projects/{slug}/adaptation/import-existing-style-refs", response_model=AdaptationStatus)
def import_existing_adaptation_style_refs(slug: str) -> AdaptationStatus:
    return adaptation.import_existing_style_refs(slug)


@app.post("/api/projects/{slug}/adaptation/style-ref-asset", response_model=AdaptationStatus)
def set_adaptation_style_ref_asset(slug: str, payload: AdaptationStyleRefAssetRequest) -> AdaptationStatus:
    return adaptation.set_style_ref_asset(slug, payload)


@app.post("/api/projects/{slug}/adaptation/generate-style-ref", response_model=AdaptationGenerateResponse)
def generate_adaptation_style_ref(slug: str, payload: AdaptationGenerateStyleRefRequest) -> AdaptationGenerateResponse:
    return adaptation.generate_style_ref(slug, payload)


@app.post("/api/projects/{slug}/adaptation/generate-next-character-sheet", response_model=AdaptationGenerateResponse)
def generate_next_adaptation_character_sheet(slug: str) -> AdaptationGenerateResponse:
    return adaptation.generate_next_character_sheet(slug)


@app.post("/api/projects/{slug}/adaptation/generate-artifact", response_model=AdaptationGenerateResponse)
def generate_adaptation_artifact(slug: str, payload: AdaptationGenerateArtifactRequest) -> AdaptationGenerateResponse:
    return adaptation.generate_artifact(slug, payload)


@app.get("/api/projects/{slug}/chat-sessions", response_model=list[ChatSessionDocument])
def list_chat_sessions(
    slug: str, includeArchived: bool = Query(default=False)
) -> list[ChatSessionDocument]:
    return chat_sessions.list_sessions(slug, include_archived=includeArchived)


@app.post("/api/projects/{slug}/chat-sessions", response_model=ChatSessionDocument)
def create_chat_session(slug: str, payload: ChatSessionCreate) -> ChatSessionDocument:
    return chat_sessions.create_session(slug, payload)


@app.get("/api/projects/{slug}/chat-sessions/{session_id}", response_model=ChatSessionDocument)
def get_chat_session(slug: str, session_id: str) -> ChatSessionDocument:
    return chat_sessions.read_session(slug, session_id)


@app.patch("/api/projects/{slug}/chat-sessions/{session_id}", response_model=ChatSessionDocument)
def patch_chat_session(
    slug: str, session_id: str, payload: ChatSessionPatch
) -> ChatSessionDocument:
    return chat_sessions.patch_session(slug, session_id, payload)


@app.post("/api/projects/{slug}/chat-sessions/{session_id}/fork", response_model=ChatSessionDocument)
def fork_chat_session(slug: str, session_id: str, sourceAssetId: str | None = None) -> ChatSessionDocument:
    return chat_sessions.fork_session(slug, session_id, source_asset_id=sourceAssetId)


@app.post("/api/projects/{slug}/chat-sessions/{session_id}/turns", response_model=ChatTurnResponse)
def send_chat_turn(slug: str, session_id: str, payload: ChatTurnRequest) -> ChatTurnResponse:
    return chat_sessions.append_turn_with_gemini(slug, session_id, payload)


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
