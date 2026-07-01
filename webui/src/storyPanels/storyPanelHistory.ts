import type { StoryPanel, StoryPanelDocument } from '../types';
import { isCaption } from './panelModel';

export type StoryPanelHistoryEntry = {
  document: StoryPanelDocument;
  label: string;
};

function panelSnapshot(panel: StoryPanel) {
  return JSON.stringify(panel);
}

export function inferDocumentChangeLabel(before: StoryPanelDocument, after: StoryPanelDocument): string {
  if (after.pages.length !== before.pages.length) {
    const delta = after.pages.length - before.pages.length;
    if (delta > 1) return `Add ${delta} pages`;
    return delta > 0 ? 'Add page' : 'Delete page';
  }

  const beforePageOrder = before.pages.map((page) => page.id).join('\0');
  const afterPageOrder = after.pages.map((page) => page.id).join('\0');
  if (beforePageOrder !== afterPageOrder) return 'Reorder pages';

  const beforePanels = new Map(before.panels.map((panel) => [panel.id, panel]));
  const afterPanels = new Map(after.panels.map((panel) => [panel.id, panel]));
  const added = after.panels.filter((panel) => !beforePanels.has(panel.id));
  const removed = before.panels.filter((panel) => !afterPanels.has(panel.id));

  if (removed.length === 1 && added.length === 0) {
    const panel = removed[0];
    if (isCaption(panel)) return 'Delete caption';
    if (panel.sourceKind === 'panel') return 'Remove panel from layout';
    return 'Delete panel';
  }

  if (added.length === 1 && removed.length === 0) {
    const panel = added[0];
    if (isCaption(panel)) return 'Add caption';
    return 'Add panel';
  }

  const changed = after.panels.filter((panel) => {
    const previous = beforePanels.get(panel.id);
    return previous && panelSnapshot(previous) !== panelSnapshot(panel);
  });

  if (changed.length === 1) {
    const next = changed[0];
    const previous = beforePanels.get(next.id)!;
    if (previous.pageId !== next.pageId) return 'Move panel to another page';
    const moved = previous.rect.x !== next.rect.x || previous.rect.y !== next.rect.y;
    const resized = previous.rect.w !== next.rect.w || previous.rect.h !== next.rect.h;
    if (moved && resized) return 'Move and resize panel';
    if (moved) return 'Move panel';
    if (resized) return 'Resize panel';
    if (previous.activeAssetId !== next.activeAssetId) return next.activeAssetId ? 'Change image' : 'Clear image';
    if (previous.panelKind !== next.panelKind) {
      return next.panelKind === 'text' ? 'Change to text panel' : 'Change to image panel';
    }
    if (previous.customText !== next.customText || previous.richText !== next.richText) return 'Edit text';
    if (JSON.stringify(previous.textStyle) !== JSON.stringify(next.textStyle)) return 'Edit text style';
    if (JSON.stringify(previous.imageCrop) !== JSON.stringify(next.imageCrop)) return 'Adjust image crop';
    if (previous.aspectRatio !== next.aspectRatio || previous.aspectRatioLocked !== next.aspectRatioLocked) {
      return 'Change aspect ratio';
    }
    if (JSON.stringify(previous.assetIds) !== JSON.stringify(next.assetIds)) return 'Change image';
  }

  if (changed.length > 1) return 'Edit layout';
  return 'Edit layout';
}
