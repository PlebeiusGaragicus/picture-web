export type ProjectPhase =
  | 'chat'
  | 'image-canvas'
  | 'story'
  | 'layout-editor'
  | 'concept-art'
  | 'characters-hub';

export const workspaceNavItems: Array<{ id: ProjectPhase; icon: string; label: string }> = [
  { id: 'story', icon: '▥', label: 'Story' },
  { id: 'layout-editor', icon: '▤', label: 'Layout' },
  { id: 'image-canvas', icon: '▦', label: 'Canvas' },
  { id: 'concept-art', icon: '▧', label: 'Concept Art' },
  { id: 'characters-hub', icon: '▨', label: 'Characters' },
  { id: 'chat', icon: '◌', label: 'Agent' },
];

export function projectPhaseLabel(phase: ProjectPhase) {
  return workspaceNavItems.find((item) => item.id === phase)?.label ?? phase;
}

export function projectPhaseIcon(phase: ProjectPhase) {
  return workspaceNavItems.find((item) => item.id === phase)?.icon ?? '•';
}

export function projectPhaseHelp(phase: ProjectPhase) {
  switch (phase) {
    case 'chat':
      return 'Browse Pi coding-agent sessions, traces, running work, and book-context conversations.';
    case 'story':
      return 'Write panels one at a time, or upload book.txt to highlight passages into panel chunks. Use Reading to manage order and open Layout to place panels.';
    case 'concept-art':
      return 'Define visual styles and create concept cards to explore the look and feel before comic generation.';
    case 'characters-hub':
      return 'Review character cards, thumbnails, prompts, and generation/refinement actions.';
    default:
      return undefined;
  }
}
