import type { CharacterRecord } from '../types';

export function slugifyKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function characterDisplayName(record: CharacterRecord): string {
  return record.name.trim() || record.slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function characterIsExtracted(record: CharacterRecord): boolean {
  const base = record.variants.base;
  return Boolean(record.visualDescription.trim() && base && base.prompt.trim());
}

export type CharacterHubState = 'Empty' | 'Extracted' | 'Generated';

export function characterHubState(record: CharacterRecord): CharacterHubState {
  if (record.variants.base?.assetIds?.length) return 'Generated';
  if (characterIsExtracted(record)) return 'Extracted';
  return 'Empty';
}
