import { useEffect, useMemo, useRef, useState } from 'react';
import type { Node } from 'reactflow';
import { isCanonicalStyleRefAsset, styleRefKindForTags } from '../styleRefs';
import type { AdaptationStatus, Asset, DraftCanvasNode, GenerationParams, ImageGroupCanvasNode, StyleRefKind, TagDefinition, VisualStyleDefinition } from '../types';
import { VisualStyleSelect } from '../adaptation/visualStyleSelect';
import { TagControlButton } from './assetTagRow';
import { canDeleteNode } from './roles';
import { assetLabel, capabilitiesForModel, defaultDraftParams, modelCapabilities, normalizedParamsForModel, uniqueOptions, visibleDisplayName, visibleVariants } from './shared';
import type { DraftNodeData, ImageGroupNodeData, PhotoNodeData } from './types';

function GenerationErrorNotice({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <div className="generation-error-notice" role="alert">
      <strong>Generation failed</strong>
      <p>{message}</p>
    </div>
  );
}

export function NodeSidebar({
  node,
  assets,
  adaptation,
  projectTags,
  coverAssetId,
  onDraftChange,
  onImageGroupChange,
  onGenerate,
  onGenerateVariants,
  generationError,
  onCreateChildText,
  onSaveStyleRefPrompt,
  onSetStyleRefAsset,
  onSetProjectCover,
  onFindOnCanvas,
  onVariant,
  onCreateSibling,
  onDelete,
  onArchiveImage,
  onRestoreImage,
  onOpenAsset,
  onPartitionedAssetTagsChange,
  onCreateTag,
  onRefineChat,
  archivedOnly = false,
}: {
  node: Node<PhotoNodeData>;
  assets: Asset[];
  adaptation: AdaptationStatus | null;
  projectTags: TagDefinition[];
  coverAssetId?: string | null;
  onDraftChange: (id: string, patch: Partial<DraftCanvasNode>) => void;
  onImageGroupChange: (id: string, patch: Partial<ImageGroupCanvasNode>) => void;
  onGenerate: (id: string, draft: DraftNodeData | ImageGroupNodeData) => void;
  onGenerateVariants: (id: string, group: ImageGroupNodeData, params: GenerationParams, visualStyleId?: string | null) => void;
  generationError?: string | null;
  onCreateChildText: (node: Node<DraftNodeData>) => void;
  onSaveStyleRefPrompt: (kind: StyleRefKind, prompt: string) => Promise<void>;
  onSetStyleRefAsset: (kind: StyleRefKind, assetId: string) => void;
  onSetProjectCover: (assetId: string) => void;
  onFindOnCanvas: (nodeId: string) => void;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
  onCreateSibling: (group: ImageGroupNodeData, sourceAsset: Asset) => void;
  onDelete: (id: string, assetId?: string) => void;
  onArchiveImage: (nodeId: string, assetId: string) => void;
  onRestoreImage: (nodeId: string, assetId: string) => void;
  onOpenAsset: (assetId: string) => void;
  onPartitionedAssetTagsChange: (nodeId: string, assetId: string, userTags: string[], characterTags: string[], locationTags: string[]) => void;
  onCreateTag: (tag: TagDefinition) => void;
  onRefineChat: (nodeId: string, assetId: string) => void;
  archivedOnly?: boolean;
}) {
  if (node.data.kind === 'draft') {
    const draftNode: Node<DraftNodeData> = { ...node, data: node.data };
    return (
      <DraftSidebar
        node={draftNode}
        assets={assets}
        visualStyles={adaptation?.visualStyles ?? []}
        defaultVisualStyleId={adaptation?.defaultVisualStyleId}
        onDraftChange={onDraftChange}
        onGenerate={onGenerate}
        onCreateChildText={onCreateChildText}
        onSaveStyleRefPrompt={onSaveStyleRefPrompt}
        onDelete={onDelete}
        generationError={generationError}
      />
    );
  }

  const imageNode: Node<ImageGroupNodeData> = { ...node, data: node.data };
  if (!node.data.activeAsset && !node.data.assetIds.length) {
    const promptNode: Node<DraftNodeData> = {
      ...node,
      type: 'draft',
      data: {
        kind: 'draft',
        type: 'draft',
        nodeId: node.data.nodeId,
        displayName: node.data.displayName,
        x: node.data.x,
        y: node.data.y,
        width: node.data.width ?? null,
        tags: node.data.tags,
        role: node.data.role ?? null,
        refs: node.data.refs ?? [],
        prompt: node.data.prompt ?? '',
        params: node.data.params ?? defaultDraftParams,
        visualStyleId: node.data.visualStyleId ?? null,
        onDetails: node.data.onDetails,
      },
    };
    return (
      <DraftSidebar
        node={promptNode}
        assets={assets}
        visualStyles={adaptation?.visualStyles ?? []}
        defaultVisualStyleId={adaptation?.defaultVisualStyleId}
        onDraftChange={(id, patch) => onImageGroupChange(id, {
          displayName: patch.displayName,
          tags: patch.tags,
          role: patch.role,
          refs: patch.refs,
          prompt: patch.prompt,
          params: patch.params,
          visualStyleId: patch.visualStyleId,
        })}
        onGenerate={(id) => onGenerate(id, imageNode.data)}
        onCreateChildText={() => undefined}
        onSaveStyleRefPrompt={onSaveStyleRefPrompt}
        onDelete={onDelete}
        generationError={generationError}
      />
    );
  }
  if (!node.data.activeAsset) {
    return (
      <aside className="details-sidebar">
        <h2>Missing image</h2>
        <button className="danger" onClick={() => onDelete(node.id)}>Delete node</button>
      </aside>
    );
  }
  return (
    <ImageSidebar
      node={imageNode}
      asset={node.data.activeAsset}
      assets={assets}
      adaptation={adaptation}
      projectTags={projectTags}
      coverAssetId={coverAssetId}
      onArchiveImage={onArchiveImage}
      onRestoreImage={onRestoreImage}
      onOpenAsset={onOpenAsset}
      onPartitionedAssetTagsChange={onPartitionedAssetTagsChange}
      onCreateTag={onCreateTag}
      onNodeChange={onImageGroupChange}
      onVariant={onVariant}
      onCreateSibling={onCreateSibling}
      onGenerateVariants={onGenerateVariants}
      generationError={generationError}
      onSetStyleRefAsset={onSetStyleRefAsset}
      onSetProjectCover={onSetProjectCover}
      onFindOnCanvas={onFindOnCanvas}
      onRefineChat={onRefineChat}
      archivedOnly={archivedOnly}
    />
  );
}

function DraftSidebar({
  node,
  assets,
  visualStyles,
  defaultVisualStyleId,
  onDraftChange,
  onGenerate,
  onCreateChildText,
  onSaveStyleRefPrompt,
  onDelete,
  generationError,
}: {
  node: Node<DraftNodeData>;
  assets: Asset[];
  visualStyles: VisualStyleDefinition[];
  defaultVisualStyleId?: string | null;
  onDraftChange: (id: string, patch: Partial<DraftCanvasNode>) => void;
  onGenerate: (id: string, draft: DraftNodeData) => void;
  onCreateChildText: (node: Node<DraftNodeData>) => void;
  onSaveStyleRefPrompt: (kind: StyleRefKind, prompt: string) => Promise<void>;
  onDelete: (id: string, assetId?: string) => void;
  generationError?: string | null;
}) {
  const draft = node.data;
  const canDelete = canDeleteNode(node);
  const isDurableSource = draft.role?.type === 'style-ref-source';
  const isFileBackedPrompt = draft.role?.type === 'style-ref-source';
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [isParentPickerOpen, setIsParentPickerOpen] = useState(false);
  const parents = draft.refs.map((ref) => assets.find((asset) => asset.id === ref) ?? null);
  const availableParents = assets.filter((asset) => !draft.refs.includes(asset.id));
  const draftModel = draft.params.model ?? defaultDraftParams.model;
  const draftCapabilities = capabilitiesForModel(draftModel);
  const styleRefKind = styleRefKindForTags(draft.tags);
  const styleRefLabel = styleRefKind === 'archetype-character' ? 'character' : styleRefKind === 'archetype-scene' ? 'scene' : null;
  const sourceLabel = styleRefLabel ? `${styleRefLabel} archetype` : null;
  const showArchetypeControls = Boolean(styleRefKind);
  const [isEditingName, setIsEditingName] = useState(false);
  const [draftName, setDraftName] = useState(visibleDisplayName(draft.displayName));
  const [styleRefPromptDraft, setStyleRefPromptDraft] = useState<string | null>(null);
  const [isSavingStyleRefPrompt, setIsSavingStyleRefPrompt] = useState(false);
  useEffect(() => {
    if (!isEditingName) setDraftName(visibleDisplayName(draft.displayName));
  }, [draft.displayName, isEditingName]);
  const saveName = () => {
    onDraftChange(node.id, { displayName: draftName.trim() });
    setIsEditingName(false);
  };
  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft.prompt]);
  return (
    <aside className="details-sidebar">
      <div className="popover-header">
        {isEditingName ? (
          <input
            className="sidebar-title-input"
            value={draftName}
            autoFocus
            aria-label="Draft name"
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={saveName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveName();
              if (event.key === 'Escape') {
                setDraftName(visibleDisplayName(draft.displayName));
                setIsEditingName(false);
              }
            }}
          />
        ) : (
          <h2
            className={`sidebar-title ${visibleDisplayName(draft.displayName) ? '' : 'placeholder'}`}
            onDoubleClick={() => setIsEditingName(true)}
          >
            {visibleDisplayName(draft.displayName) || 'Draft'}
          </h2>
        )}
        {canDelete ? <button className="danger" onClick={() => onDelete(node.id)}>Delete</button> : null}
      </div>
      {styleRefLabel && (
        <div className="canvas-role-badge">
          Durable {styleRefLabel} archetype prompt
        </div>
      )}
      {isDurableSource && (
        <p className="muted">
          This {sourceLabel ?? 'source'} prompt is backed by an adaptation file. Pick a visual style below, then generate the canonical reference image.
        </p>
      )}
      {isDurableSource && <button className="secondary" onClick={() => onCreateChildText(node)}>Create child text artifact</button>}
      {!isFileBackedPrompt && (
        <section className="sidebar-section parent-section">
          <h3>Parents</h3>
          <div className="parent-list">
            {parents.length === 0 ? (
              <div className="parent-item">
                <div className="parent-thumb-placeholder" />
                <span className="muted">None</span>
              </div>
            ) : parents.map((parent, index) => (
              <div className="parent-item" key={draft.refs[index]}>
                {parent?.thumbnailUrl ? <img src={parent.thumbnailUrl} alt="" /> : <div className="parent-thumb-placeholder" />}
                <span>{visibleDisplayName(draft.parentDisplayNames?.get(draft.refs[index]) ?? '') || assetLabel(parent, 'Unknown parent')}</span>
                <button
                  className="parent-remove"
                  onClick={() => onDraftChange(node.id, { refs: draft.refs.filter((_, refIndex) => refIndex !== index) })}
                  title="Remove parent"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button className="add-parent-button" onClick={() => setIsParentPickerOpen((current) => !current)}>+</button>
          {isParentPickerOpen && (
            <div className="asset-picker-popover">
              {availableParents.length === 0 && <p className="muted">All assets are already parents.</p>}
              {availableParents.map((asset) => (
                <button
                  className="asset-picker-row"
                  key={asset.id}
                  onClick={() => {
                    onDraftChange(node.id, { refs: [...draft.refs, asset.id] });
                    setIsParentPickerOpen(false);
                  }}
                >
                  {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" /> : <div className="parent-thumb-placeholder" />}
                  <span>{visibleDisplayName(draft.parentDisplayNames?.get(asset.id) ?? '') || assetLabel(asset)}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      {(!isFileBackedPrompt || showArchetypeControls) && (
        <VisualStyleSelect
          styles={visualStyles}
          value={draft.visualStyleId}
          defaultStyleId={defaultVisualStyleId}
          onChange={(styleId) => onDraftChange(node.id, { visualStyleId: styleId })}
        />
      )}
      <section className={`sidebar-section ${isFileBackedPrompt ? 'style-ref-sidebar-section' : ''}`}>
        <label className="field-label">
          {isFileBackedPrompt ? 'File-backed prompt' : 'Prompt'}
          <textarea
            ref={promptRef}
            className="prompt-textarea"
            autoFocus={!isFileBackedPrompt}
            value={styleRefKind ? (styleRefPromptDraft ?? draft.prompt) : draft.prompt}
            onChange={(event) => (styleRefKind ? setStyleRefPromptDraft(event.target.value) : onDraftChange(node.id, { prompt: event.target.value }))}
            placeholder="Prompt"
          />
        </label>
        {styleRefKind && styleRefPromptDraft !== null && styleRefPromptDraft !== draft.prompt && (
          <button
            className="secondary"
            disabled={isSavingStyleRefPrompt}
            onClick={async () => {
              setIsSavingStyleRefPrompt(true);
              try {
                await onSaveStyleRefPrompt(styleRefKind, styleRefPromptDraft);
                setStyleRefPromptDraft(null);
              } finally {
                setIsSavingStyleRefPrompt(false);
              }
            }}
          >
            {isSavingStyleRefPrompt ? 'Saving prompt...' : 'Save prompt to file'}
          </button>
        )}
        {isFileBackedPrompt && (
          <p className="muted">This prompt is backed by an adaptation file; saving writes it back to disk.</p>
        )}
      </section>
      {(!isFileBackedPrompt || showArchetypeControls) && <section className="sidebar-section generation-section">
        <h3>Parameters</h3>
        <GenerationErrorNotice message={generationError} />
      <div className="row">
        <select
          value={draftModel ?? ''}
          onChange={(event) => onDraftChange(node.id, { params: normalizedParamsForModel(draft.params, event.target.value) })}
        >
          {Object.keys(modelCapabilities).map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <input
          value={draft.params.seed ?? ''}
          onChange={(event) =>
            onDraftChange(node.id, { params: { ...draft.params, seed: event.target.value ? Number(event.target.value) : null } })
          }
          placeholder="Seed optional"
        />
      </div>
      <div className="row">
        <select
          value={draft.params.aspectRatio ?? (showArchetypeControls ? '1:1' : '16:9')}
          onChange={(event) => onDraftChange(node.id, { params: { ...draft.params, aspectRatio: event.target.value } })}
        >
          {draftCapabilities.aspectRatios.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <select value={draft.params.imageSize ?? '1K'} onChange={(event) => onDraftChange(node.id, { params: { ...draft.params, imageSize: event.target.value } })}>
          {draftCapabilities.imageSizes.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>
      <div className="generate-control">
        <button
          className="generate-button"
          onClick={() => onGenerate(node.id, draft)}
          disabled={
            !draft.prompt.trim()
            || draft.isGenerating
            || (showArchetypeControls && !draft.visualStyleId)
          }
        >
          {draft.isGenerating && <span className="spinner" aria-hidden="true" />}
          {draft.isGenerating ? 'Generating...' : showArchetypeControls ? 'Generate canonical reference' : 'Generate'}
        </button>
        {!showArchetypeControls && (
          <label>
            Batch size
            <input
              type="number"
              min={1}
              max={8}
              value={draft.params.batchCount}
              onChange={(event) => onDraftChange(node.id, { params: { ...draft.params, batchCount: Number(event.target.value) } })}
            />
          </label>
        )}
      </div>
      </section>}
    </aside>
  );
}

function ImageSidebar({
  node,
  asset,
  assets,
  adaptation,
  projectTags,
  coverAssetId,
  onArchiveImage,
  onRestoreImage,
  onOpenAsset,
  onPartitionedAssetTagsChange,
  onCreateTag,
  onNodeChange,
  onVariant,
  onCreateSibling,
  onGenerateVariants,
  generationError,
  onSetStyleRefAsset,
  onSetProjectCover,
  onFindOnCanvas,
  onRefineChat,
  archivedOnly = false,
}: {
  node: Node<ImageGroupNodeData>;
  asset: Asset;
  assets: Asset[];
  adaptation: AdaptationStatus | null;
  projectTags: TagDefinition[];
  coverAssetId?: string | null;
  onArchiveImage: (nodeId: string, assetId: string) => void;
  onRestoreImage: (nodeId: string, assetId: string) => void;
  onOpenAsset: (assetId: string) => void;
  onPartitionedAssetTagsChange: (nodeId: string, assetId: string, userTags: string[], characterTags: string[], locationTags: string[]) => void;
  onCreateTag: (tag: TagDefinition) => void;
  onNodeChange: (id: string, patch: Partial<ImageGroupCanvasNode>) => void;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
  onCreateSibling: (group: ImageGroupNodeData, sourceAsset: Asset) => void;
  onGenerateVariants: (id: string, group: ImageGroupNodeData, params: GenerationParams, visualStyleId?: string | null) => void;
  generationError?: string | null;
  onSetStyleRefAsset: (kind: StyleRefKind, assetId: string) => void;
  onSetProjectCover: (assetId: string) => void;
  onFindOnCanvas: (nodeId: string) => void;
  onRefineChat: (nodeId: string, assetId: string) => void;
  archivedOnly?: boolean;
}) {
  const [isVariantPanelOpen, setIsVariantPanelOpen] = useState(false);
  const [variantParams, setVariantParams] = useState(defaultDraftParams);
  const [variantVisualStyleId, setVariantVisualStyleId] = useState<string | null>(null);
  const prompt = asset.prompt?.text ?? '';
  const refs = asset.generation?.refs ?? [];
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const visibleVariantsList = visibleVariants(assets, node.data.assetIds, archivedOnly);
  const activeVariantIndex = Math.max(0, visibleVariantsList.findIndex((variant) => variant.id === asset.id));
  const hasMultipleVariants = visibleVariantsList.length > 1;
  const isGeneratedResult = node.data.role?.type === 'generated-result';
  const styleRefKind = styleRefKindForTags(node.data.tags);
  const isCharacterArchetype = adaptation?.styleRefStatuses?.['archetype-character']?.assetId === asset.id;
  const isSceneArchetype = adaptation?.styleRefStatuses?.['archetype-scene']?.assetId === asset.id;
  const isProjectCover = coverAssetId === asset.id;
  const canSetCanonicalReference = Boolean(styleRefKind) || isCanonicalStyleRefAsset(adaptation, asset.id);
  const activeModel = isVariantPanelOpen ? variantParams.model ?? asset.generation?.model : asset.generation?.model;
  const activeCapabilities = capabilitiesForModel(activeModel);
  const modelOptions = uniqueOptions(Object.keys(modelCapabilities), asset.generation?.model);
  const aspectRatioOptions = isVariantPanelOpen ? activeCapabilities.aspectRatios : uniqueOptions(activeCapabilities.aspectRatios, asset.generation?.aspectRatio);
  const imageSizeOptions = isVariantPanelOpen ? activeCapabilities.imageSizes : uniqueOptions(activeCapabilities.imageSizes, asset.generation?.imageSize);
  const changeSidebarVariantByClickSide = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!hasMultipleVariants) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const direction = event.clientX < rect.left + rect.width / 2 ? -1 : 1;
    onVariant(node.id, direction);
  };
  useEffect(() => {
    setVariantParams({
      model: asset.generation?.model ?? defaultDraftParams.model,
      aspectRatio: asset.generation?.aspectRatio ?? defaultDraftParams.aspectRatio,
      imageSize: asset.generation?.imageSize ?? defaultDraftParams.imageSize,
      seed: null,
      batchCount: 1,
    });
    setVariantVisualStyleId(asset.generation?.visualStyleId ?? adaptation?.defaultVisualStyleId ?? null);
  }, [adaptation?.defaultVisualStyleId, asset]);
  const isArchived = Boolean(asset.archivedAt);
  return (
    <aside className="details-sidebar">
      <div className="sidebar-action-row">
        {isArchived ? (
          <button className="secondary" onClick={() => onRestoreImage(node.id, asset.id)}>Unarchive</button>
        ) : (
          <button className="secondary" onClick={() => onArchiveImage(node.id, asset.id)}>Archive</button>
        )}
      </div>
      {isArchived && <p className="muted">This variant is archived. Use Tags → Show archived to browse archived items, then unarchive here.</p>}
      {(isCharacterArchetype || isSceneArchetype || styleRefKind) && (
        <div className="canvas-role-badge">
          {isCharacterArchetype ? 'Chosen character archetype' : isSceneArchetype ? 'Chosen scene archetype' : 'Style reference candidate'}
        </div>
      )}
      {isGeneratedResult && <div className="canvas-role-badge">Generated child image</div>}
      {isGeneratedResult && <p className="muted">This image was generated from a durable source node. Archiving it does not remove the source prompt.</p>}
      <label className="field-label">
        Group name
        <input value={node.data.displayName} onChange={(event) => onNodeChange(node.id, { displayName: event.target.value })} />
      </label>
      <TagControlButton
        tagIds={asset.tags}
        projectTags={projectTags}
        onPartitionedTagsChange={(userTags, characterTags, locationTags) => (
          onPartitionedAssetTagsChange(node.id, asset.id, userTags, characterTags, locationTags)
        )}
        onCreateTag={onCreateTag}
        className="sidebar-tag-controls"
        popoverClassName="split-tag-popover-sidebar"
        portaled
        portaledAlign="right"
      />
      {asset.hasPixels && (
        <div className="sidebar-cover-row">
          <button type="button" className="secondary" onClick={() => onFindOnCanvas(node.id)}>
            Find on canvas
          </button>
          <button type="button" className="secondary" disabled={isProjectCover} onClick={() => onSetProjectCover(asset.id)}>
            {isProjectCover ? 'Project cover' : 'Set as project cover'}
          </button>
        </div>
      )}
      <div className="sidebar-variant-preview" onClick={changeSidebarVariantByClickSide}>
        {asset.thumbnailUrl && <img src={asset.thumbnailUrl} alt="" />}
        <span>{activeVariantIndex + 1} / {visibleVariantsList.length}</span>
        <button
          className="sidebar-preview-eye"
          onClick={(event) => {
            event.stopPropagation();
            node.data.onView(node.id);
          }}
          title="View full image"
        >
          👁️
        </button>
        {hasMultipleVariants && (
          <>
            <button
              className="sidebar-variant-nav previous"
              onClick={(event) => {
                event.stopPropagation();
                onVariant(node.id, -1);
              }}
              title="Previous variant"
            >
              &lt;
            </button>
            <button
              className="sidebar-variant-nav next"
              onClick={(event) => {
                event.stopPropagation();
                onVariant(node.id, 1);
              }}
              title="Next variant"
            >
              &gt;
            </button>
          </>
        )}
      </div>
      {canSetCanonicalReference && <section className="sidebar-section canonical-reference-section">
        <h3>Canonical Reference</h3>
        <button className="secondary" onClick={() => onSetStyleRefAsset('archetype-character', asset.id)} disabled={isCharacterArchetype}>
          {isCharacterArchetype ? 'Current character archetype' : 'Set as character archetype'}
        </button>
        <button className="secondary" onClick={() => onSetStyleRefAsset('archetype-scene', asset.id)} disabled={isSceneArchetype}>
          {isSceneArchetype ? 'Current scene archetype' : 'Set as scene archetype'}
        </button>
      </section>}
      {asset.generation && (
        <section className="sidebar-section parent-section">
          <h3>Parents</h3>
          <div className="parent-list">
            {refs.length === 0 ? (
              <div className="parent-item">
                <div className="parent-thumb-placeholder" />
                <span className="muted">None</span>
              </div>
            ) : refs.map((ref) => {
              const parent = assetById.get(ref);
              const openParent = () => onOpenAsset(ref);
              return (
                <div className="parent-item" key={ref}>
                  {parent?.thumbnailUrl ? (
                    <button
                      type="button"
                      className="parent-thumb-button"
                      onClick={openParent}
                      title={`Open ${assetLabel(parent, 'Parent image')}`}
                    >
                      <img src={parent.thumbnailUrl} alt="" />
                    </button>
                  ) : (
                    <div className="parent-thumb-placeholder" />
                  )}
                  <span>{assetLabel(parent, 'Parent image')}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {asset.generation && !styleRefKind && (
        <VisualStyleSelect
          styles={adaptation?.visualStyles ?? []}
          value={isVariantPanelOpen ? variantVisualStyleId : asset.generation.visualStyleId}
          defaultStyleId={adaptation?.defaultVisualStyleId}
          disabled={!isVariantPanelOpen}
          onChange={setVariantVisualStyleId}
        />
      )}
      {prompt && (
        <section className={`sidebar-section ${styleRefKind ? 'style-ref-sidebar-section' : ''}`}>
          <label className="field-label">
            Prompt
            <textarea className="prompt-textarea locked-field prompt-preview" value={prompt} readOnly />
          </label>
          {styleRefKind && <p className="muted">Chat refinements create exploratory assets. Assign entity tags from the tag editor to link images to characters or locations.</p>}
          <button className="generate-button" onClick={() => onRefineChat(node.id, asset.id)}>{styleRefKind ? 'Explore refinement in chat' : 'Refine in chat'}</button>
          {!styleRefKind && <button className="secondary" onClick={() => onCreateSibling(node.data, asset)}>Create sibling</button>}
        </section>
      )}
      {asset.generation && (
        <section className="sidebar-section generation-section">
          <h3>Parameters</h3>
          <GenerationErrorNotice message={generationError} />
          <label className="field-label">
            Model
            <select
              value={isVariantPanelOpen ? variantParams.model ?? asset.generation.model : asset.generation.model}
              disabled={!isVariantPanelOpen}
              onChange={(event) => setVariantParams((current) => normalizedParamsForModel(current, event.target.value))}
            >
              {modelOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <div className="row">
            <label className="field-label">
              Aspect Ratio
              <select
                value={isVariantPanelOpen ? variantParams.aspectRatio ?? asset.generation.aspectRatio : asset.generation.aspectRatio}
                disabled={!isVariantPanelOpen}
                onChange={(event) => setVariantParams((current) => ({ ...current, aspectRatio: event.target.value }))}
              >
                {aspectRatioOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <label className="field-label">
              Image Size
              <select
                value={isVariantPanelOpen ? variantParams.imageSize ?? asset.generation.imageSize : asset.generation.imageSize}
                disabled={!isVariantPanelOpen}
                onChange={(event) => setVariantParams((current) => ({ ...current, imageSize: event.target.value }))}
              >
                {imageSizeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field-label">
              Seed
              <input
                value={isVariantPanelOpen ? variantParams.seed ?? '' : asset.generation.seed ?? 'auto'}
                readOnly={!isVariantPanelOpen}
                onChange={(event) =>
                  setVariantParams((current) => ({ ...current, seed: event.target.value ? Number(event.target.value) : null }))
                }
                placeholder="Seed optional"
              />
            </label>
          </div>
          {styleRefKind ? (
            <p className="muted">Generate style reference replacements from the adaptation style reference action so canonical metadata stays in sync.</p>
          ) : isVariantPanelOpen ? (
            <div className="generate-control">
              <button className="generate-button" onClick={() => onGenerateVariants(node.id, node.data, variantParams, variantVisualStyleId)} disabled={!prompt.trim() || node.data.isGenerating}>
                {node.data.isGenerating && <span className="spinner" aria-hidden="true" />}
                {node.data.isGenerating ? 'Generating...' : 'Generate variants'}
              </button>
              <button className="secondary" onClick={() => setIsVariantPanelOpen(false)}>Cancel</button>
              <label>
                Batch size
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={variantParams.batchCount}
                  onChange={(event) => setVariantParams((current) => ({ ...current, batchCount: Number(event.target.value) }))}
                />
              </label>
            </div>
          ) : (
            <button className="secondary" onClick={() => setIsVariantPanelOpen(true)} disabled={node.data.isGenerating}>Create variants</button>
          )}
        </section>
      )}
    </aside>
  );
}
