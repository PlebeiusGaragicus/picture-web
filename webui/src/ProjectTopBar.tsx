import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AutoPlaceToggle } from './storyPanels/AutoPlaceToggle';
import { PanelChunksToggleButton } from './storyPanels/PanelChunksToggle';
import { SidebarToggleIcon, SidebarCollapseButton } from './SidebarToggle';
import { HelpTip } from './ui';
import {
  projectPhaseHelp,
  projectPhaseIcon,
  projectPhaseLabel,
  workspaceNavItems,
  type ProjectPhase,
} from './projectNavigation';

export function ProjectTopBar({
  activePhase,
  onPhaseChange,
  sidebarCollapsed,
  onExpandSidebar,
  onCollapseSidebar,
  showPanelChunksToggle,
  panelChunksOpen,
  onTogglePanelChunks,
  showAutoPlaceToggle,
  autoPlaceEnabled,
  onAutoPlaceChange,
  endLeadingContent,
  endContent,
}: {
  activePhase: ProjectPhase;
  onPhaseChange: (phase: ProjectPhase) => void;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onCollapseSidebar: () => void;
  showPanelChunksToggle: boolean;
  panelChunksOpen: boolean;
  onTogglePanelChunks: () => void;
  showAutoPlaceToggle: boolean;
  autoPlaceEnabled: boolean;
  onAutoPlaceChange: (enabled: boolean) => void;
  endLeadingContent?: ReactNode;
  endContent?: ReactNode;
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
        {sidebarCollapsed ? (
          <button
            type="button"
            className="project-top-bar-toggle"
            onClick={onExpandSidebar}
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <SidebarToggleIcon variant="expand" />
            <span>Sidebar</span>
          </button>
        ) : (
          <SidebarCollapseButton className="project-top-bar-sidebar-collapse" onClick={onCollapseSidebar} />
        )}
      </div>
      <div className="project-top-bar-center">
        {sidebarCollapsed ? (
          <>
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
                </div>
              )}
            </div>
            {help && <HelpTip text={help} placement="bottom" />}
          </>
        ) : (
          <div className="archetype-card-title">
            <h1 className="project-top-bar-title">{projectPhaseLabel(activePhase)}</h1>
            {help && <HelpTip text={help} placement="bottom" />}
          </div>
        )}
      </div>
      <div className="project-top-bar-end">
        {endLeadingContent}
        {showAutoPlaceToggle && (
          <AutoPlaceToggle enabled={autoPlaceEnabled} onChange={onAutoPlaceChange} />
        )}
        {showPanelChunksToggle && (
          <PanelChunksToggleButton
            variant={panelChunksOpen ? 'collapse' : 'expand'}
            onClick={onTogglePanelChunks}
          />
        )}
        {endContent}
      </div>
    </header>
  );
}
