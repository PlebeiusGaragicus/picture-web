import type { Edge, Node } from 'reactflow';
import type { DraftNodeData, ImageGroupNodeData, PhotoNodeData, StoryArtifactNodeData } from './types';
import { canDeleteNode } from './roles';

export function generatedResultNodeId(sourceNodeId: string): string {
  return `generated_${sourceNodeId}`;
}

export function deriveStoryGraphEdges(filteredNodes: Node<PhotoNodeData>[]): Edge[] {
  const visibleNodeIds = new Set(filteredNodes.map((node) => node.id));
  const nodeForAsset = new Map<string, Node<ImageGroupNodeData> | Node<StoryArtifactNodeData>>();
  filteredNodes.forEach((node) => {
    if (node.data.kind === 'imageGroup') {
      const imageNode: Node<ImageGroupNodeData> = { ...node, data: node.data };
      node.data.assetIds.forEach((assetId) => nodeForAsset.set(assetId, imageNode));
    }
    if (node.data.kind === 'storyArtifact' && node.data.generatedAssetId) {
      const artifactNode: Node<StoryArtifactNodeData> = { ...node, data: node.data };
      nodeForAsset.set(node.data.generatedAssetId, artifactNode);
    }
  });
  const edgeForAssetRef = (childNode: Node<ImageGroupNodeData> | Node<DraftNodeData> | Node<StoryArtifactNodeData>, childAssetId: string | null, ref: string): Edge | null => {
    const sourceNode = nodeForAsset.get(ref);
    if (!sourceNode || sourceNode.id === childNode.id) return null;
    const sourceVisible = sourceNode.data.kind === 'imageGroup'
      ? sourceNode.data.activeAsset?.id === ref
      : sourceNode.data.generatedAssetId === ref;
    const childVisible = childNode.data.kind === 'draft' || childNode.data.kind === 'storyArtifact' || childNode.data.activeAsset?.id === childAssetId;
    const isVisibleLineage = sourceVisible && childVisible;
    return {
      id: `${sourceNode.id}-${childNode.id}-${childAssetId ?? 'draft'}-${ref}`,
      source: sourceNode.id,
      target: childNode.id,
      animated: childNode.data.kind === 'draft',
      className: `${isVisibleLineage ? 'lineage-edge-visible' : 'lineage-edge-hidden'}${childAssetId && childNode.data.kind === 'imageGroup' && childNode.data.assets.find((asset) => asset.id === childAssetId)?.generation?.chatSessionId ? ' lineage-edge-chat-refinement' : ''}`,
      style: isVisibleLineage ? undefined : { strokeDasharray: '5 5', opacity: 0.35 },
    };
  };
  const assetEdges = filteredNodes.flatMap((node) => {
    if (node.data.kind !== 'imageGroup') return [];
    const imageNode: Node<ImageGroupNodeData> = { ...node, data: node.data };
    return node.data.assets.flatMap((asset) => (asset.generation?.refs ?? []).flatMap((ref) => edgeForAssetRef(imageNode, asset.id, ref) ?? []));
  });
  const draftEdges = filteredNodes.flatMap((node) => {
    if (node.data.kind !== 'draft') return [];
    const draftNode: Node<DraftNodeData> = { ...node, data: node.data };
    return node.data.refs.flatMap((ref) => edgeForAssetRef(draftNode, null, ref) ?? []);
  });
  const artifactRefEdges = filteredNodes.flatMap((node) => {
    if (node.data.kind !== 'storyArtifact') return [];
    const artifactNode: Node<StoryArtifactNodeData> = { ...node, data: node.data };
    return node.data.refs.flatMap((ref) => edgeForAssetRef(artifactNode, null, ref) ?? []);
  });
  const generatedResultEdges = filteredNodes.flatMap((node) => {
    const sourceNodeId = node.data.role?.type === 'generated-result' ? node.data.role.sourceNodeId : null;
    if (!sourceNodeId || !visibleNodeIds.has(sourceNodeId)) return [];
    return [{
      id: `${sourceNodeId}-${node.id}-generated-result`,
      source: sourceNodeId,
      target: node.id,
      animated: node.data.kind === 'imageGroup' && node.data.isGenerating,
      className: 'lineage-edge-visible',
    }];
  });
  const textResultEdges = filteredNodes.flatMap((node) => {
    const sourceNodeId = node.data.role?.type === 'text-result' ? node.data.role.sourceNodeId : null;
    if (!sourceNodeId || !visibleNodeIds.has(sourceNodeId)) return [];
    return [{
      id: `${sourceNodeId}-${node.id}-text-result`,
      source: sourceNodeId,
      target: node.id,
      animated: false,
      className: 'lineage-edge-visible',
    }];
  });
  const visualStyleNode = filteredNodes.find((node) => node.data.role?.type === 'visual-style-source');
  const visualStyleEdges = visualStyleNode
    ? filteredNodes.flatMap((node) => {
        if (node.data.role?.type !== 'generated-result') return [];
        const sourceNodeId = node.data.role.sourceNodeId;
        const sourceNode = filteredNodes.find((candidate) => candidate.id === sourceNodeId);
        if (sourceNode?.data.role?.type !== 'style-ref-source') return [];
        return [{
          id: `${visualStyleNode.id}-${node.id}-visual-style`,
          source: visualStyleNode.id,
          target: node.id,
          animated: false,
          className: 'lineage-edge-visible',
        }];
      })
    : [];
  return [...assetEdges, ...draftEdges, ...artifactRefEdges, ...generatedResultEdges, ...textResultEdges, ...visualStyleEdges];
}

export function deletableSelectedNodes(nodes: Node<PhotoNodeData>[], selectedNodeIds: string[]): Node<PhotoNodeData>[] {
  const selected = new Set(selectedNodeIds);
  return nodes.filter((node) => selected.has(node.id) && canDeleteNode(node));
}

export function deleteSelectedNodesMessage(selectedCount: number, deletableCount: number, imageNodeCount: number): string {
  const skippedCount = selectedCount - deletableCount;
  const suffix = skippedCount ? ` ${skippedCount} source node(s) will be kept.` : '';
  const draftNodeCount = deletableCount - imageNodeCount;
  if (imageNodeCount && draftNodeCount) {
    return `Archive ${imageNodeCount} selected image node(s) and delete ${draftNodeCount} draft node(s)?${suffix}`;
  }
  if (imageNodeCount) {
    return `Archive ${imageNodeCount} selected image node(s)?${suffix}`;
  }
  return `Delete ${deletableCount} selected draft node(s)?${suffix}`;
}
