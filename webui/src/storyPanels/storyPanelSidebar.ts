import type { StoryPanel } from '../types';

export type SidebarItemKind = 'story' | 'draft' | 'note' | 'bookmark';

export type SidebarFilter = 'all' | SidebarItemKind;

export const SIDEBAR_FILTER_OPTIONS: Array<{ id: SidebarFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'story', label: 'Panels' },
  { id: 'note', label: 'Notes' },
  { id: 'bookmark', label: 'Bookmarks' },
  { id: 'draft', label: 'Drafts' },
];

export function isSidebarItem(panel: StoryPanel): panel is StoryPanel & { sourceKind: SidebarItemKind } {
  if (panel.sourceKind === 'draft') return true;
  if (panel.sourceKind === 'story' || panel.sourceKind === 'note' || panel.sourceKind === 'bookmark') {
    return panel.startOffset !== null && panel.endOffset !== null;
  }
  return false;
}

export function sidebarItemLabel(kind: SidebarItemKind) {
  switch (kind) {
    case 'story':
      return 'Panel';
    case 'draft':
      return 'Draft';
    case 'note':
      return 'Note';
    case 'bookmark':
      return 'Bookmark';
  }
}

export function sortSidebarItems(panels: StoryPanel[]) {
  return panels
    .filter(isSidebarItem)
    .sort((a, b) => (
      a.startOffset !== null && b.startOffset !== null
        ? a.startOffset - b.startOffset || a.order - b.order
        : a.order - b.order
    ));
}

export function filterSidebarItems(panels: StoryPanel[], filter: SidebarFilter) {
  const sorted = sortSidebarItems(panels);
  if (filter === 'all') return sorted;
  return sorted.filter((panel) => panel.sourceKind === filter);
}

export function sidebarItemPrimaryText(panel: StoryPanel) {
  if (panel.sourceKind === 'note') return panel.customText.trim();
  if (panel.sourceKind === 'bookmark') return panel.customText.trim() || panel.selectedText.trim();
  return panel.customText || panel.selectedText;
}

export function sidebarItemSecondaryText(panel: StoryPanel) {
  if (panel.sourceKind === 'note') return panel.selectedText.trim();
  if (panel.sourceKind === 'bookmark' && panel.customText.trim() && panel.selectedText.trim() !== panel.customText.trim()) {
    return panel.selectedText.trim();
  }
  return '';
}

export function bookAnchorPanels(panels: StoryPanel[]) {
  return panels.filter(
    (panel) => (panel.sourceKind === 'story' || panel.sourceKind === 'note' || panel.sourceKind === 'bookmark')
      && panel.startOffset !== null
      && panel.endOffset !== null,
  );
}
