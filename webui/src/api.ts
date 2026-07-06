import type { AdaptationCanvasImportResponse, AdaptationFileDocument, AdaptationFileKind, AdaptationFilePayload, AdaptationFileUpdatePayload, AdaptationStatus, AgentSession, ArtifactKind, Asset, CanvasDocument, ChatSession, ChatTurnPayload, ChatTurnResponse, ConceptArtSubjectKind, ConceptCard, ConceptNodeResponse, CreateChatSessionPayload, GeneratePayload, ImageGroupNodeResponse, PiTaskProfile, PiTaskStatus, PiTraceDocument, Project, ProjectDetail, StoryPanelBookmarkCreatePayload, StoryPanelCreatePayload, StoryPanelDocument, StoryPanelPatchPayload, TagDefinition, TagRegistryDocument, VisualStyleDefinition } from './types';

const DEBUG = import.meta.env.DEV;

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
  listConceptCards: (slug: string, includeArchived = false) =>
    request<ConceptCard[]>(`/api/projects/${slug}/concept-cards${includeArchived ? '?includeArchived=true' : ''}`),
  createConceptCard: (slug: string, payload: { subjectKind: ConceptArtSubjectKind; prompt?: string; displayName?: string }) =>
    request<ConceptCard>(`/api/projects/${slug}/concept-cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  updateConceptCard: (slug: string, cardId: string, payload: { displayName?: string; prompt?: string; subjectKind?: ConceptArtSubjectKind; archived?: boolean | null }) =>
    request<ConceptCard>(`/api/projects/${slug}/concept-cards/${cardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  deleteConceptCard: (slug: string, cardId: string) =>
    request<void>(`/api/projects/${slug}/concept-cards/${cardId}`, { method: 'DELETE' }),
  draftConceptCard: (slug: string, cardId: string) =>
    request<ConceptNodeResponse>(`/api/projects/${slug}/concept-cards/${cardId}/draft`, { method: 'POST' }),
  createImageGroup: (slug: string, payload: { displayName?: string; tags?: string[]; prompt?: string; refs?: string[]; visualStyleId?: string | null }) =>
    request<ImageGroupNodeResponse>(`/api/projects/${slug}/canvas/image-groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  uploadConceptCardImage: (slug: string, cardId: string, file: File) => {
    const data = new FormData();
    data.append('file', file);
    return request<ConceptCard>(`/api/projects/${slug}/concept-cards/${cardId}/upload`, {
      method: 'POST',
      body: data,
    });
  },
  resetCharacterData: (slug: string) =>
    request<AdaptationStatus>(`/api/projects/${slug}/adaptation/characters/reset`, {
      method: 'POST',
    }),
  importAdaptationArtifactToCanvas: (slug: string, artifactKind: ArtifactKind, artifactKey: string) =>
    request<AdaptationCanvasImportResponse>(`/api/projects/${slug}/adaptation/import-artifact-to-canvas`, {
      method: 'POST',
      body: JSON.stringify({ artifactKind, artifactKey }),
    }),
  startPiTask: (
    slug: string,
    profile: PiTaskProfile,
    options: { target?: string; force?: boolean; instructions?: string } = {},
  ) =>
    request<PiTaskStatus>(`/api/projects/${slug}/pi-tasks`, {
      method: 'POST',
      body: JSON.stringify({
        profile,
        target: options.target ?? null,
        force: options.force ?? false,
        instructions: options.instructions ?? null,
      }),
    }),
  listPiTasks: (slug: string, params: { profile?: string; active?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (params.profile) query.set('profile', params.profile);
    if (params.active !== undefined) query.set('active', String(params.active));
    const suffix = query.size ? `?${query.toString()}` : '';
    return request<PiTaskStatus[]>(`/api/projects/${slug}/pi-tasks${suffix}`);
  },
  getPiTask: (slug: string, taskId: string) =>
    request<PiTaskStatus>(`/api/projects/${slug}/pi-tasks/${taskId}`),
  abortPiTask: (slug: string, taskId: string) =>
    request<{ cancelled: boolean }>(`/api/projects/${slug}/pi-tasks/${taskId}/abort`, { method: 'POST' }),
  piTaskEventsUrl: (slug: string, taskId: string) =>
    `/api/projects/${slug}/pi-tasks/${taskId}/events`,
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
  draftPanelToCanvas: (slug: string, panelId: string, promptId: string) =>
    request<ConceptNodeResponse>(
      `/api/projects/${slug}/story-panels/panels/${panelId}/draft-to-canvas?promptId=${encodeURIComponent(promptId)}`,
      { method: 'POST' },
    ),
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
  setTagCanonical: (slug: string, tagId: string, assetId: string | null) =>
    request<TagDefinition[]>(`/api/projects/${slug}/tags/${tagId}/canonical`, {
      method: 'PUT',
      body: JSON.stringify({ assetId }),
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
