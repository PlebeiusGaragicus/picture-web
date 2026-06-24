import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { TagControlButton } from '../canvas/assetTagRow';
import { storyArtifactKeysOnCanvas } from '../canvas/shared';
import { formatRequestError, formatWorkflowStatusError } from '../formatError';
import { Modal } from '../ui';
import { VisualStyleList } from './cards';
import { HubCardMenu } from './hubCardMenu';
import type { AdaptationAssetLink, AdaptationStatus, Asset, CanvasDocument, ConceptArtSubjectKind, TagDefinition } from '../types';

function slugifyFileKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'new-item';
}

function conceptDisplayName(key: string) {
  return key
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function latestAssetForLink(link: AdaptationAssetLink, assetsById: Map<string, Asset>) {
  const assetId = link.activeAssetId ?? link.assetIds[link.assetIds.length - 1];
  return assetId ? assetsById.get(assetId) ?? null : null;
}

function subjectLabel(subjectKind: ConceptArtSubjectKind | null | undefined) {
  return subjectKind === 'location' ? 'Location' : 'Character';
}

export function ConceptArtView({
  projectSlug,
  adaptation,
  assets,
  canvas,
  projectTags,
  viewMode,
  onDraftArtifactToCanvas,
  onOpenUploadedConceptOnCanvas,
  onCreateTag,
  onReloadProject,
  onReloadAdaptation,
}: {
  projectSlug: string;
  adaptation: AdaptationStatus;
  assets: Asset[];
  canvas: CanvasDocument;
  projectTags: TagDefinition[];
  viewMode: 'list' | 'canvas';
  onDraftArtifactToCanvas: (artifactKey: string) => Promise<void>;
  onOpenUploadedConceptOnCanvas: (artifactKey: string, canvasDoc: CanvasDocument) => void;
  onCreateTag: (tag: TagDefinition) => void;
  onReloadProject: () => Promise<void>;
  onReloadAdaptation: () => Promise<void>;
}) {
  const assetsById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const [conceptArt, setConceptArt] = useState<Record<string, AdaptationAssetLink>>(() => adaptation.conceptArt ?? {});
  const refreshConceptArt = useCallback(async () => {
    const status = await api.getAdaptation(projectSlug);
    setConceptArt(status.conceptArt ?? {});
  }, [projectSlug]);

  useEffect(() => {
    setConceptArt(adaptation.conceptArt ?? {});
  }, [adaptation.conceptArt]);

  useEffect(() => {
    void refreshConceptArt();
  }, [refreshConceptArt]);

  const entries = useMemo(
    () => Object.entries(conceptArt).sort(([left], [right]) => left.localeCompare(right)),
    [conceptArt],
  );
  const canvasKeys = useMemo(() => storyArtifactKeysOnCanvas(canvas.nodes, 'concept-art'), [canvas.nodes]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [draftTagIds, setDraftTagIds] = useState<string[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null);
  const [deletingConcept, setDeletingConcept] = useState(false);
  const [suggestJob, setSuggestJob] = useState<'character' | 'location' | null>(null);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [uploadingConcept, setUploadingConcept] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const editingLink = editingKey ? conceptArt[editingKey] : null;

  const openEdit = (key: string, link: AdaptationAssetLink) => {
    setEditingKey(key);
    setDraftName(conceptDisplayName(key));
    setDraftPrompt(link.prompt);
    setDraftTagIds(link.userTags ?? []);
  };

  const saveEdit = async () => {
    if (!editingKey || !editingLink) return;
    setBusyKey(editingKey);
    setError(null);
    try {
      const trimmedName = draftName.trim() || conceptDisplayName(editingKey);
      const nextKey = slugifyFileKey(trimmedName);
      const shouldRenameKey = nextKey !== editingKey && !conceptArt[nextKey];
      await api.updateAdaptationFile(projectSlug, 'concept-art', editingKey, {
        key: shouldRenameKey ? nextKey : editingKey,
        body: draftPrompt,
        mode: editingLink.mode,
        styleRef: editingLink.styleRef,
        subjectKind: editingLink.subjectKind ?? 'character',
        userTags: draftTagIds,
      });
      await onReloadProject();
      await refreshConceptArt();
      setEditingKey(null);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setBusyKey(null);
    }
  };

  const draftToCanvas = async (key: string) => {
    setBusyKey(key);
    setError(null);
    try {
      await onDraftArtifactToCanvas(key);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setBusyKey(null);
    }
  };

  const deleteConcept = async (key: string) => {
    setBusyKey(key);
    setDeletingConcept(true);
    setError(null);
    try {
      await api.deleteAdaptationFile(projectSlug, 'concept-art', key);
      await onReloadAdaptation();
      await refreshConceptArt();
      if (editingKey === key) {
        setEditingKey(null);
      }
      setPendingDeleteKey(null);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setBusyKey(null);
      setDeletingConcept(false);
    }
  };

  const createConcept = async (subjectKind: ConceptArtSubjectKind) => {
    const existingKeys = entries.map(([entryKey]) => entryKey);
    const base = subjectKind === 'location' ? 'location-concept' : 'character-concept';
    let index = existingKeys.length + 1;
    let key = `${base}-${index}`;
    while (existingKeys.includes(key)) {
      index += 1;
      key = `${base}-${index}`;
    }
    const busyId = `__create-${subjectKind}__`;
    setBusyKey(busyId);
    setError(null);
    try {
      await api.createAdaptationFile(projectSlug, 'concept-art', {
        key,
        body: '',
        mode: 'new-image',
        styleRef: '',
        subjectKind,
      });
      await onReloadAdaptation();
      await refreshConceptArt();
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setBusyKey(null);
    }
  };

  const suggestConceptCharacter = async () => {
    setError(null);
    setSuggestJob('character');
    try {
      await api.startGenerateConceptCharacter(projectSlug);
    } catch (err) {
      setSuggestJob(null);
      setError(formatRequestError(err));
    }
  };

  const uploadConceptImage = async (file: File) => {
    setUploadingConcept(true);
    setError(null);
    try {
      const result = await api.uploadConceptArt(projectSlug, file);
      await onReloadProject();
      await refreshConceptArt();
      onOpenUploadedConceptOnCanvas(result.key, result.canvas);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setUploadingConcept(false);
    }
  };

  const suggestConceptLocation = async () => {
    setError(null);
    setSuggestJob('location');
    try {
      await api.startGenerateConceptLocation(projectSlug);
    } catch (err) {
      setSuggestJob(null);
      setError(formatRequestError(err));
    }
  };

  useEffect(() => {
    if (!suggestJob) return;
    const timer = window.setInterval(async () => {
      const status = suggestJob === 'character'
        ? await api.getGenerateConceptCharacter(projectSlug)
        : await api.getGenerateConceptLocation(projectSlug);
      if (!status.running) {
        setSuggestJob(null);
        const workflowError = formatWorkflowStatusError(status);
        if (workflowError) setError(workflowError);
        await onReloadAdaptation();
        await refreshConceptArt();
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [onReloadAdaptation, projectSlug, refreshConceptArt, suggestJob]);

  const conceptWorkflowBusy = suggestJob !== null;

  return (
    <>
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = '';
          if (file) {
            void uploadConceptImage(file);
          }
        }}
      />
      {viewMode === 'list' && (
        <div className="story-adaptation-screen story-panels-screen concept-art-screen">
          <div className="concept-art-styles-panel">
            <VisualStyleList
              projectSlug={projectSlug}
              styles={adaptation.visualStyles}
              onReload={onReloadProject}
            />
          </div>
          <header className="layout-view-toolbar concept-art-toolbar">
            <div className="concept-art-toolbar-groups">
              <div className="concept-art-toolbar-group">
                <span className="concept-art-toolbar-label">Character</span>
                <div className="concept-art-toolbar-actions">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => void createConcept('character')}
                    disabled={busyKey === '__create-character__' || conceptWorkflowBusy || uploadingConcept}
                  >
                    {busyKey === '__create-character__' ? 'Creating…' : 'New'}
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => void suggestConceptCharacter()}
                    disabled={!adaptation.hasBookSession || conceptWorkflowBusy || uploadingConcept}
                  >
                    {suggestJob === 'character' ? 'Suggesting…' : 'Suggest'}
                  </button>
                </div>
              </div>
              <div className="concept-art-toolbar-group">
                <span className="concept-art-toolbar-label">Location</span>
                <div className="concept-art-toolbar-actions">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => void createConcept('location')}
                    disabled={busyKey === '__create-location__' || conceptWorkflowBusy || uploadingConcept}
                  >
                    {busyKey === '__create-location__' ? 'Creating…' : 'New'}
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => void suggestConceptLocation()}
                    disabled={!adaptation.hasBookSession || conceptWorkflowBusy || uploadingConcept}
                  >
                    {suggestJob === 'location' ? 'Suggesting…' : 'Suggest'}
                  </button>
                </div>
              </div>
              <div className="concept-art-toolbar-group">
                <span className="concept-art-toolbar-label">Import</span>
                <div className="concept-art-toolbar-actions">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => uploadInputRef.current?.click()}
                    disabled={conceptWorkflowBusy || uploadingConcept}
                  >
                    {uploadingConcept ? 'Uploading…' : 'Upload image'}
                  </button>
                </div>
              </div>
            </div>
          </header>
          {error && <p className="error error-banner layout-view-error">{error}</p>}
          <div className="characters-hub-workspace">
            <section className="character-card-grid">
              {entries.map(([key, link]) => {
                    const asset = latestAssetForLink(link, assetsById);
                    const onCanvas = canvasKeys.has(key);
                    const busy = busyKey === key;
                    return (
                      <article key={key} className="story-card character-hub-card">
                        <div className={`character-hub-thumb ${asset ? 'has-image' : ''}`}>
                          {asset ? (
                            <div className="character-hub-thumb-frame">
                              <img src={asset.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${asset.id}/thumb`} alt="" />
                              <button
                                type="button"
                                className="character-hub-preview-eye"
                                onClick={() => setPreviewAssetId(asset.id)}
                                title="View full screen"
                                aria-label={`View ${conceptDisplayName(key)} full screen`}
                              >
                                👁️
                              </button>
                            </div>
                          ) : (
                            <span className="muted">No image</span>
                          )}
                        </div>
                        <div className="character-hub-body">
                          <div className="concept-art-card-head">
                            <span className="concept-art-subject-badge">{subjectLabel(link.subjectKind)}</span>
                            <div className="character-hub-card-header">
                              <h3>{conceptDisplayName(key)}</h3>
                              <HubCardMenu
                                disabled={busy || deletingConcept}
                                ariaLabel="Concept actions"
                                onDelete={() => setPendingDeleteKey(key)}
                              />
                            </div>
                          </div>
                          {asset && link.assetIds.length > 1 && (
                            <p className="muted">{link.assetIds.length} images</p>
                          )}
                          <div className="character-hub-actions">
                            <button className="secondary" type="button" onClick={() => openEdit(key, link)}>Edit</button>
                            <button className="secondary" type="button" disabled={busy || onCanvas} onClick={() => void draftToCanvas(key)}>
                              {onCanvas ? 'On canvas' : busy ? 'Working...' : 'Draft'}
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
              {!entries.length && (
                <p className="muted">Add a concept card to explore the visual style before continuing.</p>
              )}
            </section>
          </div>
        </div>
      )}
      {editingKey && editingLink && (
        <Modal title={draftName || conceptDisplayName(editingKey)} onClose={() => setEditingKey(null)}>
          <div className="adaptation-file-form">
            <p className="muted concept-art-edit-subject">
              Subject: {subjectLabel(editingLink.subjectKind)}
            </p>
            <label className="field-label">
              Name
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="Concept name"
              />
            </label>
            <label className="field-label">
              Image prompt
              <textarea className="modal-textarea" rows={10} value={draftPrompt} onChange={(event) => setDraftPrompt(event.target.value)} />
            </label>
            <div className="field-label">
              Tags
              <TagControlButton
                tagIds={draftTagIds}
                projectTags={projectTags}
                onPartitionedTagsChange={(userTags) => setDraftTagIds(userTags)}
                onCreateTag={onCreateTag}
                portaled
              />
            </div>
          </div>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setEditingKey(null)} disabled={busyKey === editingKey}>Cancel</button>
            <button className="generate-button" onClick={() => void saveEdit()} disabled={busyKey === editingKey || !draftName.trim()}>
              {busyKey === editingKey ? 'Saving...' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
      {pendingDeleteKey && createPortal(
        <div
          className="confirm-backdrop character-delete-confirm"
          onClick={() => !deletingConcept && setPendingDeleteKey(null)}
        >
          <div
            className="confirm-dialog character-delete-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="concept-delete-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="concept-delete-confirm-title">Delete concept?</h2>
            <p>
              Remove <strong>{conceptDisplayName(pendingDeleteKey)}</strong> from this project?
              The concept file and adaptation metadata will be deleted. Generated images on the canvas are kept.
            </p>
            <div className="row">
              <button
                className="danger"
                disabled={deletingConcept}
                onClick={() => void deleteConcept(pendingDeleteKey)}
              >
                {deletingConcept ? 'Deleting...' : 'Delete concept'}
              </button>
              <button className="secondary" disabled={deletingConcept} onClick={() => setPendingDeleteKey(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {previewAssetId && createPortal(
        <div
          className="archetype-lightbox"
          onClick={() => setPreviewAssetId(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Concept art preview"
        >
          <img
            src={`/api/projects/${projectSlug}/assets/${previewAssetId}/image`}
            alt=""
            onClick={(event) => event.stopPropagation()}
          />
          <button
            type="button"
            className="archetype-lightbox-close"
            onClick={() => setPreviewAssetId(null)}
            aria-label="Close"
          >
            ×
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
