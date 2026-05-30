import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Panel,
  Position,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
  applyNodeChanges,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './style.css';
import { api } from './api';
import type { Asset, CanvasDocument, DraftCanvasNode, GeneratePayload, ImageGroupCanvasNode, Project } from './types';

interface DraftNodeData extends DraftCanvasNode {
  kind: 'draft';
  nodeId: string;
  parentDisplayNames?: Map<string, string>;
}

interface ImageGroupNodeData extends ImageGroupCanvasNode {
  kind: 'imageGroup';
  nodeId: string;
  assets: Asset[];
  activeAsset: Asset | null;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
  onView: (nodeId: string) => void;
}

type PhotoNodeData = DraftNodeData | ImageGroupNodeData;

const emptyCanvas: CanvasDocument = {
  version: 2,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: {},
};

const defaultDraftParams = { model: 'gemini-3.1-flash-image', aspectRatio: '16:9', imageSize: '1K', seed: null, batchCount: 1 };
const minZoom = 0.2;
const maxZoom = 2;

function zoomToPercent(zoom: number) {
  const normalized = ((zoom - minZoom) / (maxZoom - minZoom)) * 100;
  return Math.round(Math.min(100, Math.max(0, normalized)));
}

function nodesToCanvas(canvas: CanvasDocument, nodes: Node<PhotoNodeData>[]): CanvasDocument {
  return {
    ...canvas,
    nodes: Object.fromEntries(
      nodes.map((node) => {
        const existing = canvas.nodes[node.id];
        if (node.data.kind === 'draft') {
          return [
            node.id,
            {
              type: 'draft',
              displayName: node.data.displayName,
              x: node.position.x,
              y: node.position.y,
              width: existing?.width ?? null,
              refs: node.data.refs,
              prompt: node.data.prompt,
              params: node.data.params,
            },
          ];
        }
        return [
          node.id,
          {
            type: 'imageGroup',
            displayName: node.data.displayName,
            x: node.position.x,
            y: node.position.y,
            width: existing?.width ?? null,
            assetIds: node.data.assetIds,
            activeAssetId: node.data.activeAssetId ?? node.data.assetIds[0] ?? null,
          },
        ];
      }),
    ),
  };
}

function displayNameFromPrompt(prompt: string) {
  const firstLine = prompt.trim().split(/\s+/).slice(0, 6).join(' ');
  return firstLine || 'Draft';
}

function toFlowNodes(
  canvas: CanvasDocument,
  assets: Asset[],
  onVariant: (nodeId: string, direction: -1 | 1) => void = () => undefined,
  onView: (nodeId: string) => void = () => undefined,
): Node<PhotoNodeData>[] {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const displayNameByAssetId = new Map<string, string>();
  Object.values(canvas.nodes).forEach((canvasNode) => {
    if (canvasNode.type === 'imageGroup') {
      canvasNode.assetIds.forEach((assetId) => displayNameByAssetId.set(assetId, canvasNode.displayName));
    }
  });
  return Object.entries(canvas.nodes).map(([id, canvasNode]) => {
    if (canvasNode.type === 'draft') {
      return {
        id,
        position: { x: canvasNode.x, y: canvasNode.y },
        type: 'draft',
        data: { ...canvasNode, kind: 'draft', nodeId: id, parentDisplayNames: displayNameByAssetId },
      };
    }
    const groupAssets = canvasNode.assetIds.map((assetId) => assetById.get(assetId)).filter((asset): asset is Asset => Boolean(asset));
    const activeAsset = assetById.get(canvasNode.activeAssetId ?? '') ?? groupAssets[0] ?? null;
    return {
      id,
      position: { x: canvasNode.x, y: canvasNode.y },
      type: 'imageGroup',
      data: { ...canvasNode, kind: 'imageGroup', nodeId: id, assets: groupAssets, activeAsset, onVariant, onView },
    };
  });
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [openProjectSlug, setOpenProjectSlug] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [canvas, setCanvas] = useState<CanvasDocument>(emptyCanvas);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [nodes, setNodes] = useState<Node<PhotoNodeData>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [popoverNodeId, setPopoverNodeId] = useState<string | null>(null);
  const [pendingConnectionSource, setPendingConnectionSource] = useState<string | null>(null);
  const [zoomPercent, setZoomPercent] = useState(zoomToPercent(1));
  const [viewerNodeId, setViewerNodeId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const reactFlowRef = useRef<ReactFlowInstance<PhotoNodeData> | null>(null);

  const changeVariant = useCallback((nodeId: string, direction: -1 | 1) => {
    setNodes((current) => {
      const next = current.map((node) => {
        if (node.id !== nodeId || node.data.kind !== 'imageGroup' || node.data.assetIds.length < 2) return node;
        const currentIndex = Math.max(0, node.data.assetIds.indexOf(node.data.activeAsset?.id ?? node.data.activeAssetId ?? ''));
        const nextIndex = (currentIndex + direction + node.data.assetIds.length) % node.data.assetIds.length;
        const activeAssetId = node.data.assetIds[nextIndex];
        const activeAsset = node.data.assets.find((asset) => asset.id === activeAssetId) ?? node.data.activeAsset;
        return { ...node, data: { ...node.data, activeAssetId, activeAsset } };
      });
      void persistNodes(next);
      return next;
    });
  }, []);

  const openViewer = useCallback((nodeId: string) => {
    setViewerNodeId(nodeId);
  }, []);

  const deleteNodeById = useCallback((nodeId: string) => {
    setNodes((current) => {
      const next = current.filter((node) => node.id !== nodeId);
      void persistNodes(next);
      return next;
    });
    setSelectedNodeIds((current) => current.filter((id) => id !== nodeId));
    setPopoverNodeId((current) => (current === nodeId ? null : current));
  }, []);

  const loadProjects = useCallback(async () => {
    setProjects(await api.listProjects());
  }, []);

  const loadProject = useCallback(async (projectSlug: string) => {
    if (!projectSlug) return;
    const [detail, layout] = await Promise.all([api.getProject(projectSlug), api.getCanvas(projectSlug)]);
    setAssets(detail.assets);
    setCanvas(layout);
    setNodes(toFlowNodes(layout, detail.assets, changeVariant, openViewer));
  }, [changeVariant, openViewer]);

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
    const nodeForAsset = new Map<string, string>();
    nodes.forEach((node) => {
      if (node.data.kind === 'imageGroup') {
        node.data.assetIds.forEach((assetId) => nodeForAsset.set(assetId, node.id));
      }
    });
    const assetEdges = nodes.flatMap((node) => {
      if (node.data.kind !== 'imageGroup') return [];
      const refs = new Set(node.data.assets.flatMap((asset) => asset.generation?.refs ?? []));
      return Array.from(refs).flatMap((ref) => {
        const source = nodeForAsset.get(ref);
        return source && source !== node.id ? [{ id: `${source}-${node.id}-${ref}`, source, target: node.id }] : [];
      });
    });
    const draftEdges = nodes.flatMap((node) => {
      if (node.data.kind !== 'draft') return [];
      return node.data.refs.flatMap((ref) => {
        const source = nodeForAsset.get(ref);
        return source ? [{ id: `${source}-${node.id}-${ref}`, source, target: node.id, animated: true }] : [];
      });
    });
    return [...assetEdges, ...draftEdges];
  }, [nodes]);

  const selectedNode = useMemo(() => nodes.find((node) => node.id === popoverNodeId) ?? null, [nodes, popoverNodeId]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const saveLayout = useCallback(async (_: React.MouseEvent, draggedNode?: Node<PhotoNodeData>) => {
    if (!openProjectSlug) return;
    const currentNodes = draggedNode ? nodes.map((node) => (node.id === draggedNode.id ? draggedNode : node)) : nodes;
    const next = nodesToCanvas(canvas, currentNodes);
    const saved = await api.saveCanvas(openProjectSlug, next);
    setCanvas(saved);
    setNodes(currentNodes);
  }, [assets, canvas, nodes, openProjectSlug]);

  const reload = async () => loadProject(openProjectSlug);

  const openProject = async (projectSlug: string) => {
    setOpenProjectSlug(projectSlug);
    setSelectedIds([]);
    setSelectedNodeIds([]);
    setError(null);
  };

  const closeProject = () => {
    setOpenProjectSlug('');
    setAssets([]);
    setNodes([]);
    setSelectedIds([]);
    setSelectedNodeIds([]);
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

  const updateDraft = async (id: string, patch: Partial<DraftCanvasNode>) => {
    console.debug('[photo-web] update draft', { id, patch });
    setNodes((current) => {
      const nextNodes = current.map((node) =>
        node.id === id && node.data.kind === 'draft' ? { ...node, data: { ...node.data, ...patch } } : node,
      );
      persistNodes(nextNodes, { refresh: false }).catch((err) => {
        console.error('[photo-web] failed to persist draft update', err);
        setError(String(err));
      });
      return nextNodes;
    });
  };

  const updateImageGroup = async (id: string, patch: Partial<ImageGroupCanvasNode>) => {
    setNodes((current) => {
      const nextNodes = current.map((node) =>
        node.id === id && node.data.kind === 'imageGroup' ? { ...node, data: { ...node.data, ...patch } } : node,
      );
      persistNodes(nextNodes, { refresh: false }).catch((err) => {
        console.error('[photo-web] failed to persist image group update', err);
        setError(String(err));
      });
      return nextNodes;
    });
  };

  const persistNodes = async (nextNodes: Node<PhotoNodeData>[], options: { refresh?: boolean } = {}) => {
    if (!openProjectSlug) return;
    const next = nodesToCanvas(canvas, nextNodes);
    const saved = await api.saveCanvas(openProjectSlug, next);
    setCanvas(saved);
    if (options.refresh ?? true) {
      setNodes(toFlowNodes(saved, assets, changeVariant, openViewer));
    }
  };

  const deleteSelectedNodes = useCallback(async () => {
    if (!selectedNodeIds.length) return;
    const selected = new Set(selectedNodeIds);
    const nextNodes = nodes.filter((node) => !selected.has(node.id));
    setNodes(nextNodes);
    setSelectedNodeIds([]);
    setSelectedIds([]);
    if (popoverNodeId && selected.has(popoverNodeId)) setPopoverNodeId(null);
    await persistNodes(nextNodes);
  }, [nodes, persistNodes, popoverNodeId, selectedNodeIds]);

  useEffect(() => {
    const deleteOnKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches?.('input, textarea, select, [contenteditable="true"]');
      if (isTyping || !['Backspace', 'Delete'].includes(event.key)) return;
      event.preventDefault();
      void deleteSelectedNodes();
    };
    window.addEventListener('keydown', deleteOnKey);
    return () => window.removeEventListener('keydown', deleteOnKey);
  }, [deleteSelectedNodes]);

  const createDraftAt = async (refs: string[], position: { x: number; y: number }) => {
    const nodeId = `draft_${Date.now()}`;
    const node: Node<PhotoNodeData> = {
      id: nodeId,
      position,
      type: 'draft',
      data: {
        kind: 'draft',
        nodeId,
        type: 'draft',
        displayName: 'Draft',
        x: position.x,
        y: position.y,
        refs: Array.from(new Set(refs)),
        prompt: '',
        params: defaultDraftParams,
      },
    };
    const nextNodes = [...nodes, node];
    setNodes(nextNodes);
    setPopoverNodeId(node.id);
    await persistNodes(nextNodes);
  };

  const createLooseDraft = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    void createDraftAt(
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
        model: draft.params.model,
        aspectRatio: draft.params.aspectRatio,
        imageSize: draft.params.imageSize,
        seed: draft.params.seed,
        batchCount: draft.params.batchCount,
        title: draft.displayName,
        tags: [],
        canvasNodeId: id,
      };
      await api.generate(openProjectSlug, payload);
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
    <div className="app">
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
          minZoom={minZoom}
          maxZoom={maxZoom}
          onMove={(_, viewport) => setZoomPercent(zoomToPercent(viewport.zoom))}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => setPopoverNodeId(node.id)}
          onNodeDragStop={saveLayout}
          onInit={(instance) => {
            reactFlowRef.current = instance;
          }}
          onConnectStart={(_, params) => {
            const sourceNode = nodes.find((node) => node.id === params.nodeId);
            setPendingConnectionSource(sourceNode?.data.kind === 'imageGroup' ? sourceNode.data.activeAsset?.id ?? null : null);
          }}
          onConnectEnd={(event) => {
            if (!pendingConnectionSource || !(event instanceof MouseEvent)) return;
            const target = event.target as HTMLElement | null;
              const draftElement = target?.closest?.('[data-id^="draft_"]') as HTMLElement | null;
            if (draftElement?.dataset.id) {
              const nextNodes = nodes.map((node) =>
                  node.id === draftElement.dataset.id && node.data.kind === 'draft'
                    ? { ...node, data: { ...node.data, refs: Array.from(new Set([...node.data.refs, pendingConnectionSource])) } }
                    : node,
                );
              setNodes(nextNodes);
              void persistNodes(nextNodes);
              setPopoverNodeId(draftElement.dataset.id);
            } else {
              const flowPosition = reactFlowRef.current?.screenToFlowPosition({
                x: event.clientX,
                y: event.clientY,
              });
              void createDraftAt(
                [pendingConnectionSource],
                flowPosition ?? { x: event.clientX, y: event.clientY },
              );
            }
            setPendingConnectionSource(null);
          }}
          onConnect={(connection: Connection) => {
            if (!connection.source || !connection.target) return;
            const sourceNode = nodes.find((node) => node.id === connection.source);
            const sourceAssetId = sourceNode?.data.kind === 'imageGroup' ? sourceNode.data.activeAsset?.id : null;
            if (!sourceAssetId) return;
            const nextNodes = nodes.map((node) =>
                node.id === connection.target && node.data.kind === 'draft'
                  ? { ...node, data: { ...node.data, refs: Array.from(new Set([...node.data.refs, sourceAssetId])) } }
                  : node,
              );
            setNodes(nextNodes);
            void persistNodes(nextNodes);
            setPopoverNodeId(connection.target);
          }}
          onPaneClick={() => setPopoverNodeId(null)}
          onSelectionChange={({ nodes: selected }) => {
            setSelectedNodeIds(selected.map((node) => node.id));
            setSelectedIds(selected.flatMap((node) => (node.data.kind === 'imageGroup' && node.data.activeAsset ? [node.data.activeAsset.id] : [])));
          }}
          proOptions={{ hideAttribution: true }}
          fitView
        >
          <Background />
          <Controls showInteractive={false} />
          <Panel position="bottom-left" className="zoom-panel">
            Zoom {zoomPercent}%
          </Panel>
        </ReactFlow>
        {isDraggingFile && <div className="drop-overlay">Drop photos to import</div>}
        {contextMenu && (
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
            <button onClick={openImportPicker}>Import</button>
            <button onClick={createLooseDraft}>Generate</button>
          </div>
        )}
      </main>
      {selectedNode && (
        <NodeSidebar
          node={selectedNode}
          assets={assets}
          onDraftChange={updateDraft}
          onImageGroupChange={updateImageGroup}
          onGenerate={generateDraft}
          onDelete={deleteNodeById}
          onDisplaySaved={async () => {
            await reload();
          }}
          projectSlug={openProjectSlug}
        />
      )}
      {viewerNodeId && (
        <ImageViewer
          node={nodes.find((node) => node.id === viewerNodeId && node.data.kind === 'imageGroup') as Node<ImageGroupNodeData> | undefined}
          projectSlug={openProjectSlug}
          onClose={() => setViewerNodeId(null)}
          onVariant={changeVariant}
        />
      )}
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

function NodeSidebar({
  node,
  assets,
  projectSlug,
  onDraftChange,
  onImageGroupChange,
  onGenerate,
  onDelete,
  onDisplaySaved,
}: {
  node: Node<PhotoNodeData>;
  assets: Asset[];
  projectSlug: string;
  onDraftChange: (id: string, patch: Partial<DraftCanvasNode>) => void;
  onImageGroupChange: (id: string, patch: Partial<ImageGroupCanvasNode>) => void;
  onGenerate: (id: string, draft: DraftNodeData) => void;
  onDelete: (id: string) => void;
  onDisplaySaved: () => void;
}) {
  if (node.data.kind === 'draft') {
    const draftNode: Node<DraftNodeData> = { ...node, data: node.data };
    return (
      <DraftSidebar
        node={draftNode}
        assets={assets}
        onDraftChange={onDraftChange}
        onGenerate={onGenerate}
        onDelete={onDelete}
      />
    );
  }

  const imageNode: Node<ImageGroupNodeData> = { ...node, data: node.data };
  if (!node.data.activeAsset) {
    return (
      <aside className="details-sidebar">
        <h2>Missing image</h2>
        <button className="danger" onClick={() => onDelete(node.id)}>Delete node</button>
      </aside>
    );
  }
  return <ImageSidebar node={imageNode} asset={node.data.activeAsset} projectSlug={projectSlug} onDelete={onDelete} onNodeChange={onImageGroupChange} onDisplaySaved={onDisplaySaved} />;
}

function DraftSidebar({
  node,
  assets,
  onDraftChange,
  onGenerate,
  onDelete,
}: {
  node: Node<DraftNodeData>;
  assets: Asset[];
  onDraftChange: (id: string, patch: Partial<DraftCanvasNode>) => void;
  onGenerate: (id: string, draft: DraftNodeData) => void;
  onDelete: (id: string) => void;
}) {
  const draft = node.data;
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [isParentPickerOpen, setIsParentPickerOpen] = useState(false);
  const parents = draft.refs.map((ref) => assets.find((asset) => asset.id === ref) ?? null);
  const availableParents = assets.filter((asset) => !draft.refs.includes(asset.id));
  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft.prompt]);
  return (
    <aside className="details-sidebar">
      <div className="popover-header">
        <h2>{draft.displayName}</h2>
        <button className="danger" onClick={() => onDelete(node.id)}>Delete</button>
      </div>
      <label className="field-label">
        Name
        <input value={draft.displayName} onChange={(event) => onDraftChange(node.id, { displayName: event.target.value })} />
      </label>
      <section className="sidebar-section parent-section">
        <h3>Parents</h3>
        {parents.length === 0 && <p className="muted">None</p>}
        {parents.length > 0 && (
          <div className="parent-list">
            {parents.map((parent, index) => (
              <div className="parent-item" key={draft.refs[index]}>
                {parent?.thumbnailUrl ? <img src={parent.thumbnailUrl} alt="" /> : <div className="parent-thumb-placeholder" />}
                <span>{draft.parentDisplayNames?.get(draft.refs[index]) ?? parent?.title ?? 'Unknown parent'}</span>
                <button
                  className="parent-remove"
                  onClick={() => onDraftChange(node.id, { refs: draft.refs.filter((_, refIndex) => refIndex !== index) })}
                  title="Remove parent"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <button className="add-parent-button" onClick={() => setIsParentPickerOpen((current) => !current)}>+</button>
        {isParentPickerOpen && (
          <div className="asset-picker-popover">
            {availableParents.length === 0 && <p className="muted">All assets are already parents.</p>}
            {availableParents.map((asset) => (
              <button
                className="asset-picker-row"
                key={asset.id}
                onClick={() => {
                  onDraftChange(node.id, { refs: [...draft.refs, asset.id] });
                  setIsParentPickerOpen(false);
                }}
              >
                {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" /> : <div className="parent-thumb-placeholder" />}
                <span>{asset.title}</span>
                <small>{asset.kind}</small>
              </button>
            ))}
          </div>
        )}
      </section>
      <div className="row">
        <input
          value={draft.params.seed ?? ''}
          onChange={(event) =>
            onDraftChange(node.id, { params: { ...draft.params, seed: event.target.value ? Number(event.target.value) : null } })
          }
          placeholder="Seed optional"
        />
      </div>
      <div className="row">
        <select value={draft.params.aspectRatio ?? '16:9'} onChange={(event) => onDraftChange(node.id, { params: { ...draft.params, aspectRatio: event.target.value } })}>
          <option value="16:9">16:9</option>
          <option value="4:3">4:3</option>
          <option value="1:1">1:1</option>
          <option value="3:4">3:4</option>
          <option value="9:16">9:16</option>
        </select>
        <select value={draft.params.imageSize ?? '1K'} onChange={(event) => onDraftChange(node.id, { params: { ...draft.params, imageSize: event.target.value } })}>
          <option value="512">512</option>
          <option value="1K">1K</option>
          <option value="2K">2K</option>
          <option value="4K">4K</option>
        </select>
      </div>
      <textarea
        ref={promptRef}
        className="prompt-textarea"
        autoFocus
        value={draft.prompt}
        onChange={(event) =>
          onDraftChange(node.id, {
            prompt: event.target.value,
            displayName: draft.displayName === 'Draft' ? displayNameFromPrompt(event.target.value) : draft.displayName,
          })
        }
        placeholder="Prompt"
      />
      <div className="generate-control">
        <button onClick={() => onGenerate(node.id, draft)} disabled={!draft.prompt.trim()}>
          Generate
        </button>
        <label>
          Candidates
          <input
            type="number"
            min={1}
            max={8}
            value={draft.params.batchCount}
            onChange={(event) => onDraftChange(node.id, { params: { ...draft.params, batchCount: Number(event.target.value) } })}
          />
        </label>
      </div>
    </aside>
  );
}

function ImageSidebar({
  node,
  asset,
  projectSlug,
  onDelete,
  onNodeChange,
  onDisplaySaved,
}: {
  node: Node<ImageGroupNodeData>;
  asset: Asset;
  projectSlug: string;
  onDelete: (id: string) => void;
  onNodeChange: (id: string, patch: Partial<ImageGroupCanvasNode>) => void;
  onDisplaySaved: () => void;
}) {
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
    <aside className="details-sidebar">
      <div className="popover-header">
        <h2>{node.data.displayName}</h2>
        <button className="danger" onClick={() => onDelete(node.id)}>Delete</button>
      </div>
      <label className="field-label">
        Name
        <input value={node.data.displayName} onChange={(event) => onNodeChange(node.id, { displayName: event.target.value })} />
      </label>
      <p className="muted">Variant {(node.data.assetIds.indexOf(asset.id) + 1) || 1} / {node.data.assetIds.length}</p>
      <input value={title} onChange={(event) => setTitle(event.target.value)} />
      <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="tags, comma-separated" />
      <button onClick={save}>Save display</button>
      {asset.generation && <pre>{JSON.stringify({ prompt: asset.prompt, generation: asset.generation }, null, 2)}</pre>}
    </aside>
  );
}

function ImageGroupNode({ data }: NodeProps<ImageGroupNodeData>) {
  const asset = data.activeAsset;
  if (!asset) {
    return (
      <div className="node">
        <Handle type="target" position={Position.Left} isConnectable={false} />
        <strong>Missing image</strong>
        <Handle type="source" position={Position.Right} className="output-handle" />
      </div>
    );
  }
  const currentIndex = Math.max(0, data.assetIds.indexOf(asset.id));
  const params = asset.generation;
  const tooltip = [
    asset.prompt?.text,
    params ? `model: ${params.model}` : null,
    params ? `ratio: ${params.aspectRatio}, size: ${params.imageSize}, seed: ${params.seed ?? 'auto'}` : null,
    `variants: ${currentIndex + 1}/${data.assetIds.length}`,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className={`node image-group-node ${data.assetIds.length > 1 ? 'stacked' : ''}`} title={tooltip}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="node-image-frame">
        {asset.thumbnailUrl && <img src={asset.thumbnailUrl} alt="" />}
      </div>
      <button
        className="view-image-button"
        onClick={(event) => {
          event.stopPropagation();
          data.onView(data.nodeId);
        }}
        title="View full image"
      >
        *
      </button>
      <strong>{data.displayName}</strong>
      {data.assetIds.length > 1 && <small>{currentIndex + 1} / {data.assetIds.length}</small>}
      {data.assetIds.length > 1 && (
        <div className="variant-controls">
          <button
            onClick={(event) => {
              event.stopPropagation();
              data.onVariant(data.nodeId, -1);
            }}
            title="Previous variant"
          >
            &lt;
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              data.onVariant(data.nodeId, 1);
            }}
            title="Next variant"
          >
            &gt;
          </button>
        </div>
      )}
      <Handle type="source" position={Position.Right} className="output-handle" />
    </div>
  );
}

function ImageViewer({
  node,
  projectSlug,
  onClose,
  onVariant,
}: {
  node?: Node<ImageGroupNodeData>;
  projectSlug: string;
  onClose: () => void;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && node && node.data.assetIds.length > 1) onVariant(node.id, -1);
      if (event.key === 'ArrowRight' && node && node.data.assetIds.length > 1) onVariant(node.id, 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [node, onClose, onVariant]);

  if (!node || !node.data.activeAsset) return null;
  const asset = node.data.activeAsset;
  const currentIndex = Math.max(0, node.data.assetIds.indexOf(asset.id));
  const imageUrl = `/api/projects/${projectSlug}/assets/${asset.id}/image`;
  return (
    <div className="image-viewer" onClick={onClose}>
      <div className="image-viewer-toolbar" onClick={(event) => event.stopPropagation()}>
        <strong>{node.data.displayName}</strong>
        <span>{currentIndex + 1} / {node.data.assetIds.length}</span>
        <button className="secondary" onClick={onClose}>Close</button>
      </div>
      {node.data.assetIds.length > 1 && (
        <button
          className="image-viewer-nav previous"
          onClick={(event) => {
            event.stopPropagation();
            onVariant(node.id, -1);
          }}
          title="Previous variant"
        >
          &lt;
        </button>
      )}
      <img src={imageUrl} alt={node.data.displayName} onClick={(event) => event.stopPropagation()} />
      {node.data.assetIds.length > 1 && (
        <button
          className="image-viewer-nav next"
          onClick={(event) => {
            event.stopPropagation();
            onVariant(node.id, 1);
          }}
          title="Next variant"
        >
          &gt;
        </button>
      )}
    </div>
  );
}

function DraftNode({ data }: NodeProps<DraftNodeData>) {
  const tooltip = [
    data.prompt || 'Draft prompt not set',
    `parents: ${data.refs.length}`,
    `model: ${data.params.model ?? 'default'}`,
    `ratio: ${data.params.aspectRatio ?? 'default'}, size: ${data.params.imageSize ?? 'default'}, seed: ${data.params.seed ?? 'auto'}`,
  ].join('\n');
  return (
    <div className="node draft-node" title={tooltip}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="draft-placeholder" aria-hidden="true" />
      <strong>Draft</strong>
      <small>{data.refs.length} parent{data.refs.length === 1 ? '' : 's'}</small>
    </div>
  );
}

const nodeTypes = {
  imageGroup: ImageGroupNode,
  draft: DraftNode,
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
