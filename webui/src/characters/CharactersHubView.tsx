import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { PiTaskPanel } from '../sessions/PiTaskPanel';
import { usePiTask } from '../sessions/usePiTask';
import { VisualStyleList } from '../visualStyles/VisualStyleList';
import { formatRequestError } from '../formatError';
import { HelpTip, HoverTooltip, Modal } from '../ui';
import { SYSTEM_TAGS, characterEntityTags, isCharacterCanvasNode, locationEntityTags, partitionAssetTagIds, userProjectTags, visibleDisplayName } from '../canvas/shared';
import { TagControlButton } from '../canvas/assetTagRow';
import type { AdaptationAssetLink, AdaptationStatus, Asset, CanvasDocument, CharacterRecord, CanvasNode, TagDefinition } from '../types';

function characterEntityTagForKey(key: string, projectTags: TagDefinition[]) {
  const tagId = slugifyFileKey(key);
  return projectTags.find((tag) => tag.id === tagId && tag.entityKind === 'character') ?? null;
}

function characterLabel(key: string, projectTags: TagDefinition[]) {
  return characterEntityTagForKey(key, projectTags)?.name ?? characterDisplayName(key);
}

function characterDisplayName(key: string) {
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

function characterDraftTagIds(key: string, link: AdaptationAssetLink, asset: Asset | null) {
  const entityTagId = slugifyFileKey(key);
  if (asset?.tags.length) {
    return asset.tags;
  }
  return Array.from(new Set([entityTagId, ...link.userTags]));
}

function mergeCharacterTagSelection(editingKey: string, draftTagIds: string[], userTags: string[], characterTags: string[], locationTags: string[]) {
  const entityTagId = slugifyFileKey(editingKey);
  const preserved = draftTagIds.filter((tagId) => SYSTEM_TAGS.has(tagId));
  return Array.from(new Set([
    ...preserved,
    ...userTags,
    entityTagId,
    ...characterTags.filter((tagId) => tagId !== entityTagId),
    ...locationTags,
  ]));
}

function characterBaseLink(record: CharacterRecord): AdaptationAssetLink | null {
  return record.variants.base ?? null;
}

function characterHubState(record: CharacterRecord): string {
  const base = characterBaseLink(record);
  if (base?.assetIds?.length) return 'Generated';
  if (base?.prompt) return 'Extracted';
  if (record.description.trim()) return 'Listed';
  return 'Not listed';
}

function characterVariantLabel(variantKey: string): string {
  if (variantKey === 'base') return 'Base';
  return variantKey
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function sortedVariantKeyList(keys: string[]): string[] {
  return [...keys].sort((left, right) => {
    if (left === 'base') return -1;
    if (right === 'base') return 1;
    return left.localeCompare(right);
  });
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
  onDraftArtifactToCanvas,
  onOpenChatForAsset,
  onViewAsset,
  onCreateTag,
  onSaveProjectTagName,
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
  onDraftArtifactToCanvas: (key: string) => Promise<void>;
  onOpenChatForAsset: (nodeId: string, assetId: string) => void;
  onViewAsset: (assetId: string) => void;
  onCreateTag: (tag: TagDefinition) => void;
  onSaveProjectTagName: (tagId: string, name: string) => Promise<void>;
  onPatchAssetTags: (assetId: string, tags: string[]) => Promise<void>;
  onReloadProject: () => Promise<void>;
  onOpenAgentSession: (sessionId: string) => void;
}) {
  const assetsById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const characterKeys = useMemo(() => new Set(Object.keys(adaptation.characters)), [adaptation.characters]);
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
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftVariantPrompts, setDraftVariantPrompts] = useState<Record<string, string>>({});
  const [draftTagIds, setDraftTagIds] = useState<string[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listTask = usePiTask(projectSlug, 'extract-character-list', async () => {
    await onReloadProject();
  });
  const extractAllTask = usePiTask(
    projectSlug,
    'extract-all-characters',
    async () => {
      await onReloadProject();
    },
    // Characters land one tool call at a time; show each as it arrives.
    async () => {
      await onReloadProject();
    },
  );
  const extractOneTask = usePiTask(projectSlug, 'extract-character', async () => {
    await onReloadProject();
  });
  const listJobRunning = listTask.isActive;
  const extractAllRunning = extractAllTask.isActive;
  const extractingSlug = extractOneTask.isActive ? extractOneTask.target : null;
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null);
  const [deletingCharacter, setDeletingCharacter] = useState(false);
  const [thumbnailIndexes, setThumbnailIndexes] = useState<Record<string, number>>({});
  const editingRecord = editingKey ? adaptation.characters[editingKey] : null;
  const editingLink = editingRecord ? characterBaseLink(editingRecord) : null;
  const editingAsset = editingLink ? latestAssetForLink(editingLink, assetsById) : null;

  const openEdit = (key: string, record: CharacterRecord) => {
    const link = characterBaseLink(record);
    const asset = link ? latestAssetForLink(link, assetsById) : null;
    setEditingKey(key);
    setDraftName(characterLabel(key, projectTags));
    setDraftDescription(record.description);
    setDraftVariantPrompts(Object.fromEntries(
      Object.entries(record.variants).map(([variantKey, variantLink]) => [variantKey, variantLink.prompt]),
    ));
    setDraftTagIds(characterDraftTagIds(key, link ?? { userTags: record.userTags } as AdaptationAssetLink, asset));
  };

  const saveEdit = async () => {
    if (!editingKey || !editingRecord) return;
    setBusyKey(editingKey);
    setError(null);
    try {
      const trimmedName = draftName.trim() || characterDisplayName(editingKey);
      const nextKey = slugifyFileKey(trimmedName);
      const shouldRenameKey = nextKey !== editingKey && !adaptation.characters[nextKey];
      const savedKey = shouldRenameKey ? nextKey : editingKey;
      const partitioned = partitionAssetTagIds(draftTagIds, projectTags);

      await api.updateAdaptationFile(projectSlug, 'characters', editingKey, {
        key: shouldRenameKey ? nextKey : editingKey,
        description: draftDescription,
        variants: Object.fromEntries(
          Object.entries(draftVariantPrompts).map(([variantKey, prompt]) => [variantKey, { prompt }]),
        ),
        userTags: partitioned.user,
      });
      await onReloadProject();

      if (trimmedName !== characterDisplayName(savedKey)) {
        await onSaveProjectTagName(savedKey, trimmedName);
      }

      if (editingAsset) {
        const entityTagId = slugifyFileKey(savedKey);
        const nextTags = Array.from(new Set([
          ...draftTagIds.filter((tagId) => SYSTEM_TAGS.has(tagId)),
          ...partitioned.user,
          entityTagId,
          ...partitioned.character.filter((tagId) => tagId !== entityTagId),
          ...partitioned.location,
        ]));
        await onPatchAssetTags(editingAsset.id, nextTags);
      }

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

  const deleteCharacter = async (key: string) => {
    setBusyKey(key);
    setDeletingCharacter(true);
    setError(null);
    try {
      await api.deleteAdaptationFile(projectSlug, 'characters', key);
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
    const existingKeys = Array.from(characterKeys);
    let index = existingKeys.length + 1;
    let key = `new-character-${index}`;
    while (existingKeys.includes(key)) {
      index += 1;
      key = `new-character-${index}`;
    }
    setBusyKey('__create__');
    setError(null);
    try {
      await api.createAdaptationFile(projectSlug, 'characters', {
        key,
        body: '',
        mode: 'new-image',
        styleRef: '',
      });
      await api.createImageGroup(projectSlug, {
        displayName: characterDisplayName(key),
        tags: ['comic-adaptation', 'character-sheet', key],
        prompt: '',
      });
      await onReloadProject();
      // Stay on the Characters list and open the edit modal in place.
      setEditingKey(key);
      setDraftName(characterDisplayName(key));
      setDraftDescription('');
      setDraftVariantPrompts({});
      setDraftTagIds([slugifyFileKey(key)]);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setBusyKey(null);
    }
  };

  const workflowBusy = listJobRunning || extractAllRunning || Boolean(extractingSlug);

  return (
    <>
      {viewMode === 'list' && (
        <div className="story-adaptation-screen story-panels-screen characters-hub-screen">
          <header className="layout-view-toolbar characters-hub-toolbar">
            <div className="layout-view-toolbar-primary">
              <button className="secondary" type="button" onClick={() => void createCharacter()} disabled={busyKey === '__create__'}>
                {busyKey === '__create__' ? 'Creating…' : '+ character'}
              </button>
              <button className="secondary" type="button" onClick={() => void listTask.start()} disabled={!adaptation.hasBookSession || workflowBusy}>
                {listJobRunning ? 'Listing…' : 'List characters'}
              </button>
              <button className="generate-button" type="button" onClick={() => void extractAllTask.start()} disabled={!adaptation.hasBookSession || workflowBusy}>
                {extractAllRunning ? 'Extracting all…' : 'Extract all'}
              </button>
            </div>
          </header>
          {error && <p className="error error-banner layout-view-error">{error}</p>}
          {listTask.state !== null && (
            <PiTaskPanel
              title="List characters"
              state={listTask.state}
              events={listTask.events}
              error={listTask.error}
              onAbort={() => void listTask.abort()}
              onDismiss={listTask.dismiss}
              onOpenSession={listTask.taskId ? () => onOpenAgentSession(listTask.taskId!) : undefined}
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
          <div className="characters-hub-workspace">
            <section className="character-card-grid">
              {Object.entries(adaptation.characters).sort(([left], [right]) => left.localeCompare(right)).map(([characterSlug, record]) => {
                const link = record ? characterBaseLink(record) : null;
                const taggedImages = characterImageAssetsForSlug(characterSlug, canvasEntries, assetsById);
                const thumbnailIndex = Math.min(thumbnailIndexes[characterSlug] ?? 0, Math.max(0, taggedImages.length - 1));
                const thumbnail = taggedImages[thumbnailIndex] ?? null;
                const asset = thumbnail?.asset ?? null;
                const busy = busyKey === characterSlug || extractingSlug === characterSlug;
                const canExtract = record != null && characterHubState(record) === 'Listed';
                const title = characterSlug
                  ? characterLabel(characterSlug, projectTags)
                  : characterDisplayName(characterSlug);
                const canPlaceOnCanvas = Boolean(characterSlug && link?.prompt.trim());
                return (
                  <article
                    key={characterSlug}
                    className={`story-card character-hub-card${record ? ' is-clickable' : ''}`}
                    onClick={record ? () => openEdit(characterSlug, record) : undefined}
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
                        <span className="muted">{link?.prompt.trim() ? link.prompt.trim().slice(0, 60) : 'No prompt'}</span>
                      )}
                    </div>
                    <div className="character-hub-body">
                      <div className="character-hub-card-header">
                        <h3>{title}</h3>
                      </div>
                      {!asset && link?.prompt.trim() && (
                        <p className="muted concept-art-node-preview">{link.prompt.trim().split('\n').slice(0, 2).join(' ')}</p>
                      )}
                      <div className="character-hub-actions" onClick={(event) => event.stopPropagation()}>
                        {characterSlug && canExtract && (
                          <button className="secondary" type="button" disabled={busy || !adaptation.hasBookSession} onClick={() => void extractOneTask.start({ target: characterSlug })}>
                            {extractingSlug === characterSlug ? 'Extracting…' : 'Extract'}
                          </button>
                        )}
                        {characterSlug && (
                          <button
                            className="secondary"
                            type="button"
                            disabled={busy || !canPlaceOnCanvas}
                            title={canPlaceOnCanvas ? 'Create another tagged draft node on the canvas' : 'Add a prompt before drafting to canvas'}
                            onClick={() => void draftToCanvas(characterSlug)}
                          >
                            {busy ? 'Working…' : 'Draft'}
                          </button>
                        )}
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
              {!Object.keys(adaptation.characters).length && <p className="muted">Add a character or list characters from the book to see cards here.</p>}
            </section>
          </div>
        </div>
      )}
      {editingKey && editingRecord && (
        <Modal
          title={draftName || characterLabel(editingKey, projectTags)}
          dialogClassName="editor-dialog--character-edit"
          onClose={() => setEditingKey(null)}
        >
          <div className="adaptation-file-form character-edit-form">
            <label className="field-label character-edit-name">
              Character name
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="Character name"
              />
            </label>
            <div className="field-label">
              Tags
              <div className="character-edit-tags">
                <TagControlButton
                  tagIds={draftTagIds}
                  projectTags={projectTags}
                  onPartitionedTagsChange={(userTags, characterTags, locationTags) => {
                    setDraftTagIds(mergeCharacterTagSelection(editingKey, draftTagIds, userTags, characterTags, locationTags));
                  }}
                  onCreateTag={onCreateTag}
                  className="character-edit-tag-control"
                  portaled
                />
              </div>
            </div>
            <label className="field-label">
              Character summary
              <textarea
                className="modal-textarea character-edit-description"
                rows={10}
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                placeholder={'## Summary\n\n...\n\n## Visual Description\n\n...'}
              />
            </label>
            {sortedVariantKeyList(Object.keys(draftVariantPrompts)).length > 0 ? (
              <div className="character-edit-variant-list">
                <h3 className="character-edit-section-heading">Image prompts</h3>
                {sortedVariantKeyList(Object.keys(draftVariantPrompts)).map((variantKey) => (
                  <label key={variantKey} className="field-label character-edit-variant-item">
                    {characterVariantLabel(variantKey)}
                    <textarea
                      className="modal-textarea"
                      rows={6}
                      value={draftVariantPrompts[variantKey] ?? ''}
                      onChange={(event) => {
                        setDraftVariantPrompts((current) => ({
                          ...current,
                          [variantKey]: event.target.value,
                        }));
                      }}
                    />
                  </label>
                ))}
              </div>
            ) : (
              <p className="muted">No image prompts yet. Run Extract to generate variant prompts.</p>
            )}
          </div>
          <div className="modal-actions character-edit-modal-actions">
            <button onClick={() => void saveEdit()} disabled={busyKey === editingKey || !draftName.trim()}>
              {busyKey === editingKey ? 'Saving...' : 'Save'}
            </button>
            <button className="secondary" onClick={() => setEditingKey(null)} disabled={busyKey === editingKey}>Cancel</button>
            <span className="character-edit-actions-spacer" />
            <button
              className="danger"
              type="button"
              disabled={busyKey === editingKey || deletingCharacter}
              onClick={() => setPendingDeleteKey(editingKey)}
            >
              Delete
            </button>
          </div>
        </Modal>
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
              Remove <strong>{characterLabel(pendingDeleteKey, projectTags)}</strong> from this project?
              The character file and adaptation metadata will be deleted. Generated images on the canvas are kept.
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

function slugifyFileKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'new-item';
}
