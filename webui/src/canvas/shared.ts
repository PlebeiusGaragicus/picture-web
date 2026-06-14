import type { ArtifactKind, Asset, GenerationParams } from '../types';

export const defaultDraftParams: GenerationParams = { model: 'gemini-3.1-flash-image', aspectRatio: '16:9', imageSize: '1K', seed: null, batchCount: 1 };

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
