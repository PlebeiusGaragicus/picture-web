import { useEffect, useMemo, useRef, useState } from 'react';
import type { Node } from 'reactflow';
import { isCanonicalStyleRefAsset, styleRefKindForTags } from '../styleRefs';
import type { AdaptationStatus, ArtifactKind, Asset, DraftCanvasNode, GenerationParams, ImageGroupCanvasNode, StyleRefKind } from '../types';
import { canDeleteNode } from './roles';
import { artifactKindLabel, assetLabel, capabilitiesForModel, defaultDraftParams, modelCapabilities, normalizedParamsForModel, uniqueOptions, visibleDisplayName } from './shared';
import type { DraftNodeData, ImageGroupNodeData, PhotoNodeData, StoryArtifactNodeData } from './types';

export function NodeSidebar({
  node,
  assets,
  adaptation,
  projectSlug,
  onDraftChange,
  onImageGroupChange,
  onGenerate,
  onGenerateArtifact,
  onGenerateVariants,
  onSetStyleRefAsset,
  onVariant,
  onCreateSibling,
  onCreateChildDraft,
  onDelete,
  onRefineChat,
}: {
  node: Node<PhotoNodeData>;
  assets: Asset[];
  adaptation: AdaptationStatus | null;
  projectSlug: string;
  onDraftChange: (id: string, patch: Partial<DraftCanvasNode>) => void;
  onImageGroupChange: (id: string, patch: Partial<ImageGroupCanvasNode>) => void;
  onGenerate: (id: string, draft: DraftNodeData) => void;
  onGenerateArtifact: (id: string, artifact: StoryArtifactNodeData) => void;
  onGenerateVariants: (id: string, group: ImageGroupNodeData, params: GenerationParams) => void;
  onSetStyleRefAsset: (kind: StyleRefKind, assetId: string) => void;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
  onCreateSibling: (group: ImageGroupNodeData, sourceAsset: Asset) => void;
  onCreateChildDraft: (nodeId: string, sourceAssetId: string) => void;
  onDelete: (id: string, assetId?: string) => void;
  onRefineChat: (nodeId: string, assetId: string) => void;
}) {
  if (node.data.kind === 'draft') {
    const draftNode: Node<DraftNodeData> = { ...node, data: node.data };
    return (
      <DraftSidebar
        node={draftNode}
        assets={assets}
        onDraftChange={onDraftChange}
        onGenerate={onGenerate}
        onDelete={onDelete}
      />
    );
  }

  if (node.data.kind === 'storyArtifact') {
    const artifactNode: Node<StoryArtifactNodeData> = { ...node, data: node.data };
    return (
      <StoryArtifactSidebar
        node={artifactNode}
        projectSlug={projectSlug}
        onGenerate={onGenerateArtifact}
        onDelete={onDelete}
        onCreateChildDraft={onCreateChildDraft}
        onRefineChat={onRefineChat}
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
      onDelete={onDelete}
      onNodeChange={onImageGroupChange}
      onVariant={onVariant}
      onCreateSibling={onCreateSibling}
      onGenerateVariants={onGenerateVariants}
      onSetStyleRefAsset={onSetStyleRefAsset}
      onRefineChat={onRefineChat}
    />
  );
}

function DraftSidebar({
  node,
  assets,
  onDraftChange,
  onGenerate,
  onDelete,
}: {
  node: Node<DraftNodeData>;
  assets: Asset[];
  onDraftChange: (id: string, patch: Partial<DraftCanvasNode>) => void;
  onGenerate: (id: string, draft: DraftNodeData) => void;
  onDelete: (id: string, assetId?: string) => void;
}) {
  const draft = node.data;
  const canDelete = canDeleteNode(node);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [isParentPickerOpen, setIsParentPickerOpen] = useState(false);
  const parents = draft.refs.map((ref) => assets.find((asset) => asset.id === ref) ?? null);
  const availableParents = assets.filter((asset) => !draft.refs.includes(asset.id));
  const draftModel = draft.params.model ?? defaultDraftParams.model;
  const draftCapabilities = capabilitiesForModel(draftModel);
  const styleRefKind = styleRefKindForTags(draft.tags);
  const styleRefLabel = styleRefKind === 'archetype-character' ? 'character' : styleRefKind === 'archetype-scene' ? 'scene' : null;
  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft.prompt]);
  return (
    <aside className="details-sidebar">
      <div className="popover-header">
        <h2>{visibleDisplayName(draft.displayName) || 'Draft'}</h2>
        {canDelete ? <button className="danger" onClick={() => onDelete(node.id)}>Delete</button> : null}
      </div>
      {styleRefLabel && (
        <div className="canvas-role-badge">
          Draft {styleRefLabel} archetype reference
        </div>
      )}
      <label className="field-label">
        Name
        <input value={draft.displayName} onChange={(event) => onDraftChange(node.id, { displayName: event.target.value })} />
      </label>
      {!styleRefKind && (
        <section className="sidebar-section parent-section">
          <h3>Parents</h3>
          {parents.length === 0 && <p className="muted">None</p>}
          {parents.length > 0 && (
            <div className="parent-list">
              {parents.map((parent, index) => (
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
          )}
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
      <section className={`sidebar-section ${styleRefKind ? 'style-ref-sidebar-section' : ''}`}>
        <label className="field-label">
          {styleRefKind ? 'File-backed prompt' : 'Prompt'}
          <textarea
            ref={promptRef}
            className={`prompt-textarea ${styleRefKind ? 'locked-field' : ''}`}
            autoFocus={!styleRefKind}
            value={draft.prompt}
            onChange={(event) => !styleRefKind && onDraftChange(node.id, { prompt: event.target.value })}
            placeholder="Prompt"
            readOnly={Boolean(styleRefKind)}
          />
        </label>
        {styleRefKind && <p className="muted">Edit this prompt from the style reference card. The canvas node is synced from the file.</p>}
      </section>
      {!styleRefKind && <section className="sidebar-section generation-section">
        <h3>Parameters</h3>
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
  projectSlug,
  onGenerate,
  onDelete,
  onCreateChildDraft,
  onRefineChat,
}: {
  node: Node<StoryArtifactNodeData>;
  projectSlug: string;
  onGenerate: (id: string, artifact: StoryArtifactNodeData) => void;
  onDelete: (id: string, assetId?: string) => void;
  onCreateChildDraft: (nodeId: string, sourceAssetId: string) => void;
  onRefineChat: (nodeId: string, assetId: string) => void;
}) {
  const artifact = node.data;
  const generated = artifact.generatedAsset;
  const canDelete = canDeleteNode(node);
  return (
    <aside className="details-sidebar story-artifact-sidebar">
      <div className="popover-header">
        <div>
          <h2>{artifact.displayName || artifact.artifactKey}</h2>
          <p className="muted">{artifactKindLabel(artifact.artifactKind)}</p>
        </div>
        {canDelete ? <button className="danger" onClick={() => onDelete(node.id)}>Delete</button> : null}
      </div>
      <section className="sidebar-section">
        <h3>Source</h3>
        <code className="path-code">{artifact.promptPath}</code>
      </section>
      {generated && (
        <section className="sidebar-section">
          <h3>Generated Image</h3>
          <button className="story-artifact-sidebar-preview" onClick={() => artifact.onViewAsset(generated.id)}>
            <img src={generated.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${generated.id}/thumb`} alt="" />
            <span className="sidebar-preview-eye story-preview-eye" aria-hidden="true">👁️</span>
            <span>{assetLabel(generated)}</span>
          </button>
          <button className="generate-button" onClick={() => onRefineChat(node.id, generated.id)}>Refine in chat</button>
          <button className="secondary" onClick={() => onCreateChildDraft(node.id, generated.id)}>Create child draft</button>
        </section>
      )}
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
            {artifact.isGenerating ? 'Generating...' : generated ? 'Regenerate artifact' : 'Generate artifact'}
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
  onDelete,
  onNodeChange,
  onVariant,
  onCreateSibling,
  onGenerateVariants,
  onSetStyleRefAsset,
  onRefineChat,
}: {
  node: Node<ImageGroupNodeData>;
  asset: Asset;
  assets: Asset[];
  adaptation: AdaptationStatus | null;
  onDelete: (id: string, assetId?: string) => void;
  onNodeChange: (id: string, patch: Partial<ImageGroupCanvasNode>) => void;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
  onCreateSibling: (group: ImageGroupNodeData, sourceAsset: Asset) => void;
  onGenerateVariants: (id: string, group: ImageGroupNodeData, params: GenerationParams) => void;
  onSetStyleRefAsset: (kind: StyleRefKind, assetId: string) => void;
  onRefineChat: (nodeId: string, assetId: string) => void;
}) {
  const [isVariantPanelOpen, setIsVariantPanelOpen] = useState(false);
  const [variantParams, setVariantParams] = useState(defaultDraftParams);
  const prompt = asset.prompt?.text ?? '';
  const refs = asset.generation?.refs ?? [];
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const activeVariantIndex = Math.max(0, node.data.assetIds.indexOf(asset.id));
  const styleRefKind = styleRefKindForTags(node.data.tags);
  const isCharacterArchetype = adaptation?.styleRefStatuses?.['archetype-character']?.assetId === asset.id;
  const isSceneArchetype = adaptation?.styleRefStatuses?.['archetype-scene']?.assetId === asset.id;
  const canSetCanonicalReference = Boolean(styleRefKind) || isCanonicalStyleRefAsset(adaptation, asset.id);
  const activeModel = isVariantPanelOpen ? variantParams.model ?? asset.generation?.model : asset.generation?.model;
  const activeCapabilities = capabilitiesForModel(activeModel);
  const modelOptions = uniqueOptions(Object.keys(modelCapabilities), asset.generation?.model);
  const aspectRatioOptions = isVariantPanelOpen ? activeCapabilities.aspectRatios : uniqueOptions(activeCapabilities.aspectRatios, asset.generation?.aspectRatio);
  const imageSizeOptions = isVariantPanelOpen ? activeCapabilities.imageSizes : uniqueOptions(activeCapabilities.imageSizes, asset.generation?.imageSize);
  const changeSidebarVariantByClickSide = (event: React.MouseEvent<HTMLDivElement>) => {
    if (node.data.assetIds.length < 2) return;
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
  }, [asset]);
  return (
    <aside className="details-sidebar">
      <button className="danger" onClick={() => onDelete(node.id, asset.id)}>Delete</button>
      {(isCharacterArchetype || isSceneArchetype || styleRefKind) && (
        <div className="canvas-role-badge">
          {isCharacterArchetype ? 'Chosen character archetype' : isSceneArchetype ? 'Chosen scene archetype' : 'Style reference candidate'}
        </div>
      )}
      <label className="field-label">
        Group name
        <input value={node.data.displayName} onChange={(event) => onNodeChange(node.id, { displayName: event.target.value })} />
      </label>
      <div className="sidebar-variant-preview" onClick={changeSidebarVariantByClickSide}>
        {asset.thumbnailUrl && <img src={asset.thumbnailUrl} alt="" />}
        <span>{activeVariantIndex + 1} / {node.data.assetIds.length}</span>
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
        {node.data.assetIds.length > 1 && (
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
          {refs.length === 0 && <p className="muted">None</p>}
          {refs.length > 0 && (
            <div className="parent-list">
              {refs.map((ref) => (
                <div className="parent-item" key={ref}>
                  {assetById.get(ref)?.thumbnailUrl ? <img src={assetById.get(ref)?.thumbnailUrl ?? ''} alt="" /> : <div className="parent-thumb-placeholder" />}
                  <span>{assetLabel(assetById.get(ref), 'Parent image')}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {prompt && (
        <section className={`sidebar-section ${styleRefKind ? 'style-ref-sidebar-section' : ''}`}>
          <label className="field-label">
            Prompt
            <textarea className="prompt-textarea locked-field prompt-preview" value={prompt} readOnly />
          </label>
          {styleRefKind && <p className="muted">Chat refinements create exploratory assets. Use the canonical reference controls to update adaptation metadata.</p>}
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
          {styleRefKind ? (
            <p className="muted">Generate style reference replacements from the adaptation style reference action so canonical metadata stays in sync.</p>
          ) : isVariantPanelOpen ? (
            <div className="generate-control">
              <button className="generate-button" onClick={() => onGenerateVariants(node.id, node.data, variantParams)} disabled={!prompt.trim() || node.data.isGenerating}>
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
