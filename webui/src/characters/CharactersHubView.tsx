import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { PiTaskPanel } from '../sessions/PiTaskPanel';
import { usePiTask } from '../sessions/usePiTask';
import { formatRequestError } from '../formatError';
import { SYSTEM_TAGS, isCharacterCanvasNode, partitionAssetTagIds } from '../canvas/shared';
import { CharacterEditModal, type CharacterDraft } from './CharacterEditModal';
import { characterDisplayName, characterHubState, characterIsExtracted, slugifyKey } from './characterShared';
import type { AdaptationStatus, Asset, CanvasDocument, CharacterRecord, CanvasNode, EntityVariant, TagDefinition } from '../types';

function latestAssetForVariant(variant: EntityVariant, assetsById: Map<string, Asset>) {
  const assetId = variant.activeAssetId ?? variant.assetIds[variant.assetIds.length - 1];
  return assetId ? assetsById.get(assetId) ?? null : null;
}

function characterImageAssetsForSlug(
  characterSlug: string,
  canvasEntries: Array<[string, CanvasNode]>,
  assetsById: Map<string, Asset>,
) {
  const assets: Array<{ asset: Asset; nodeId: string }> = [];
  const seen = new Set<string>();
  for (const [nodeId, node] of canvasEntries) {
    if (!node.tags.includes(characterSlug)) continue;
    const orderedAssetIds = [
      ...(node.activeAssetId ? [node.activeAssetId] : []),
      ...node.assetIds,
    ];
    for (const assetId of orderedAssetIds) {
      if (seen.has(assetId)) continue;
      const asset = assetsById.get(assetId);
      if (!asset || asset.archivedAt) continue;
      seen.add(assetId);
      assets.push({ asset, nodeId });
    }
  }
  return assets;
}

export function CharactersHubView({
  projectSlug,
  adaptation,
  assets,
  canvas,
  projectTags,
  viewMode,
  onDraftVariantToCanvas,
  onOpenChatForAsset,
  onViewAsset,
  onCreateTag,
  onPatchAssetTags,
  onReloadProject,
  onOpenAgentSession,
}: {
  projectSlug: string;
  adaptation: AdaptationStatus;
  assets: Asset[];
  canvas: CanvasDocument;
  projectTags: TagDefinition[];
  viewMode: 'list' | 'canvas';
  onDraftVariantToCanvas: (characterSlug: string, variantKey: string) => Promise<void>;
  onOpenChatForAsset: (nodeId: string, assetId: string) => void;
  onViewAsset: (assetId: string) => void;
  onCreateTag: (tag: TagDefinition) => void;
  onPatchAssetTags: (assetId: string, tags: string[]) => Promise<void>;
  onReloadProject: () => Promise<void>;
  onOpenAgentSession: (sessionId: string) => void;
}) {
  const assetsById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const canvasEntries = useMemo(
    () => Object.entries(canvas.nodes)
      .filter((entry): entry is [string, CanvasNode] => {
        const node = entry[1];
        return isCharacterCanvasNode(node.tags, projectTags);
      })
      .sort(([left], [right]) => left.localeCompare(right)),
    [canvas.nodes, projectTags],
  );
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const discoverTask = usePiTask(
    projectSlug,
    'discover-characters',
    async () => {
      await onReloadProject();
    },
    // Characters register one tool call at a time; show each as it arrives.
    async () => {
      await onReloadProject();
    },
  );
  const extractAllTask = usePiTask(
    projectSlug,
    'extract-all-characters',
    async () => {
      await onReloadProject();
    },
    async () => {
      await onReloadProject();
    },
  );
  const extractOneTask = usePiTask(projectSlug, 'extract-character', async () => {
    await onReloadProject();
  });
  const refineTask = usePiTask(projectSlug, 'refine-character', async () => {
    await onReloadProject();
  });
  const discoverRunning = discoverTask.isActive;
  const extractAllRunning = extractAllTask.isActive;
  const extractingSlug = extractOneTask.isActive ? extractOneTask.target : null;
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null);
  const [deletingCharacter, setDeletingCharacter] = useState(false);
  const [thumbnailIndexes, setThumbnailIndexes] = useState<Record<string, number>>({});
  const editingRecord = editingKey ? adaptation.characters[editingKey] ?? null : null;

  const saveEdit = async (draft: CharacterDraft) => {
    if (!editingKey || !editingRecord) return;
    setBusyKey(editingKey);
    setError(null);
    try {
      const partitioned = partitionAssetTagIds(draft.tagIds, projectTags);
      // Follow the display name with the slug while nothing references it yet;
      // once any variant has generated images, the slug (and its entity tag,
      // node tags, panel links) stays put.
      const nextKey = slugifyKey(draft.name);
      const hasImages = Object.values(editingRecord.variants).some((variant) => variant.assetIds.length > 0);
      const shouldRename = Boolean(nextKey) && nextKey !== editingKey && !hasImages && !adaptation.characters[nextKey];
      await api.patchCharacter(projectSlug, editingKey, {
        ...(shouldRename ? { slug: nextKey } : {}),
        name: draft.name.trim(),
        summary: draft.summary,
        visualDescription: draft.visualDescription,
        performanceNotes: draft.performanceNotes,
        continuityNotes: draft.continuityNotes,
        userTags: partitioned.user,
        variants: draft.variants,
        removeVariants: draft.removedVariants.filter((variantKey) => !draft.variants[variantKey]),
      });
      await onReloadProject();

      const base = editingRecord.variants.base;
      const activeAsset = base ? latestAssetForVariant(base, assetsById) : null;
      if (activeAsset) {
        const nextTags = Array.from(new Set([
          ...activeAsset.tags.filter((tagId) => SYSTEM_TAGS.has(tagId)),
          ...partitioned.user,
          editingKey,
          ...partitioned.character.filter((tagId) => tagId !== editingKey),
          ...partitioned.location,
        ]));
        await onPatchAssetTags(activeAsset.id, nextTags);
      }

      setEditingKey(null);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setBusyKey(null);
    }
  };

  const draftVariantToCanvas = async (key: string, variantKey: string) => {
    setBusyKey(key);
    setError(null);
    try {
      await onDraftVariantToCanvas(key, variantKey);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setBusyKey(null);
    }
  };

  const deleteCharacter = async (key: string) => {
    setBusyKey(key);
    setDeletingCharacter(true);
    setError(null);
    try {
      await api.deleteCharacter(projectSlug, key);
      await onReloadProject();
      if (editingKey === key) {
        setEditingKey(null);
      }
      setPendingDeleteKey(null);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setBusyKey(null);
      setDeletingCharacter(false);
    }
  };

  const createCharacter = async () => {
    const existingKeys = new Set(Object.keys(adaptation.characters));
    let index = existingKeys.size + 1;
    while (existingKeys.has(`new-character-${index}`)) {
      index += 1;
    }
    setBusyKey('__create__');
    setError(null);
    try {
      const record = await api.createCharacter(projectSlug, { name: `New Character ${index}` });
      await onReloadProject();
      // Stay on the Characters list and open the edit modal in place.
      setEditingKey(record.slug);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setBusyKey(null);
    }
  };

  const workflowBusy = discoverRunning || extractAllRunning || Boolean(extractingSlug) || refineTask.isActive;

  return (
    <>
      {viewMode === 'list' && (
        <div className="story-adaptation-screen story-panels-screen characters-hub-screen">
          <header className="layout-view-toolbar characters-hub-toolbar">
            <div className="layout-view-toolbar-primary">
              <button className="secondary" type="button" onClick={() => void createCharacter()} disabled={busyKey === '__create__'}>
                {busyKey === '__create__' ? 'Creating…' : '+ character'}
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => void discoverTask.start()}
                disabled={!adaptation.hasBookSession || workflowBusy}
                title="Read through the book and register every character as a card"
              >
                {discoverRunning ? 'Finding…' : 'Find characters'}
              </button>
              <button className="generate-button" type="button" onClick={() => void extractAllTask.start()} disabled={!adaptation.hasBookSession || workflowBusy}>
                {extractAllRunning ? 'Extracting all…' : 'Extract all'}
              </button>
            </div>
          </header>
          {error && <p className="error error-banner layout-view-error">{error}</p>}
          {discoverTask.state !== null && (
            <PiTaskPanel
              title="Find characters"
              state={discoverTask.state}
              events={discoverTask.events}
              error={discoverTask.error}
              onAbort={() => void discoverTask.abort()}
              onDismiss={discoverTask.dismiss}
              onOpenSession={discoverTask.taskId ? () => onOpenAgentSession(discoverTask.taskId!) : undefined}
            />
          )}
          {extractAllTask.state !== null && (
            <PiTaskPanel
              title="Extract all characters"
              state={extractAllTask.state}
              events={extractAllTask.events}
              error={extractAllTask.error}
              onAbort={() => void extractAllTask.abort()}
              onDismiss={extractAllTask.dismiss}
              onOpenSession={extractAllTask.taskId ? () => onOpenAgentSession(extractAllTask.taskId!) : undefined}
            />
          )}
          {extractOneTask.state !== null && (
            <PiTaskPanel
              title={extractOneTask.target ? `Extract ${extractOneTask.target}` : 'Extract character'}
              state={extractOneTask.state}
              events={extractOneTask.events}
              error={extractOneTask.error}
              onAbort={() => void extractOneTask.abort()}
              onDismiss={extractOneTask.dismiss}
              onOpenSession={extractOneTask.taskId ? () => onOpenAgentSession(extractOneTask.taskId!) : undefined}
            />
          )}
          {refineTask.state !== null && (
            <PiTaskPanel
              title={refineTask.target ? `Refine ${refineTask.target}` : 'Refine character'}
              state={refineTask.state}
              events={refineTask.events}
              error={refineTask.error}
              onAbort={() => void refineTask.abort()}
              onDismiss={refineTask.dismiss}
              onOpenSession={refineTask.taskId ? () => onOpenAgentSession(refineTask.taskId!) : undefined}
            />
          )}
          <div className="characters-hub-workspace">
            <section className="character-card-grid">
              {Object.entries(adaptation.characters).sort(([left], [right]) => left.localeCompare(right)).map(([characterSlug, record]) => {
                const base = record.variants.base ?? null;
                const taggedImages = characterImageAssetsForSlug(characterSlug, canvasEntries, assetsById);
                const thumbnailIndex = Math.min(thumbnailIndexes[characterSlug] ?? 0, Math.max(0, taggedImages.length - 1));
                const thumbnail = taggedImages[thumbnailIndex] ?? null;
                const asset = thumbnail?.asset ?? null;
                const busy = busyKey === characterSlug || extractingSlug === characterSlug;
                const state = characterHubState(record);
                const title = characterDisplayName(record);
                const canPlaceOnCanvas = Boolean(base?.prompt.trim());
                return (
                  <article
                    key={characterSlug}
                    className="story-card character-hub-card is-clickable"
                    onClick={() => setEditingKey(characterSlug)}
                  >
                    <div
                      className={`character-hub-thumb ${asset ? 'has-image' : ''}`}
                      onClick={(event) => {
                        if (!asset) return;
                        event.stopPropagation();
                        onViewAsset(asset.id);
                      }}
                      role={asset ? 'button' : undefined}
                    >
                      {asset ? (
                        <div className="character-hub-thumb-frame">
                          <img src={asset.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${asset.id}/thumb`} alt="" />
                          {taggedImages.length > 1 && (
                            <div className="character-hub-thumb-nav" onClick={(event) => event.stopPropagation()}>
                              <button
                                type="button"
                                className="secondary character-hub-thumb-nav-button"
                                aria-label="Previous character thumbnail"
                                onClick={() => {
                                  setThumbnailIndexes((current) => ({
                                    ...current,
                                    [characterSlug]: (thumbnailIndex - 1 + taggedImages.length) % taggedImages.length,
                                  }));
                                }}
                              >
                                ‹
                              </button>
                              <span>{thumbnailIndex + 1}/{taggedImages.length}</span>
                              <button
                                type="button"
                                className="secondary character-hub-thumb-nav-button"
                                aria-label="Next character thumbnail"
                                onClick={() => {
                                  setThumbnailIndexes((current) => ({
                                    ...current,
                                    [characterSlug]: (thumbnailIndex + 1) % taggedImages.length,
                                  }));
                                }}
                              >
                                ›
                              </button>
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="muted">
                          {base?.prompt.trim()
                            ? base.prompt.trim().slice(0, 60)
                            : record.summary.trim().slice(0, 60) || 'Not extracted yet'}
                        </span>
                      )}
                    </div>
                    <div className="character-hub-body">
                      <div className="character-hub-card-header">
                        <h3>{title}</h3>
                      </div>
                      {!asset && (base?.prompt.trim() || record.summary.trim()) && (
                        <p className="muted concept-art-node-preview">
                          {(base?.prompt.trim() || record.summary.trim()).split('\n').slice(0, 2).join(' ')}
                        </p>
                      )}
                      <div className="character-hub-actions" onClick={(event) => event.stopPropagation()}>
                        {state === 'Empty' && (
                          <button className="secondary" type="button" disabled={busy || !adaptation.hasBookSession} onClick={() => void extractOneTask.start({ target: characterSlug })}>
                            {extractingSlug === characterSlug ? 'Extracting…' : 'Extract'}
                          </button>
                        )}
                        <button
                          className="secondary"
                          type="button"
                          disabled={busy || !canPlaceOnCanvas}
                          title={canPlaceOnCanvas ? 'Create another tagged draft node on the canvas' : 'Add a prompt before drafting to canvas'}
                          onClick={() => void draftVariantToCanvas(characterSlug, 'base')}
                        >
                          {busy ? 'Working…' : 'Draft'}
                        </button>
                        {asset && (
                          <button className="secondary" type="button" onClick={() => onOpenChatForAsset(thumbnail.nodeId, asset.id)}>
                            Refine
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
              {!Object.keys(adaptation.characters).length && <p className="muted">Add a character or run Find characters to register the book's cast here.</p>}
            </section>
          </div>
        </div>
      )}
      {editingKey && editingRecord && (
        <CharacterEditModal
          characterSlug={editingKey}
          record={editingRecord}
          isExtracted={characterIsExtracted(editingRecord)}
          hasBookSession={adaptation.hasBookSession}
          projectTags={projectTags}
          busy={busyKey === editingKey}
          extractTask={extractOneTask}
          refineTask={refineTask}
          onSave={saveEdit}
          onDraftVariant={(variantKey) => draftVariantToCanvas(editingKey, variantKey)}
          onClose={() => setEditingKey(null)}
          onRequestDelete={() => setPendingDeleteKey(editingKey)}
          onCreateTag={onCreateTag}
        />
      )}
      {pendingDeleteKey && createPortal(
        <div
          className="confirm-backdrop character-delete-confirm"
          onClick={() => !deletingCharacter && setPendingDeleteKey(null)}
        >
          <div
            className="confirm-dialog character-delete-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="character-delete-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="character-delete-confirm-title">Delete character?</h2>
            <p>
              Remove <strong>{adaptation.characters[pendingDeleteKey] ? characterDisplayName(adaptation.characters[pendingDeleteKey]) : pendingDeleteKey}</strong> from this project?
              The character record will be deleted. Generated images on the canvas are kept.
            </p>
            <div className="row">
              <button
                className="danger"
                disabled={deletingCharacter}
                onClick={() => void deleteCharacter(pendingDeleteKey)}
              >
                {deletingCharacter ? 'Deleting...' : 'Delete character'}
              </button>
              <button className="secondary" disabled={deletingCharacter} onClick={() => setPendingDeleteKey(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
