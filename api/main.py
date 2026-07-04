"""photo-web API: library CRUD, canvas storage, and image generation."""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.responses import Response
from starlette import status

import adaptation
import agent_sessions
import concept_cards
import library
import book_chat_sessions
import book_session_load
import chat_sessions
import story_panels
import story_panels_print
from models import (
    ArchivePatch,
    AdaptationCanvasImportResponse,
    AgentSessionDocument,
    AgentSessionPatch,
    ConceptCardDocument,
    ConceptCardPatch,
    ConceptNodeCreate,
    ConceptNodeResponse,
    ImageGroupNodeCreate,
    ImageGroupNodeResponse,
    AdaptationImportArtifactRequest,
    AdaptationFileCreate,
    AdaptationFileDocument,
    AdaptationFileKind,
    AdaptationFileUpdate,
    AssetSummary,
    BookChatSessionCreate,
    BookChatSessionDocument,
    BookChatSessionPatch,
    BookChatTurnRequest,
    PiTraceDocument,
    CanvasDocument,
    ChatSessionCreate,
    ChatSessionDocument,
    ChatSessionPatch,
    ChatTurnRequest,
    ChatTurnResponse,
    AdaptationGenerateArtifactRequest,
    AdaptationGenerateStyleRefRequest,
    AdaptationSyncStyleRefRequest,
    AdaptationGenerateResponse,
    AdaptationSettingsPatch,
    AdaptationStatus,
    AdaptationStyleRefAssetRequest,
    AdaptationStylePromptPatch,
    VisualStyleCreate,
    VisualStylePatch,
    AdaptationWorkflowStartRequest,
    AdaptationWorkflowStatus,
    SceneListDocument,
    SceneListLineCreate,
    SceneListReplace,
    SceneMomentsDocument,
    SceneMomentsUpdate,
    MomentSequenceDocument,
    MomentSequenceEntry,
    MomentPatch,
    StoryPanelCreate,
    StoryPanelBookmarkCreate,
    StoryPanelDocument,
    StoryPanelPatch,
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
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
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


@app.post("/api/projects/{slug}/adaptation/visual-styles", response_model=AdaptationStatus)
def create_adaptation_visual_style(slug: str, payload: VisualStyleCreate) -> AdaptationStatus:
    return adaptation.create_visual_style(slug, payload)


@app.patch("/api/projects/{slug}/adaptation/visual-styles/{style_id}", response_model=AdaptationStatus)
def patch_adaptation_visual_style(slug: str, style_id: str, payload: VisualStylePatch) -> AdaptationStatus:
    return adaptation.update_visual_style(slug, style_id, payload)


@app.delete("/api/projects/{slug}/adaptation/visual-styles/{style_id}", response_model=AdaptationStatus)
def delete_adaptation_visual_style(slug: str, style_id: str) -> AdaptationStatus:
    return adaptation.delete_visual_style(slug, style_id)


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


@app.delete("/api/projects/{slug}/adaptation/files/{kind}/{key}", response_model=AdaptationStatus)
def delete_adaptation_file(slug: str, kind: AdaptationFileKind, key: str) -> AdaptationStatus:
    return adaptation.delete_adaptation_file(slug, kind, key)


@app.get("/api/projects/{slug}/concept-cards", response_model=list[ConceptCardDocument])
def list_concept_cards(slug: str, includeArchived: bool = Query(default=False)) -> list[ConceptCardDocument]:
    return concept_cards.list_cards(slug, include_archived=includeArchived)


@app.post("/api/projects/{slug}/concept-cards", response_model=ConceptCardDocument)
def create_concept_card(slug: str, payload: ConceptNodeCreate) -> ConceptCardDocument:
    return concept_cards.create_card(slug, payload)


@app.patch("/api/projects/{slug}/concept-cards/{card_id}", response_model=ConceptCardDocument)
def patch_concept_card(slug: str, card_id: str, payload: ConceptCardPatch) -> ConceptCardDocument:
    return concept_cards.update_card(slug, card_id, payload)


@app.delete("/api/projects/{slug}/concept-cards/{card_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_concept_card(slug: str, card_id: str) -> None:
    concept_cards.delete_card(slug, card_id)


@app.post("/api/projects/{slug}/concept-cards/{card_id}/draft", response_model=ConceptNodeResponse)
def draft_concept_card(slug: str, card_id: str) -> ConceptNodeResponse:
    return concept_cards.draft_card_to_canvas(slug, card_id)


@app.post("/api/projects/{slug}/concept-nodes", response_model=ConceptCardDocument)
def create_concept_node(slug: str, payload: ConceptNodeCreate) -> ConceptCardDocument:
    return concept_cards.create_card(slug, payload)


@app.post("/api/projects/{slug}/canvas/image-groups", response_model=ImageGroupNodeResponse)
def create_canvas_image_group(slug: str, payload: ImageGroupNodeCreate) -> ImageGroupNodeResponse:
    return adaptation.create_image_group(slug, payload)


@app.post("/api/projects/{slug}/adaptation/concept-art/upload", response_model=ConceptCardDocument)
async def upload_concept_art(slug: str, file: UploadFile = File(...)) -> ConceptCardDocument:
    return await concept_cards.upload_card_image(slug, file)


@app.get("/api/projects/{slug}/adaptation/scenes/list", response_model=SceneListDocument)
def get_scene_list(slug: str) -> SceneListDocument:
    return adaptation.scene_list_document(slug)


@app.put("/api/projects/{slug}/adaptation/scenes/list", response_model=SceneListDocument)
def put_scene_list(slug: str, payload: SceneListReplace) -> SceneListDocument:
    return adaptation.replace_scene_list(slug, payload)


@app.post("/api/projects/{slug}/adaptation/scenes/list/lines", response_model=SceneListDocument)
def add_scene_list_line(slug: str, payload: SceneListLineCreate) -> SceneListDocument:
    return adaptation.add_scene_list_line(slug, payload)


@app.delete("/api/projects/{slug}/adaptation/scenes/list/lines/{key}", response_model=SceneListDocument)
def delete_scene_list_line(slug: str, key: str) -> SceneListDocument:
    return adaptation.delete_scene_list_line(slug, key)


@app.post("/api/projects/{slug}/adaptation/characters/list", response_model=AdaptationWorkflowStatus)
def start_character_list(slug: str) -> AdaptationWorkflowStatus:
    return adaptation.start_character_list(slug)


@app.get("/api/projects/{slug}/adaptation/characters/list", response_model=AdaptationWorkflowStatus)
def get_character_list(slug: str) -> AdaptationWorkflowStatus:
    return adaptation.character_list_status(slug)


@app.post("/api/projects/{slug}/adaptation/characters/extract-all", response_model=AdaptationWorkflowStatus)
def start_character_extract_all(slug: str) -> AdaptationWorkflowStatus:
    return adaptation.start_character_extract_all(slug)


@app.get("/api/projects/{slug}/adaptation/characters/extract-all", response_model=AdaptationWorkflowStatus)
def get_character_extract_all(slug: str) -> AdaptationWorkflowStatus:
    return adaptation.character_extract_all_status(slug)


@app.post("/api/projects/{slug}/adaptation/characters/{key}/extract", response_model=AdaptationWorkflowStatus)
def start_character_extract(slug: str, key: str, force: bool = False) -> AdaptationWorkflowStatus:
    return adaptation.start_character_extract(slug, key, force=force)


@app.get("/api/projects/{slug}/adaptation/characters/{key}/extract", response_model=AdaptationWorkflowStatus)
def get_character_extract(slug: str, key: str) -> AdaptationWorkflowStatus:
    return adaptation.character_extract_status(slug, key)


@app.post("/api/projects/{slug}/adaptation/concept-art/generate-character", response_model=AdaptationWorkflowStatus)
def start_generate_concept_character(slug: str) -> AdaptationWorkflowStatus:
    return adaptation.start_generate_concept_character(slug)


@app.get("/api/projects/{slug}/adaptation/concept-art/generate-character", response_model=AdaptationWorkflowStatus)
def get_generate_concept_character(slug: str) -> AdaptationWorkflowStatus:
    return adaptation.generate_concept_character_status(slug)


@app.post("/api/projects/{slug}/adaptation/concept-art/generate-location", response_model=AdaptationWorkflowStatus)
def start_generate_concept_location(slug: str) -> AdaptationWorkflowStatus:
    return adaptation.start_generate_concept_location(slug)


@app.get("/api/projects/{slug}/adaptation/concept-art/generate-location", response_model=AdaptationWorkflowStatus)
def get_generate_concept_location(slug: str) -> AdaptationWorkflowStatus:
    return adaptation.generate_concept_location_status(slug)


@app.post("/api/projects/{slug}/adaptation/characters/reset", response_model=AdaptationStatus)
def reset_character_data(slug: str) -> AdaptationStatus:
    return adaptation.reset_character_data(slug)


@app.post("/api/projects/{slug}/adaptation/scenes/{key}/extract", response_model=AdaptationWorkflowStatus)
def start_scene_extract(slug: str, key: str, force: bool = False) -> AdaptationWorkflowStatus:
    return adaptation.start_scene_extract(slug, key, force=force)


@app.get("/api/projects/{slug}/adaptation/scenes/{key}/extract", response_model=AdaptationWorkflowStatus)
def get_scene_extract(slug: str, key: str) -> AdaptationWorkflowStatus:
    return adaptation.scene_extract_status(slug, key)


@app.post("/api/projects/{slug}/adaptation/scenes/{key}/plan", response_model=AdaptationWorkflowStatus)
def start_scene_plan(slug: str, key: str) -> AdaptationWorkflowStatus:
    return adaptation.start_scene_plan(slug, key)


@app.get("/api/projects/{slug}/adaptation/scenes/{key}/plan", response_model=AdaptationWorkflowStatus)
def get_scene_plan(slug: str, key: str) -> AdaptationWorkflowStatus:
    return adaptation.scene_plan_status(slug, key)


@app.get("/api/projects/{slug}/adaptation/scenes/{key}/moments", response_model=SceneMomentsDocument)
def get_scene_moments(slug: str, key: str) -> SceneMomentsDocument:
    return adaptation.scene_moments_document(slug, key)


@app.put("/api/projects/{slug}/adaptation/scenes/{key}/moments", response_model=SceneMomentsDocument)
def put_scene_moments(slug: str, key: str, payload: SceneMomentsUpdate) -> SceneMomentsDocument:
    return adaptation.put_scene_moments(slug, key, payload)


@app.get("/api/projects/{slug}/adaptation/moments/sequence", response_model=MomentSequenceDocument)
def get_moment_sequence(slug: str) -> MomentSequenceDocument:
    return adaptation.moment_sequence_document(slug)


@app.patch("/api/projects/{slug}/adaptation/moments/{key}", response_model=MomentSequenceEntry)
def patch_moment(slug: str, key: str, payload: MomentPatch) -> MomentSequenceEntry:
    return adaptation.patch_moment(slug, key, payload)


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


@app.post("/api/projects/{slug}/adaptation/import-artifact-to-canvas", response_model=AdaptationCanvasImportResponse)
def import_adaptation_artifact_to_canvas(slug: str, payload: AdaptationImportArtifactRequest) -> AdaptationCanvasImportResponse:
    return adaptation.import_artifact_to_canvas(slug, payload.artifactKind, payload.artifactKey)


@app.post("/api/projects/{slug}/adaptation/import-book", response_model=AdaptationStatus)
async def import_adaptation_book(slug: str, file: UploadFile = File(...)) -> AdaptationStatus:
    return await adaptation.import_book(slug, file)


@app.get("/api/projects/{slug}/adaptation/book")
def get_adaptation_book(slug: str) -> dict[str, str]:
    return {"text": adaptation.read_book(slug)}


@app.get("/api/projects/{slug}/adaptation/book-session/load", response_model=AdaptationWorkflowStatus)
def get_book_session_load(slug: str) -> AdaptationWorkflowStatus:
    return book_session_load.book_session_load_status(slug)


@app.post("/api/projects/{slug}/adaptation/book-session/load", response_model=AdaptationWorkflowStatus)
def start_book_session_load(slug: str) -> AdaptationWorkflowStatus:
    return book_session_load.start_book_session_load(slug)


@app.get("/api/projects/{slug}/adaptation/book-chats", response_model=list[BookChatSessionDocument])
def list_book_chats(slug: str, includeArchived: bool = Query(default=False)) -> list[BookChatSessionDocument]:
    return book_chat_sessions.list_sessions(slug, include_archived=includeArchived)


@app.post("/api/projects/{slug}/adaptation/book-chats", response_model=BookChatSessionDocument)
def create_book_chat(slug: str, payload: BookChatSessionCreate = BookChatSessionCreate()) -> BookChatSessionDocument:
    return book_chat_sessions.create_session(slug, payload)


@app.get("/api/projects/{slug}/adaptation/book-chats/{session_id}", response_model=BookChatSessionDocument)
def get_book_chat(slug: str, session_id: str) -> BookChatSessionDocument:
    return book_chat_sessions.read_session(slug, session_id)


@app.patch("/api/projects/{slug}/adaptation/book-chats/{session_id}", response_model=BookChatSessionDocument)
def patch_book_chat(slug: str, session_id: str, payload: BookChatSessionPatch) -> BookChatSessionDocument:
    return book_chat_sessions.patch_session(slug, session_id, payload)


@app.post("/api/projects/{slug}/adaptation/book-chats/{session_id}/turns", response_model=BookChatSessionDocument)
def send_book_chat_turn(slug: str, session_id: str, payload: BookChatTurnRequest) -> BookChatSessionDocument:
    return book_chat_sessions.append_turn(slug, session_id, payload)


@app.get("/api/projects/{slug}/adaptation/book-chats/{session_id}/trace", response_model=PiTraceDocument)
def get_book_chat_trace(slug: str, session_id: str) -> PiTraceDocument:
    return book_chat_sessions.read_trace(slug, session_id)


@app.get("/api/projects/{slug}/agent-sessions", response_model=list[AgentSessionDocument])
def list_agent_sessions(slug: str, includeArchived: bool = Query(default=False)) -> list[AgentSessionDocument]:
    return agent_sessions.list_sessions(slug, include_archived=includeArchived)


@app.get("/api/projects/{slug}/agent-sessions/{session_id}", response_model=AgentSessionDocument)
def get_agent_session(slug: str, session_id: str) -> AgentSessionDocument:
    return agent_sessions.read_session(slug, session_id)


@app.patch("/api/projects/{slug}/agent-sessions/{session_id}", response_model=AgentSessionDocument)
def patch_agent_session(slug: str, session_id: str, payload: AgentSessionPatch) -> AgentSessionDocument:
    return agent_sessions.patch_session(slug, session_id, payload)


@app.get("/api/projects/{slug}/agent-sessions/{session_id}/trace", response_model=PiTraceDocument)
def get_agent_session_trace(slug: str, session_id: str) -> PiTraceDocument:
    return agent_sessions.read_trace(slug, session_id)


@app.get("/api/projects/{slug}/story-panels/book")
def get_story_panel_book(slug: str) -> dict[str, str]:
    text = story_panels.optional_book_text(slug)
    return {"text": text or ""}


@app.get("/api/projects/{slug}/story-panels", response_model=StoryPanelDocument)
def get_story_panels(slug: str) -> StoryPanelDocument:
    return story_panels.read_document(slug)


@app.get("/api/projects/{slug}/story-panels/print/booklet.pdf")
def get_story_panels_booklet_pdf(slug: str, pageBorder: story_panels_print.PageBorder = "black") -> Response:
    if pageBorder not in {"black", "grey", "none"}:
        raise HTTPException(status_code=400, detail=f"Unknown pageBorder: {pageBorder}")
    pdf = story_panels_print.render_booklet_pdf(slug, page_border=pageBorder)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{slug}-comic-booklet.pdf"'},
    )


@app.put("/api/projects/{slug}/story-panels", response_model=StoryPanelDocument)
def put_story_panels(slug: str, payload: StoryPanelDocument) -> StoryPanelDocument:
    return story_panels.save_document(slug, payload)


@app.post("/api/projects/{slug}/story-panels/panels", response_model=StoryPanelDocument)
def create_story_panel(slug: str, payload: StoryPanelCreate) -> StoryPanelDocument:
    return story_panels.create_panel(slug, payload)


@app.post("/api/projects/{slug}/story-panels/panels/bookmark", response_model=StoryPanelDocument)
def create_story_panel_bookmark(slug: str, payload: StoryPanelBookmarkCreate) -> StoryPanelDocument:
    return story_panels.create_bookmark(slug, payload)


@app.patch("/api/projects/{slug}/story-panels/panels/{panel_id}", response_model=StoryPanelDocument)
def patch_story_panel(slug: str, panel_id: str, payload: StoryPanelPatch) -> StoryPanelDocument:
    return story_panels.patch_panel(slug, panel_id, payload)


@app.post("/api/projects/{slug}/story-panels/panels/{panel_id}/auto-place", response_model=StoryPanelDocument)
def auto_place_story_panel(slug: str, panel_id: str) -> StoryPanelDocument:
    return story_panels.auto_place_panel(slug, panel_id)


@app.delete("/api/projects/{slug}/story-panels/panels/{panel_id}", response_model=StoryPanelDocument)
def delete_story_panel(slug: str, panel_id: str) -> StoryPanelDocument:
    return story_panels.delete_panel(slug, panel_id)


@app.post("/api/projects/{slug}/story-panels/reset-layout", response_model=StoryPanelDocument)
def reset_story_panel_layout(slug: str) -> StoryPanelDocument:
    return story_panels.reset_layout(slug)


@app.post("/api/projects/{slug}/story-panels/reset-chunks", response_model=StoryPanelDocument)
def reset_story_panel_chunks(slug: str) -> StoryPanelDocument:
    return story_panels.reset_chunks(slug)


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


@app.post("/api/projects/{slug}/adaptation/sync-style-ref-to-canvas", response_model=AdaptationCanvasImportResponse)
def sync_adaptation_style_ref_to_canvas(slug: str, payload: AdaptationSyncStyleRefRequest) -> AdaptationCanvasImportResponse:
    return adaptation.sync_style_ref_to_canvas(slug, payload.kind)


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
