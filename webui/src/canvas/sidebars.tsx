import { useEffect, useMemo, useRef, useState } from 'react';
import type { Node } from 'reactflow';
import { isCanonicalStyleRefAsset, styleRefKindForTags } from '../styleRefs';
import type { AdaptationStatus, ArtifactKind, Asset, DraftCanvasNode, GenerationParams, ImageGroupCanvasNode, StyleRefKind, TagDefinition, VisualStyleDefinition } from '../types';
import { VisualStyleSelect } from '../adaptation/visualStyleSelect';
import { TagControlButton } from './assetTagRow';
import { canDeleteNode } from './roles';
import { artifactKindLabel, assetLabel, capabilitiesForModel, defaultDraftParams, modelCapabilities, nonArchivedVariants, normalizedParamsForModel, uniqueOptions, visibleDisplayName } from './shared';
import type { DraftNodeData, ImageGroupNodeData, PhotoNodeData, StoryArtifactNodeData } from './types';

export function NodeSidebar({
  node,
  assets,
  adaptation,
  projectTags,
  coverAssetId,
  onDraftChange,
  onImageGroupChange,
  onGenerate,
  onGenerateArtifact,
  onGenerateVariants,
  onCreateChildText,
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
}: {
  node: Node<PhotoNodeData>;
  assets: Asset[];
  adaptation: AdaptationStatus | null;
  projectTags: TagDefinition[];
  coverAssetId?: string | null;
  onDraftChange: (id: string, patch: Partial<DraftCanvasNode>) => void;
  onImageGroupChange: (id: string, patch: Partial<ImageGroupCanvasNode>) => void;
  onGenerate: (id: string, draft: DraftNodeData) => void;
  onGenerateArtifact: (id: string, artifact: StoryArtifactNodeData) => void;
  onGenerateVariants: (id: string, group: ImageGroupNodeData, params: GenerationParams, visualStyleId?: string | null) => void;
  onCreateChildText: (node: Node<DraftNodeData> | Node<StoryArtifactNodeData>) => void;
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
}) {
  if (node.data.kind === 'draft') {
    const draftNode: Node<DraftNodeData> = { ...node, data: node.data };
    return (
      <DraftSidebar
        node={draftNode}
        assets={assets}
        visualStyles={adaptation?.visualStyles ?? []}
        onDraftChange={onDraftChange}
        onGenerate={onGenerate}
        onCreateChildText={onCreateChildText}
        onDelete={onDelete}
      />
    );
  }

  if (node.data.kind === 'storyArtifact') {
    const artifactNode: Node<StoryArtifactNodeData> = { ...node, data: node.data };
    return (
      <StoryArtifactSidebar
        node={artifactNode}
        onGenerate={onGenerateArtifact}
        onCreateChildText={onCreateChildText}
        onDelete={onDelete}
      />
    );
  }

  const imageNode: Node<ImageGroupNodeData> = { ...node, data: node.data };
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
      onSetStyleRefAsset={onSetStyleRefAsset}
      onSetProjectCover={onSetProjectCover}
      onFindOnCanvas={onFindOnCanvas}
      onRefineChat={onRefineChat}
    />
  );
}

function DraftSidebar({
  node,
  assets,
  visualStyles,
  onDraftChange,
  onGenerate,
  onCreateChildText,
  onDelete,
}: {
  node: Node<DraftNodeData>;
  assets: Asset[];
  visualStyles: VisualStyleDefinition[];
  onDraftChange: (id: string, patch: Partial<DraftCanvasNode>) => void;
  onGenerate: (id: string, draft: DraftNodeData) => void;
  onCreateChildText: (node: Node<DraftNodeData>) => void;
  onDelete: (id: string, assetId?: string) => void;
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
  const [isEditingName, setIsEditingName] = useState(false);
  const [draftName, setDraftName] = useState(visibleDisplayName(draft.displayName));
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
      {isDurableSource && <p className="muted">This {sourceLabel ?? 'source'} prompt is backed by an adaptation file. Sync will recreate it if it is missing from the canvas.</p>}
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
      <section className={`sidebar-section ${isFileBackedPrompt ? 'style-ref-sidebar-section' : ''}`}>
        <label className="field-label">
          {isFileBackedPrompt ? 'File-backed prompt' : 'Prompt'}
          <textarea
            ref={promptRef}
            className={`prompt-textarea ${isFileBackedPrompt ? 'locked-field' : ''}`}
            autoFocus={!isFileBackedPrompt}
            value={draft.prompt}
            onChange={(event) => !isFileBackedPrompt && onDraftChange(node.id, { prompt: event.target.value })}
            placeholder="Prompt"
            readOnly={isFileBackedPrompt}
          />
        </label>
        {isFileBackedPrompt && <p className="muted">Edit this prompt from the adaptation style controls or source file. The canvas node is synced from disk.</p>}
      </section>
      {!isFileBackedPrompt && <section className="sidebar-section generation-section">
        <h3>Parameters</h3>
      <VisualStyleSelect
        styles={visualStyles}
        value={draft.visualStyleId}
        onChange={(styleId) => onDraftChange(node.id, { visualStyleId: styleId })}
      />
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
        <select value={draft.params.aspectRatio ?? '16:9'} onChange={(event) => onDraftChange(node.id, { params: { ...draft.params, aspectRatio: event.target.value } })}>
          {draftCapabilities.aspectRatios.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <select value={draft.params.imageSize ?? '1K'} onChange={(event) => onDraftChange(node.id, { params: { ...draft.params, imageSize: event.target.value } })}>
          {draftCapabilities.imageSizes.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>
      <div className="generate-control">
        <button className="generate-button" onClick={() => onGenerate(node.id, draft)} disabled={!draft.prompt.trim() || draft.isGenerating}>
          {draft.isGenerating && <span className="spinner" aria-hidden="true" />}
          {draft.isGenerating ? 'Generating...' : 'Generate'}
        </button>
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
      </div>
      </section>}
      {styleRefKind && (
        <section className="sidebar-section generation-section style-ref-sidebar-section">
          <button className="generate-button" onClick={() => onGenerate(node.id, draft)} disabled={!draft.prompt.trim() || draft.isGenerating}>
            {draft.isGenerating && <span className="spinner" aria-hidden="true" />}
            {draft.isGenerating ? 'Generating...' : 'Generate canonical reference'}
          </button>
        </section>
      )}
    </aside>
  );
}

function canGenerateArtifact(kind: ArtifactKind) {
  return kind !== 'scene-artifact';
}

function StoryArtifactSidebar({
  node,
  onGenerate,
  onCreateChildText,
  onDelete,
}: {
  node: Node<StoryArtifactNodeData>;
  onGenerate: (id: string, artifact: StoryArtifactNodeData) => void;
  onCreateChildText: (node: Node<StoryArtifactNodeData>) => void;
  onDelete: (id: string, assetId?: string) => void;
}) {
  const artifact = node.data;
  const canDelete = canDeleteNode(node);
  const isDurableSource = artifact.role?.type === 'artifact-source';
  return (
    <aside className="details-sidebar story-artifact-sidebar">
      <div className="popover-header">
        <div>
          <h2>{artifact.displayName || artifact.artifactKey}</h2>
          <p className="muted">{artifactKindLabel(artifact.artifactKind)}</p>
        </div>
        {canDelete ? <button className="danger" onClick={() => onDelete(node.id)}>Delete</button> : null}
      </div>
      {isDurableSource && <div className="canvas-role-badge">Durable story source</div>}
      {isDurableSource && <p className="muted">This source artifact is backed by book-derived files and metadata. Generated images appear as child nodes on the canvas.</p>}
      {isDurableSource && <button className="secondary" onClick={() => onCreateChildText(node)}>Create child text artifact</button>}
      <section className="sidebar-section">
        <h3>Source</h3>
        <code className="path-code">{artifact.promptPath}</code>
      </section>
      <section className="sidebar-section">
        <h3>Prompt</h3>
        <textarea className="prompt-textarea prompt-preview locked-field" value={artifact.prompt} readOnly />
      </section>
      <section className="sidebar-section generation-section">
        <h3>Parameters</h3>
        <div className="row">
          <input value={artifact.params.model ?? defaultDraftParams.model ?? ''} readOnly />
          <input value={artifact.params.aspectRatio ?? defaultDraftParams.aspectRatio ?? ''} readOnly />
          <input value={artifact.params.imageSize ?? defaultDraftParams.imageSize ?? ''} readOnly />
        </div>
        {canGenerateArtifact(artifact.artifactKind) ? (
          <button className="generate-button" onClick={() => onGenerate(node.id, artifact)} disabled={!artifact.prompt.trim() || artifact.isGenerating}>
            {artifact.isGenerating && <span className="spinner" aria-hidden="true" />}
            {artifact.isGenerating ? 'Generating...' : 'Generate child image'}
          </button>
        ) : (
          <p className="muted">Planning artifact only. Generate page or panel prompts from later layout artifacts.</p>
        )}
      </section>
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
  onSetStyleRefAsset,
  onSetProjectCover,
  onFindOnCanvas,
  onRefineChat,
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
  onSetStyleRefAsset: (kind: StyleRefKind, assetId: string) => void;
  onSetProjectCover: (assetId: string) => void;
  onFindOnCanvas: (nodeId: string) => void;
  onRefineChat: (nodeId: string, assetId: string) => void;
}) {
  const [isVariantPanelOpen, setIsVariantPanelOpen] = useState(false);
  const [variantParams, setVariantParams] = useState(defaultDraftParams);
  const [variantVisualStyleId, setVariantVisualStyleId] = useState<string | null>(null);
  const prompt = asset.prompt?.text ?? '';
  const refs = asset.generation?.refs ?? [];
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const visibleVariants = nonArchivedVariants(assets, node.data.assetIds);
  const activeVariantIndex = Math.max(0, visibleVariants.findIndex((variant) => variant.id === asset.id));
  const hasMultipleVariants = visibleVariants.length > 1;
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
    setVariantVisualStyleId(asset.generation?.visualStyleId ?? null);
  }, [asset]);
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
      {isArchived && <p className="muted">This variant is archived and hidden unless Show archived is enabled.</p>}
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
        <span>{activeVariantIndex + 1} / {visibleVariants.length}</span>
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
          <VisualStyleSelect
            styles={adaptation?.visualStyles ?? []}
            value={isVariantPanelOpen ? variantVisualStyleId : asset.generation.visualStyleId}
            disabled={!isVariantPanelOpen}
            onChange={setVariantVisualStyleId}
          />
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
