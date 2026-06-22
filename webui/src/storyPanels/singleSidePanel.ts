export type SingleSidePanel = 'info' | 'chunks';

export const SINGLE_SIDE_PANEL_KEY = 'story-panels-single-side-panel';

export function readSingleSidePanel(): SingleSidePanel {
  try {
    const stored = localStorage.getItem(SINGLE_SIDE_PANEL_KEY);
    if (stored === 'chunks') return 'chunks';
    if (stored === 'info') return 'info';
  } catch {
    // Ignore storage read failures.
  }
  return 'info';
}

export function writeSingleSidePanel(panel: SingleSidePanel) {
  try {
    localStorage.setItem(SINGLE_SIDE_PANEL_KEY, panel);
  } catch {
    // Ignore storage write failures.
  }
}
