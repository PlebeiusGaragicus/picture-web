import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { formatRequestError, formatWorkflowStatusError } from '../formatError';
import { VisualStyleList } from './cards';
import { HubCardMenu } from './hubCardMenu';
import type { Asset, AdaptationStatus, CanvasDocument, ConceptArtSubjectKind, ConceptCard } from '../types';

function conceptCardTag(cardId: string) {
  return `concept-card-${cardId.toLowerCase()}`;
}

function conceptCardTitle(card: ConceptCard) {
  if (card.displayName.trim()) return card.displayName.trim();
  const firstLine = card.prompt.trim().split('\n').find(Boolean);
  if (firstLine) return firstLine.slice(0, 80);
  return card.id.replace(/^card_/, 'Concept');
}

function subjectLabel(subjectKind: ConceptArtSubjectKind | null) {
  return subjectKind === 'location' ? 'Location' : subjectKind === 'character' ? 'Character' : 'Concept';
}

function latestAssetForCard(card: ConceptCard, assets: Asset[], assetsById: Map<string, Asset>, canvas: CanvasDocument) {
  const cardTag = conceptCardTag(card.id);
  const orderedIds: string[] = [];
  const addId = (assetId: string | null | undefined) => {
    if (assetId && !orderedIds.includes(assetId)) orderedIds.push(assetId);
  };

  Object.values(canvas.nodes).forEach((node) => {
    if (node.type !== 'imageGroup') return;
    if (node.sourceConceptCardId !== card.id && !node.tags.includes(cardTag)) return;
    addId(node.activeAssetId);
    node.assetIds.forEach(addId);
  });
  assets.filter((asset) => asset.tags.includes(cardTag)).forEach((asset) => addId(asset.id));
  addId(card.activeAssetId);
  card.assetIds.forEach(addId);

  return orderedIds.map((assetId) => assetsById.get(assetId) ?? null).find((asset): asset is Asset => Boolean(asset)) ?? null;
}

export function ConceptArtView({
  projectSlug,
  adaptation,
  assets,
  canvas,
  viewMode,
  onConceptCanvasUpdate,
  onReloadProject,
  onReloadAdaptation,
}: {
  projectSlug: string;
  adaptation: AdaptationStatus;
  assets: Asset[];
  canvas: CanvasDocument;
  viewMode: 'list' | 'canvas';
  onConceptCanvasUpdate: (canvasDoc: CanvasDocument, nodeId?: string) => void;
  onFocusNode: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onReloadProject: () => Promise<void>;
  onReloadAdaptation: () => Promise<void>;
}) {
  const assetsById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const [conceptCards, setConceptCards] = useState<ConceptCard[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingConcept, setDeletingConcept] = useState(false);
  const [suggestJob, setSuggestJob] = useState<'character' | 'location' | null>(null);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [uploadingConcept, setUploadingConcept] = useState(false);
  const [editingCard, setEditingCard] = useState<ConceptCard | null>(null);
  const [editName, setEditName] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const loadConceptCards = useCallback(async () => {
    const cards = await api.listConceptCards(projectSlug);
    setConceptCards(cards);
  }, [projectSlug]);

  useEffect(() => {
    void loadConceptCards().catch((err) => setError(formatRequestError(err)));
  }, [loadConceptCards]);

  const createConcept = async (subjectKind: ConceptArtSubjectKind) => {
    const busyId = `__create-${subjectKind}__`;
    setBusyKey(busyId);
    setError(null);
    try {
      await api.createConceptCard(projectSlug, { subjectKind });
      await loadConceptCards();
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

  const uploadConceptImage = async (file: File) => {
    setUploadingConcept(true);
    setError(null);
    try {
      await api.uploadConceptArt(projectSlug, file);
      await onReloadProject();
      await loadConceptCards();
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setUploadingConcept(false);
    }
  };

  const draftConceptCard = async (cardId: string) => {
    setBusyKey(cardId);
    setError(null);
    try {
      const result = await api.draftConceptCard(projectSlug, cardId);
      onConceptCanvasUpdate(result.canvas, result.nodeId);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setBusyKey(null);
    }
  };

  const deleteConceptCard = async (cardId: string) => {
    setBusyKey(cardId);
    setDeletingConcept(true);
    setError(null);
    try {
      await api.deleteConceptCard(projectSlug, cardId);
      await loadConceptCards();
      setPendingDeleteId(null);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setBusyKey(null);
      setDeletingConcept(false);
    }
  };

  const beginEditCard = (card: ConceptCard) => {
    setEditingCard(card);
    setEditName(card.displayName);
    setEditPrompt(card.prompt);
    setError(null);
  };

  const saveEditCard = async () => {
    if (!editingCard) return;
    setSavingEdit(true);
    setError(null);
    try {
      const updated = await api.updateConceptCard(projectSlug, editingCard.id, {
        displayName: editName,
        prompt: editPrompt,
      });
      setConceptCards((cards) => cards.map((card) => (card.id === updated.id ? updated : card)));
      setEditingCard(null);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setSavingEdit(false);
    }
  };

  useEffect(() => {
    if (!suggestJob) return;
    const timer = window.setInterval(async () => {
      try {
        const status = suggestJob === 'character'
          ? await api.getGenerateConceptCharacter(projectSlug)
          : await api.getGenerateConceptLocation(projectSlug);
        if (!status.running) {
          setSuggestJob(null);
          const workflowError = formatWorkflowStatusError(status);
          if (workflowError) setError(workflowError);
          await loadConceptCards();
          await onReloadAdaptation();
        }
      } catch (err) {
        setSuggestJob(null);
        setError(formatRequestError(err));
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [loadConceptCards, onReloadAdaptation, projectSlug, suggestJob]);

  const conceptWorkflowBusy = suggestJob !== null;

  const conceptChrome = (
    <>
      {viewMode === 'list' && (
        <div className="concept-art-styles-panel">
          <VisualStyleList
            projectSlug={projectSlug}
            styles={adaptation.visualStyles}
            onReload={onReloadProject}
          />
        </div>
      )}
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
                {busyKey === '__create-character__' ? 'Creating...' : 'New'}
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => void suggestConceptCharacter()}
                disabled={!adaptation.hasBookSession || conceptWorkflowBusy || uploadingConcept}
              >
                {suggestJob === 'character' ? 'Suggesting...' : 'Suggest'}
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
                {busyKey === '__create-location__' ? 'Creating...' : 'New'}
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => void suggestConceptLocation()}
                disabled={!adaptation.hasBookSession || conceptWorkflowBusy || uploadingConcept}
              >
                {suggestJob === 'location' ? 'Suggesting...' : 'Suggest'}
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
                {uploadingConcept ? 'Uploading...' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      </header>
      {error && <p className="error error-banner layout-view-error">{error}</p>}
    </>
  );

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
      {viewMode === 'canvas' ? (
        <div className="concept-art-canvas-chrome">{conceptChrome}</div>
      ) : (
        <div className="story-adaptation-screen story-panels-screen concept-art-screen">
          {conceptChrome}
          <div className="characters-hub-workspace">
            <section className="character-card-grid">
              {conceptCards.map((card) => {
                const asset = latestAssetForCard(card, assets, assetsById, canvas);
                const busy = busyKey === card.id;
                const title = conceptCardTitle(card);
                return (
                  <article key={card.id} className="story-card character-hub-card">
                    <div className={`character-hub-thumb ${asset ? 'has-image' : ''}`}>
                      {asset ? (
                        <div className="character-hub-thumb-frame">
                          <img src={asset.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${asset.id}/thumb`} alt="" />
                          <button
                            type="button"
                            className="character-hub-preview-eye"
                            onClick={() => setPreviewAssetId(asset.id)}
                            title="View full screen"
                            aria-label={`View ${title} full screen`}
                          >
                            View
                          </button>
                        </div>
                      ) : (
                        <p className="muted character-hub-thumb-prompt">{card.prompt.trim() || 'No prompt'}</p>
                      )}
                    </div>
                    <div className="character-hub-body">
                      <div className="concept-art-card-head">
                        <span className="concept-art-subject-badge">{subjectLabel(card.subjectKind)}</span>
                        <div className="character-hub-card-header">
                          <h3>{title}</h3>
                          <HubCardMenu
                            disabled={busy || deletingConcept}
                            ariaLabel="Concept actions"
                            onEdit={() => beginEditCard(card)}
                            onDelete={() => setPendingDeleteId(card.id)}
                          />
                        </div>
                      </div>
                      <div className="character-hub-actions">
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => void draftConceptCard(card.id)}
                          disabled={busy}
                        >
                          {busy ? 'Drafting...' : 'Draft'}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>
          </div>
        </div>
      )}
      {editingCard && createPortal(
        <div
          className="confirm-backdrop character-edit-modal"
          onClick={() => !savingEdit && setEditingCard(null)}
        >
          <div
            className="confirm-dialog character-edit-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="concept-edit-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="concept-edit-title">Edit concept card</h2>
            <label className="field-stack">
              <span>Name</span>
              <input value={editName} onChange={(event) => setEditName(event.target.value)} disabled={savingEdit} />
            </label>
            <label className="field-stack">
              <span>Prompt</span>
              <textarea value={editPrompt} onChange={(event) => setEditPrompt(event.target.value)} disabled={savingEdit} rows={10} />
            </label>
            <div className="row">
              <button className="primary" disabled={savingEdit} onClick={() => void saveEditCard()}>
                {savingEdit ? 'Saving...' : 'Save'}
              </button>
              <button className="secondary" disabled={savingEdit} onClick={() => setEditingCard(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {pendingDeleteId && createPortal(
        <div
          className="confirm-backdrop character-delete-confirm"
          onClick={() => !deletingConcept && setPendingDeleteId(null)}
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
              Remove this concept card?
              Generated images in the library are kept.
            </p>
            <div className="row">
              <button
                className="danger"
                disabled={deletingConcept}
                onClick={() => void deleteConceptCard(pendingDeleteId)}
              >
                {deletingConcept ? 'Deleting...' : 'Delete concept'}
              </button>
              <button className="secondary" disabled={deletingConcept} onClick={() => setPendingDeleteId(null)}>Cancel</button>
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
            x
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
