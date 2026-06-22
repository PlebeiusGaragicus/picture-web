import type { StoryPanel, StoryPanelDocument, StoryPanelPage } from '../types';
import { storyPageNumberById } from './pageNumbers';

export function panelIsPlacedOnLayout(pages: StoryPanelPage[], panel: Pick<StoryPanel, 'pageId' | 'sourceKind'>): boolean {
  if (!panel.pageId) return false;
  if (panel.sourceKind === 'story') {
    return storyPageNumberById(pages).has(panel.pageId);
  }
  return pages.some((page) => page.id === panel.pageId);
}

export function removeStoryPanelFromLayout(document: StoryPanelDocument, panelId: string): StoryPanelDocument {
  const childIds = new Set(
    document.panels.filter((panel) => panel.parentPanelId === panelId).map((panel) => panel.id),
  );
  return {
    ...document,
    panels: document.panels
      .filter((panel) => !childIds.has(panel.id))
      .map((panel) => (
        panel.id === panelId
          ? { ...panel, pageId: null }
          : panel
      )),
  };
}
