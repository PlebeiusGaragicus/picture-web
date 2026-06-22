import type { StoryPanel, StoryPanelDocument, StoryPanelRect } from '../types';

export function sortCaptionPanels(panels: StoryPanel[]) {
  return [...panels].sort((first, second) => first.order - second.order || first.rect.y - second.rect.y || first.id.localeCompare(second.id));
}

export function captionPanelsFor(document: StoryPanelDocument, parentPanelId: string) {
  return sortCaptionPanels(document.panels.filter((panel) => panel.parentPanelId === parentPanelId));
}

export function defaultCaptionRect(parent: StoryPanel, captions: StoryPanel[]): StoryPanelRect {
  const gap = 0.25;
  const bottom = captions.length
    ? Math.max(...captions.map((caption) => caption.rect.y + caption.rect.h))
    : parent.rect.y + parent.rect.h;
  return {
    x: parent.rect.x,
    y: bottom + (captions.length ? gap : gap),
    w: parent.rect.w,
    h: 1,
  };
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

export function removePanelAndCaptionChildren(document: StoryPanelDocument, panelId: string) {
  const childIds = new Set(
    document.panels.filter((panel) => panel.parentPanelId === panelId).map((panel) => panel.id),
  );
  return document.panels.filter((panel) => panel.id !== panelId && !childIds.has(panel.id));
}
