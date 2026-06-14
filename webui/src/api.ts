import type { AdaptationCanvasImportResponse, AdaptationFileDocument, AdaptationFileKind, AdaptationFilePayload, AdaptationFileUpdatePayload, AdaptationGenerateResponse, AdaptationStage, AdaptationStatus, AdaptationWorkflowStatus, ArtifactKind, Asset, CanvasDocument, ChatSession, ChatTurnPayload, ChatTurnResponse, CreateChatSessionPayload, GeneratePayload, Project, ProjectDetail, StoryKind, StyleRefKind } from './types';

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

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),
  createProject: (slug: string, name: string, settings: Record<string, unknown> = {}) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ slug, name, settings }),
    }),
  getProject: (slug: string, includeArchived = false) => request<ProjectDetail>(`/api/projects/${slug}${includeArchived ? '?includeArchived=true' : ''}`),
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
  saveAdaptationStyle: (slug: string, visualStyle: string) =>
    request<AdaptationStatus>(`/api/projects/${slug}/adaptation/style`, {
      method: 'PUT',
      body: JSON.stringify({ visualStyle }),
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
  getAdaptationBook: (slug: string) =>
    request<{ text: string }>(`/api/projects/${slug}/adaptation/book`),
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
  generateAdaptationStyleRef: (slug: string, kind: StyleRefKind, canvasNodeId?: string | null) =>
    request<AdaptationGenerateResponse>(`/api/projects/${slug}/adaptation/generate-style-ref`, {
      method: 'POST',
      body: JSON.stringify({ kind, canvasNodeId }),
    }),
  generateAdaptationArtifact: (slug: string, artifactKind: ArtifactKind, artifactKey: string, canvasNodeId?: string | null) =>
    request<AdaptationGenerateResponse>(`/api/projects/${slug}/adaptation/generate-artifact`, {
      method: 'POST',
      body: JSON.stringify({ artifactKind, artifactKey, canvasNodeId }),
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
