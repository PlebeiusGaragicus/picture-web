export type AssetKind = 'imported' | 'generated';

export interface Prompt {
  text: string;
}

export interface GenerationReceipt {
  refs: string[];
  runId: string;
  runIndex: number;
  model: string;
  aspectRatio: string;
  imageSize: string;
  seed?: number | null;
}

export interface ProviderCapture {
  name: string;
  response: Record<string, unknown>;
}

export interface Asset {
  id: string;
  kind: AssetKind;
  title: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  prompt?: Prompt | null;
  generation?: GenerationReceipt | null;
  provider?: ProviderCapture | null;
  hasPixels: boolean;
  thumbnailUrl?: string | null;
}

export interface Project {
  slug: string;
  name: string;
  createdAt: string;
  settings: Record<string, unknown>;
}

export interface ProjectDetail {
  project: Project;
  assets: Asset[];
}

export interface CanvasDocument {
  version: 2;
  viewport: { x: number; y: number; zoom: number };
  nodes: Record<string, CanvasNode>;
}

export interface GenerationParams {
  model?: string | null;
  aspectRatio?: string | null;
  imageSize?: string | null;
  seed?: number | null;
  batchCount: number;
}

export interface CanvasNodeLayout {
  displayName: string;
  x: number;
  y: number;
  width?: number | null;
}

export interface DraftCanvasNode extends CanvasNodeLayout {
  type: 'draft';
  refs: string[];
  prompt: string;
  params: GenerationParams;
}

export interface ImageGroupCanvasNode extends CanvasNodeLayout {
  type: 'imageGroup';
  assetIds: string[];
  activeAssetId?: string | null;
}

export type CanvasNode = DraftCanvasNode | ImageGroupCanvasNode;

export interface GeneratePayload {
  prompt: string;
  refs: string[];
  model?: string | null;
  aspectRatio?: string | null;
  imageSize?: string | null;
  seed?: number | null;
  batchCount: number;
  title?: string | null;
  tags: string[];
  canvasNodeId?: string | null;
}
