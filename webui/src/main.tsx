import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import ReactFlow, {
  Background,
  Controls,
  type Edge,
  type Node,
  type NodeChange,
  applyNodeChanges,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './style.css';
import { api } from './api';
import type { Asset, CanvasDocument, GeneratePayload, Project } from './types';

const emptyCanvas: CanvasDocument = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: {},
  stacks: [],
};

function assetNode(asset: Asset, canvas: CanvasDocument, index: number): Node {
  const position = canvas.nodes[asset.id] ?? { x: 80 + index * 40, y: 80 + index * 40 };
  return {
    id: asset.id,
    position: { x: position.x, y: position.y },
    data: { asset },
    type: 'default',
  };
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [slug, setSlug] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [canvas, setCanvas] = useState<CanvasDocument>(emptyCanvas);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    const next = await api.listProjects();
    setProjects(next);
    if (!slug && next.length) setSlug(next[0].slug);
  }, [slug]);

  const loadProject = useCallback(async (projectSlug: string) => {
    if (!projectSlug) return;
    const [detail, layout] = await Promise.all([
      api.getProject(projectSlug),
      api.getCanvas(projectSlug),
    ]);
    setAssets(detail.assets);
    setCanvas(layout);
    setNodes(detail.assets.map((asset, index) => assetNode(asset, layout, index)));
  }, []);

  useEffect(() => {
    loadProjects().catch((err) => setError(String(err)));
  }, [loadProjects]);

  useEffect(() => {
    loadProject(slug).catch((err) => setError(String(err)));
  }, [loadProject, slug]);

  const edges: Edge[] = useMemo(() => {
    return assets.flatMap((asset) =>
      (asset.generation?.refs ?? []).map((ref) => ({
        id: `${ref}-${asset.id}`,
        source: ref,
        target: asset.id,
      })),
    );
  }, [assets]);

  const selectedAssets = useMemo(
    () => assets.filter((asset) => selectedIds.includes(asset.id)),
    [assets, selectedIds],
  );

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const saveLayout = async () => {
    const next: CanvasDocument = {
      ...canvas,
      nodes: Object.fromEntries(
        nodes.map((node) => [
          node.id,
          { x: node.position.x, y: node.position.y, width: canvas.nodes[node.id]?.width ?? null },
        ]),
      ),
    };
    setCanvas(await api.saveCanvas(slug, next));
  };

  const reload = async () => loadProject(slug);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>photo-web</h1>
        {error && <p className="error">{error}</p>}
        <ProjectPicker
          projects={projects}
          slug={slug}
          onChange={setSlug}
          onCreated={async (nextSlug) => {
            await loadProjects();
            setSlug(nextSlug);
          }}
        />
        {slug && (
          <>
            <ImportButton slug={slug} onImported={reload} />
            <GenerationForm slug={slug} selectedAssets={selectedAssets} onGenerated={reload} />
            <AssetInspector slug={slug} assets={selectedAssets} onSaved={reload} />
          </>
        )}
      </aside>
      <main className="canvas">
        <div className="toolbar">
          <button onClick={saveLayout} disabled={!slug}>
            Save layout
          </button>
          <span>{assets.length} assets</span>
        </div>
        <ReactFlow
          nodes={nodes.map((node) => ({ ...node, data: { label: <NodeLabel asset={node.data.asset} /> } }))}
          edges={edges}
          onNodesChange={onNodesChange}
          onSelectionChange={({ nodes: selected }) => setSelectedIds(selected.map((node) => node.id))}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </main>
    </div>
  );
}

function ProjectPicker({
  projects,
  slug,
  onChange,
  onCreated,
}: {
  projects: Project[];
  slug: string;
  onChange: (slug: string) => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState('');
  const create = async () => {
    const nextSlug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!nextSlug) return;
    await api.createProject(nextSlug, name);
    setName('');
    onCreated(nextSlug);
  };
  return (
    <section>
      <label>Project</label>
      <select value={slug} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select...</option>
        {projects.map((project) => (
          <option key={project.slug} value={project.slug}>
            {project.name}
          </option>
        ))}
      </select>
      <div className="row">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="New project" />
        <button onClick={create}>Create</button>
      </div>
    </section>
  );
}

function ImportButton({ slug, onImported }: { slug: string; onImported: () => void }) {
  return (
    <section>
      <label>Import image</label>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          await api.importAsset(slug, file);
          event.currentTarget.value = '';
          onImported();
        }}
      />
    </section>
  );
}

function GenerationForm({
  slug,
  selectedAssets,
  onGenerated,
}: {
  slug: string;
  selectedAssets: Asset[];
  onGenerated: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [batchCount, setBatchCount] = useState(1);
  const [seed, setSeed] = useState('');
  const generate = async () => {
    const payload: GeneratePayload = {
      prompt,
      refs: selectedAssets.map((asset) => asset.id),
      model: 'gemini-3.1-flash-image',
      aspectRatio: '16:9',
      imageSize: '1K',
      seed: seed ? Number(seed) : null,
      batchCount,
      tags: [],
    };
    await api.generate(slug, payload);
    setPrompt('');
    onGenerated();
  };
  return (
    <section>
      <h2>Generate / Refine</h2>
      <p className="muted">Parents: {selectedAssets.map((asset) => asset.title).join(', ') || 'none'}</p>
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Prompt" />
      <div className="row">
        <input value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="Seed optional" />
        <input
          type="number"
          min={1}
          max={8}
          value={batchCount}
          onChange={(event) => setBatchCount(Number(event.target.value))}
        />
      </div>
      <button onClick={generate} disabled={!prompt.trim()}>
        Generate
      </button>
    </section>
  );
}

function AssetInspector({
  slug,
  assets,
  onSaved,
}: {
  slug: string;
  assets: Asset[];
  onSaved: () => void;
}) {
  const asset = assets[0];
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  useEffect(() => {
    setTitle(asset?.title ?? '');
    setTags(asset?.tags.join(', ') ?? '');
  }, [asset]);
  if (!asset) return <section className="muted">Select an asset to inspect metadata.</section>;
  const save = async () => {
    await api.patchDisplay(
      slug,
      asset.id,
      title,
      tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    );
    onSaved();
  };
  return (
    <section>
      <h2>Asset</h2>
      <input value={title} onChange={(event) => setTitle(event.target.value)} />
      <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="tags, comma-separated" />
      <button onClick={save}>Save display</button>
      {asset.generation && (
        <pre>{JSON.stringify({ prompt: asset.prompt, generation: asset.generation }, null, 2)}</pre>
      )}
    </section>
  );
}

function NodeLabel({ asset }: { asset: Asset }) {
  return (
    <div className="node">
      {asset.thumbnailUrl && <img src={asset.thumbnailUrl} alt="" />}
      <strong>{asset.title}</strong>
      <small>{asset.kind}</small>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
