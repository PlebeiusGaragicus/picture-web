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
  chatSessionId?: string | null;
  chatTurnId?: string | null;
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
  contentHash?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  prompt?: Prompt | null;
  generation?: GenerationReceipt | null;
  provider?: ProviderCapture | null;
  hasPixels: boolean;
  thumbnailUrl?: string | null;
  isProtected?: boolean;
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

export type ArtifactKind = 'character-sheet' | 'location-prompt';

export interface StoryArtifactCanvasNode extends CanvasNodeLayout {
  type: 'storyArtifact';
  artifactKind: ArtifactKind;
  artifactKey: string;
  promptPath: string;
  prompt: string;
  refs: string[];
  params: GenerationParams;
  generatedAssetId?: string | null;
}

export interface ImageGroupCanvasNode extends CanvasNodeLayout {
  type: 'imageGroup';
  assetIds: string[];
  activeAssetId?: string | null;
}

export type CanvasNode = DraftCanvasNode | StoryArtifactCanvasNode | ImageGroupCanvasNode;

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

export interface AdaptationAssetLink {
  artifactKind: ArtifactKind;
  promptPath: string;
  mode: string;
  styleRef: string;
  prompt: string;
  assetId?: string | null;
  status: 'missing' | 'ready' | 'generated';
}

export interface AdaptationStatus {
  projectSlug: string;
  hasBook: boolean;
  hasBookSession: boolean;
  styleRefs: Record<string, boolean>;
  counts: Record<string, number>;
  visualStyle: string;
  characters: Record<string, AdaptationAssetLink>;
  locations: Record<string, AdaptationAssetLink>;
}

export interface AdaptationGenerateResponse {
  generated: boolean;
  kind: 'character' | 'artifact';
  key?: string | null;
  asset?: Asset | null;
  status?: AdaptationStatus | null;
  message: string;
}

export interface ChatTurnSettings {
  model: string;
  aspectRatio: string;
  imageSize: string;
  thinkingLevel?: string | null;
  includeThoughts: boolean;
}

export interface ChatAttachment {
  kind: 'asset';
  assetId: string;
  purpose: 'source' | 'reference';
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'model';
  createdAt: string;
  text: string;
  settings: ChatTurnSettings;
  attachments: ChatAttachment[];
  generatedAssetIds: string[];
}

export interface ChatSession {
  version: 1;
  id: string;
  projectSlug: string;
  status: 'active' | 'archived';
  title: string;
  source: { assetId: string; canvasNodeId?: string | null };
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  defaults: ChatTurnSettings;
  protectedAssetIds: string[];
  turns: ChatTurn[];
}

export interface CreateChatSessionPayload {
  sourceAssetId: string;
  canvasNodeId?: string | null;
  title?: string | null;
}

export interface ChatTurnPayload {
  text: string;
  attachmentAssetIds: string[];
  settings?: ChatTurnSettings | null;
}

export interface ChatTurnResponse {
  session: ChatSession;
  assets: Asset[];
}
