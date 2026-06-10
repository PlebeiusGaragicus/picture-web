"""Pydantic models for the photo-web API and library JSON."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

TAG_RE = r"^[a-z0-9]+(-[a-z0-9]+)*$"
SLUG_RE = r"^[a-z0-9]+(-[a-z0-9]+)*$"

AssetKind = Literal["imported", "generated"]
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


class ProjectMetadata(ProjectCreate):
    createdAt: str
    settings: dict[str, Any] = Field(default_factory=dict)


class ProjectDetail(BaseModel):
    project: ProjectMetadata
    assets: list[AssetSummary]


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


class ImageGroupCanvasNode(CanvasNodeLayout):
    type: Literal["imageGroup"] = "imageGroup"
    assetIds: list[str] = Field(default_factory=list, min_length=1)
    activeAssetId: str | None = None

    @model_validator(mode="after")
    def active_asset_defaults_to_first(self) -> "ImageGroupCanvasNode":
        if self.activeAssetId is None or self.activeAssetId not in self.assetIds:
            self.activeAssetId = self.assetIds[0]
        return self


CanvasNode = DraftCanvasNode | ImageGroupCanvasNode


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
