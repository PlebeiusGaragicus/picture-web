export function PhaseSidebarToggleIcon({ variant }: { variant: 'collapse' | 'expand' }) {
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

export function SidebarCollapseButton({
  onClick,
  className = '',
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`phase-sidebar-collapse ${className}`.trim()}
      onClick={onClick}
      title="Collapse sidebar"
      aria-label="Collapse sidebar"
    >
      <PhaseSidebarToggleIcon variant="collapse" />
    </button>
  );
}
