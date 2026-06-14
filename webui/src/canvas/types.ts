import type { Asset, DraftCanvasNode, ImageGroupCanvasNode, StoryArtifactCanvasNode } from '../types';

export interface DraftNodeData extends DraftCanvasNode {
  kind: 'draft';
  nodeId: string;
  parentDisplayNames?: Map<string, string>;
  isGenerating?: boolean;
  onDetails: (nodeId: string) => void;
}

export interface ImageGroupNodeData extends ImageGroupCanvasNode {
  kind: 'imageGroup';
  nodeId: string;
  assets: Asset[];
  activeAsset: Asset | null;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
  onView: (nodeId: string) => void;
  onDetails: (nodeId: string) => void;
  onDisplayNameChange: (nodeId: string, displayName: string) => void;
  isGenerating?: boolean;
}

export interface StoryArtifactNodeData extends StoryArtifactCanvasNode {
  kind: 'storyArtifact';
  nodeId: string;
  generatedAsset: Asset | null;
  onRefineChat: (nodeId: string, assetId: string) => void;
  isGenerating?: boolean;
  onDetails: (nodeId: string) => void;
  onViewAsset: (assetId: string) => void;
}

export type PhotoNodeData = DraftNodeData | StoryArtifactNodeData | ImageGroupNodeData;
