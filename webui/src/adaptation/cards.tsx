import { useEffect, useState } from 'react';
import { HelpTip, Modal } from '../ui';
import type { AdaptationStatus, AdaptationWorkflowStatus, Asset, StyleRefKind, StyleRefStatus } from '../types';

export function StyleRefCard({
  status,
  projectSlug,
  asset,
  onImportStyleRef,
  onSavePrompt,
  onGenerateStyleRef,
}: {
  status: StyleRefStatus;
  projectSlug: string;
  asset: Asset | null;
  onImportStyleRef: (refKind: StyleRefKind, file: File) => Promise<void>;
  onSavePrompt: (refKind: StyleRefKind, prompt: string) => Promise<void>;
  onGenerateStyleRef: (refKind: StyleRefKind) => Promise<void>;
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
          <HelpTip text={`The ${styleLabel} for this project. Generate it on the canvas, edit the prompt, or import a reference image.`} />
        </div>
        <span className={`status-pill ${asset ? 'is-ready' : hasPrompt ? 'is-active' : 'is-pending'}`}>
          {asset ? 'Image set' : hasPrompt ? 'Prompt ready' : 'Empty'}
        </span>
      </div>
      <div className="archetype-body">
        <div className="archetype-prompt-col">
          {hasPrompt ? <p className="archetype-prompt-preview">{prompt}</p> : <p className="muted">No prompt yet.</p>}
          <button className="secondary" onClick={() => setIsEditing(true)}>{hasPrompt ? 'Edit prompt' : 'Write prompt'}</button>
          <button className="generate-button" onClick={() => onGenerateStyleRef(status.kind)} disabled={!hasPrompt || isSaving}>
            Generate this {isCharacter ? 'character' : 'scene'} reference
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

export function VisualStyleCard({
  value,
  isSaving,
  onChange,
  onSave,
}: {
  value: string;
  isSaving: boolean;
  onChange: (value: string) => void;
  onSave: (value: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const hasStyle = value.trim().length > 0;
  const save = async () => {
    onChange(draft);
    await onSave(draft);
    setIsEditing(false);
  };
  return (
    <section className="story-card archetype-card">
      <div className="archetype-card-head">
        <div className="archetype-card-title">
          <h2>Visual Style</h2>
          <HelpTip text="The shared style guide appended to every generated image." />
        </div>
        <span className={`status-pill ${hasStyle ? 'is-ready' : 'is-pending'}`}>{hasStyle ? 'Set' : 'Empty'}</span>
      </div>
      {hasStyle ? <p className="archetype-prompt-preview">{value}</p> : <p className="muted">No visual style yet.</p>}
      <div className="archetype-card-actions">
        <button className="secondary" onClick={() => setIsEditing(true)}>{hasStyle ? 'Edit style' : 'Write style'}</button>
      </div>
      {isEditing && (
        <Modal title="Edit Visual Style" onClose={() => setIsEditing(false)}>
          <p className="muted">This style guide is appended to every generated image prompt.</p>
          <textarea className="modal-textarea" value={draft} onChange={(event) => setDraft(event.target.value)} rows={12} />
          <div className="modal-actions">
            <button className="secondary" onClick={() => setIsEditing(false)} disabled={isSaving}>Cancel</button>
            <button className="generate-button" onClick={save} disabled={isSaving}>{isSaving ? 'Saving...' : 'Save style'}</button>
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
}: {
  kind: 'characters' | 'locations';
  adaptation: AdaptationStatus;
  workflow: AdaptationWorkflowStatus | null;
  validation: AdaptationWorkflowStatus | null;
  onStartWorkflow: () => Promise<void>;
  onStartValidation: () => Promise<void>;
}) {
  return (
    <div className="assets-row">
      <section className="story-card assets-extract-card">
        <div className="assets-extract-head">
          <div className="archetype-card-title">
            <h2>Extract From Book</h2>
            <HelpTip text={`Run Pi to populate ${kind} files from the ingested book session.`} />
          </div>
          <button className="generate-button workflow-run-button" onClick={onStartWorkflow} disabled={!adaptation.hasBookSession || workflow?.running}>
            {workflow?.running && <span className="spinner" aria-hidden="true" />}
            {workflow?.running ? 'Running extraction...' : 'Run extraction'}
          </button>
        </div>
        {!adaptation.hasBookSession && (
          <p className="assets-extract-hint">Create the read-book session in Phase 0 first, or author files manually below.</p>
        )}
      </section>
      <section className="story-card">
        <div className="archetype-card-title">
          <h2>Validate</h2>
          <HelpTip text={`Check that ${kind} files are well-formed.`} />
        </div>
        <button className="secondary" onClick={onStartValidation} disabled={validation?.running}>{validation?.running ? 'Validating...' : 'Run validation'}</button>
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
