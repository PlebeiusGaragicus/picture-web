import type { AdaptationStatus, Asset, CanvasNode, StyleRefKind, StyleRefStatus } from './types';

export const styleRefKinds: StyleRefKind[] = ['archetype-character', 'archetype-scene'];

export function styleRefKindForTags(tags: string[]): StyleRefKind | null {
  if (tags.includes('character-style')) return 'archetype-character';
  if (tags.includes('scene-style')) return 'archetype-scene';
  return null;
}

export function styleRefKindForNode(node: CanvasNode): StyleRefKind | null {
  return styleRefKindForTags(node.tags);
}

export function isStyleRefDraftNode(node: CanvasNode): boolean {
  return node.type === 'draft' && styleRefKindForNode(node) !== null;
}

export function isStyleRefImageNode(node: CanvasNode): boolean {
  return node.type === 'imageGroup' && styleRefKindForNode(node) !== null;
}

export function styleRefStatusFromAdaptation(
  kind: StyleRefKind,
  adaptation: AdaptationStatus,
  assets: Asset[],
): StyleRefStatus & { asset: Asset | null } {
  const status = adaptation.styleRefStatuses?.[kind] ?? legacyStyleRefStatus(kind, adaptation);
  return {
    ...status,
    asset: assets.find((asset) => asset.id === status.assetId) ?? null,
  };
}

export function isCanonicalStyleRefAsset(adaptation: AdaptationStatus | null, assetId: string): boolean {
  if (!adaptation) return false;
  return styleRefKinds.some((kind) => adaptation.styleRefStatuses?.[kind]?.assetId === assetId)
    || adaptation.archetypeCharacterAssetId === assetId
    || adaptation.archetypeSceneAssetId === assetId;
}

export function styleRefImageNodeId(kind: StyleRefKind, adaptation: AdaptationStatus | null): string {
  return adaptation?.styleRefStatuses?.[kind]?.canvasImageNodeId ?? `${styleRefDraftNodeId(kind, adaptation)}_image`;
}

export function styleRefDraftNodeId(kind: StyleRefKind, adaptation: AdaptationStatus | null): string {
  return adaptation?.styleRefStatuses?.[kind]?.canvasDraftNodeId ?? (kind === 'archetype-character' ? 'archetype_archetype_character' : 'archetype_archetype_scene');
}

function legacyStyleRefStatus(kind: StyleRefKind, adaptation: AdaptationStatus): StyleRefStatus {
  const isCharacter = kind === 'archetype-character';
  const draftNodeId = isCharacter ? 'archetype_archetype_character' : 'archetype_archetype_scene';
  return {
    kind,
    promptPath: isCharacter ? 'style-refs/archetype-character.md' : 'style-refs/archetype-scene.md',
    promptText: isCharacter ? adaptation.archetypeCharacterPromptText ?? '' : adaptation.archetypeScenePromptText ?? '',
    assetId: isCharacter ? adaptation.archetypeCharacterAssetId ?? null : adaptation.archetypeSceneAssetId ?? null,
    canvasDraftNodeId: draftNodeId,
    canvasImageNodeId: `${draftNodeId}_image`,
  };
}
