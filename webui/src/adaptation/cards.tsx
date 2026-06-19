import { useEffect, useState } from 'react';
import { api } from '../api';
import { HelpTip, Modal } from '../ui';
import type { AdaptationStatus, AdaptationWorkflowStatus, Asset, StyleRefKind, StyleRefStatus, VisualStyleDefinition } from '../types';

export function StyleRefCard({
  status,
  projectSlug,
  asset,
  onImportStyleRef,
  onSavePrompt,
  onOpenStyleRefOnCanvas,
}: {
  status: StyleRefStatus;
  projectSlug: string;
  asset: Asset | null;
  onImportStyleRef: (refKind: StyleRefKind, file: File) => Promise<void>;
  onSavePrompt: (refKind: StyleRefKind, prompt: string) => Promise<void>;
  onOpenStyleRefOnCanvas: (refKind: StyleRefKind) => Promise<void>;
}) {
  const refKind = status.kind;
  const prompt = status.promptText;
  const isCharacter = refKind === 'archetype-character';
  const title = isCharacter ? 'Character Archetype' : 'Scene Archetype';
  const styleLabel = isCharacter ? 'character style reference' : 'scene style reference';
  const hasPrompt = prompt.trim().length > 0;
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(prompt);
  const [isSaving, setIsSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    setDraft(prompt);
  }, [prompt]);
  const savePrompt = async () => {
    setIsSaving(true);
    try {
      await onSavePrompt(status.kind, draft);
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  };
  const imageSrc = asset ? asset.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${asset.id}/thumb` : null;
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/'));
    if (file) void onImportStyleRef(status.kind, file);
  };
  return (
    <section className="story-card archetype-card">
      <div className="archetype-card-head">
        <div className="archetype-card-title">
          <h2>{title}</h2>
          <HelpTip text={`The ${styleLabel} for this project. Edit the prompt here, then open on canvas to pick a visual style and generate.`} />
        </div>
        <span className={`status-pill ${asset ? 'is-ready' : hasPrompt ? 'is-active' : 'is-pending'}`}>
          {asset ? 'Image set' : hasPrompt ? 'Prompt ready' : 'Empty'}
        </span>
      </div>
      <div className="archetype-body">
        <div className="archetype-prompt-col">
          {hasPrompt ? <p className="archetype-prompt-preview">{prompt}</p> : <p className="muted">No prompt yet.</p>}
          <button className="secondary" onClick={() => setIsEditing(true)}>{hasPrompt ? 'Edit prompt' : 'Write prompt'}</button>
          <button className="generate-button" onClick={() => onOpenStyleRefOnCanvas(status.kind)} disabled={!hasPrompt || isSaving}>
            {asset ? 'View on canvas' : 'Open on canvas to generate'}
          </button>
        </div>
        <div className="archetype-image-col">
          <div
            className={`archetype-dropzone ${isDragging ? 'is-dragging' : ''} ${imageSrc ? 'has-image' : ''}`}
            onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
            onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDragging(false); }}
            onDrop={onDrop}
            onClick={() => imageSrc && setIsFullscreen(true)}
            role={imageSrc ? 'button' : undefined}
            title={imageSrc ? 'Click to view full screen' : undefined}
          >
            {imageSrc ? <img src={imageSrc} alt="" /> : <span className="muted">Drag an image here, or import below</span>}
          </div>
          <label className="secondary file-button">
            {asset ? 'Replace image' : 'Import image'}
            <input type="file" accept="image/*" hidden onChange={(event) => event.target.files?.[0] && void onImportStyleRef(status.kind, event.target.files[0])} />
          </label>
        </div>
      </div>
      {isEditing && (
        <Modal title={`Edit ${title} Prompt`} onClose={() => setIsEditing(false)}>
          <p className="muted">This prompt drives the generated {styleLabel} on the canvas.</p>
          <textarea className="modal-textarea" value={draft} onChange={(event) => setDraft(event.target.value)} rows={10} />
          <div className="modal-actions">
            <button className="secondary" onClick={() => setIsEditing(false)} disabled={isSaving}>Cancel</button>
            <button className="generate-button" onClick={savePrompt} disabled={isSaving}>{isSaving ? 'Saving...' : 'Save prompt'}</button>
          </div>
        </Modal>
      )}
      {isFullscreen && imageSrc && (
        <div className="archetype-lightbox" onClick={() => setIsFullscreen(false)} role="dialog" aria-modal="true">
          <img src={asset ? `/api/projects/${projectSlug}/assets/${asset.id}/image` : imageSrc} alt="" onClick={(event) => event.stopPropagation()} />
          <button className="archetype-lightbox-close" onClick={() => setIsFullscreen(false)} aria-label="Close">×</button>
        </div>
      )}
    </section>
  );
}

export const DEFAULT_VISUAL_STYLE_TEMPLATE = `Style:
Color palette:
Realism:
Lighting:
`;

export function VisualStyleList({
  projectSlug,
  styles,
  onReload,
}: {
  projectSlug: string;
  styles: VisualStyleDefinition[];
  onReload: () => Promise<void>;
}) {
  const [editingStyle, setEditingStyle] = useState<VisualStyleDefinition | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftPrompt, setDraftPrompt] = useState(DEFAULT_VISUAL_STYLE_TEMPLATE);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<VisualStyleDefinition | null>(null);

  const openCreate = () => {
    setDraftName('');
    setDraftPrompt(DEFAULT_VISUAL_STYLE_TEMPLATE);
    setCreating(true);
  };

  const openEdit = (style: VisualStyleDefinition) => {
    setDraftName(style.name);
    setDraftPrompt(style.prompt);
    setEditingStyle(style);
  };

  const saveCreate = async () => {
    const name = draftName.trim();
    if (!name) return;
    setIsSaving(true);
    try {
      await api.createVisualStyle(projectSlug, { name, prompt: draftPrompt });
      setCreating(false);
      await onReload();
    } finally {
      setIsSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editingStyle) return;
    const name = draftName.trim();
    if (!name) return;
    setIsSaving(true);
    try {
      await api.updateVisualStyle(projectSlug, editingStyle.id, { name, prompt: draftPrompt });
      setEditingStyle(null);
      await onReload();
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setIsSaving(true);
    try {
      await api.deleteVisualStyle(projectSlug, pendingDelete.id);
      setPendingDelete(null);
      await onReload();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="story-card visual-style-list-card">
      <div className="archetype-card-head">
        <div className="archetype-card-title">
          <h2>Visual Styles</h2>
          <HelpTip text="Reusable style snippets appended to canvas image prompts when you pick a style on a draft or image." />
        </div>
        <button className="secondary" type="button" onClick={openCreate}>Add style</button>
      </div>
      {styles.length === 0 ? (
        <p className="muted">No visual styles yet. Add one to reuse a consistent look across generated images.</p>
      ) : (
        <div className="visual-style-list">
          {styles.map((style) => (
            <article key={style.id} className="visual-style-list-item">
              <div className="visual-style-list-item-head">
                <strong>
                  {style.name}
                  {style.default ? <span className="visual-style-default-badge">Default</span> : null}
                </strong>
                <div className="visual-style-list-item-actions">
                  {!style.default && (
                    <button
                      className="secondary"
                      type="button"
                      disabled={isSaving}
                      onClick={async () => {
                        setIsSaving(true);
                        try {
                          await api.updateVisualStyle(projectSlug, style.id, { default: true });
                          await onReload();
                        } finally {
                          setIsSaving(false);
                        }
                      }}
                    >
                      Set as default
                    </button>
                  )}
                  <button className="secondary" type="button" onClick={() => openEdit(style)}>Edit</button>
                  <button className="danger" type="button" onClick={() => setPendingDelete(style)}>Delete</button>
                </div>
              </div>
              <p className="archetype-prompt-preview">{style.prompt.trim() || 'Empty style snippet.'}</p>
            </article>
          ))}
        </div>
      )}
      {creating && (
        <Modal title="Add visual style" onClose={() => !isSaving && setCreating(false)}>
          <label className="field-label">
            Name
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
          </label>
          <label className="field-label">
            Style snippet
            <textarea className="modal-textarea" value={draftPrompt} onChange={(event) => setDraftPrompt(event.target.value)} rows={10} />
          </label>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setCreating(false)} disabled={isSaving}>Cancel</button>
            <button className="generate-button" onClick={saveCreate} disabled={isSaving || !draftName.trim()}>{isSaving ? 'Saving...' : 'Create style'}</button>
          </div>
        </Modal>
      )}
      {editingStyle && (
        <Modal title={`Edit ${editingStyle.name}`} onClose={() => !isSaving && setEditingStyle(null)}>
          <label className="field-label">
            Name
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
          </label>
          <label className="field-label">
            Style snippet
            <textarea className="modal-textarea" value={draftPrompt} onChange={(event) => setDraftPrompt(event.target.value)} rows={10} />
          </label>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setEditingStyle(null)} disabled={isSaving}>Cancel</button>
            <button className="generate-button" onClick={saveEdit} disabled={isSaving || !draftName.trim()}>{isSaving ? 'Saving...' : 'Save style'}</button>
          </div>
        </Modal>
      )}
      {pendingDelete && (
        <Modal title="Delete visual style?" onClose={() => !isSaving && setPendingDelete(null)}>
          <p>Remove <strong>{pendingDelete.name}</strong>? Existing images keep their recorded style id; drafts may reference a missing style.</p>
          <div className="modal-actions">
            <button className="danger" onClick={confirmDelete} disabled={isSaving}>{isSaving ? 'Deleting...' : 'Delete style'}</button>
            <button className="secondary" onClick={() => setPendingDelete(null)} disabled={isSaving}>Cancel</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function PhaseWorkflowActions({
  kind,
  adaptation,
  workflow,
  validation,
  onStartWorkflow,
  onStartValidation,
  workflowDisabled = false,
  workflowDisabledReason = 'Workflow not available for this phase yet.',
  validateEnabled,
}: {
  kind: 'characters' | 'locations';
  adaptation: AdaptationStatus;
  workflow: AdaptationWorkflowStatus | null;
  validation: AdaptationWorkflowStatus | null;
  onStartWorkflow: () => Promise<void>;
  onStartValidation: () => Promise<void>;
  workflowDisabled?: boolean;
  workflowDisabledReason?: string;
  validateEnabled?: boolean;
}) {
  const canValidate = validateEnabled ?? !workflowDisabled;
  return (
    <div className="assets-row">
      <section className="story-card assets-extract-card">
        <div className="assets-extract-head">
          <div className="archetype-card-title">
            <h2>Extract From Book</h2>
            <HelpTip text={`Run Pi to populate ${kind} files from the ingested book session.`} />
          </div>
          <button className="generate-button workflow-run-button" onClick={onStartWorkflow} disabled={workflowDisabled || !adaptation.hasBookSession || workflow?.running}>
            {workflow?.running && <span className="spinner" aria-hidden="true" />}
            {workflow?.running ? 'Running extraction...' : 'Run extraction'}
          </button>
        </div>
        {workflowDisabled && (
          <p className="assets-extract-hint">{workflowDisabledReason}</p>
        )}
        {!workflowDisabled && !adaptation.hasBookSession && (
          <p className="assets-extract-hint">Create the read-book session in Phase 0 first, or author files manually below.</p>
        )}
      </section>
      <section className="story-card">
        <div className="archetype-card-title">
          <h2>Validate</h2>
          <HelpTip text={`Check that ${kind} files are well-formed.`} />
        </div>
        <button className="secondary" onClick={onStartValidation} disabled={!canValidate || validation?.running}>{validation?.running ? 'Validating...' : 'Run validation'}</button>
      </section>
    </div>
  );
}

export function PublishToCanvasCard({
  kind,
  count,
  isPublishing,
  onPublishToCanvas,
}: {
  kind: 'characters' | 'locations';
  count: number;
  isPublishing: boolean;
  onPublishToCanvas: () => Promise<void>;
}) {
  return (
    <div className="assets-row">
      <section className="story-card">
        <div className="archetype-card-title">
          <h2>Publish To Canvas</h2>
          <HelpTip text={`Send ${kind} files to the canvas to generate references.`} />
        </div>
        <button className="generate-button" onClick={onPublishToCanvas} disabled={!count || isPublishing}>
          {isPublishing ? 'Publishing...' : `Publish ${count} ${kind}`}
        </button>
      </section>
    </div>
  );
}
