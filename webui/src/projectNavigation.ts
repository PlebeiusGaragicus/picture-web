import type { AdaptationStatus } from './types';

export type ProjectPhase =
  | 'chat'
  | 'image-canvas'
  | 'story'
  | 'layout-editor'
  | 'concept-art'
  | 'characters-hub'
  | 'phase-0-ingestion'
  | 'phase-1-characters'
  | 'phase-2-scenes'
  | 'phase-3-locations'
  | 'phase-4-moments';

export type PhaseNavStatus = 'pending' | 'active' | 'ready';

export const workspaceNavItems: Array<{ id: ProjectPhase; icon: string; label: string }> = [
  { id: 'story', icon: '▥', label: 'Story' },
  { id: 'layout-editor', icon: '▤', label: 'Layout' },
  { id: 'image-canvas', icon: '▦', label: 'Canvas' },
  { id: 'concept-art', icon: '▧', label: 'Concept Art' },
  { id: 'characters-hub', icon: '▨', label: 'Characters' },
  { id: 'chat', icon: '◌', label: 'Agent' },
];

export const adaptationNavPhases: Array<{ id: ProjectPhase; number: string; title: string }> = [
  { id: 'phase-0-ingestion', number: '0', title: 'Story & Style' },
  { id: 'phase-1-characters', number: '1', title: 'Characters' },
  { id: 'phase-2-scenes', number: '2', title: 'Scenes' },
  { id: 'phase-3-locations', number: '3', title: 'Locations' },
  { id: 'phase-4-moments', number: '4', title: 'Moments' },
];

const workspacePhaseIds = new Set(workspaceNavItems.map((item) => item.id));

/** Story Adaptation phases use the collapse control on the sidebar edge; workspace phases use the top bar. */
export function phaseHasSidebarEdgeCollapse(phase: ProjectPhase) {
  return !workspacePhaseIds.has(phase);
}

export function projectPhaseLabel(phase: ProjectPhase) {
  return workspaceNavItems.find((item) => item.id === phase)?.label
    ?? adaptationNavPhases.find((item) => item.id === phase)?.title
    ?? phase;
}

export function projectPhaseIcon(phase: ProjectPhase) {
  return workspaceNavItems.find((item) => item.id === phase)?.icon
    ?? adaptationNavPhases.find((item) => item.id === phase)?.number
    ?? '•';
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

export function phaseStatus(adaptation: AdaptationStatus | null, phase: ProjectPhase): PhaseNavStatus {
  if (!adaptation) return 'pending';
  const counts = adaptation.counts;
  if (phase === 'phase-0-ingestion') return adaptation.hasBookSession ? 'ready' : adaptation.hasBook ? 'active' : 'pending';
  if (phase === 'phase-1-characters') return (counts.characterFiles ?? 0) > 0 ? 'ready' : (counts.characterListLines ?? 0) > 0 ? 'active' : 'pending';
  if (phase === 'phase-2-scenes') return (counts.sceneArtifacts ?? 0) > 0 ? 'ready' : (counts.sceneListLines ?? 0) > 0 ? 'active' : 'pending';
  if (phase === 'phase-3-locations') return (counts.locationPrompts ?? 0) > 0 ? 'ready' : 'pending';
  if (phase === 'phase-4-moments') {
    const total = counts.momentSections ?? 0;
    const illustrated = counts.illustratedMoments ?? 0;
    if (!total) return (counts.sceneArtifacts ?? 0) > 0 ? 'active' : 'pending';
    return illustrated >= total ? 'ready' : 'active';
  }
  return 'pending';
}
