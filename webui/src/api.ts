import type { Asset, CanvasDocument, GeneratePayload, Project, ProjectDetail } from './types';

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
  getProject: (slug: string) => request<ProjectDetail>(`/api/projects/${slug}`),
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
  deleteAsset: (slug: string, assetId: string) =>
    request<void>(`/api/projects/${slug}/assets/${assetId}`, {
      method: 'DELETE',
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
