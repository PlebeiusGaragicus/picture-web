import type { StoryPanelPage } from '../types';

export function sortedStoryPages(pages: StoryPanelPage[]) {
  return pages
    .filter((page) => page.pageKind === 'story')
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function storyPageNumberById(pages: StoryPanelPage[]) {
  return new Map(sortedStoryPages(pages).map((page, index) => [page.id, index + 1]));
}

export function storyPagePlacementLabel(pages: StoryPanelPage[], pageId: string | null) {
  if (!pageId) return 'Not placed';
  const pageNumber = storyPageNumberById(pages).get(pageId);
  return pageNumber ? `Page ${pageNumber}` : 'Not placed';
}
