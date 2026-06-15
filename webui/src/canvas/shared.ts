import type { ArtifactKind, Asset, GenerationParams, TagDefinition } from '../types';

export const defaultDraftParams: GenerationParams = { model: 'gemini-3.1-flash-image', aspectRatio: '16:9', imageSize: '1K', seed: null, batchCount: 1 };
export const SYSTEM_TAGS = new Set([
  'adaptation',
  'archetype',
  'character-sheet',
  'character-style',
  'comic-adaptation',
  'generated',
  'generated-image',
  'imported-image',
  'location',
  'page',
  'panel',
  'scene-style',
  'text-result',
  'visual-style',
]);
export const tagColorOptions = [
  { color: '#ef4444', label: 'Red' },
  { color: '#f59e0b', label: 'Orange' },
  { color: '#facc15', label: 'Yellow' },
  { color: '#22c55e', label: 'Green' },
  { color: '#3b82f6', label: 'Blue' },
  { color: '#c084fc', label: 'Purple' },
  { color: '#cbd5e1', label: 'Gray' },
] as const;
export const tagColors = tagColorOptions.map((option) => option.color);

export function normalizeTagName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function isValidTagName(value: string) {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
}

export function isEntityTag(tagId: string, projectTags: TagDefinition[]): boolean {
  return projectTags.some((tag) => tag.id === tagId && tag.locked);
}

export function lockedEntityTagIds(projectTags: TagDefinition[]): Set<string> {
  return new Set(projectTags.filter((tag) => tag.locked).map((tag) => tag.id));
}

export function mergeAvailableUserTags(projectTags: TagDefinition[], assets: Asset[]): TagDefinition[] {
  const byId = new Map(projectTags.map((tag) => [tag.id, tag]));
  assets.forEach((asset) => {
    asset.tags.forEach((tagId) => {
      if (!SYSTEM_TAGS.has(tagId) && !byId.has(tagId)) {
        byId.set(tagId, { id: tagId, name: tagId, color: '#64748b' });
      }
    });
  });
  return Array.from(byId.values()).sort((first, second) => first.name.localeCompare(second.name));
}

export const modelCapabilities: Record<string, { aspectRatios: string[]; imageSizes: string[] }> = {
  'gemini-2.5-flash-image': {
    aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    imageSizes: ['1K', '2K', '4K'],
  },
  'gemini-3.1-flash-image': {
    aspectRatios: ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'],
    imageSizes: ['512', '1K', '2K', '4K'],
  },
  'gemini-3-pro-image': {
    aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    imageSizes: ['1K', '2K', '4K'],
  },
};

export function visibleDisplayName(displayName: string) {
  return /^(Draft|Generated\s+[0-9A-Z]+)$/i.test(displayName.trim()) ? '' : displayName;
}

export function assetLabel(asset: Asset | null | undefined, fallback = 'Untitled image') {
  return asset?.title?.trim() || fallback;
}

export function uniqueOptions(options: string[], current: string | null | undefined) {
  return Array.from(new Set(current ? [...options, current] : options));
}

export function capabilitiesForModel(model: string | null | undefined) {
  return modelCapabilities[model ?? ''] ?? modelCapabilities[defaultDraftParams.model ?? 'gemini-3.1-flash-image'];
}

export function normalizedParamsForModel(params: GenerationParams, model: string) {
  const capabilities = capabilitiesForModel(model);
  return {
    ...params,
    model,
    aspectRatio: capabilities.aspectRatios.includes(params.aspectRatio ?? '') ? params.aspectRatio : capabilities.aspectRatios[0],
    imageSize: capabilities.imageSizes.includes(params.imageSize ?? '') ? params.imageSize : capabilities.imageSizes[0],
  };
}

export function artifactKindLabel(kind: ArtifactKind) {
  const labels: Record<ArtifactKind, string> = {
    'character-sheet': 'Character Sheet',
    'location-prompt': 'Location Prompt',
    'scene-artifact': 'Scene Artifact',
    'page-plan': 'Page Plan',
    'panel-prompt': 'Panel Prompt',
  };
  return labels[kind];
}
