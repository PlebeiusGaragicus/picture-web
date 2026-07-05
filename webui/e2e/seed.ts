/**
 * Global setup: seed the isolated e2e photo-library via the REST API only.
 * Storage shapes are declared breakable (AGENTS.md); the HTTP API is the seam.
 * Never calls generate/adaptation/chat endpoints — no Gemini or pi required.
 */
import fs from 'node:fs';
import path from 'node:path';

const API = 'http://127.0.0.1:8799/api';
const SLUG = 'e2e-fixture';

const PNGS: Array<{ name: string; base64: string; x: number; y: number }> = [
  {
    name: 'blue.png',
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAf0lEQVR4nNXOMREAIBDAsFJbuEM0MyJ+4BoFWftcyiRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4vwdmHo+YQIz9DYGkAAAAABJRU5ErkJggg==',
    x: 120,
    y: 160,
  },
  {
    name: 'rose.png',
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAgUlEQVR4nNXOQREAIAzAsFJjOMG/AAQgYg+uUZB196FM4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iTO34GpB9cNAhGEYbJfAAAAAElFTkSuQmCC',
    x: 520,
    y: 160,
  },
  {
    name: 'amber.png',
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAgElEQVR4nNXOMREAIBDAsNIV/ysu2RHxA9coyLpnUyZxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEufvwNQDSrQCHh48z58AAAAASUVORK5CYII=',
    x: 920,
    y: 380,
  },
];

async function api(pathname: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API}${pathname}`, init);
  if (!response.ok) {
    throw new Error(`seed: ${init?.method ?? 'GET'} ${pathname} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export default async function globalSetup(): Promise<void> {
  await api('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, name: 'E2E Fixture', settings: {} }),
  });

  for (const png of PNGS) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(png.base64, 'base64')], { type: 'image/png' }), png.name);
    form.append('title', png.name.replace('.png', ''));
    form.append('canvasX', String(png.x));
    form.append('canvasY', String(png.y));
    await api(`/projects/${SLUG}/assets/import`, { method: 'POST', body: form });
  }

  for (const [index, text] of ['A quiet morning on the farm.', 'The hen bolts for the fence.'].entries()) {
    await api(`/projects/${SLUG}/story-panels/panels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Panel ${index + 1}`, storyText: text, visibleText: text }),
    });
  }

  fs.writeFileSync(path.join(__dirname, '.fixture.json'), JSON.stringify({ slug: SLUG }));
}
