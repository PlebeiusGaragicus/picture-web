import { modelCapabilities } from '../canvas/shared';
import type { StoryPanel, StoryPanelRect } from '../types';
import { PRINT_PAGE_HEIGHT, PRINT_PAGE_WIDTH } from './printLayout';

export const PAGE_LAYOUT_ASPECT = PRINT_PAGE_WIDTH / PRINT_PAGE_HEIGHT;
export const LAYOUT_GRID_COLUMNS = 12;

export const GEMINI_IMAGE_ASPECT_RATIOS = Array.from(
  new Set(Object.values(modelCapabilities).flatMap((capabilities) => capabilities.aspectRatios)),
).sort((first, second) => parseAspectRatio(first) - parseAspectRatio(second));

export function parseAspectRatio(value: string): number {
  const trimmed = value.trim();
  if (trimmed.includes(':')) {
    const [width, height] = trimmed.split(':').map((part) => Number(part));
    if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) {
      throw new Error(`Invalid aspect ratio: ${value}`);
    }
    return width / height;
  }
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Invalid aspect ratio: ${value}`);
  }
  return numeric;
}

export function formatAspectRatioFromPixels(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const scale = 1000;
  const reducedWidth = Math.max(1, Math.round(width));
  const reducedHeight = Math.max(1, Math.round(height));
  const divisor = gcd(reducedWidth, reducedHeight);
  return `${reducedWidth / divisor}:${reducedHeight / divisor}`;
}

export function nearestGeminiAspectRatio(ratio: number): string {
  return GEMINI_IMAGE_ASPECT_RATIOS.reduce((best, candidate) => (
    Math.abs(parseAspectRatio(candidate) - ratio) < Math.abs(parseAspectRatio(best) - ratio)
      ? candidate
      : best
  ));
}

export function panelVisualAspectRatio(rect: StoryPanelRect, pageRows: number): number {
  const rows = Math.max(1, pageRows);
  return (rect.w * rows * PAGE_LAYOUT_ASPECT) / (rect.h * LAYOUT_GRID_COLUMNS);
}

export function pageRowsForPanels(panels: StoryPanel[], pageId: string): number {
  return Math.max(
    10,
    ...panels.filter((panel) => panel.pageId === pageId).map((panel) => panel.rect.y + panel.rect.h),
  );
}

export function snapRectToAspectRatio(
  rect: StoryPanelRect,
  pageRows: number,
  targetAspect: number,
  panelKind: StoryPanel['panelKind'],
  clampRect: (rect: StoryPanelRect, panelKind: StoryPanel['panelKind']) => StoryPanelRect,
): StoryPanelRect {
  const rows = Math.max(1, pageRows);
  const nextHeight = (rect.w * rows * PAGE_LAYOUT_ASPECT) / (targetAspect * LAYOUT_GRID_COLUMNS);
  return clampRect({ ...rect, h: nextHeight }, panelKind);
}

export function enforceLockedAspectOnResize(
  rect: StoryPanelRect,
  anchor: StoryPanelRect,
  corner: 'nw' | 'ne' | 'sw' | 'se',
  pageRows: number,
  targetAspect: number,
  panelKind: StoryPanel['panelKind'],
  clampRect: (rect: StoryPanelRect, panelKind: StoryPanel['panelKind']) => StoryPanelRect,
): StoryPanelRect {
  const rows = Math.max(1, pageRows);
  const width = rect.w;
  const height = (width * rows * PAGE_LAYOUT_ASPECT) / (targetAspect * LAYOUT_GRID_COLUMNS);
  const right = anchor.x + anchor.w;
  const bottom = anchor.y + anchor.h;

  if (corner === 'se') {
    return clampRect({ x: anchor.x, y: anchor.y, w: width, h: height }, panelKind);
  }
  if (corner === 'nw') {
    return clampRect({ x: right - width, y: bottom - height, w: width, h: height }, panelKind);
  }
  if (corner === 'ne') {
    return clampRect({ x: anchor.x, y: bottom - height, w: width, h: height }, panelKind);
  }
  return clampRect({ x: right - width, y: anchor.y, w: width, h: height }, panelKind);
}

export function loadImageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('Failed to load image dimensions'));
    image.src = url;
  });
}
