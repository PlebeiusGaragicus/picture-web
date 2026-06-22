import { useEffect, useRef, useState } from 'react';
import { PanelChunksToggleButton } from './storyPanels/PanelChunksToggle';
import { HelpTip } from './ui';
import type { AdaptationStatus } from './types';
import {
  adaptationNavPhases,
  phaseStatus,
  projectPhaseHelp,
  projectPhaseIcon,
  projectPhaseLabel,
  workspaceNavItems,
  type ProjectPhase,
} from './projectNavigation';

function PhaseSidebarToggleIcon({ variant }: { variant: 'collapse' | 'expand' }) {
  return (
    <svg className="phase-sidebar-toggle-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <line x1="5.5" y1="2.5" x2="5.5" y2="13.5" stroke="currentColor" strokeWidth="1.25" />
      {variant === 'collapse' ? (
        <path d="M7 8 L10 5.5 M7 8 L10 10.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M11 8 L8 5.5 M11 8 L8 10.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

export function ProjectTopBar({
  activePhase,
  adaptation,
  onPhaseChange,
  onExpandSidebar,
  showChunksToggle,
  onOpenChunks,
}: {
  activePhase: ProjectPhase;
  adaptation: AdaptationStatus | null;
  onPhaseChange: (phase: ProjectPhase) => void;
  onExpandSidebar: () => void;
  showChunksToggle: boolean;
  onOpenChunks: () => void;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const navRef = useRef<HTMLDivElement | null>(null);
  const help = projectPhaseHelp(activePhase);

  useEffect(() => {
    if (!navOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) {
        setNavOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [navOpen]);

  const selectPhase = (phase: ProjectPhase) => {
    onPhaseChange(phase);
    setNavOpen(false);
  };

  return (
    <header className="project-top-bar" role="toolbar" aria-label="Project toolbar">
      <div className="project-top-bar-start">
        <button
          type="button"
          className="project-top-bar-toggle"
          onClick={onExpandSidebar}
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <PhaseSidebarToggleIcon variant="expand" />
          <span>Sidebar</span>
        </button>
      </div>
      <div className="project-top-bar-center">
        <div className="project-top-bar-nav-wrap" ref={navRef}>
          <button
            type="button"
            className="project-top-bar-nav-trigger"
            aria-haspopup="menu"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((open) => !open)}
          >
            <span className="project-top-bar-nav-icon" aria-hidden="true">{projectPhaseIcon(activePhase)}</span>
            <span className="project-top-bar-nav-label">{projectPhaseLabel(activePhase)}</span>
            <span className="project-top-bar-nav-chevron" aria-hidden="true">▾</span>
          </button>
          {navOpen && (
            <div className="project-top-bar-nav-menu" role="menu" aria-label="Project navigation">
              <p className="project-top-bar-nav-heading">Workspace</p>
              {workspaceNavItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className={`project-top-bar-nav-item ${activePhase === item.id ? 'is-selected' : ''}`}
                  onClick={() => selectPhase(item.id)}
                >
                  <span className="project-top-bar-nav-icon" aria-hidden="true">{item.icon}</span>
                  <strong>{item.label}</strong>
                </button>
              ))}
              <p className="project-top-bar-nav-heading">Story Adaptation</p>
              {adaptationNavPhases.map((phase) => {
                const status = phaseStatus(adaptation, phase.id);
                const selected = activePhase === phase.id;
                return (
                  <button
                    key={phase.id}
                    type="button"
                    role="menuitem"
                    className={`project-top-bar-nav-item status-${status} ${selected ? 'is-selected' : ''}`}
                    onClick={() => selectPhase(phase.id)}
                  >
                    <span className="project-top-bar-nav-icon" aria-hidden="true">{phase.number}</span>
                    <strong>{phase.title}</strong>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {help && <HelpTip text={help} placement="bottom" />}
      </div>
      <div className="project-top-bar-end">
        {showChunksToggle && (
          <PanelChunksToggleButton variant="expand" onClick={onOpenChunks} />
        )}
      </div>
    </header>
  );
}
