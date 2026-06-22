import type { StoryPanelLayoutMode } from './PageLayoutEditor';

export type LayoutEditorNavigation = {
  panelId: string;
  layoutMode: Extract<StoryPanelLayoutMode, 'single-chunks'>;
};
