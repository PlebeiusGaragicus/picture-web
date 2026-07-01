import type { StoryPanel, StoryPanelDocument } from '../types';

export function isPanel(panel: Pick<StoryPanel, 'sourceKind'>): boolean {
  return panel.sourceKind === 'panel';
}

export function isBookmark(panel: Pick<StoryPanel, 'sourceKind'>): boolean {
  return panel.sourceKind === 'bookmark';
}

export function isCaption(panel: Pick<StoryPanel, 'sourceKind' | 'parentPanelId'>): boolean {
  return isPanel(panel) && Boolean(panel.parentPanelId);
}

export function isBookLinked(panel: StoryPanel): panel is StoryPanel & { startOffset: number; endOffset: number } {
  return panel.startOffset !== null && panel.endOffset !== null;
}

export function isUnplaced(panel: StoryPanel): boolean {
  return isPanel(panel) && panel.parentPanelId == null && panel.pageId === null;
}

export function topLevelPanels(panels: StoryPanel[]) {
  return panels.filter((panel) => isPanel(panel) && panel.parentPanelId == null);
}

export function layoutPanels(document: StoryPanelDocument) {
  return document.panels.filter((panel) => isPanel(panel) && panel.pageId !== null);
}
