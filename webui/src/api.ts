import type { Asset, CanvasDocument, ChatSession, ChatTurnPayload, ChatTurnResponse, CreateChatSessionPayload, GeneratePayload, Project, ProjectDetail } from './types';

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
    const detail = await response.text();
    console.error(`[photo-web] request failed ${method} ${url}`, { status: response.status, detail });
    throw new Error(detail || response.statusText);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),
  createProject: (slug: string, name: string) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ slug, name }),
    }),
  getProject: (slug: string, includeArchived = false) => request<ProjectDetail>(`/api/projects/${slug}${includeArchived ? '?includeArchived=true' : ''}`),
  getCanvas: (slug: string) => request<CanvasDocument>(`/api/projects/${slug}/canvas`),
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
  importAsset: (slug: string, file: File) => {
    const data = new FormData();
    data.append('file', file);
    data.append('title', file.name.replace(/\.[^.]+$/, ''));
    return request<Asset>(`/api/projects/${slug}/assets/import`, {
      method: 'POST',
      body: data,
    });
  },
};
