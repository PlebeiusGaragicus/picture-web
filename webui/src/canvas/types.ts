import type { Asset, DraftCanvasNode, ImageGroupCanvasNode, TagDefinition } from '../types';

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
  onCreateTag: (tag: TagDefinition) => void;
  projectTags: TagDefinition[];
  isGenerating?: boolean;
  archivedOnlyView?: boolean;
}

export type PhotoNodeData = DraftNodeData | ImageGroupNodeData;
