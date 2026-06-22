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
  visualStyleId?: string | null;
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
  coverAssetId?: string | null;
  coverThumbnailUrl?: string | null;
}

export type EntityKind = 'character' | 'location';

export interface TagDefinition {
  id: string;
  name: string;
  color: string;
  locked?: boolean;
  entityKind?: EntityKind | null;
}

export interface TagRegistryDocument {
  tags: TagDefinition[];
}

export interface ProjectDetail {
  project: Project;
  assets: Asset[];
  tags: TagDefinition[];
}

export type StoryKind = 'picture-book' | 'illustrated-story' | 'comic-book';
export type StyleRefKind = 'archetype-character' | 'archetype-scene';

export interface AdaptationSettings {
  storyKind: StoryKind;
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
  tags: string[];
  role?: CanvasRole | null;
}

export type CanvasRole =
  | { type: 'style-ref-source'; kind: StyleRefKind }
  | { type: 'artifact-source'; artifactKind: ArtifactKind; artifactKey: string }
  | { type: 'text-result'; sourceNodeId: string }
  | { type: 'generated-result'; sourceNodeId: string }
  | { type: 'refinement'; sourceNodeId: string; sourceAssetId?: string | null };

export interface DraftCanvasNode extends CanvasNodeLayout {
  type: 'draft';
  refs: string[];
  prompt: string;
  params: GenerationParams;
  visualStyleId?: string | null;
}

export type ArtifactKind = 'character-sheet' | 'location-prompt' | 'scene-artifact' | 'page-plan' | 'panel-prompt';
export type AdaptationFileKind = 'characters' | 'locations' | 'scenes';

export interface StoryArtifactCanvasNode extends CanvasNodeLayout {
  type: 'storyArtifact';
  artifactKind: ArtifactKind;
  artifactKey: string;
  promptPath: string;
  prompt: string;
  refs: string[];
  params: GenerationParams;
  visualStyleId?: string | null;
  generatedAssetIds: string[];
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
  visualStyleId?: string | null;
}

export interface GenerateStyleRefPayload {
  kind: StyleRefKind;
  canvasNodeId?: string | null;
  visualStyleId: string;
  model?: string | null;
  aspectRatio?: string | null;
  imageSize?: string | null;
  seed?: number | null;
  batchCount?: number;
}

export interface GenerateArtifactPayload {
  artifactKind: ArtifactKind;
  artifactKey: string;
  canvasNodeId?: string | null;
  visualStyleId?: string | null;
  model?: string | null;
  aspectRatio?: string | null;
  imageSize?: string | null;
  seed?: number | null;
  batchCount?: number;
}

export interface VisualStyleDefinition {
  id: string;
  name: string;
  prompt: string;
  default?: boolean;
}

export interface AdaptationAssetLink {
  artifactKind: ArtifactKind;
  promptPath: string;
  mode: string;
  styleRef: string;
  prompt: string;
  narration: string;
  dialogue: string;
  caption: string;
  assetIds: string[];
  activeAssetId?: string | null;
  finalized: boolean;
  status: 'missing' | 'ready' | 'generated';
}

export interface StyleRefStatus {
  kind: StyleRefKind;
  promptPath: string;
  promptText: string;
  assetId?: string | null;
  canvasDraftNodeId: string;
  canvasImageNodeId: string;
}

export interface AdaptationStatus {
  projectSlug: string;
  settings: AdaptationSettings;
  hasBook: boolean;
  hasBookSession: boolean;
  styleRefs: Record<string, boolean>;
  styleRefStatuses: Record<StyleRefKind, StyleRefStatus>;
  archetypeCharacterAssetId?: string | null;
  archetypeSceneAssetId?: string | null;
  archetypeCharacterPromptText?: string;
  archetypeScenePromptText?: string;
  counts: Record<string, number>;
  visualStyles: VisualStyleDefinition[];
  defaultVisualStyleId?: string | null;
  characters: Record<string, AdaptationAssetLink>;
  locations: Record<string, AdaptationAssetLink>;
  scenes: Record<string, AdaptationAssetLink>;
  pages: Record<string, AdaptationAssetLink>;
  panels: Record<string, AdaptationAssetLink>;
}

export type AdaptationStage = 'ingest' | 'characters' | 'scene-list' | 'scenes' | 'locations' | 'moments' | 'all';

export interface MomentRefInput {
  ref: string;
  kind: 'character' | 'location' | 'unknown';
  entityKey: string;
  tagId: string;
  ready: boolean;
  assetIds: string[];
  detail: string;
}

export interface MomentLayoutSection {
  key: string;
  refs: string;
  narration: string;
  dialogue: string;
  caption: string;
  prompt: string;
  refInputs?: MomentRefInput[];
  canGenerate?: boolean;
  referenceImageCount?: number;
  referenceImageLimit?: number;
  referenceLimitExceeded?: boolean;
}

export interface SceneMomentsDocument {
  sceneSlug: string;
  path: string;
  body: string;
  sections: MomentLayoutSection[];
  sectionCount: number;
  storyKind: StoryKind;
  exists: boolean;
}

export interface MomentSequenceEntry {
  momentKey: string;
  sceneSlug: string;
  artifactKind: ArtifactKind;
  promptPath: string;
  prompt: string;
  narration: string;
  dialogue: string;
  caption: string;
  refs: string;
  assetIds: string[];
  activeAssetId?: string | null;
  finalized: boolean;
  status: 'missing' | 'ready' | 'generated';
  refInputs?: MomentRefInput[];
  canGenerate?: boolean;
  referenceImageCount?: number;
  referenceImageLimit?: number;
  referenceLimitExceeded?: boolean;
}

export interface MomentSequenceDocument {
  moments: MomentSequenceEntry[];
  counts: {
    total: number;
    illustrated: number;
    finalized: number;
  };
}

export interface MomentPatch {
  narration?: string;
  dialogue?: string;
  caption?: string;
  activeAssetId?: string | null;
  finalized?: boolean;
}

export interface StoryPanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StoryPanelPage {
  id: string;
  order: number;
  title: string;
  pageKind: 'cover' | 'inside-cover' | 'story' | 'inside-back-cover' | 'back-cover';
}

export interface StoryPanelPageSettings {
  width: number;
  height: number;
}

export interface StoryPanelImageCrop {
  focalX: number;
  focalY: number;
  scale: number;
}

export interface StoryPanelTextStyle {
  fontFamily: 'serif' | 'sans' | 'mono' | 'comic';
  fontSize: number;
  align: 'left' | 'center' | 'right';
  speechKind?: 'dialogue' | 'narration';
  background?: 'transparent' | 'white';
  color?: string;
  outlineColor?: string;
}

export interface StoryPanel {
  id: string;
  order: number;
  sourceKind: 'story' | 'draft' | 'bookmark' | 'free-text' | 'free-image' | 'caption';
  startOffset: number | null;
  endOffset: number | null;
  selectedText: string;
  customText: string;
  richText: string;
  textStyle: StoryPanelTextStyle;
  pageId: string | null;
  panelKind: 'image' | 'text';
  rect: StoryPanelRect;
  layer: number;
  parentPanelId?: string | null;
  assetIds: string[];
  activeAssetId?: string | null;
  aspectRatio?: string | null;
  aspectRatioLocked?: boolean;
  imageCrop?: StoryPanelImageCrop | null;
  finalized: boolean;
}

export interface StoryPanelDocument {
  version: 1;
  bookSource: string;
  pageSettings: StoryPanelPageSettings;
  pages: StoryPanelPage[];
  panels: StoryPanel[];
}

export interface StoryPanelCreatePayload {
  startOffset: number;
  endOffset: number;
  selectedText?: string;
  customText?: string;
  insertAfterPanelId?: string | null;
  pageId?: string | null;
  rect?: StoryPanelRect | null;
  layer?: number;
}

export interface StoryPanelBookmarkCreatePayload {
  startOffset: number;
  endOffset: number;
  selectedText?: string;
  customText?: string;
  insertAfterPanelId?: string | null;
}

export interface StoryPanelDraftCreatePayload {
  customText: string;
  insertAfterPanelId?: string | null;
  pageId?: string | null;
  rect?: StoryPanelRect | null;
  layer?: number;
}

export type StoryPanelPatchPayload = Partial<
  Pick<StoryPanel, 'order' | 'sourceKind' | 'startOffset' | 'endOffset' | 'selectedText' | 'customText' | 'richText' | 'textStyle' | 'pageId' | 'panelKind' | 'rect' | 'layer' | 'parentPanelId' | 'assetIds' | 'activeAssetId' | 'aspectRatio' | 'aspectRatioLocked' | 'imageCrop' | 'finalized'>
>;

export interface SceneListLine {
  slug: string;
  description: string;
}

export interface SceneListDocument {
  lines: SceneListLine[];
}

export interface AdaptationWorkflowStatus {
  running: boolean;
  returnCode?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  log: string;
  logFiles?: Record<string, string>;
}

export interface AdaptationGenerateResponse {
  generated: boolean;
  kind: 'character' | 'artifact' | 'style-ref';
  key?: string | null;
  asset?: Asset | null;
  status?: AdaptationStatus | null;
  message: string;
}

export interface AdaptationCanvasImportResponse {
  canvas: CanvasDocument;
  importedNodeCount: number;
}

export interface AdaptationFileDocument {
  kind: AdaptationFileKind;
  key: string;
  promptPath: string;
  artifactKind: ArtifactKind;
  body: string;
  mode: string;
  styleRef: string;
  status: 'missing' | 'ready' | 'generated';
}

export interface AdaptationFilePayload {
  key: string;
  body: string;
  mode?: string;
  styleRef?: string;
}

export interface AdaptationFileUpdatePayload {
  key?: string;
  body?: string;
  mode?: string;
  styleRef?: string;
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
