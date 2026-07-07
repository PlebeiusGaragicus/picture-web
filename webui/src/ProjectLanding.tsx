import { useState } from 'react';
import { api } from './api';
import { Modal } from './ui';
import type { Project } from './types';

export function ProjectLanding({
  projects,
  error,
  onOpen,
  onCreated,
  onOpenSettings,
}: {
  projects: Project[];
  error: string | null;
  onOpen: (slug: string) => void;
  onCreated: (slug: string) => void;
  onOpenSettings?: () => void;
}) {
  const [name, setName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const closeCreate = () => {
    if (creating) return;
    setCreateOpen(false);
    setName('');
  };
  const create = async () => {
    const nextSlug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!nextSlug || creating) return;
    setCreating(true);
    try {
      await api.createProject(nextSlug, name, {});
      setName('');
      setCreateOpen(false);
      onCreated(nextSlug);
    } finally {
      setCreating(false);
    }
  };
  return (
    <div className="landing">
      <div className="landing-content">
        <header className="landing-masthead">
          <span className="landing-logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="44" height="44" fill="none">
              <rect x="2" y="2" width="28" height="28" rx="7" fill="var(--accent-strong)" />
              <rect x="7" y="7" width="8" height="7" rx="1.5" fill="#fff" opacity="0.95" />
              <rect x="17" y="7" width="8" height="10" rx="1.5" fill="#fff" opacity="0.6" />
              <rect x="7" y="17" width="8" height="8" rx="1.5" fill="#fff" opacity="0.6" />
              <rect x="17" y="20" width="8" height="5" rx="1.5" fill="#fff" opacity="0.95" />
            </svg>
          </span>
          <h1 className="landing-title">Comic Canvas</h1>
          <p className="landing-tagline">Turn a manuscript into a laid-out, illustrated comic.</p>
          {onOpenSettings && (
            <button
              type="button"
              className="icon-button landing-settings-button"
              title="Settings"
              aria-label="Settings"
              onClick={onOpenSettings}
            >
              ⚙
            </button>
          )}
        </header>
        {error && <p className="error error-banner landing-error">{error}</p>}
        <div className="project-list">
          {projects.map((project) => (
            <button key={project.slug} className="project-tile" onClick={() => onOpen(project.slug)}>
              <div className="project-tile-cover">
                {project.coverThumbnailUrl ? (
                  <img src={project.coverThumbnailUrl} alt="" />
                ) : (
                  <div className="project-tile-cover-placeholder" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="5" width="18" height="14" rx="2" />
                      <circle cx="8.5" cy="10" r="1.5" />
                      <path d="M21 16l-4.5-4.5L7 21" />
                    </svg>
                  </div>
                )}
              </div>
              <strong className="project-tile-name">{project.name}</strong>
            </button>
          ))}
          <button className="project-tile project-create-tile" onClick={() => setCreateOpen(true)}>
            <div className="project-tile-cover project-create-cover" aria-hidden="true">+</div>
            <span className="project-tile-name">New project</span>
          </button>
        </div>
      </div>
      {createOpen && (
        <Modal title="New project" onClose={closeCreate}>
          <label className="field-label">
            Project name
            <input
              autoFocus
              value={name}
              disabled={creating}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create();
              }}
              placeholder="My project"
            />
          </label>
          <div className="modal-actions">
            <button className="secondary" disabled={creating} onClick={closeCreate}>Cancel</button>
            <button disabled={creating || !name.trim()} onClick={() => void create()}>
              {creating ? 'Creating...' : 'Create project'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
