import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { storyArtifactKeysOnCanvas, storyArtifactNodeId } from '../canvas/shared';
import { formatRequestError } from '../formatError';
import { Modal } from '../ui';
import { VisualStyleList } from './cards';
import { HubCardMenu } from './hubCardMenu';
import type { AdaptationAssetLink, AdaptationStatus, Asset, CanvasDocument, ConceptArtSubjectKind } from '../types';

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
  viewMode,
  onDraftArtifactToCanvas,
  onOpenChatForAsset,
  onViewAsset,
  onReloadProject,
  onReloadAdaptation,
}: {
  projectSlug: string;
  adaptation: AdaptationStatus;
  assets: Asset[];
  canvas: CanvasDocument;
  viewMode: 'list' | 'canvas';
  onDraftArtifactToCanvas: (artifactKey: string) => Promise<void>;
  onOpenChatForAsset: (nodeId: string, assetId: string) => void;
  onViewAsset: (assetId: string) => void;
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
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null);
  const [deletingConcept, setDeletingConcept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editingLink = editingKey ? conceptArt[editingKey] : null;
  const hasVisualStyle = Boolean(adaptation.defaultVisualStyleId);

  const openEdit = (key: string, link: AdaptationAssetLink) => {
    setEditingKey(key);
    setDraftName(conceptDisplayName(key));
    setDraftPrompt(link.prompt);
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

  const generateConcept = async (key: string) => {
    setBusyKey(key);
    setError(null);
    try {
      await api.generateAdaptationArtifact(projectSlug, {
        artifactKind: 'concept-art',
        artifactKey: key,
        visualStyleId: adaptation.defaultVisualStyleId ?? null,
      });
      await onReloadProject();
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
    const existingKeys = entries.map(([key]) => key);
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

  return (
    <>
      {viewMode === 'list' && (
        <div className="story-adaptation-screen story-panels-screen concept-art-screen">
          <div className="concept-art-styles-panel">
            <VisualStyleList
              projectSlug={projectSlug}
              styles={adaptation.visualStyles}
              onReload={onReloadProject}
            />
          </div>
          <header className="layout-view-toolbar characters-hub-toolbar">
            <div className="layout-view-toolbar-primary">
              <button
                className="secondary"
                type="button"
                onClick={() => void createConcept('character')}
                disabled={busyKey === '__create-character__'}
              >
                {busyKey === '__create-character__' ? 'Creating…' : '+ character concept'}
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => void createConcept('location')}
                disabled={busyKey === '__create-location__'}
              >
                {busyKey === '__create-location__' ? 'Creating…' : '+ location concept'}
              </button>
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
                        <div
                          className={`character-hub-thumb ${asset ? 'has-image' : ''}`}
                          onClick={() => asset && onViewAsset(asset.id)}
                          role={asset ? 'button' : undefined}
                        >
                          {asset ? (
                            <img src={asset.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${asset.id}/thumb`} alt="" />
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
                            <button
                              className="generate-button"
                              type="button"
                              disabled={busy || !hasVisualStyle}
                              onClick={() => void generateConcept(key)}
                            >
                              {busy ? 'Generating...' : asset ? 'Regenerate' : 'Generate'}
                            </button>
                            {asset && (
                              <button
                                className="secondary"
                                type="button"
                                onClick={() => onOpenChatForAsset(storyArtifactNodeId('concept-art', key), asset.id)}
                              >
                                Refine
                              </button>
                            )}
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
    </>
  );
}
