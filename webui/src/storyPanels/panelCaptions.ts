import type { StoryPanel, StoryPanelDocument, StoryPanelRect } from '../types';

export const CAPTION_GRID_SNAP = 12;
const CAPTION_GRID_COLUMNS = 12;
const CAPTION_MIN_WIDTH = 0.5;
const CAPTION_MIN_HEIGHT = 0.25;

export function sortCaptionPanels(panels: StoryPanel[]) {
  return [...panels].sort((first, second) => first.order - second.order || first.rect.y - second.rect.y || first.id.localeCompare(second.id));
}

export function captionPanelsFor(document: StoryPanelDocument, parentPanelId: string) {
  return sortCaptionPanels(document.panels.filter((panel) => panel.parentPanelId === parentPanelId));
}

function roundCaptionStep(value: number) {
  return Math.round(value * CAPTION_GRID_SNAP) / CAPTION_GRID_SNAP;
}

export function clampCaptionRect(rect: StoryPanelRect): StoryPanelRect {
  const w = Math.min(CAPTION_GRID_COLUMNS, Math.max(CAPTION_MIN_WIDTH, roundCaptionStep(rect.w)));
  const h = Math.max(CAPTION_MIN_HEIGHT, roundCaptionStep(rect.h));
  const x = Math.min(CAPTION_GRID_COLUMNS - w, Math.max(0, roundCaptionStep(rect.x)));
  return { x, y: Math.max(0, roundCaptionStep(rect.y)), w, h };
}

export function defaultCaptionRect(parent: StoryPanel, captions: StoryPanel[]): StoryPanelRect {
  const gap = 1 / CAPTION_GRID_SNAP;
  const bottom = captions.length
    ? Math.max(...captions.map((caption) => caption.rect.y + caption.rect.h))
    : parent.rect.y + parent.rect.h;
  return clampCaptionRect({
    x: parent.rect.x,
    y: bottom + gap,
    w: parent.rect.w,
    h: 0.5,
  });
}

export function captionLabel(index: number) {
  return `Caption ${index + 1}`;
}

export function parentPanelFor(document: StoryPanelDocument, panel: StoryPanel) {
  if (!panel.parentPanelId) return null;
  return document.panels.find((candidate) => candidate.id === panel.parentPanelId) ?? null;
}

export function imageInfoHostFor(document: StoryPanelDocument, panel: StoryPanel | null) {
  if (!panel) return null;
  if (panel.sourceKind === 'caption') {
    const linkedParent = parentPanelFor(document, panel);
    if (linkedParent) return linkedParent;
    return document.panels.find((candidate) =>
      candidate.panelKind === 'image'
      && captionPanelsFor(document, candidate.id).some((caption) => caption.id === panel.id),
    ) ?? null;
  }
  if (panel.panelKind === 'image') return panel;
  return null;
}

export function panelKindHostFor(document: StoryPanelDocument, panel: StoryPanel | null) {
  if (!panel) return null;
  if (panel.sourceKind === 'caption') {
    return imageInfoHostFor(document, panel);
  }
  return panel;
}

export function removePanelAndCaptionChildren(document: StoryPanelDocument, panelId: string) {
  const childIds = new Set(
    document.panels.filter((panel) => panel.parentPanelId === panelId).map((panel) => panel.id),
  );
  return document.panels.filter((panel) => panel.id !== panelId && !childIds.has(panel.id));
}

export function captionSnapScaleFor(panel: Pick<StoryPanel, 'sourceKind'>) {
  return panel.sourceKind === 'caption' ? CAPTION_GRID_SNAP : null;
}
