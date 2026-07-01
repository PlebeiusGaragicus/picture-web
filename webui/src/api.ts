import type { AdaptationCanvasImportResponse, AdaptationFileDocument, AdaptationFileKind, AdaptationFilePayload, AdaptationFileUpdatePayload, AdaptationGenerateResponse, AdaptationStage, AdaptationStatus, AdaptationWorkflowStatus, AgentSession, ArtifactKind, Asset, BookChatSession, CanvasDocument, ChatSession, ChatTurnPayload, ChatTurnResponse, ConceptArtSubjectKind, ConceptCard, ConceptNodeResponse, CreateChatSessionPayload, GenerateArtifactPayload, GeneratePayload, GenerateStyleRefPayload, ImageGroupNodeResponse, MomentLayoutSection, MomentPatch, MomentSequenceDocument, MomentSequenceEntry, PiTraceDocument, Project, ProjectDetail, SceneListDocument, SceneListLine, SceneMomentsDocument, StoryKind, StoryPanelBookmarkCreatePayload, StoryPanelCreatePayload, StoryPanelDocument, StoryPanelPatchPayload, StyleRefKind, TagDefinition, TagRegistryDocument, VisualStyleDefinition } from './types';

const DEBUG = true;

function debugLog(message: string, details?: unknown) {
  if (!DEBUG) return;
  if (details === undefined) {
    console.debug(`[photo-web] ${message}`);
  } else {
    console.debug(`[photo-web] ${message}`, details);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET';
  debugLog(`request ${method} ${url}`);
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: init?.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch (error) {
    console.error(`[photo-web] request failed before response ${method} ${url}`, error);
    throw error;
  }
  debugLog(`response ${response.status} ${method} ${url}`, { ms: Math.round(performance.now() - started) });
  if (!response.ok) {
    const body = await response.text();
    let message = body || response.statusText;
    try {
      const parsed = JSON.parse(body) as { detail?: unknown };
      if (typeof parsed.detail === 'string') {
        message = parsed.detail;
      } else if (parsed.detail !== undefined) {
        message = JSON.stringify(parsed.detail);
      }
    } catch {
      // Keep the raw response text when the server did not return JSON.
    }
    console.error(`[photo-web] request failed ${method} ${url}`, { status: response.status, detail: message });
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function requestBlob(url: string, init?: RequestInit): Promise<Blob> {
  const method = init?.method ?? 'GET';
  debugLog(`request ${method} ${url}`);
  const response = await fetch(url, init);
  debugLog(`response ${response.status} ${method} ${url}`);
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  return response.blob();
}

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),
  createProject: (slug: string, name: string, settings: Record<string, unknown> = {}) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ slug, name, settings }),
    }),
  getProject: (slug: string, includeArchived = false) => request<ProjectDetail>(`/api/projects/${slug}${includeArchived ? '?includeArchived=true' : ''}`),
  getProjectTags: (slug: string) => request<TagDefinition[]>(`/api/projects/${slug}/tags`),
  saveProjectTags: (slug: string, tags: TagDefinition[]) =>
    request<TagRegistryDocument>(`/api/projects/${slug}/tags`, {
      method: 'PUT',
      body: JSON.stringify({ tags }),
    }),
  setProjectCover: (slug: string, coverAssetId: string | null) =>
    request<Project>(`/api/projects/${slug}`, {
      method: 'PATCH',
      body: JSON.stringify({ coverAssetId }),
    }),
  deleteProject: (slug: string) =>
    request<void>(`/api/projects/${slug}`, {
      method: 'DELETE',
    }),
  getCanvas: (slug: string, includeArchived = false) =>
    request<CanvasDocument>(`/api/projects/${slug}/canvas${includeArchived ? '?includeArchived=true' : ''}`),
  saveCanvas: (slug: string, canvas: CanvasDocument) =>
    request<CanvasDocument>(`/api/projects/${slug}/canvas`, {
      method: 'PUT',
      body: JSON.stringify(canvas),
    }),
  generate: (slug: string, payload: GeneratePayload) =>
    request<{ assets: Asset[] }>(`/api/projects/${slug}/generate`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getAdaptation: (slug: string) => request<AdaptationStatus>(`/api/projects/${slug}/adaptation`),
  createVisualStyle: (slug: string, payload: { name: string; prompt?: string }) =>
    request<AdaptationStatus>(`/api/projects/${slug}/adaptation/visual-styles`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateVisualStyle: (slug: string, styleId: string, payload: { name?: string; prompt?: string; default?: boolean }) =>
    request<AdaptationStatus>(`/api/projects/${slug}/adaptation/visual-styles/${styleId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteVisualStyle: (slug: string, styleId: string) =>
    request<AdaptationStatus>(`/api/projects/${slug}/adaptation/visual-styles/${styleId}`, {
      method: 'DELETE',
    }),
  saveAdaptationStyleRefPrompt: (slug: string, kind: StyleRefKind, prompt: string) =>
    request<AdaptationStatus>(`/api/projects/${slug}/adaptation/style-ref-prompt`, {
      method: 'PUT',
      body: JSON.stringify({ kind, prompt }),
    }),
  saveAdaptationSettings: (slug: string, storyKind: StoryKind) =>
    request<AdaptationStatus>(`/api/projects/${slug}/adaptation/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ storyKind }),
    }),
  listAdaptationFiles: (slug: string, kind: AdaptationFileKind) =>
    request<AdaptationFileDocument[]>(`/api/projects/${slug}/adaptation/files/${kind}`),
  createAdaptationFile: (slug: string, kind: AdaptationFileKind, payload: AdaptationFilePayload) =>
    request<AdaptationFileDocument>(`/api/projects/${slug}/adaptation/files/${kind}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateAdaptationFile: (slug: string, kind: AdaptationFileKind, key: string, payload: AdaptationFileUpdatePayload) =>
    request<AdaptationFileDocument>(`/api/projects/${slug}/adaptation/files/${kind}/${key}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteAdaptationFile: (slug: string, kind: AdaptationFileKind, key: string) =>
    request<AdaptationStatus>(`/api/projects/${slug}/adaptation/files/${kind}/${key}`, {
      method: 'DELETE',
    }),
  getSceneList: (slug: string) => request<SceneListDocument>(`/api/projects/${slug}/adaptation/scenes/list`),
  putSceneList: (slug: string, lines: SceneListLine[]) =>
    request<SceneListDocument>(`/api/projects/${slug}/adaptation/scenes/list`, {
      method: 'PUT',
      body: JSON.stringify({ lines }),
    }),
  addSceneListLine: (slug: string, line: SceneListLine) =>
    request<SceneListDocument>(`/api/projects/${slug}/adaptation/scenes/list/lines`, {
      method: 'POST',
      body: JSON.stringify(line),
    }),
  deleteSceneListLine: (slug: string, key: string) =>
    request<SceneListDocument>(`/api/projects/${slug}/adaptation/scenes/list/lines/${key}`, {
      method: 'DELETE',
    }),
  startSceneExtract: (slug: string, sceneKey: string, force = false) =>
    request<AdaptationWorkflowStatus>(
      `/api/projects/${slug}/adaptation/scenes/${sceneKey}/extract${force ? '?force=true' : ''}`,
      {
        method: 'POST',
      },
    ),
  getSceneExtract: (slug: string, sceneKey: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/scenes/${sceneKey}/extract`),
  startCharacterList: (slug: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/characters/list`, { method: 'POST' }),
  getCharacterList: (slug: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/characters/list`),
  startCharacterExtractAll: (slug: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/characters/extract-all`, { method: 'POST' }),
  getCharacterExtractAll: (slug: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/characters/extract-all`),
  startCharacterExtract: (slug: string, characterKey: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/characters/${characterKey}/extract`, { method: 'POST' }),
  getCharacterExtract: (slug: string, characterKey: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/characters/${characterKey}/extract`),
  startGenerateConceptCharacter: (slug: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/concept-art/generate-character`, { method: 'POST' }),
  getGenerateConceptCharacter: (slug: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/concept-art/generate-character`),
  startGenerateConceptLocation: (slug: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/concept-art/generate-location`, { method: 'POST' }),
  getGenerateConceptLocation: (slug: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/concept-art/generate-location`),
  listConceptCards: (slug: string, includeArchived = false) =>
    request<ConceptCard[]>(`/api/projects/${slug}/concept-cards${includeArchived ? '?includeArchived=true' : ''}`),
  createConceptCard: (slug: string, payload: { subjectKind: ConceptArtSubjectKind; prompt?: string; displayName?: string }) =>
    request<ConceptCard>(`/api/projects/${slug}/concept-cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  updateConceptCard: (slug: string, cardId: string, payload: { displayName?: string; prompt?: string; archived?: boolean | null }) =>
    request<ConceptCard>(`/api/projects/${slug}/concept-cards/${cardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  deleteConceptCard: (slug: string, cardId: string) =>
    request<void>(`/api/projects/${slug}/concept-cards/${cardId}`, { method: 'DELETE' }),
  draftConceptCard: (slug: string, cardId: string) =>
    request<ConceptNodeResponse>(`/api/projects/${slug}/concept-cards/${cardId}/draft`, { method: 'POST' }),
  createConceptNode: (slug: string, payload: { subjectKind: ConceptArtSubjectKind; prompt?: string; displayName?: string }) =>
    request<ConceptCard>(`/api/projects/${slug}/concept-nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  createImageGroup: (slug: string, payload: { displayName?: string; tags?: string[]; prompt?: string; refs?: string[]; visualStyleId?: string | null }) =>
    request<ImageGroupNodeResponse>(`/api/projects/${slug}/canvas/image-groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  uploadConceptArt: (slug: string, file: File) => {
    const data = new FormData();
    data.append('file', file);
    return request<ConceptCard>(`/api/projects/${slug}/adaptation/concept-art/upload`, {
      method: 'POST',
      body: data,
    });
  },
  resetCharacterData: (slug: string) =>
    request<AdaptationStatus>(`/api/projects/${slug}/adaptation/characters/reset`, {
      method: 'POST',
    }),
  startScenePlan: (slug: string, sceneKey: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/scenes/${sceneKey}/plan`, {
      method: 'POST',
    }),
  getScenePlan: (slug: string, sceneKey: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/scenes/${sceneKey}/plan`),
  getSceneMoments: (slug: string, sceneKey: string) =>
    request<SceneMomentsDocument>(`/api/projects/${slug}/adaptation/scenes/${sceneKey}/moments`),
  putSceneMoments: (
    slug: string,
    sceneKey: string,
    payload: { body: string } | { sections: MomentLayoutSection[] },
  ) =>
    request<SceneMomentsDocument>(`/api/projects/${slug}/adaptation/scenes/${sceneKey}/moments`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  getMomentSequence: (slug: string) =>
    request<MomentSequenceDocument>(`/api/projects/${slug}/adaptation/moments/sequence`),
  patchMoment: (slug: string, momentKey: string, patch: MomentPatch) =>
    request<MomentSequenceEntry>(`/api/projects/${slug}/adaptation/moments/${momentKey}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  getAdaptationWorkflow: (slug: string, stage: AdaptationStage = 'all') =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/workflow?stage=${stage}`),
  startAdaptationWorkflow: (slug: string, stage: AdaptationStage = 'all') =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/workflow/start`, {
      method: 'POST',
      body: JSON.stringify({ stage }),
    }),
  getAdaptationValidation: (slug: string, stage: AdaptationStage = 'all') =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/validation?stage=${stage}`),
  startAdaptationValidation: (slug: string, stage: AdaptationStage = 'all') =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/validation/start`, {
      method: 'POST',
      body: JSON.stringify({ stage }),
    }),
  publishAdaptationPhaseToCanvas: (slug: string) =>
    request<AdaptationCanvasImportResponse>(`/api/projects/${slug}/adaptation/import-drafts-to-canvas`, {
      method: 'POST',
    }),
  importAdaptationArtifactToCanvas: (slug: string, artifactKind: ArtifactKind, artifactKey: string) =>
    request<AdaptationCanvasImportResponse>(`/api/projects/${slug}/adaptation/import-artifact-to-canvas`, {
      method: 'POST',
      body: JSON.stringify({ artifactKind, artifactKey }),
    }),
  getAdaptationBook: (slug: string) =>
    request<{ text: string }>(`/api/projects/${slug}/adaptation/book`),
  getBookSessionLoad: (slug: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/book-session/load`),
  startBookSessionLoad: (slug: string) =>
    request<AdaptationWorkflowStatus>(`/api/projects/${slug}/adaptation/book-session/load`, {
      method: 'POST',
    }),
  listBookChatSessions: (slug: string, includeArchived = false) =>
    request<BookChatSession[]>(`/api/projects/${slug}/adaptation/book-chats${includeArchived ? '?includeArchived=true' : ''}`),
  getBookChatSession: (slug: string, sessionId: string) =>
    request<BookChatSession>(`/api/projects/${slug}/adaptation/book-chats/${sessionId}`),
  createBookChatSession: (slug: string, payload: { title?: string | null } = {}) =>
    request<BookChatSession>(`/api/projects/${slug}/adaptation/book-chats`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  patchBookChatSession: (slug: string, sessionId: string, payload: { title?: string | null; archived?: boolean | null }) =>
    request<BookChatSession>(`/api/projects/${slug}/adaptation/book-chats/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  sendBookChatTurn: (slug: string, sessionId: string, text: string) =>
    request<BookChatSession>(`/api/projects/${slug}/adaptation/book-chats/${sessionId}/turns`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  getBookChatTrace: (slug: string, sessionId: string) =>
    request<PiTraceDocument>(`/api/projects/${slug}/adaptation/book-chats/${sessionId}/trace`),
  listAgentSessions: (slug: string, includeArchived = false) =>
    request<AgentSession[]>(`/api/projects/${slug}/agent-sessions${includeArchived ? '?includeArchived=true' : ''}`),
  getAgentSession: (slug: string, sessionId: string) =>
    request<AgentSession>(`/api/projects/${slug}/agent-sessions/${sessionId}`),
  patchAgentSession: (slug: string, sessionId: string, payload: { title?: string | null; archived?: boolean | null }) =>
    request<AgentSession>(`/api/projects/${slug}/agent-sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  getAgentSessionTrace: (slug: string, sessionId: string) =>
    request<PiTraceDocument>(`/api/projects/${slug}/agent-sessions/${sessionId}/trace`),
  getStoryPanelBook: (slug: string) =>
    request<{ text: string }>(`/api/projects/${slug}/story-panels/book`),
  getStoryPanels: (slug: string) =>
    request<StoryPanelDocument>(`/api/projects/${slug}/story-panels`),
  getStoryPanelsBookletPdf: (slug: string, options?: { pageBorder?: 'black' | 'grey' | 'none' }) => {
    const params = new URLSearchParams();
    if (options?.pageBorder) params.set('pageBorder', options.pageBorder);
    const query = params.toString();
    return requestBlob(`/api/projects/${slug}/story-panels/print/booklet.pdf${query ? `?${query}` : ''}`);
  },
  saveStoryPanels: (slug: string, document: StoryPanelDocument) =>
    request<StoryPanelDocument>(`/api/projects/${slug}/story-panels`, {
      method: 'PUT',
      body: JSON.stringify(document),
    }),
  createStoryPanel: (slug: string, payload: StoryPanelCreatePayload) =>
    request<StoryPanelDocument>(`/api/projects/${slug}/story-panels/panels`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  createStoryBookmark: (slug: string, payload: StoryPanelBookmarkCreatePayload) =>
    request<StoryPanelDocument>(`/api/projects/${slug}/story-panels/panels/bookmark`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  patchStoryPanel: (slug: string, panelId: string, patch: StoryPanelPatchPayload) =>
    request<StoryPanelDocument>(`/api/projects/${slug}/story-panels/panels/${panelId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  autoPlaceStoryPanel: (slug: string, panelId: string) =>
    request<StoryPanelDocument>(`/api/projects/${slug}/story-panels/panels/${panelId}/auto-place`, {
      method: 'POST',
    }),
  deleteStoryPanel: (slug: string, panelId: string) =>
    request<StoryPanelDocument>(`/api/projects/${slug}/story-panels/panels/${panelId}`, {
      method: 'DELETE',
    }),
  // Recovery after breaking panels.json schema changes; keeps canvas, assets, and adaptation.
  resetStoryPanelLayout: (slug: string) =>
    request<StoryPanelDocument>(`/api/projects/${slug}/story-panels/reset-layout`, {
      method: 'POST',
    }),
  resetStoryPanelChunks: (slug: string) =>
    request<StoryPanelDocument>(`/api/projects/${slug}/story-panels/reset-chunks`, {
      method: 'POST',
    }),
  importAdaptationBook: (slug: string, file: File) => {
    const data = new FormData();
    data.append('file', file);
    return request<AdaptationStatus>(`/api/projects/${slug}/adaptation/import-book`, {
      method: 'POST',
      body: data,
    });
  },
  importAdaptationStyleRef: (slug: string, kind: StyleRefKind, file: File) => {
    const data = new FormData();
    data.append('kind', kind);
    data.append('file', file);
    return request<AdaptationStatus>(`/api/projects/${slug}/adaptation/import-style-ref`, {
      method: 'POST',
      body: data,
    });
  },
  setAdaptationStyleRefAsset: (slug: string, kind: StyleRefKind, assetId: string) =>
    request<AdaptationStatus>(`/api/projects/${slug}/adaptation/style-ref-asset`, {
      method: 'POST',
      body: JSON.stringify({ kind, assetId }),
    }),
  syncAdaptationStyleRefToCanvas: (slug: string, kind: StyleRefKind) =>
    request<AdaptationCanvasImportResponse>(`/api/projects/${slug}/adaptation/sync-style-ref-to-canvas`, {
      method: 'POST',
      body: JSON.stringify({ kind }),
    }),
  generateAdaptationStyleRef: (slug: string, payload: GenerateStyleRefPayload) =>
    request<AdaptationGenerateResponse>(`/api/projects/${slug}/adaptation/generate-style-ref`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  generateAdaptationArtifact: (slug: string, payload: GenerateArtifactPayload) =>
    request<AdaptationGenerateResponse>(`/api/projects/${slug}/adaptation/generate-artifact`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  patchDisplay: (slug: string, assetId: string, title: string, tags: string[]) =>
    request<Asset>(`/api/projects/${slug}/assets/${assetId}/display`, {
      method: 'PATCH',
      body: JSON.stringify({ title, tags }),
    }),
  archiveAsset: (slug: string, assetId: string, archived = true) =>
    request<Asset>(`/api/projects/${slug}/assets/${assetId}/archive`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    }),
  deleteAsset: (slug: string, assetId: string) =>
    request<void>(`/api/projects/${slug}/assets/${assetId}`, {
      method: 'DELETE',
    }),
  listChatSessions: (slug: string, includeArchived = false) =>
    request<ChatSession[]>(`/api/projects/${slug}/chat-sessions${includeArchived ? '?includeArchived=true' : ''}`),
  createChatSession: (slug: string, payload: CreateChatSessionPayload) =>
    request<ChatSession>(`/api/projects/${slug}/chat-sessions`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  patchChatSession: (slug: string, sessionId: string, payload: { title?: string | null; archived?: boolean | null }) =>
    request<ChatSession>(`/api/projects/${slug}/chat-sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  sendChatTurn: (slug: string, sessionId: string, payload: ChatTurnPayload) =>
    request<ChatTurnResponse>(`/api/projects/${slug}/chat-sessions/${sessionId}/turns`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  forkChatSession: (slug: string, sessionId: string, sourceAssetId?: string | null) =>
    request<ChatSession>(`/api/projects/${slug}/chat-sessions/${sessionId}/fork${sourceAssetId ? `?sourceAssetId=${encodeURIComponent(sourceAssetId)}` : ''}`, {
      method: 'POST',
    }),
  importAsset: (slug: string, file: File, position?: { x: number; y: number }) => {
    const data = new FormData();
    data.append('file', file);
    data.append('title', file.name.replace(/\.[^.]+$/, ''));
    if (position) {
      data.append('canvasX', String(position.x));
      data.append('canvasY', String(position.y));
    }
    return request<Asset>(`/api/projects/${slug}/assets/import`, {
      method: 'POST',
      body: data,
    });
  },
};
