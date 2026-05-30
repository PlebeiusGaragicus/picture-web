import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  applyNodeChanges,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './style.css';
import { api } from './api';
import type { Asset, CanvasDocument, GeneratePayload, Project } from './types';

interface DraftNodeData {
  kind: 'draft';
  refs: string[];
  prompt: string;
  seed: string;
  aspectRatio: string;
  imageSize: string;
  batchCount: number;
}

interface AssetNodeData {
  kind: 'asset';
  asset: Asset;
}

type PhotoNodeData = AssetNodeData | DraftNodeData;

const emptyCanvas: CanvasDocument = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: {},
  stacks: [],
};

function assetNode(asset: Asset, canvas: CanvasDocument, index: number): Node<PhotoNodeData> {
  const position = canvas.nodes[asset.id] ?? { x: 80 + index * 40, y: 80 + index * 40 };
  return {
    id: asset.id,
    position: { x: position.x, y: position.y },
    data: { kind: 'asset', asset },
    type: 'photoAsset',
  };
}

function draftNode(refs: string[], position: { x: number; y: number }): Node<PhotoNodeData> {
  return {
    id: `draft-${Date.now()}`,
    position,
    type: 'draft',
    data: {
      kind: 'draft',
      refs,
      prompt: '',
      seed: '',
      aspectRatio: '16:9',
      imageSize: '1K',
      batchCount: 1,
    },
  };
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [openProjectSlug, setOpenProjectSlug] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [canvas, setCanvas] = useState<CanvasDocument>(emptyCanvas);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [nodes, setNodes] = useState<Node<PhotoNodeData>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [popoverNodeId, setPopoverNodeId] = useState<string | null>(null);
  const [pendingConnectionSource, setPendingConnectionSource] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const loadProjects = useCallback(async () => {
    setProjects(await api.listProjects());
  }, []);

  const loadProject = useCallback(async (projectSlug: string) => {
    if (!projectSlug) return;
    const [detail, layout] = await Promise.all([api.getProject(projectSlug), api.getCanvas(projectSlug)]);
    setAssets(detail.assets);
    setCanvas(layout);
    setNodes((current) => {
      const drafts = current.filter((node) => node.data.kind === 'draft');
      return [...detail.assets.map((asset, index) => assetNode(asset, layout, index)), ...drafts];
    });
  }, []);

  useEffect(() => {
    loadProjects().catch((err) => setError(String(err)));
  }, [loadProjects]);

  useEffect(() => {
    loadProject(openProjectSlug).catch((err) => setError(String(err)));
  }, [loadProject, openProjectSlug]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
        setPopoverNodeId(null);
      }
    };
    window.addEventListener('click', closeMenu);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const edges: Edge[] = useMemo(() => {
    const lineageEdges = assets.flatMap((asset) =>
      (asset.generation?.refs ?? []).map((ref) => ({ id: `${ref}-${asset.id}`, source: ref, target: asset.id })),
    );
    const draftEdges = nodes.flatMap((node) => {
      if (node.data.kind !== 'draft') return [];
      return node.data.refs.map((ref) => ({ id: `${ref}-${node.id}`, source: ref, target: node.id, animated: true }));
    });
    return [...lineageEdges, ...draftEdges];
  }, [assets, nodes]);

  const selectedNode = useMemo(() => nodes.find((node) => node.id === popoverNodeId) ?? null, [nodes, popoverNodeId]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const saveLayout = useCallback(async () => {
    if (!openProjectSlug) return;
    const next: CanvasDocument = {
      ...canvas,
      nodes: Object.fromEntries(
        nodes
          .filter((node) => node.data.kind === 'asset')
          .map((node) => [node.id, { x: node.position.x, y: node.position.y, width: canvas.nodes[node.id]?.width ?? null }]),
      ),
    };
    setCanvas(await api.saveCanvas(openProjectSlug, next));
  }, [canvas, nodes, openProjectSlug]);

  const reload = async () => loadProject(openProjectSlug);

  const openProject = async (projectSlug: string) => {
    setOpenProjectSlug(projectSlug);
    setSelectedIds([]);
    setError(null);
  };

  const closeProject = () => {
    setOpenProjectSlug('');
    setAssets([]);
    setNodes([]);
    setSelectedIds([]);
    setCanvas(emptyCanvas);
    setContextMenu(null);
    setPopoverNodeId(null);
  };

  const importFiles = async (files: FileList | File[]) => {
    if (!openProjectSlug) return;
    const images = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (!images.length) return;
    try {
      setError(null);
      for (const file of images) await api.importAsset(openProjectSlug, file);
      await reload();
    } catch (err) {
      setError(String(err));
    }
  };

  const openImportPicker = () => {
    setContextMenu(null);
    fileInputRef.current?.click();
  };

  const updateDraft = (id: string, patch: Partial<DraftNodeData>) => {
    setNodes((current) =>
      current.map((node) =>
        node.id === id && node.data.kind === 'draft' ? { ...node, data: { ...node.data, ...patch } } : node,
      ),
    );
  };

  const createDraftAt = (refs: string[], position: { x: number; y: number }) => {
    const node = draftNode(Array.from(new Set(refs)), position);
    setNodes((current) => [...current, node]);
    setPopoverNodeId(node.id);
  };

  const createLooseDraft = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    createDraftAt(
      selectedIds,
      rect
        ? { x: Math.max(80, (contextMenu?.x ?? rect.left + 220) - rect.left), y: Math.max(80, (contextMenu?.y ?? rect.top + 160) - rect.top) }
        : { x: 160, y: 160 },
    );
    setContextMenu(null);
  };

  const generateDraft = async (id: string, draft: DraftNodeData) => {
    try {
      setError(null);
      const payload: GeneratePayload = {
        prompt: draft.prompt,
        refs: draft.refs,
        aspectRatio: draft.aspectRatio,
        imageSize: draft.imageSize,
        seed: draft.seed ? Number(draft.seed) : null,
        batchCount: draft.batchCount,
        tags: [],
      };
      await api.generate(openProjectSlug, payload);
      setNodes((current) => current.filter((node) => node.id !== id));
      setPopoverNodeId(null);
      await reload();
    } catch (err) {
      setError(String(err));
    }
  };

  const currentProject = projects.find((project) => project.slug === openProjectSlug);

  if (!openProjectSlug) {
    return (
      <ProjectLanding
        projects={projects}
        error={error}
        onOpen={openProject}
        onCreated={async (nextSlug) => {
          await loadProjects();
          await openProject(nextSlug);
        }}
      />
    );
  }

  return (
    <div className="app canvas-only">
      <main
        ref={canvasRef}
        className={`canvas ${isDraggingFile ? 'dragging-file' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDraggingFile(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setIsDraggingFile(false);
        }}
        onDrop={async (event) => {
          event.preventDefault();
          setIsDraggingFile(false);
          await importFiles(event.dataTransfer.files);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={async (event) => {
            if (event.target.files) await importFiles(event.target.files);
            event.currentTarget.value = '';
          }}
        />
        <div className="toolbar">
          <strong>{currentProject?.name ?? openProjectSlug}</strong>
          <button className="plus-button" onClick={openImportPicker} title="Import photos">+</button>
          <button className="secondary" onClick={closeProject}>Close project</button>
          <span>{assets.length} assets</span>
          {error && <span className="error">{error}</span>}
        </div>
        <ReactFlow
          nodeTypes={nodeTypes}
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => setPopoverNodeId(node.id)}
          onNodeDragStop={saveLayout}
          onConnectStart={(_, params) => setPendingConnectionSource(params.nodeId ?? null)}
          onConnectEnd={(event) => {
            if (!pendingConnectionSource || !(event instanceof MouseEvent)) return;
            const target = event.target as HTMLElement | null;
            const draftElement = target?.closest?.('[data-id^="draft-"]') as HTMLElement | null;
            if (draftElement?.dataset.id) {
              setNodes((current) =>
                current.map((node) =>
                  node.id === draftElement.dataset.id && node.data.kind === 'draft'
                    ? { ...node, data: { ...node.data, refs: Array.from(new Set([...node.data.refs, pendingConnectionSource])) } }
                    : node,
                ),
              );
              setPopoverNodeId(draftElement.dataset.id);
            } else {
              const rect = canvasRef.current?.getBoundingClientRect();
              createDraftAt(
                [pendingConnectionSource],
                rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: event.clientX, y: event.clientY },
              );
            }
            setPendingConnectionSource(null);
          }}
          onConnect={(connection: Connection) => {
            if (!connection.source || !connection.target) return;
            setNodes((current) =>
              current.map((node) =>
                node.id === connection.target && node.data.kind === 'draft'
                  ? { ...node, data: { ...node.data, refs: Array.from(new Set([...node.data.refs, connection.source!])) } }
                  : node,
              ),
            );
            setPopoverNodeId(connection.target);
          }}
          onPaneClick={() => setPopoverNodeId(null)}
          onSelectionChange={({ nodes: selected }) =>
            setSelectedIds(selected.filter((node) => node.data.kind === 'asset').map((node) => node.id))
          }
          proOptions={{ hideAttribution: true }}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
        {isDraggingFile && <div className="drop-overlay">Drop photos to import</div>}
        {contextMenu && (
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
            <button onClick={openImportPicker}>Import</button>
            <button onClick={createLooseDraft}>Generate</button>
          </div>
        )}
        {selectedNode && (
          <NodePopover
            node={selectedNode}
            assets={assets}
            onClose={() => setPopoverNodeId(null)}
            onDraftChange={updateDraft}
            onGenerate={generateDraft}
            onDisplaySaved={async () => {
              await reload();
              setPopoverNodeId(null);
            }}
            projectSlug={openProjectSlug}
          />
        )}
      </main>
    </div>
  );
}

function ProjectLanding({
  projects,
  error,
  onOpen,
  onCreated,
}: {
  projects: Project[];
  error: string | null;
  onOpen: (slug: string) => void;
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
    <div className="landing">
      <div className="landing-card">
        <h1>photo-web</h1>
        <p className="muted">Open or create a project to begin.</p>
        {error && <p className="error">{error}</p>}
        <section>
          <h2>Open project</h2>
          {projects.length === 0 && <p className="muted">No projects yet.</p>}
          <div className="project-list">
            {projects.map((project) => (
              <button key={project.slug} className="project-card" onClick={() => onOpen(project.slug)}>
                <strong>{project.name}</strong>
                <small>{project.slug}</small>
              </button>
            ))}
          </div>
        </section>
        <section>
          <h2>Create project</h2>
          <div className="row">
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" />
            <button onClick={create}>Create</button>
          </div>
        </section>
      </div>
    </div>
  );
}

function NodePopover({
  node,
  assets,
  projectSlug,
  onClose,
  onDraftChange,
  onGenerate,
  onDisplaySaved,
}: {
  node: Node<PhotoNodeData>;
  assets: Asset[];
  projectSlug: string;
  onClose: () => void;
  onDraftChange: (id: string, patch: Partial<DraftNodeData>) => void;
  onGenerate: (id: string, draft: DraftNodeData) => void;
  onDisplaySaved: () => void;
}) {
  if (node.data.kind === 'draft') {
    const draft = node.data;
    const parentTitles = draft.refs.map((ref) => assets.find((asset) => asset.id === ref)?.title ?? ref).join(', ');
    return (
      <div className="popover" style={{ left: node.position.x + 220, top: node.position.y + 24 }}>
        <div className="popover-header">
          <h2>Draft</h2>
          <button className="secondary" onClick={onClose}>Close</button>
        </div>
        <p className="muted">Parents: {parentTitles || 'none'}</p>
        <textarea autoFocus value={draft.prompt} onChange={(event) => onDraftChange(node.id, { prompt: event.target.value })} placeholder="Prompt" />
        <div className="row">
          <input value={draft.seed} onChange={(event) => onDraftChange(node.id, { seed: event.target.value })} placeholder="Seed optional" />
          <input type="number" min={1} max={8} value={draft.batchCount} onChange={(event) => onDraftChange(node.id, { batchCount: Number(event.target.value) })} />
        </div>
        <div className="row">
          <select value={draft.aspectRatio} onChange={(event) => onDraftChange(node.id, { aspectRatio: event.target.value })}>
            <option value="16:9">16:9</option>
            <option value="4:3">4:3</option>
            <option value="1:1">1:1</option>
            <option value="3:4">3:4</option>
            <option value="9:16">9:16</option>
          </select>
          <select value={draft.imageSize} onChange={(event) => onDraftChange(node.id, { imageSize: event.target.value })}>
            <option value="512">512</option>
            <option value="1K">1K</option>
            <option value="2K">2K</option>
            <option value="4K">4K</option>
          </select>
        </div>
        <button onClick={() => onGenerate(node.id, draft)} disabled={!draft.prompt.trim()}>Generate</button>
      </div>
    );
  }

  const asset = node.data.asset;
  const [title, setTitle] = useState(asset.title);
  const [tags, setTags] = useState(asset.tags.join(', '));
  useEffect(() => {
    setTitle(asset.title);
    setTags(asset.tags.join(', '));
  }, [asset]);
  const save = async () => {
    await api.patchDisplay(projectSlug, asset.id, title, tags.split(',').map((tag) => tag.trim()).filter(Boolean));
    onDisplaySaved();
  };
  return (
    <div className="popover" style={{ left: node.position.x + 220, top: node.position.y + 24 }}>
      <div className="popover-header">
        <h2>Asset</h2>
        <button className="secondary" onClick={onClose}>Close</button>
      </div>
      <input value={title} onChange={(event) => setTitle(event.target.value)} />
      <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="tags, comma-separated" />
      <button onClick={save}>Save display</button>
      {asset.generation && <pre>{JSON.stringify({ prompt: asset.prompt, generation: asset.generation }, null, 2)}</pre>}
    </div>
  );
}

function AssetNode({ data }: NodeProps<AssetNodeData>) {
  const asset = data.asset;
  return (
    <div className="node">
      <Handle type="target" position={Position.Left} />
      {asset.thumbnailUrl && <img src={asset.thumbnailUrl} alt="" />}
      <strong>{asset.title}</strong>
      <small>{asset.kind}</small>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function DraftNode({ data }: NodeProps<DraftNodeData>) {
  return (
    <div className="node draft-node">
      <Handle type="target" position={Position.Left} />
      <strong>Draft</strong>
      <small>{data.refs.length} parent{data.refs.length === 1 ? '' : 's'}</small>
      <span>{data.prompt || 'Click to add prompt'}</span>
    </div>
  );
}

const nodeTypes = {
  photoAsset: AssetNode,
  draft: DraftNode,
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
