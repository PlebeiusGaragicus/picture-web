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
ArtifactKind = Literal["character-sheet", "location-prompt", "concept-art"]
AdaptationFileKind = Literal["locations"]
ConceptArtSubjectKind = Literal["character", "location"]
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


EntityKind = Literal["character", "location", "style"]


class TagDefinition(BaseModel):
    id: str = Field(pattern=TAG_RE)
    name: str = Field(min_length=1)
    color: str = Field(pattern=TAG_COLOR_RE)
    locked: bool = False
    entityKind: EntityKind | None = None
    # Entity tags only: the image that keeps this entity consistent — attached
    # as a generation reference wherever the entity appears.
    canonicalAssetId: str | None = None


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


class TagCanonicalPatch(BaseModel):
    assetId: str | None = None


class ProjectCoverPatch(BaseModel):
    coverAssetId: str | None = None


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


class CharacterVariant(BaseModel):
    label: str = ""
    # When this look applies in the story, e.g. "after the duel in chapter 2".
    storyContext: str = ""
    mode: str = "new-image"
    styleRef: str = ""
    prompt: str = ""
    assetIds: list[str] = Field(default_factory=list)
    activeAssetId: str | None = None
    finalized: bool = False
    status: Literal["missing", "ready", "generated"] = "missing"


class CharacterRecord(BaseModel):
    slug: str = Field(pattern=SLUG_RE)
    name: str = ""
    summary: str = ""
    visualDescription: str = ""
    performanceNotes: str = ""
    continuityNotes: str = ""
    userTags: list[str] = Field(default_factory=list)
    variants: dict[str, CharacterVariant] = Field(default_factory=dict)
    createdAt: str = ""
    updatedAt: str = ""


class CharacterCreate(BaseModel):
    name: str = Field(min_length=1)
    summary: str = ""
    slug: str | None = Field(default=None, pattern=SLUG_RE)


class CharacterVariantPatch(BaseModel):
    label: str | None = None
    storyContext: str | None = None
    mode: str | None = None
    styleRef: str | None = None
    prompt: str | None = None


class CharacterPatch(BaseModel):
    slug: str | None = Field(default=None, pattern=SLUG_RE)
    name: str | None = None
    summary: str | None = None
    visualDescription: str | None = None
    performanceNotes: str | None = None
    continuityNotes: str | None = None
    userTags: list[str] | None = None
    variants: dict[str, CharacterVariantPatch] | None = None
    removeVariants: list[str] | None = None


class AdaptationMetadata(BaseModel):
    version: int = 3
    characters: dict[str, CharacterRecord] = Field(default_factory=dict)
    locations: dict[str, AdaptationAssetLink] = Field(default_factory=dict)


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
    hasBook: bool
    hasBookSession: bool
    counts: dict[str, int]
    visualStyles: list[VisualStyleDefinition]
    defaultVisualStyleId: str | None = Field(default=None, pattern=TAG_RE)
    characters: dict[str, CharacterRecord]
    locations: dict[str, AdaptationAssetLink]


AgentSessionKind = Literal[
    "read-book",
    "discover-characters",
    "extract-character",
    "extract-all-characters",
    "refine-character",
    "suggest-concept-character",
    "suggest-concept-location",
    "draft-panel-prompt",
    "refine-panel-prompt",
]
AgentSessionStatus = Literal["running", "succeeded", "failed", "archived"]


PiTaskState = Literal["starting", "running", "aborting", "done", "failed", "cancelled"]


class PiTaskStartRequest(BaseModel):
    profile: str
    target: str | None = None
    force: bool = False
    instructions: str | None = None


class PiTaskStatus(BaseModel):
    taskId: str
    projectSlug: str
    profile: str
    title: str
    target: str | None = None
    state: PiTaskState
    startedAt: str
    completedAt: str | None = None
    error: str | None = None
    piSessionId: str | None = None
    lastSeq: int | None = None


class PiTaskAbortResponse(BaseModel):
    cancelled: bool


class AgentSessionDocument(BaseModel):
    version: int = 1
    id: str
    projectSlug: str
    title: str
    kind: AgentSessionKind
    status: AgentSessionStatus
    createdAt: str
    updatedAt: str
    completedAt: str | None = None
    archivedAt: str | None = None
    piSessionId: str | None = None
    piSessionFile: str | None = None
    parentSessionId: str | None = None
    source: dict[str, Any] = Field(default_factory=dict)
    logFiles: dict[str, str] = Field(default_factory=dict)
    error: str | None = None
    stats: dict[str, Any] | None = None


class AgentSessionPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    archived: bool | None = None


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


class AdaptationCanvasImportResponse(BaseModel):
    canvas: CanvasDocument
    importedNodeCount: int
    nodeId: str | None = None


class ConceptCardDocument(BaseModel):
    version: int = 1
    id: str
    projectSlug: str
    subjectKind: ConceptArtSubjectKind
    displayName: str = ""
    prompt: str = ""
    assetIds: list[str] = Field(default_factory=list)
    activeAssetId: str | None = None
    createdAt: str
    updatedAt: str
    archivedAt: str | None = None


class ConceptNodeCreate(BaseModel):
    subjectKind: ConceptArtSubjectKind
    prompt: str | None = None
    displayName: str = ""


class ConceptCardPatch(BaseModel):
    displayName: str | None = None
    prompt: str | None = None
    subjectKind: ConceptArtSubjectKind | None = None
    archived: bool | None = None


class ConceptNodeResponse(BaseModel):
    nodeId: str
    canvas: CanvasDocument


class ImageGroupNodeCreate(BaseModel):
    displayName: str = ""
    tags: list[str] = Field(default_factory=list)
    prompt: str = ""
    refs: list[str] = Field(default_factory=list)
    visualStyleId: str | None = Field(default=None, pattern=TAG_RE)


class ImageGroupNodeResponse(BaseModel):
    nodeId: str
    canvas: CanvasDocument


class AdaptationImportArtifactRequest(BaseModel):
    artifactKind: ArtifactKind
    artifactKey: str = Field(pattern=SLUG_RE)


class AdaptationFileBase(BaseModel):
    key: str = Field(pattern=SLUG_RE)
    body: str = ""
    mode: str = ""
    styleRef: str = ""
    subjectKind: ConceptArtSubjectKind | None = None


class AdaptationFileCreate(AdaptationFileBase):
    pass


class AdaptationFileUpdate(BaseModel):
    key: str | None = Field(default=None, pattern=SLUG_RE)
    body: str | None = None
    mode: str | None = None
    styleRef: str | None = None
    subjectKind: ConceptArtSubjectKind | None = None
    userTags: list[str] | None = None


class AdaptationFileDocument(AdaptationFileBase):
    kind: AdaptationFileKind
    promptPath: str
    artifactKind: ArtifactKind
    status: Literal["missing", "ready", "generated"] = "missing"


class StoryPanelRect(BaseModel):
    """Layout rect in page-grid columns/rows.

    Single-page rects use columns 0-12. Panels that span a two-page spread use
    a unified 24-column space (columns 0-12 = left page, 12-24 = right page);
    the 12-column bound is enforced per panel via `spansSpread`.
    """

    x: float = Field(ge=0, le=2 * LAYOUT_GRID_COLUMNS)
    y: float = Field(ge=0)
    w: float = Field(ge=0.25, le=2 * LAYOUT_GRID_COLUMNS)
    h: float = Field(ge=0.25, le=12)

    @model_validator(mode="after")
    def fits_page_grid(self) -> "StoryPanelRect":
        if self.x + self.w > 2 * LAYOUT_GRID_COLUMNS:
            raise ValueError("Panel layout must fit within the 24-column spread grid")
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


class StoryPanelCaptionTail(BaseModel):
    """Tip of a dialogue bubble's tail, in page-grid coordinates (24-column space on spanning parents)."""

    x: float = Field(ge=0, le=2 * LAYOUT_GRID_COLUMNS)
    y: float = Field(ge=0, le=LAYOUT_PAGE_ROWS)


class StoryPanelCaption(BaseModel):
    id: str = Field(pattern=TAG_RE)
    visibleText: str = ""
    richText: str = ""
    textStyle: StoryPanelTextStyle = Field(default_factory=StoryPanelTextStyle)
    rect: StoryPanelRect
    tail: StoryPanelCaptionTail | None = None
    layer: int = Field(default=0, ge=0)


class StoryPanelImagePrompt(BaseModel):
    id: str = Field(pattern=TAG_RE)
    text: str = ""


class StoryPanelImagePromptWrite(BaseModel):
    text: str
    characterSlugs: list[str] | None = None
    locationSlug: str | None = None


class StoryPanel(BaseModel):
    id: str = Field(pattern=TAG_RE)
    order: int = Field(ge=0)
    title: str = Field(default="", max_length=120)
    sourceKind: Literal["panel", "bookmark"] = "panel"
    startOffset: int | None = Field(default=None, ge=0)
    endOffset: int | None = Field(default=None, ge=0)
    selectedText: str = ""
    storyText: str = ""
    visibleText: str = ""
    richText: str = ""
    textStyle: StoryPanelTextStyle = Field(default_factory=StoryPanelTextStyle)
    pageId: str | None = None
    panelKind: Literal["image", "text"] = "image"
    spansSpread: bool = False
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
    captions: list[StoryPanelCaption] = Field(default_factory=list)
    imagePrompts: list[StoryPanelImagePrompt] = Field(default_factory=list)
    characterSlugs: list[str] = Field(default_factory=list)
    locationSlug: str | None = None
    finalized: bool = False

    @model_validator(mode="after")
    def validate_offsets_and_active_asset(self) -> "StoryPanel":
        has_start = self.startOffset is not None
        has_end = self.endOffset is not None
        if has_start != has_end:
            raise ValueError("Panel book offsets must be set together")
        if has_start and has_end:
            assert self.startOffset is not None and self.endOffset is not None
            if self.endOffset <= self.startOffset:
                raise ValueError("Panel endOffset must be greater than startOffset")
        if self.sourceKind == "bookmark":
            if self.startOffset is None or self.endOffset is None:
                raise ValueError("Bookmark items must have book offsets")
            if self.parentPanelId is not None:
                raise ValueError("Bookmark items must not have parentPanelId")
            if self.pageId is not None:
                raise ValueError("Bookmark items must not be placed on the layout")
        elif self.parentPanelId is not None:
            raise ValueError("Captions must be stored on their parent panel")
        if self.activeAssetId is not None and self.activeAssetId not in self.assetIds:
            raise ValueError("activeAssetId must be attached to the panel")
        if not self.spansSpread:
            if self.rect.x + self.rect.w > LAYOUT_GRID_COLUMNS + 1e-9:
                raise ValueError("Panel layout must fit within the 12-column page grid")
            for caption in self.captions:
                if caption.rect.x + caption.rect.w > LAYOUT_GRID_COLUMNS + 1e-9:
                    raise ValueError("Caption layout must fit within the 12-column page grid")
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
        caption_ids = [caption.id for panel in self.panels for caption in panel.captions]
        if len(caption_ids) != len(set(caption_ids)):
            raise ValueError("Duplicate caption ids")
        overlap_ids = set(panel_ids).intersection(caption_ids)
        if overlap_ids:
            raise ValueError(f"Caption id duplicates panel id: {sorted(overlap_ids)[0]}")
        page_id_set = set(page_ids)
        for panel in self.panels:
            if panel.pageId is not None and panel.pageId not in page_id_set:
                raise ValueError(f"Panel references unknown page: {panel.pageId}")
        ranges = sorted(
            (panel.startOffset, panel.endOffset, panel.id)
            for panel in self.panels
            if panel.sourceKind == "panel" and panel.startOffset is not None and panel.endOffset is not None
        )
        for previous, current in zip(ranges, ranges[1:]):
            if previous[1] > current[0]:
                raise ValueError(f"Panel text ranges overlap: {previous[2]} and {current[2]}")
        return self


class StoryPanelCreate(BaseModel):
    startOffset: int | None = Field(default=None, ge=0)
    endOffset: int | None = Field(default=None, ge=0)
    selectedText: str = ""
    title: str = Field(default="", max_length=120)
    storyText: str = ""
    visibleText: str = ""
    imagePrompts: list[StoryPanelImagePrompt] = Field(default_factory=list)
    insertAfterPanelId: str | None = Field(default=None, pattern=TAG_RE)
    autoPlace: bool = True
    pageId: str | None = Field(default=None, pattern=TAG_RE)
    panelKind: Literal["image", "text"] = "image"
    rect: StoryPanelRect | None = None
    layer: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def validate_offsets(self) -> "StoryPanelCreate":
        if (self.startOffset is None) != (self.endOffset is None):
            raise ValueError("Panel book offsets must be set together")
        if self.startOffset is not None and self.endOffset is not None and self.endOffset <= self.startOffset:
            raise ValueError("Panel endOffset must be greater than startOffset")
        return self


class StoryPanelBookmarkCreate(BaseModel):
    startOffset: int = Field(ge=0)
    endOffset: int = Field(ge=0)
    selectedText: str = ""
    title: str = Field(default="", max_length=120)
    insertAfterPanelId: str | None = Field(default=None, pattern=TAG_RE)

    @model_validator(mode="after")
    def validate_bookmark(self) -> "StoryPanelBookmarkCreate":
        if self.endOffset <= self.startOffset:
            raise ValueError("Bookmark endOffset must be greater than startOffset")
        return self


class StoryPanelPatch(BaseModel):
    order: int | None = Field(default=None, ge=0)
    title: str | None = Field(default=None, max_length=120)
    sourceKind: Literal["panel", "bookmark"] | None = None
    startOffset: int | None = Field(default=None, ge=0)
    endOffset: int | None = Field(default=None, ge=0)
    selectedText: str | None = None
    storyText: str | None = None
    visibleText: str | None = None
    richText: str | None = None
    textStyle: StoryPanelTextStyle | None = None
    pageId: str | None = Field(default=None, pattern=TAG_RE)
    panelKind: Literal["image", "text"] | None = None
    spansSpread: bool | None = None
    rect: StoryPanelRect | None = None
    layer: int | None = Field(default=None, ge=0)
    parentPanelId: str | None = Field(default=None, pattern=TAG_RE)
    assetIds: list[str] | None = None
    activeAssetId: str | None = None
    aspectRatio: str | None = None
    aspectRatioLocked: bool | None = None
    imageCrop: StoryPanelImageCrop | None = None
    captions: list[StoryPanelCaption] | None = None
    imagePrompts: list[StoryPanelImagePrompt] | None = None
    characterSlugs: list[str] | None = None
    locationSlug: str | None = None
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


class CanvasNodeLayout(BaseModel):
    displayName: str
    x: float
    y: float
    width: float | None = None
    tags: list[str] = Field(default_factory=list)


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


class CanvasNodeOrigin(BaseModel):
    """The domain object that spawned this node (results attach back to it)."""

    kind: Literal["panel", "conceptCard"]
    id: str


class CanvasNode(CanvasNodeLayout):
    """The one canvas node: an image made from a prompt.

    An empty ``assetIds`` stack is the draft state (no pixels yet); generation
    fills the stack in place. ``refs``/``prompt``/``params`` always hold the
    recipe for the node's next generation.
    """

    refs: list[str] = Field(default_factory=list)
    prompt: str = ""
    params: GenerationParams = Field(default_factory=GenerationParams)
    visualStyleId: str | None = Field(default=None, pattern=TAG_RE)
    assetIds: list[str] = Field(default_factory=list)
    activeAssetId: str | None = None
    origin: CanvasNodeOrigin | None = None

    @model_validator(mode="after")
    def active_asset_defaults_to_first(self) -> "CanvasNode":
        if not self.assetIds:
            self.activeAssetId = None
        elif self.activeAssetId is None or self.activeAssetId not in self.assetIds:
            self.activeAssetId = self.assetIds[0]
        return self

    @property
    def is_draft(self) -> bool:
        return not self.assetIds


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
