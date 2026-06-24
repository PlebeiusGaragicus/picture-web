"""Pydantic models for the photo-web API and library JSON."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

TAG_RE = r"^[a-z0-9]+(-[a-z0-9]+)*$"
SLUG_RE = r"^[a-z0-9]+(-[a-z0-9]+)*$"
TAG_COLOR_RE = r"^#[0-9a-fA-F]{6}$"
LAYOUT_GRID_COLUMNS = 12
LAYOUT_PAGE_ROWS = 10
DEFAULT_AUTO_PLACE_W = LAYOUT_GRID_COLUMNS / 3.0
DEFAULT_AUTO_PLACE_H = LAYOUT_PAGE_ROWS / 3.0

AssetKind = Literal["imported", "generated"]
StoryKind = Literal["picture-book", "illustrated-story", "comic-book"]
ArtifactKind = Literal["character-sheet", "location-prompt", "scene-artifact", "page-plan", "panel-prompt", "concept-art"]
AdaptationFileKind = Literal["characters", "locations", "scenes", "concept-art"]
ConceptArtSubjectKind = Literal["character", "location"]
StyleRefKind = Literal["archetype-character", "archetype-scene"]
MODEL_CAPABILITIES = {
    "gemini-2.5-flash-image": {
        "aspectRatios": {"1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"},
        "imageSizes": {"1K", "2K", "4K"},
    },
    "gemini-3.1-flash-image": {
        "aspectRatios": {"1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"},
        "imageSizes": {"512", "1K", "2K", "4K"},
    },
    "gemini-3-pro-image": {
        "aspectRatios": {"1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"},
        "imageSizes": {"1K", "2K", "4K"},
    },
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class Prompt(BaseModel):
    text: str = Field(min_length=1)


class GenerationReceipt(BaseModel):
    refs: list[str] = Field(default_factory=list)
    runId: str
    runIndex: int = Field(ge=0)
    model: str = Field(min_length=1)
    aspectRatio: str = Field(min_length=1)
    imageSize: str = Field(min_length=1)
    seed: int | None = Field(default=None, ge=0)
    chatSessionId: str | None = None
    chatTurnId: str | None = None
    visualStyleId: str | None = Field(default=None, pattern=TAG_RE)


class ProviderCapture(BaseModel):
    name: str = "google-genai"
    response: dict[str, Any] = Field(default_factory=dict)


class AssetMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kind: AssetKind
    title: str
    tags: list[str] = Field(default_factory=list)
    contentHash: str | None = None
    createdAt: str
    updatedAt: str
    archivedAt: str | None = None
    prompt: Prompt | None = None
    generation: GenerationReceipt | None = None
    provider: ProviderCapture | None = None

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, tags: list[str]) -> list[str]:
        import re

        for tag in tags:
            if not re.match(TAG_RE, tag):
                raise ValueError(f"Invalid tag slug: {tag}")
        return tags

    @field_validator("generation")
    @classmethod
    def generated_requires_receipt(
        cls, generation: GenerationReceipt | None, info
    ) -> GenerationReceipt | None:
        kind = info.data.get("kind")
        if kind == "generated" and generation is None:
            raise ValueError("generated assets require generation metadata")
        if kind == "imported" and generation is not None:
            raise ValueError("imported assets cannot have generation metadata")
        return generation

    @field_validator("prompt")
    @classmethod
    def generated_requires_prompt(cls, prompt: Prompt | None, info) -> Prompt | None:
        kind = info.data.get("kind")
        if kind == "generated" and prompt is None:
            raise ValueError("generated assets require prompt metadata")
        if kind == "imported" and prompt is not None:
            raise ValueError("imported assets cannot have prompt metadata")
        return prompt

    @field_validator("provider")
    @classmethod
    def provider_matches_kind(
        cls, provider: ProviderCapture | None, info
    ) -> ProviderCapture | None:
        kind = info.data.get("kind")
        if kind == "imported" and provider is not None:
            raise ValueError("imported assets cannot have provider metadata")
        return provider


class AssetSummary(AssetMetadata):
    hasPixels: bool = True
    thumbnailUrl: str | None = None
    isProtected: bool = False


class ProjectCreate(BaseModel):
    slug: str = Field(pattern=SLUG_RE)
    name: str = Field(min_length=1)
    settings: dict[str, Any] = Field(default_factory=dict)


class ProjectMetadata(ProjectCreate):
    createdAt: str
    coverAssetId: str | None = None
    coverThumbnailUrl: str | None = None


EntityKind = Literal["character", "location"]


class TagDefinition(BaseModel):
    id: str = Field(pattern=TAG_RE)
    name: str = Field(min_length=1)
    color: str = Field(pattern=TAG_COLOR_RE)
    locked: bool = False
    entityKind: EntityKind | None = None


class TagRegistryDocument(BaseModel):
    tags: list[TagDefinition] = Field(default_factory=list)

    @field_validator("tags")
    @classmethod
    def unique_tags(cls, tags: list[TagDefinition]) -> list[TagDefinition]:
        seen: set[str] = set()
        unique: list[TagDefinition] = []
        for tag in tags:
            if tag.id in seen:
                continue
            seen.add(tag.id)
            unique.append(tag)
        return unique


class ProjectCoverPatch(BaseModel):
    coverAssetId: str | None = None


class AdaptationSettings(BaseModel):
    storyKind: StoryKind = "comic-book"


class AdaptationAssetLink(BaseModel):
    artifactKind: ArtifactKind
    promptPath: str
    subjectKind: ConceptArtSubjectKind | None = None
    mode: str = ""
    styleRef: str = ""
    prompt: str = ""
    narration: str = ""
    dialogue: str = ""
    caption: str = ""
    assetIds: list[str] = Field(default_factory=list)
    activeAssetId: str | None = None
    finalized: bool = False
    status: Literal["missing", "ready", "generated"] = "missing"
    userTags: list[str] = Field(default_factory=list)


class CharacterRecord(BaseModel):
    slug: str = Field(pattern=SLUG_RE)
    promptPath: str
    description: str = ""
    userTags: list[str] = Field(default_factory=list)
    variants: dict[str, AdaptationAssetLink] = Field(default_factory=dict)


class AdaptationStyleRefs(BaseModel):
    archetypeCharacterAssetId: str | None = None
    archetypeSceneAssetId: str | None = None


class StyleRefStatus(BaseModel):
    kind: StyleRefKind
    promptPath: str
    promptText: str = ""
    assetId: str | None = None
    canvasDraftNodeId: str
    canvasImageNodeId: str


class AdaptationMetadata(BaseModel):
    version: int = 2
    settings: AdaptationSettings = Field(default_factory=AdaptationSettings)
    styleRefs: AdaptationStyleRefs = Field(default_factory=AdaptationStyleRefs)
    characters: dict[str, CharacterRecord] = Field(default_factory=dict)
    locations: dict[str, AdaptationAssetLink] = Field(default_factory=dict)
    conceptArt: dict[str, AdaptationAssetLink] = Field(default_factory=dict)
    scenes: dict[str, AdaptationAssetLink] = Field(default_factory=dict)
    pages: dict[str, AdaptationAssetLink] = Field(default_factory=dict)
    panels: dict[str, AdaptationAssetLink] = Field(default_factory=dict)


class VisualStyleDefinition(BaseModel):
    id: str = Field(pattern=TAG_RE)
    name: str = Field(min_length=1)
    prompt: str = ""
    default: bool = False


class VisualStyleCreate(BaseModel):
    name: str = Field(min_length=1)
    prompt: str | None = None


class VisualStylePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    prompt: str | None = None
    default: bool | None = None


class AdaptationStatus(BaseModel):
    projectSlug: str
    settings: AdaptationSettings
    hasBook: bool
    hasBookSession: bool
    styleRefs: dict[str, bool]
    styleRefStatuses: dict[StyleRefKind, StyleRefStatus]
    archetypeCharacterAssetId: str | None = None
    archetypeSceneAssetId: str | None = None
    archetypeCharacterPromptText: str = ""
    archetypeScenePromptText: str = ""
    counts: dict[str, int]
    visualStyles: list[VisualStyleDefinition]
    defaultVisualStyleId: str | None = Field(default=None, pattern=TAG_RE)
    characters: dict[str, CharacterRecord]
    locations: dict[str, AdaptationAssetLink]
    conceptArt: dict[str, AdaptationAssetLink]
    scenes: dict[str, AdaptationAssetLink]
    pages: dict[str, AdaptationAssetLink]
    panels: dict[str, AdaptationAssetLink]


class AdaptationWorkflowStatus(BaseModel):
    running: bool
    returnCode: int | None = None
    startedAt: str | None = None
    completedAt: str | None = None
    log: str = ""
    logFiles: dict[str, str] = Field(default_factory=dict)


class BookChatTurn(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    createdAt: str
    text: str = ""
    piSessionId: str | None = None
    events: list[dict[str, Any]] = Field(default_factory=list)
    error: str | None = None


class BookChatSessionDocument(BaseModel):
    version: int = 1
    id: str
    projectSlug: str
    status: Literal["active", "archived"] = "active"
    title: str
    createdAt: str
    updatedAt: str
    archivedAt: str | None = None
    forkRootSessionId: str
    piSessionId: str | None = None
    piSessionFile: str | None = None
    turns: list[BookChatTurn] = Field(default_factory=list)


class PiTraceUsage(BaseModel):
    input: int | None = None
    output: int | None = None
    cacheRead: int | None = None
    cacheWrite: int | None = None
    totalTokens: int | None = None


class PiTraceUserStep(BaseModel):
    kind: Literal["user"] = "user"
    timestamp: str | None = None
    text: str


class PiTraceToolCall(BaseModel):
    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    result: str | None = None
    isError: bool = False
    details: dict[str, Any] | None = None


class PiTraceAssistantStep(BaseModel):
    kind: Literal["assistant"] = "assistant"
    timestamp: str | None = None
    provider: str | None = None
    model: str | None = None
    thinkingLevel: str | None = None
    stopReason: str | None = None
    usage: PiTraceUsage | None = None
    thinking: list[str] = Field(default_factory=list)
    text: str | None = None
    toolCalls: list[PiTraceToolCall] = Field(default_factory=list)


class PiTraceInfoBanner(BaseModel):
    kind: Literal["compaction", "branch_summary"]
    timestamp: str | None = None
    text: str
    tokensBefore: int | None = None


class PiTraceStats(BaseModel):
    messageCount: int = 0
    toolCount: int = 0
    userCount: int = 0
    assistantCount: int = 0


class PiTraceDocument(BaseModel):
    sessionId: str | None = None
    cwd: str | None = None
    version: int | None = None
    steps: list[PiTraceUserStep | PiTraceAssistantStep | PiTraceInfoBanner] = Field(default_factory=list)
    stats: PiTraceStats = Field(default_factory=PiTraceStats)


class BookChatSessionCreate(BaseModel):
    title: str | None = Field(default=None, min_length=1)


class BookChatSessionPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    archived: bool | None = None


class BookChatTurnRequest(BaseModel):
    text: str = Field(min_length=1)


class AdaptationCanvasImportResponse(BaseModel):
    canvas: CanvasDocument
    importedNodeCount: int


class AdaptationImportArtifactRequest(BaseModel):
    artifactKind: ArtifactKind
    artifactKey: str = Field(pattern=SLUG_RE)


class AdaptationStylePromptPatch(BaseModel):
    kind: StyleRefKind
    prompt: str


class AdaptationSettingsPatch(BaseModel):
    storyKind: StoryKind


class AdaptationWorkflowStartRequest(BaseModel):
    stage: Literal["ingest", "characters", "scene-list", "scenes", "locations", "moments", "all"] = "all"


class SceneListLine(BaseModel):
    slug: str = Field(pattern=SLUG_RE)
    description: str = ""


class SceneListDocument(BaseModel):
    lines: list[SceneListLine] = Field(default_factory=list)


class SceneListReplace(BaseModel):
    lines: list[SceneListLine]


class SceneListLineCreate(BaseModel):
    slug: str = Field(pattern=SLUG_RE)
    description: str = ""


class MomentRefInput(BaseModel):
    ref: str
    kind: Literal["character", "location", "unknown"]
    entityKey: str = ""
    tagId: str = ""
    ready: bool
    assetIds: list[str] = Field(default_factory=list)
    detail: str = ""


class MomentLayoutSection(BaseModel):
    key: str = Field(pattern=SLUG_RE)
    refs: str = ""
    narration: str = ""
    dialogue: str = ""
    caption: str = ""
    prompt: str = ""
    refInputs: list[MomentRefInput] = Field(default_factory=list)
    canGenerate: bool = False
    referenceImageCount: int = 0
    referenceImageLimit: int = 14
    referenceLimitExceeded: bool = False


class SceneMomentsDocument(BaseModel):
    sceneSlug: str
    path: str
    body: str
    sections: list[MomentLayoutSection] = Field(default_factory=list)
    sectionCount: int
    storyKind: StoryKind
    exists: bool = False


class SceneMomentsUpdate(BaseModel):
    body: str | None = None
    sections: list[MomentLayoutSection] | None = None


class MomentSequenceEntry(BaseModel):
    momentKey: str
    sceneSlug: str
    artifactKind: ArtifactKind
    promptPath: str
    prompt: str = ""
    narration: str = ""
    dialogue: str = ""
    caption: str = ""
    refs: str = ""
    assetIds: list[str] = Field(default_factory=list)
    activeAssetId: str | None = None
    finalized: bool = False
    status: Literal["missing", "ready", "generated"] = "ready"
    refInputs: list[MomentRefInput] = Field(default_factory=list)
    canGenerate: bool = False
    referenceImageCount: int = 0
    referenceImageLimit: int = 14
    referenceLimitExceeded: bool = False


class MomentSequenceCounts(BaseModel):
    total: int = 0
    illustrated: int = 0
    finalized: int = 0


class MomentSequenceDocument(BaseModel):
    moments: list[MomentSequenceEntry] = Field(default_factory=list)
    counts: MomentSequenceCounts = Field(default_factory=MomentSequenceCounts)


class MomentPatch(BaseModel):
    narration: str | None = None
    dialogue: str | None = None
    caption: str | None = None
    activeAssetId: str | None = None
    finalized: bool | None = None


class AdaptationFileBase(BaseModel):
    key: str = Field(pattern=SLUG_RE)
    body: str = ""
    mode: str = ""
    styleRef: str = ""
    subjectKind: ConceptArtSubjectKind | None = None


class AdaptationFileCreate(AdaptationFileBase):
    pass


class CharacterVariantUpdate(BaseModel):
    prompt: str | None = None
    mode: str | None = None
    styleRef: str | None = None


class AdaptationFileUpdate(BaseModel):
    key: str | None = Field(default=None, pattern=SLUG_RE)
    body: str | None = None
    description: str | None = None
    variants: dict[str, CharacterVariantUpdate] | None = None
    mode: str | None = None
    styleRef: str | None = None
    subjectKind: ConceptArtSubjectKind | None = None
    userTags: list[str] | None = None


class AdaptationFileDocument(AdaptationFileBase):
    kind: AdaptationFileKind
    promptPath: str
    artifactKind: ArtifactKind
    status: Literal["missing", "ready", "generated"] = "missing"


class AdaptationStyleRefAssetRequest(BaseModel):
    kind: StyleRefKind
    assetId: str


class AdaptationSyncStyleRefRequest(BaseModel):
    kind: StyleRefKind


class AdaptationGenerateStyleRefRequest(BaseModel):
    kind: StyleRefKind
    canvasNodeId: str | None = None
    visualStyleId: str | None = Field(default=None, pattern=TAG_RE)
    model: str | None = None
    aspectRatio: str | None = None
    imageSize: str | None = None
    seed: int | None = Field(default=None, ge=0)
    batchCount: int = Field(default=1, ge=1, le=8)


class AdaptationGenerateArtifactRequest(BaseModel):
    artifactKind: ArtifactKind
    artifactKey: str = Field(min_length=1)
    variantKey: str = Field(default="base", pattern=SLUG_RE)
    canvasNodeId: str | None = None
    visualStyleId: str | None = Field(default=None, pattern=TAG_RE)
    model: str | None = None
    aspectRatio: str | None = None
    imageSize: str | None = None
    seed: int | None = Field(default=None, ge=0)
    batchCount: int = Field(default=1, ge=1, le=8)


class AdaptationGenerateResponse(BaseModel):
    generated: bool
    kind: Literal["character", "artifact", "style-ref"]
    key: str | None = None
    asset: AssetSummary | None = None
    status: AdaptationStatus | None = None
    message: str


class StoryPanelRect(BaseModel):
    x: float = Field(ge=0, le=12)
    y: float = Field(ge=0)
    w: float = Field(ge=0.25, le=12)
    h: float = Field(ge=0.25, le=12)

    @model_validator(mode="after")
    def fits_page_grid(self) -> "StoryPanelRect":
        if self.x + self.w > LAYOUT_GRID_COLUMNS:
            raise ValueError("Panel layout must fit within the 12-column page grid")
        if self.y + self.h > LAYOUT_PAGE_ROWS:
            raise ValueError("Panel layout must fit within the page height grid")
        return self


class StoryPanelPage(BaseModel):
    id: str = Field(pattern=TAG_RE)
    order: int = Field(ge=0)
    title: str = Field(default="", max_length=120)
    pageKind: Literal["cover", "inside-cover", "story", "inside-back-cover", "back-cover"] = "story"


class StoryPanelPageSettings(BaseModel):
    width: int = Field(default=2, ge=1, le=100)
    height: int = Field(default=3, ge=1, le=100)


class StoryPanelTextStyle(BaseModel):
    fontFamily: Literal["serif", "sans", "mono", "comic"] = "serif"
    fontSize: int = Field(default=8, ge=6, le=48)
    align: Literal["left", "center", "right"] = "left"
    speechKind: Literal["dialogue", "narration"] = "dialogue"
    background: Literal["transparent", "white"] = "white"
    color: str = Field(default="#111827", pattern=TAG_COLOR_RE)
    outlineColor: str = Field(default="#ffffff", pattern=TAG_COLOR_RE)


class StoryPanelImageCrop(BaseModel):
    focalX: float = Field(default=0.5, ge=0, le=1)
    focalY: float = Field(default=0.5, ge=0, le=1)
    scale: float = Field(default=1, ge=1, le=4)


class StoryPanel(BaseModel):
    id: str = Field(pattern=TAG_RE)
    order: int = Field(ge=0)
    sourceKind: Literal["story", "draft", "bookmark", "free-text", "free-image", "caption"] = "story"
    startOffset: int | None = Field(default=None, ge=0)
    endOffset: int | None = Field(default=None, ge=0)
    selectedText: str = ""
    customText: str = ""
    richText: str = ""
    textStyle: StoryPanelTextStyle = Field(default_factory=StoryPanelTextStyle)
    pageId: str | None = None
    panelKind: Literal["image", "text"] = "image"
    rect: StoryPanelRect = Field(
        default_factory=lambda: StoryPanelRect(x=0, y=0, w=DEFAULT_AUTO_PLACE_W, h=DEFAULT_AUTO_PLACE_H),
    )
    layer: int = Field(default=0, ge=0)
    parentPanelId: str | None = Field(default=None, pattern=TAG_RE)
    assetIds: list[str] = Field(default_factory=list)
    activeAssetId: str | None = None
    aspectRatio: str | None = None
    aspectRatioLocked: bool = False
    imageCrop: StoryPanelImageCrop | None = None
    finalized: bool = False

    @model_validator(mode="after")
    def validate_offsets_and_active_asset(self) -> "StoryPanel":
        if self.sourceKind == "story":
            if self.startOffset is None or self.endOffset is None:
                raise ValueError("Story panels must have book offsets")
            if self.endOffset <= self.startOffset:
                raise ValueError("Panel endOffset must be greater than startOffset")
            if self.parentPanelId is not None:
                raise ValueError("Story panels must not have parentPanelId")
        elif self.sourceKind == "draft":
            if self.startOffset is not None or self.endOffset is not None:
                raise ValueError("Draft panels must not have book offsets")
            if self.parentPanelId is not None:
                raise ValueError("Draft panels must not have parentPanelId")
        elif self.sourceKind == "bookmark":
            if self.startOffset is None or self.endOffset is None:
                raise ValueError("Bookmark items must have book offsets")
            if self.endOffset <= self.startOffset:
                raise ValueError("Panel endOffset must be greater than startOffset")
            if self.parentPanelId is not None:
                raise ValueError("Bookmark items must not have parentPanelId")
        elif self.sourceKind == "caption":
            if not self.parentPanelId:
                raise ValueError("Caption panels must have parentPanelId")
            if self.panelKind != "text":
                raise ValueError("Caption panels must be text panels")
            if self.startOffset is not None or self.endOffset is not None:
                raise ValueError("Caption panels must not have book offsets")
        elif self.startOffset is not None or self.endOffset is not None:
            raise ValueError("Free layout items must not have book offsets")
        elif self.parentPanelId is not None:
            raise ValueError("Only caption panels may have parentPanelId")
        if self.pageId is None and self.sourceKind not in {"story", "draft", "bookmark"}:
            raise ValueError("Only story, draft, and bookmark panels may be unplaced")
        if self.activeAssetId is not None and self.activeAssetId not in self.assetIds:
            raise ValueError("activeAssetId must be attached to the panel")
        return self


class StoryPanelDocument(BaseModel):
    version: int = 1
    bookSource: str = "adaptation/book.txt"
    pageSettings: StoryPanelPageSettings = Field(default_factory=StoryPanelPageSettings)
    pages: list[StoryPanelPage] = Field(default_factory=list)
    panels: list[StoryPanel] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_document(self) -> "StoryPanelDocument":
        page_ids = [page.id for page in self.pages]
        if len(page_ids) != len(set(page_ids)):
            raise ValueError("Duplicate page ids")
        panel_ids = [panel.id for panel in self.panels]
        if len(panel_ids) != len(set(panel_ids)):
            raise ValueError("Duplicate panel ids")
        page_id_set = set(page_ids)
        for panel in self.panels:
            if panel.pageId is not None and panel.pageId not in page_id_set:
                raise ValueError(f"Panel references unknown page: {panel.pageId}")
        ranges = sorted((panel.startOffset, panel.endOffset, panel.id) for panel in self.panels if panel.sourceKind == "story")
        for previous, current in zip(ranges, ranges[1:]):
            if previous[1] > current[0]:
                raise ValueError(f"Panel text ranges overlap: {previous[2]} and {current[2]}")
        return self


class StoryPanelCreate(BaseModel):
    startOffset: int = Field(ge=0)
    endOffset: int = Field(ge=0)
    selectedText: str = ""
    customText: str = ""
    insertAfterPanelId: str | None = Field(default=None, pattern=TAG_RE)
    autoPlace: bool = True
    pageId: str | None = Field(default=None, pattern=TAG_RE)
    rect: StoryPanelRect | None = None
    layer: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def validate_offsets(self) -> "StoryPanelCreate":
        if self.endOffset <= self.startOffset:
            raise ValueError("Panel endOffset must be greater than startOffset")
        return self


class StoryPanelBookmarkCreate(BaseModel):
    startOffset: int = Field(ge=0)
    endOffset: int = Field(ge=0)
    selectedText: str = ""
    customText: str = ""
    insertAfterPanelId: str | None = Field(default=None, pattern=TAG_RE)

    @model_validator(mode="after")
    def validate_bookmark(self) -> "StoryPanelBookmarkCreate":
        if self.endOffset <= self.startOffset:
            raise ValueError("Bookmark endOffset must be greater than startOffset")
        return self


class StoryPanelDraftCreate(BaseModel):
    customText: str = Field(min_length=1)
    insertAfterPanelId: str | None = Field(default=None, pattern=TAG_RE)
    autoPlace: bool = True
    pageId: str | None = Field(default=None, pattern=TAG_RE)
    rect: StoryPanelRect | None = None
    layer: int = Field(default=0, ge=0)


class StoryPanelPatch(BaseModel):
    order: int | None = Field(default=None, ge=0)
    sourceKind: Literal["story", "draft", "bookmark", "free-text", "free-image", "caption"] | None = None
    startOffset: int | None = Field(default=None, ge=0)
    endOffset: int | None = Field(default=None, ge=0)
    selectedText: str | None = None
    customText: str | None = None
    richText: str | None = None
    textStyle: StoryPanelTextStyle | None = None
    pageId: str | None = Field(default=None, pattern=TAG_RE)
    panelKind: Literal["image", "text"] | None = None
    rect: StoryPanelRect | None = None
    layer: int | None = Field(default=None, ge=0)
    parentPanelId: str | None = Field(default=None, pattern=TAG_RE)
    assetIds: list[str] | None = None
    activeAssetId: str | None = None
    aspectRatio: str | None = None
    aspectRatioLocked: bool | None = None
    imageCrop: StoryPanelImageCrop | None = None
    finalized: bool | None = None


class ProjectDetail(BaseModel):
    project: ProjectMetadata
    assets: list[AssetSummary]
    tags: list[TagDefinition] = Field(default_factory=list)


class DisplayPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    tags: list[str] | None = None

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, tags: list[str] | None) -> list[str] | None:
        if tags is None:
            return None
        import re

        for tag in tags:
            if not re.match(TAG_RE, tag):
                raise ValueError(f"Invalid tag slug: {tag}")
        return tags


class StyleRefSourceRole(BaseModel):
    type: Literal["style-ref-source"] = "style-ref-source"
    kind: StyleRefKind


class ArtifactSourceRole(BaseModel):
    type: Literal["artifact-source"] = "artifact-source"
    artifactKind: ArtifactKind
    artifactKey: str


class TextResultRole(BaseModel):
    type: Literal["text-result"] = "text-result"
    sourceNodeId: str


class GeneratedResultRole(BaseModel):
    type: Literal["generated-result"] = "generated-result"
    sourceNodeId: str


class RefinementRole(BaseModel):
    type: Literal["refinement"] = "refinement"
    sourceNodeId: str
    sourceAssetId: str | None = None


CanvasRole = Annotated[StyleRefSourceRole | ArtifactSourceRole | TextResultRole | GeneratedResultRole | RefinementRole, Field(discriminator="type")]


class CanvasNodeLayout(BaseModel):
    displayName: str
    x: float
    y: float
    width: float | None = None
    tags: list[str] = Field(default_factory=list)
    role: CanvasRole | None = None


class GenerationParams(BaseModel):
    model: str | None = None
    aspectRatio: str | None = None
    imageSize: str | None = None
    seed: int | None = Field(default=None, ge=0)
    batchCount: int = Field(default=1, ge=1, le=8)


class ChatTurnSettings(BaseModel):
    model: str
    aspectRatio: str
    imageSize: str
    thinkingLevel: str | None = None
    includeThoughts: bool = False


class ChatAttachment(BaseModel):
    kind: Literal["asset"] = "asset"
    assetId: str
    purpose: Literal["source", "reference"] = "reference"


class ChatTurn(BaseModel):
    id: str
    role: Literal["user", "model"]
    createdAt: str
    text: str = ""
    settings: ChatTurnSettings
    attachments: list[ChatAttachment] = Field(default_factory=list)
    generatedAssetIds: list[str] = Field(default_factory=list)


class ChatSource(BaseModel):
    assetId: str
    canvasNodeId: str | None = None


class ChatProviderState(BaseModel):
    name: str = "google-genai"
    model: str
    history: list[dict[str, Any]] = Field(default_factory=list)


class ChatSessionDocument(BaseModel):
    version: int = 1
    id: str
    projectSlug: str
    status: Literal["active", "archived"] = "active"
    title: str
    source: ChatSource
    createdAt: str
    updatedAt: str
    archivedAt: str | None = None
    defaults: ChatTurnSettings
    protectedAssetIds: list[str] = Field(default_factory=list)
    turns: list[ChatTurn] = Field(default_factory=list)
    provider: ChatProviderState


class ChatSessionCreate(BaseModel):
    sourceAssetId: str
    canvasNodeId: str | None = None
    title: str | None = Field(default=None, min_length=1)


class ChatSessionPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    archived: bool | None = None


class ChatTurnRequest(BaseModel):
    text: str = Field(min_length=1)
    attachmentAssetIds: list[str] = Field(default_factory=list)
    settings: ChatTurnSettings | None = None


class ChatTurnResponse(BaseModel):
    session: ChatSessionDocument
    assets: list[AssetSummary]


class ArchivePatch(BaseModel):
    archived: bool = True


class DraftCanvasNode(CanvasNodeLayout):
    type: Literal["draft"] = "draft"
    refs: list[str] = Field(default_factory=list)
    prompt: str = ""
    params: GenerationParams = Field(default_factory=GenerationParams)
    visualStyleId: str | None = Field(default=None, pattern=TAG_RE)


class StoryArtifactCanvasNode(CanvasNodeLayout):
    type: Literal["storyArtifact"] = "storyArtifact"
    artifactKind: ArtifactKind
    artifactKey: str
    promptPath: str
    prompt: str = ""
    refs: list[str] = Field(default_factory=list)
    params: GenerationParams = Field(default_factory=GenerationParams)
    visualStyleId: str | None = Field(default=None, pattern=TAG_RE)
    generatedAssetIds: list[str] = Field(default_factory=list)


class ImageGroupCanvasNode(CanvasNodeLayout):
    type: Literal["imageGroup"] = "imageGroup"
    assetIds: list[str] = Field(default_factory=list, min_length=1)
    activeAssetId: str | None = None

    @model_validator(mode="after")
    def active_asset_defaults_to_first(self) -> "ImageGroupCanvasNode":
        if self.activeAssetId is None or self.activeAssetId not in self.assetIds:
            self.activeAssetId = self.assetIds[0]
        return self


CanvasNode = Annotated[DraftCanvasNode | StoryArtifactCanvasNode | ImageGroupCanvasNode, Field(discriminator="type")]


class CanvasDocument(BaseModel):
    version: int = 2
    viewport: dict[str, float] = Field(
        default_factory=lambda: {"x": 0.0, "y": 0.0, "zoom": 1.0}
    )
    nodes: dict[str, CanvasNode] = Field(default_factory=dict)


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1)
    refs: list[str] = Field(default_factory=list)
    model: str | None = None
    aspectRatio: str | None = None
    imageSize: str | None = None
    seed: int | None = Field(default=None, ge=0)
    batchCount: int = Field(default=1, ge=1, le=8)
    title: str | None = Field(default=None, min_length=1)
    tags: list[str] = Field(default_factory=list)
    canvasNodeId: str | None = None
    visualStyleId: str | None = Field(default=None, pattern=TAG_RE)

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, tags: list[str]) -> list[str]:
        import re

        for tag in tags:
            if not re.match(TAG_RE, tag):
                raise ValueError(f"Invalid tag slug: {tag}")
        return tags

    @model_validator(mode="after")
    def validate_model_capabilities(self) -> "GenerateRequest":
        if self.model is None:
            return self
        capabilities = MODEL_CAPABILITIES.get(self.model)
        if capabilities is None:
            raise ValueError(f"Unsupported model: {self.model}")
        if self.aspectRatio is not None and self.aspectRatio not in capabilities["aspectRatios"]:
            raise ValueError(f"Unsupported aspect ratio {self.aspectRatio} for model {self.model}")
        if self.imageSize is not None and self.imageSize not in capabilities["imageSizes"]:
            raise ValueError(f"Unsupported image size {self.imageSize} for model {self.model}")
        return self


class GenerateResponse(BaseModel):
    assets: list[AssetSummary]
