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

export type StyleRefKind = 'archetype-character' | 'archetype-scene';

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

export type ArtifactKind = 'character-sheet' | 'location-prompt' | 'concept-art';
export type AdaptationFileKind = 'characters' | 'locations';
export type ConceptArtSubjectKind = 'character' | 'location';

export interface ImageGroupCanvasNode extends CanvasNodeLayout {
  type: 'imageGroup';
  refs: string[];
  prompt: string;
  params: GenerationParams;
  visualStyleId?: string | null;
  assetIds: string[];
  activeAssetId?: string | null;
  sourceConceptCardId?: string | null;
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

export interface CharacterRecord {
  slug: string;
  promptPath: string;
  description: string;
  userTags: string[];
  variants: Record<string, AdaptationAssetLink>;
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
  subjectKind?: ConceptArtSubjectKind | null;
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
  userTags: string[];
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
  characters: Record<string, CharacterRecord>;
  locations: Record<string, AdaptationAssetLink>;
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

export interface StoryPanelCaption {
  id: string;
  visibleText: string;
  richText: string;
  textStyle: StoryPanelTextStyle;
  rect: StoryPanelRect;
  layer: number;
}

export interface StoryPanelImagePrompt {
  id: string;
  text: string;
}

export interface StoryPanel {
  id: string;
  order: number;
  title: string;
  sourceKind: 'panel' | 'bookmark';
  startOffset: number | null;
  endOffset: number | null;
  selectedText: string;
  storyText: string;
  visibleText: string;
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
  captions: StoryPanelCaption[];
  imagePrompts: StoryPanelImagePrompt[];
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
  startOffset?: number | null;
  endOffset?: number | null;
  selectedText?: string;
  title?: string;
  storyText?: string;
  visibleText?: string;
  imagePrompts?: StoryPanelImagePrompt[];
  insertAfterPanelId?: string | null;
  autoPlace?: boolean;
  pageId?: string | null;
  panelKind?: 'image' | 'text';
  rect?: StoryPanelRect | null;
  layer?: number;
}

export interface StoryPanelBookmarkCreatePayload {
  startOffset: number;
  endOffset: number;
  selectedText?: string;
  title?: string;
  insertAfterPanelId?: string | null;
}

export type StoryPanelPatchPayload = Partial<
  Pick<StoryPanel, 'order' | 'title' | 'sourceKind' | 'startOffset' | 'endOffset' | 'selectedText' | 'storyText' | 'visibleText' | 'richText' | 'textStyle' | 'pageId' | 'panelKind' | 'rect' | 'layer' | 'parentPanelId' | 'assetIds' | 'activeAssetId' | 'aspectRatio' | 'aspectRatioLocked' | 'imageCrop' | 'captions' | 'imagePrompts' | 'finalized'>
>;

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
  nodeId?: string | null;
}

export interface ImageGroupNodeResponse {
  nodeId: string;
  canvas: CanvasDocument;
}

export interface ConceptNodeResponse {
  nodeId: string;
  canvas: CanvasDocument;
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
  subjectKind?: ConceptArtSubjectKind;
}

export interface CharacterVariantUpdatePayload {
  prompt?: string;
  mode?: string;
  styleRef?: string;
}

export interface AdaptationFileUpdatePayload {
  key?: string;
  body?: string;
  description?: string;
  variants?: Record<string, CharacterVariantUpdatePayload>;
  mode?: string;
  styleRef?: string;
  subjectKind?: ConceptArtSubjectKind;
  userTags?: string[];
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

export interface BookChatTurn {
  id: string;
  role: 'user' | 'assistant';
  createdAt: string;
  text: string;
  piSessionId?: string | null;
  events: Array<Record<string, unknown>>;
  error?: string | null;
}

export interface BookChatSession {
  version: 1;
  id: string;
  projectSlug: string;
  status: 'active' | 'archived';
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  forkRootSessionId: string;
  piSessionId?: string | null;
  piSessionFile?: string | null;
  turns: BookChatTurn[];
}

export interface ConceptCard {
  version: 1;
  id: string;
  projectSlug: string;
  subjectKind: ConceptArtSubjectKind;
  displayName: string;
  prompt: string;
  assetIds: string[];
  activeAssetId?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

export type AgentSessionKind =
  | 'read-book'
  | 'extract-character-list'
  | 'extract-character'
  | 'extract-all-characters'
  | 'suggest-concept-character'
  | 'suggest-concept-location'
  | 'draft-panel-prompt'
  | 'refine-panel-prompt'
  | 'book-chat';

export type PiTaskProfile =
  | 'read-book'
  | 'extract-character-list'
  | 'extract-character'
  | 'extract-all-characters'
  | 'suggest-concept-character'
  | 'suggest-concept-location'
  | 'draft-panel-prompt'
  | 'refine-panel-prompt';

export type PiTaskState = 'starting' | 'running' | 'aborting' | 'done' | 'failed' | 'cancelled';

export interface PiTaskStatus {
  taskId: string;
  projectSlug: string;
  profile: string;
  title: string;
  target?: string | null;
  state: PiTaskState;
  startedAt: string;
  completedAt?: string | null;
  error?: string | null;
  piSessionId?: string | null;
  lastSeq?: number | null;
}

export interface PiTaskEvent {
  seq: number;
  ts: string;
  event: {
    type: string;
    [key: string]: unknown;
  };
}

export type AgentSessionStatus = 'running' | 'succeeded' | 'failed' | 'archived';

export interface AgentSession {
  version: 1;
  id: string;
  projectSlug: string;
  title: string;
  kind: AgentSessionKind;
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  archivedAt?: string | null;
  piSessionId?: string | null;
  piSessionFile?: string | null;
  parentSessionId?: string | null;
  source: Record<string, unknown>;
  logFiles: Record<string, string>;
  error?: string | null;
  stats?: Record<string, unknown> | null;
}

export interface PiTraceUsage {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  totalTokens?: number | null;
}

export interface PiTraceUserStep {
  kind: 'user';
  timestamp?: string | null;
  text: string;
}

export interface PiTraceToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string | null;
  isError?: boolean;
  details?: { diff?: string; firstChangedLine?: number } | null;
}

export interface PiTraceAssistantStep {
  kind: 'assistant';
  timestamp?: string | null;
  provider?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
  stopReason?: string | null;
  usage?: PiTraceUsage | null;
  thinking: string[];
  text?: string | null;
  toolCalls: PiTraceToolCall[];
}

export interface PiTraceInfoBanner {
  kind: 'compaction' | 'branch_summary';
  timestamp?: string | null;
  text: string;
  tokensBefore?: number | null;
}

export type PiTraceStep = PiTraceUserStep | PiTraceAssistantStep | PiTraceInfoBanner;

export interface PiTraceStats {
  messageCount: number;
  toolCount: number;
  userCount: number;
  assistantCount: number;
}

export interface PiTraceDocument {
  sessionId?: string | null;
  cwd?: string | null;
  version?: number | null;
  steps: PiTraceStep[];
  stats: PiTraceStats;
}
