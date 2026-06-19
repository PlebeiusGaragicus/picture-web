import type { AdaptationStatus, Asset, MomentRefInput } from '../types';

const REFERENCE_LIMIT_25 = 3;
const REFERENCE_LIMIT_DEFAULT = 14;

export function referenceImageLimit(model?: string | null): number {
  const normalized = (model ?? 'gemini-3.1-flash-image').toLowerCase();
  if (normalized.includes('2.5-flash-image') || normalized.includes('2-5-flash-image')) {
    return REFERENCE_LIMIT_25;
  }
  return REFERENCE_LIMIT_DEFAULT;
}

function normalizeTagId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseSemanticRef(ref: string): { prefix: string; entityKey: string } | null {
  const index = ref.indexOf(':');
  if (index < 0) return null;
  return { prefix: ref.slice(0, index).trim(), entityKey: ref.slice(index + 1).trim() };
}

function refKind(prefix: string): MomentRefInput['kind'] {
  if (prefix === 'character' || prefix === 'character-sheet') return 'character';
  if (prefix === 'location' || prefix === 'location-prompt') return 'location';
  return 'unknown';
}

function parseRefsLine(styleRef: string): string[] {
  return styleRef.split(',').map((item) => item.trim()).filter(Boolean);
}

function taggedAssetIds(assets: Asset[], tagId: string): string[] {
  return assets
    .filter((asset) => asset.hasPixels && !asset.archivedAt && asset.tags.includes(tagId))
    .map((asset) => asset.id)
    .sort();
}

function missingDetail(kind: MomentRefInput['kind'], ref: string, tagId: string): string {
  if (kind === 'unknown') return `${ref} is not a supported character: or location: reference`;
  if (!tagId) return `${ref} is invalid`;
  return `${ref} has no tagged images — apply tag \`${tagId}\` on the canvas`;
}

export function momentRefInputs(
  refs: string,
  adaptation: AdaptationStatus,
  assets: Asset[],
  model?: string | null,
): {
  refInputs: MomentRefInput[];
  referenceImageCount: number;
  referenceImageLimit: number;
  referenceLimitExceeded: boolean;
  canGenerate: boolean;
} {
  const limit = referenceImageLimit(model);
  const tokens = parseRefsLine(refs);
  const entityTokens = tokens.filter((token) => {
    const parsed = parseSemanticRef(token);
    return parsed && refKind(parsed.prefix) !== 'unknown';
  });
  const inputs: MomentRefInput[] = [];

  if (!entityTokens.length) {
    inputs.push({
      ref: 'refs',
      kind: 'unknown',
      entityKey: '',
      tagId: '',
      ready: false,
      assetIds: [],
      detail: 'Panel refs must include at least one character: or location: reference',
    });
    return {
      refInputs: inputs,
      referenceImageCount: 0,
      referenceImageLimit: limit,
      referenceLimitExceeded: false,
      canGenerate: false,
    };
  }

  for (const token of tokens) {
    const parsed = parseSemanticRef(token);
    if (!parsed) {
      inputs.push({
        ref: token,
        kind: 'unknown',
        entityKey: '',
        tagId: '',
        ready: false,
        assetIds: [],
        detail: missingDetail('unknown', token, ''),
      });
      continue;
    }
    const kind = refKind(parsed.prefix);
    const tagId = kind === 'unknown' ? '' : normalizeTagId(parsed.entityKey);
    const assetIds = kind === 'unknown' ? [] : taggedAssetIds(assets, tagId);
    const ready = kind !== 'unknown' && assetIds.length > 0;
    let detail = ready ? '' : missingDetail(kind, token, tagId);
    if (!ready && kind !== 'unknown' && parsed.entityKey) {
      const known =
        kind === 'character'
          ? parsed.entityKey in adaptation.characters
          : parsed.entityKey in adaptation.locations;
      if (!known) {
        detail = `${token} is not a known entity key — use exact Visual Continuity slugs; apply tag \`${tagId}\` on the canvas`;
      }
    }
    inputs.push({
      ref: token,
      kind,
      entityKey: parsed.entityKey,
      tagId,
      ready,
      assetIds,
      detail,
    });
  }

  const referenceImageCount = inputs.reduce((sum, item) => sum + item.assetIds.length, 0);
  const referenceLimitExceeded = referenceImageCount > limit;
  const entityInputs = inputs.filter((item) => item.kind === 'character' || item.kind === 'location');
  const canGenerate =
    entityInputs.length > 0 &&
    entityInputs.every((item) => item.ready) &&
    !referenceLimitExceeded;

  return {
    refInputs: inputs,
    referenceImageCount,
    referenceImageLimit: limit,
    referenceLimitExceeded,
    canGenerate,
  };
}
