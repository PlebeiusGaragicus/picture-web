"""Pydantic models for the photo-web API and library JSON."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

TAG_RE = r"^[a-z0-9]+(-[a-z0-9]+)*$"
SLUG_RE = r"^[a-z0-9]+(-[a-z0-9]+)*$"

AssetKind = Literal["imported", "generated"]


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


class ProviderCapture(BaseModel):
    name: str = "google-genai"
    response: dict[str, Any] = Field(default_factory=dict)


class AssetMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kind: AssetKind
    title: str
    tags: list[str] = Field(default_factory=list)
    createdAt: str
    updatedAt: str
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


class CanvasNode(BaseModel):
    x: float
    y: float
    width: float | None = None


class CanvasStack(BaseModel):
    runId: str
    collapsed: bool = True


class CanvasDocument(BaseModel):
    version: int = 1
    viewport: dict[str, float] = Field(
        default_factory=lambda: {"x": 0.0, "y": 0.0, "zoom": 1.0}
    )
    nodes: dict[str, CanvasNode] = Field(default_factory=dict)
    stacks: list[CanvasStack] = Field(default_factory=list)


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

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, tags: list[str]) -> list[str]:
        import re

        for tag in tags:
            if not re.match(TAG_RE, tag):
                raise ValueError(f"Invalid tag slug: {tag}")
        return tags


class GenerateResponse(BaseModel):
    assets: list[AssetSummary]
