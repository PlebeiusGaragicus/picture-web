import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import ReactFlow, {
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
import type { AdaptationStatus, AdaptationWorkflowStatus, ArtifactKind, Asset, CanvasDocument, ChatSession, ChatTurnSettings, DraftCanvasNode, GeneratePayload, GenerationParams, ImageGroupCanvasNode, Project, StoryArtifactCanvasNode } from './types';

interface DraftNodeData extends DraftCanvasNode {
  kind: 'draft';
  nodeId: string;
  parentDisplayNames?: Map<string, string>;
  isGenerating?: boolean;
  onDetails: (nodeId: string) => void;
}

interface ImageGroupNodeData extends ImageGroupCanvasNode {
  kind: 'imageGroup';
  nodeId: string;
  assets: Asset[];
  activeAsset: Asset | null;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
  onView: (nodeId: string) => void;
  onDetails: (nodeId: string) => void;
  onDisplayNameChange: (nodeId: string, displayName: string) => void;
  onRefineChat: (nodeId: string, assetId: string) => void;
  hasRefinements?: boolean;
  isGenerating?: boolean;
}

interface StoryArtifactNodeData extends StoryArtifactCanvasNode {
  kind: 'storyArtifact';
  nodeId: string;
  generatedAsset: Asset | null;
  onRefineChat: (nodeId: string, assetId: string) => void;
  onCreateChildDraft: (nodeId: string, assetId: string) => void;
  isGenerating?: boolean;
  onDetails: (nodeId: string) => void;
  onViewAsset: (assetId: string) => void;
}

type PhotoNodeData = DraftNodeData | StoryArtifactNodeData | ImageGroupNodeData;

const emptyCanvas: CanvasDocument = {
  version: 2,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: {},
};

const defaultDraftParams: GenerationParams = { model: 'gemini-3.1-flash-image', aspectRatio: '16:9', imageSize: '1K', seed: null, batchCount: 1 };
const modelCapabilities: Record<string, { aspectRatios: string[]; imageSizes: string[] }> = {
  'gemini-2.5-flash-image': {
    aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    imageSizes: ['1K', '2K', '4K'],
  },
  'gemini-3.1-flash-image': {
    aspectRatios: ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'],
    imageSizes: ['512', '1K', '2K', '4K'],
  },
  'gemini-3-pro-image': {
    aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    imageSizes: ['1K', '2K', '4K'],
  },
};
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
              tags: node.data.tags ?? [],
              refs: node.data.refs,
              prompt: node.data.prompt,
              params: node.data.params,
            },
          ];
        }
        if (node.data.kind === 'storyArtifact') {
          return [
            node.id,
            {
              type: 'storyArtifact',
              displayName: node.data.displayName,
              x: node.position.x,
              y: node.position.y,
              width: existing?.width ?? node.data.width ?? null,
              tags: node.data.tags ?? [],
              artifactKind: node.data.artifactKind,
              artifactKey: node.data.artifactKey,
              promptPath: node.data.promptPath,
              prompt: node.data.prompt,
              refs: node.data.refs,
              params: node.data.params,
              generatedAssetId: node.data.generatedAssetId ?? null,
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
            tags: node.data.tags ?? [],
            assetIds: node.data.assetIds,
            activeAssetId: node.data.activeAssetId ?? node.data.assetIds[0] ?? null,
          },
        ];
      }),
    ),
  };
}

function visibleDisplayName(displayName: string) {
  return /^(Draft|Generated\s+[0-9A-Z]+)$/i.test(displayName.trim()) ? '' : displayName;
}

function assetLabel(asset: Asset | null | undefined, fallback = 'Untitled image') {
  return asset?.title?.trim() || fallback;
}

function uniqueOptions(options: string[], current: string | null | undefined) {
  return Array.from(new Set(current ? [...options, current] : options));
}

function capabilitiesForModel(model: string | null | undefined) {
  return modelCapabilities[model ?? ''] ?? modelCapabilities[defaultDraftParams.model ?? 'gemini-3.1-flash-image'];
}

function normalizedParamsForModel(params: GenerationParams, model: string) {
  const capabilities = capabilitiesForModel(model);
  return {
    ...params,
    model,
    aspectRatio: capabilities.aspectRatios.includes(params.aspectRatio ?? '') ? params.aspectRatio : capabilities.aspectRatios[0],
    imageSize: capabilities.imageSizes.includes(params.imageSize ?? '') ? params.imageSize : capabilities.imageSizes[0],
  };
}

function toFlowNodes(
  canvas: CanvasDocument,
  assets: Asset[],
  generatingNodeIds: Set<string> = new Set(),
  onVariant: (nodeId: string, direction: -1 | 1) => void = () => undefined,
  onView: (nodeId: string) => void = () => undefined,
  onDetails: (nodeId: string) => void = () => undefined,
  onViewAsset: (assetId: string) => void = () => undefined,
  onDisplayNameChange: (nodeId: string, displayName: string) => void = () => undefined,
  onRefineChat: (nodeId: string, assetId: string) => void = () => undefined,
  chatSessions: ChatSession[] = [],
): Node<PhotoNodeData>[] {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const sourceAssetIdsWithSessions = new Set(chatSessions.map((session) => session.source.assetId));
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
        data: { ...canvasNode, kind: 'draft', nodeId: id, parentDisplayNames: displayNameByAssetId, isGenerating: generatingNodeIds.has(id), onDetails },
      };
    }
    if (canvasNode.type === 'storyArtifact') {
      const generatedAsset = assetById.get(canvasNode.generatedAssetId ?? '') ?? null;
      return {
        id,
        position: { x: canvasNode.x, y: canvasNode.y },
        type: 'storyArtifact',
        data: { ...canvasNode, kind: 'storyArtifact', nodeId: id, generatedAsset, isGenerating: generatingNodeIds.has(id), onDetails, onViewAsset, onRefineChat, onCreateChildDraft: () => undefined },
      };
    }
    const groupAssets = canvasNode.assetIds.map((assetId) => assetById.get(assetId)).filter((asset): asset is Asset => Boolean(asset));
    const activeAsset = assetById.get(canvasNode.activeAssetId ?? '') ?? groupAssets[0] ?? null;
    return {
      id,
      position: { x: canvasNode.x, y: canvasNode.y },
      type: 'imageGroup',
      data: { ...canvasNode, kind: 'imageGroup', nodeId: id, assets: groupAssets, activeAsset, onVariant, onView, onDetails, onDisplayNameChange, onRefineChat, hasRefinements: Boolean(activeAsset && sourceAssetIdsWithSessions.has(activeAsset.id)), isGenerating: generatingNodeIds.has(id) },
    };
  });
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [openProjectSlug, setOpenProjectSlug] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
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
  const [viewerAssetId, setViewerAssetId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ nodeId: string; assetId?: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [activeTagFilters, setActiveTagFilters] = useState<string[]>([]);
  const [projectView, setProjectView] = useState<'canvas' | 'adaptation'>('canvas');
  const [generatingNodeIds, setGeneratingNodeIds] = useState<Set<string>>(new Set());
  const [adaptation, setAdaptation] = useState<AdaptationStatus | null>(null);
  const [adaptationWorkflow, setAdaptationWorkflow] = useState<AdaptationWorkflowStatus | null>(null);
  const [adaptationValidation, setAdaptationValidation] = useState<AdaptationWorkflowStatus | null>(null);
  const [isValidationLogExpanded, setIsValidationLogExpanded] = useState(false);
  const [isWorkflowLogExpanded, setIsWorkflowLogExpanded] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const reactFlowRef = useRef<ReactFlowInstance<PhotoNodeData> | null>(null);
  const pendingImportPositionRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const generatingNodeIdsRef = useRef<Set<string>>(new Set());
  const chatSessionsRef = useRef<ChatSession[]>([]);

  useEffect(() => {
    generatingNodeIdsRef.current = generatingNodeIds;
  }, [generatingNodeIds]);

  useEffect(() => {
    chatSessionsRef.current = chatSessions;
  }, [chatSessions]);

  const updateImageGroupDisplayName = useCallback((nodeId: string, displayName: string) => {
    setNodes((current) => {
      const renamedNode = current.find((node) => node.id === nodeId && node.data.kind === 'imageGroup') as Node<ImageGroupNodeData> | undefined;
      const renamedAssetIds = renamedNode?.data.assetIds ?? [];
      const nextNodes = current.map((node) =>
        node.id === nodeId && node.data.kind === 'imageGroup'
          ? { ...node, data: { ...node.data, displayName } }
          : node.data.kind === 'draft' && renamedAssetIds.length
            ? {
                ...node,
                data: {
                  ...node.data,
                  parentDisplayNames: new Map([
                    ...(node.data.parentDisplayNames ?? new Map<string, string>()),
                    ...renamedAssetIds.map((assetId) => [assetId, displayName] as [string, string]),
                  ]),
                },
              }
            : node,
      );
      persistNodes(nextNodes, { refresh: false }).catch((err) => {
        console.error('[photo-web] failed to persist image group name', err);
        setError(String(err));
      });
      return nextNodes;
    });
  }, []);

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
    setViewerAssetId(null);
  }, []);

  const openAssetInViewer = useCallback((assetId: string) => {
    setNodes((current) => {
      const targetNode = current.find((node) => node.data.kind === 'imageGroup' && node.data.assetIds.includes(assetId)) as Node<ImageGroupNodeData> | undefined;
      if (!targetNode) {
        setViewerAssetId(assetId);
        setViewerNodeId(null);
        return current;
      }
      setViewerNodeId(targetNode.id);
      setViewerAssetId(null);
      const next = current.map((node) => {
        if (node.id !== targetNode.id || node.data.kind !== 'imageGroup') return node;
        const activeAsset = node.data.assets.find((asset) => asset.id === assetId) ?? node.data.activeAsset;
        return { ...node, data: { ...node.data, activeAssetId: assetId, activeAsset } };
      });
      void persistNodes(next);
      return next;
    });
  }, []);

  const openDetails = useCallback((nodeId: string) => {
    setActiveChatSessionId(null);
    setPopoverNodeId(nodeId);
  }, []);

  const openViewerDetails = useCallback((nodeId: string) => {
    setPopoverNodeId(nodeId);
    setViewerNodeId(null);
  }, []);

  const loadProjects = useCallback(async () => {
    setProjects(await api.listProjects());
  }, []);

  const openChatForAsset = useCallback(async (nodeId: string, assetId: string) => {
    if (!openProjectSlug) return;
    setError(null);
    try {
      const existing = chatSessionsRef.current.find((session) => session.source.assetId === assetId && !session.archivedAt);
      const session = existing ?? await api.createChatSession(openProjectSlug, { sourceAssetId: assetId, canvasNodeId: nodeId });
      setActiveChatSessionId(session.id);
      setPopoverNodeId(null);
      if (!existing) {
        setChatSessions((current) => [...current, session]);
      }
    } catch (err) {
      setError(String(err));
    }
  }, [openProjectSlug]);

  const loadProject = useCallback(async (projectSlug: string) => {
    if (!projectSlug) return;
    const [detail, layout, sessions] = await Promise.all([api.getProject(projectSlug, showArchived), api.getCanvas(projectSlug), api.listChatSessions(projectSlug, showArchived)]);
    setAssets(detail.assets);
    setChatSessions(sessions);
    setCanvas(layout);
    setNodes(toFlowNodes(layout, detail.assets, generatingNodeIdsRef.current, changeVariant, openViewer, openDetails, openAssetInViewer, updateImageGroupDisplayName, openChatForAsset, sessions));
  }, [changeVariant, openAssetInViewer, openChatForAsset, openDetails, openViewer, showArchived, updateImageGroupDisplayName]);

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

  const availableTagFilters = useMemo(() => {
    const tags = new Set<string>();
    nodes.forEach((node) => node.data.tags.forEach((tag) => tags.add(tag)));
    return Array.from(tags).sort();
  }, [nodes]);
  const filteredNodes = useMemo(() => {
    if (activeTagFilters.length === 0) return nodes;
    const required = new Set(activeTagFilters);
    return nodes.filter((node) => node.data.tags.some((tag) => required.has(tag)));
  }, [activeTagFilters, nodes]);

  const edges: Edge[] = useMemo(() => {
    const visibleNodeIds = new Set(filteredNodes.map((node) => node.id));
    const nodeForAsset = new Map<string, Node<ImageGroupNodeData>>();
    filteredNodes.forEach((node) => {
      if (node.data.kind === 'imageGroup') {
        const imageNode: Node<ImageGroupNodeData> = { ...node, data: node.data };
        node.data.assetIds.forEach((assetId) => nodeForAsset.set(assetId, imageNode));
      }
    });
    const edgeForAssetRef = (childNode: Node<ImageGroupNodeData> | Node<DraftNodeData> | Node<StoryArtifactNodeData>, childAssetId: string | null, ref: string): Edge | null => {
      const sourceNode = nodeForAsset.get(ref);
      if (!sourceNode || sourceNode.id === childNode.id) return null;
      const sourceVisible = sourceNode.data.activeAsset?.id === ref;
      const childVisible = childNode.data.kind === 'draft' || childNode.data.kind === 'storyArtifact' || childNode.data.activeAsset?.id === childAssetId;
      const isVisibleLineage = sourceVisible && childVisible;
      return {
        id: `${sourceNode.id}-${childNode.id}-${childAssetId ?? 'draft'}-${ref}`,
        source: sourceNode.id,
        target: childNode.id,
        animated: childNode.data.kind === 'draft',
        className: `${isVisibleLineage ? 'lineage-edge-visible' : 'lineage-edge-hidden'}${childAssetId && childNode.data.kind === 'imageGroup' && childNode.data.assets.find((asset) => asset.id === childAssetId)?.generation?.chatSessionId ? ' lineage-edge-chat-refinement' : ''}`,
        style: isVisibleLineage ? undefined : { strokeDasharray: '5 5', opacity: 0.35 },
      };
    };
    const assetEdges = filteredNodes.flatMap((node) => {
      if (node.data.kind !== 'imageGroup') return [];
      const imageNode: Node<ImageGroupNodeData> = { ...node, data: node.data };
      return node.data.assets.flatMap((asset) => (asset.generation?.refs ?? []).flatMap((ref) => edgeForAssetRef(imageNode, asset.id, ref) ?? []));
    });
    const draftEdges = filteredNodes.flatMap((node) => {
      if (node.data.kind !== 'draft') return [];
      const draftNode: Node<DraftNodeData> = { ...node, data: node.data };
      return node.data.refs.flatMap((ref) => edgeForAssetRef(draftNode, null, ref) ?? []);
    });
    const artifactRefEdges = filteredNodes.flatMap((node) => {
      if (node.data.kind !== 'storyArtifact') return [];
      const artifactNode: Node<StoryArtifactNodeData> = { ...node, data: node.data };
      return node.data.refs.flatMap((ref) => edgeForAssetRef(artifactNode, null, ref) ?? []);
    });
    const artifactGeneratedEdges = filteredNodes.flatMap((node): Edge[] => {
      if (node.data.kind !== 'storyArtifact' || !node.data.generatedAssetId) return [];
      const targetNode = nodeForAsset.get(node.data.generatedAssetId);
      if (!targetNode || !visibleNodeIds.has(targetNode.id)) return [];
      return [{
        id: `${node.id}-${targetNode.id}-${node.data.generatedAssetId}`,
        source: node.id,
        target: targetNode.id,
        animated: false,
        className: 'lineage-edge-visible',
      }];
    });
    return [...assetEdges, ...draftEdges, ...artifactRefEdges, ...artifactGeneratedEdges];
  }, [filteredNodes]);

  const selectedNode = useMemo(() => nodes.find((node) => node.id === popoverNodeId) ?? null, [nodes, popoverNodeId]);
  const activeChatSession = useMemo(
    () => chatSessions.find((session) => session.id === activeChatSessionId) ?? null,
    [activeChatSessionId, chatSessions],
  );

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

  const performDeleteNodeById = useCallback((nodeId: string, assetId?: string) => {
    const nodeToDelete = nodes.find((node) => node.id === nodeId);
    const assetIdsToDelete = nodeToDelete?.data.kind === 'imageGroup'
      ? [assetId ?? nodeToDelete.data.activeAsset?.id ?? nodeToDelete.data.activeAssetId ?? nodeToDelete.data.assetIds[0]].filter((id): id is string => Boolean(id))
      : [];
    if (nodeToDelete?.data.kind === 'imageGroup') {
      void Promise.all(assetIdsToDelete.map((assetId) => api.deleteAsset(openProjectSlug, assetId)))
        .then(() => loadProject(openProjectSlug))
        .catch((err) => {
          console.error('[photo-web] failed to delete image asset', err);
          setError(String(err));
        });
    }
    setNodes((current) => {
      const next = nodeToDelete?.data.kind === 'imageGroup'
        ? current
            .map((node) => {
              if (node.id !== nodeId || node.data.kind !== 'imageGroup') return node;
              const nextAssetIds = node.data.assetIds.filter((id) => !assetIdsToDelete.includes(id));
              if (!nextAssetIds.length) return null;
              const nextActiveAssetId = nextAssetIds.includes(node.data.activeAssetId ?? '') ? node.data.activeAssetId : nextAssetIds[0];
              const nextAssets = node.data.assets.filter((asset) => nextAssetIds.includes(asset.id));
              const nextActiveAsset = nextAssets.find((asset) => asset.id === nextActiveAssetId) ?? nextAssets[0] ?? null;
              return { ...node, data: { ...node.data, assetIds: nextAssetIds, activeAssetId: nextActiveAssetId, assets: nextAssets, activeAsset: nextActiveAsset } };
            })
            .filter((node): node is Node<PhotoNodeData> => Boolean(node))
        : current.filter((node) => node.id !== nodeId);
      void persistNodes(next);
      return next;
    });
    setSelectedNodeIds((current) => current.filter((id) => id !== nodeId));
    setPopoverNodeId((current) => (current === nodeId ? null : current));
  }, [loadProject, nodes, openProjectSlug]);

  const deleteNodeById = useCallback((nodeId: string, assetId?: string) => {
    setPendingDelete({ nodeId, assetId });
  }, []);

  const openProject = async (projectSlug: string) => {
    setOpenProjectSlug(projectSlug);
    setProjectView('canvas');
    setSelectedIds([]);
    setSelectedNodeIds([]);
    setError(null);
  };

  const closeProject = () => {
    setOpenProjectSlug('');
    setProjectView('canvas');
    setAssets([]);
    setChatSessions([]);
    setActiveChatSessionId(null);
    setNodes([]);
    setSelectedIds([]);
    setSelectedNodeIds([]);
    setCanvas(emptyCanvas);
    setContextMenu(null);
    setPopoverNodeId(null);
  };

  const sendChatMessage = async (session: ChatSession, text: string, settings: ChatTurnSettings, attachmentAssetIds: string[]) => {
    if (!openProjectSlug) return;
    const sourceNodeId = session.source.canvasNodeId;
    setError(null);
    try {
      if (sourceNodeId) {
        setGeneratingNodeIds((current) => new Set(current).add(sourceNodeId));
        setNodes((current) => current.map((node) => (node.id === sourceNodeId ? { ...node, data: { ...node.data, isGenerating: true } } : node)));
      }
      const response = await api.sendChatTurn(openProjectSlug, session.id, { text, settings, attachmentAssetIds });
      setChatSessions((current) => current.map((item) => (item.id === response.session.id ? response.session : item)));
      await loadProject(openProjectSlug);
      setActiveChatSessionId(response.session.id);
    } catch (err) {
      const message = String(err);
      setError(message);
      throw err;
    } finally {
      if (sourceNodeId) {
        setGeneratingNodeIds((current) => {
          const next = new Set(current);
          next.delete(sourceNodeId);
          return next;
        });
        setNodes((current) => current.map((node) => (node.id === sourceNodeId ? { ...node, data: { ...node.data, isGenerating: false } } : node)));
      }
    }
  };

  const archiveChatSession = async (session: ChatSession) => {
    if (!openProjectSlug) return;
    try {
      const archived = await api.patchChatSession(openProjectSlug, session.id, { archived: true });
      setChatSessions((current) => current.map((item) => (item.id === archived.id ? archived : item)));
      setActiveChatSessionId(null);
      await loadProject(openProjectSlug);
    } catch (err) {
      setError(String(err));
    }
  };

  const flowPositionFromClientPoint = (point: { x: number; y: number }) => {
    const flowPosition = reactFlowRef.current?.screenToFlowPosition(point);
    if (flowPosition) return flowPosition;
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? { x: point.x - rect.left, y: point.y - rect.top } : { x: point.x, y: point.y };
  };

  const importFiles = async (files: FileList | File[], position?: { x: number; y: number }) => {
    if (!openProjectSlug) return;
    const images = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (!images.length) return;
    try {
      setError(null);
      for (const [index, file] of images.entries()) {
        try {
          const nextPosition = position ? { x: position.x + (index % 3) * 280, y: position.y + Math.floor(index / 3) * 240 } : undefined;
          await api.importAsset(openProjectSlug, file, nextPosition);
        } catch (err) {
          const message = String(err);
          if (message.includes('Already imported')) {
            setError(message);
            continue;
          }
          throw err;
        }
      }
      await reload();
    } catch (err) {
      setError(String(err));
    }
  };

  const openImportPicker = () => {
    pendingImportPositionRef.current = contextMenu ? flowPositionFromClientPoint({ x: contextMenu.x, y: contextMenu.y }) : undefined;
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
      const updatedNode = current.find((node) => node.id === id && node.data.kind === 'imageGroup') as Node<ImageGroupNodeData> | undefined;
      const renamedAssetIds = patch.displayName !== undefined ? updatedNode?.data.assetIds ?? [] : [];
      const nextNodes = current.map((node) => {
        if (node.id === id && node.data.kind === 'imageGroup') {
          return { ...node, data: { ...node.data, ...patch } };
        }
        if (node.data.kind === 'draft' && patch.displayName !== undefined && renamedAssetIds.length) {
          return {
            ...node,
            data: {
              ...node.data,
              parentDisplayNames: new Map([
                ...(node.data.parentDisplayNames ?? new Map<string, string>()),
                ...renamedAssetIds.map((assetId) => [assetId, patch.displayName ?? ''] as [string, string]),
              ]),
            },
          };
        }
        return node;
      });
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
      setNodes(toFlowNodes(saved, assets, generatingNodeIdsRef.current, changeVariant, openViewer, openDetails, openAssetInViewer, updateImageGroupDisplayName, openChatForAsset, chatSessionsRef.current));
    }
  };

  const deleteSelectedNodes = useCallback(async () => {
    if (!selectedNodeIds.length) return;
    const selected = new Set(selectedNodeIds);
    const selectedImageNodes = nodes.filter((node) => selected.has(node.id) && node.data.kind === 'imageGroup') as Node<ImageGroupNodeData>[];
    const message = selectedImageNodes.length
      ? `Delete ${selectedNodeIds.length} selected node(s) and move image files to the system Trash?`
      : `Delete ${selectedNodeIds.length} selected draft node(s)?`;
    if (!window.confirm(message)) return;
    try {
      await Promise.all(selectedImageNodes.flatMap((node) => node.data.assetIds.map((assetId) => api.deleteAsset(openProjectSlug, assetId))));
    } catch (err) {
      console.error('[photo-web] failed to delete selected image assets', err);
      setError(String(err));
    }
    const nextNodes = nodes.filter((node) => !selected.has(node.id));
    setNodes(nextNodes);
    setSelectedNodeIds([]);
    setSelectedIds([]);
    if (popoverNodeId && selected.has(popoverNodeId)) setPopoverNodeId(null);
    await persistNodes(nextNodes);
    await loadProject(openProjectSlug);
  }, [loadProject, nodes, openProjectSlug, persistNodes, popoverNodeId, selectedNodeIds]);

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

  const createDraftAt = async (
    refs: string[],
    position: { x: number; y: number },
    options: { prompt?: string; params?: GenerationParams; displayName?: string } = {},
  ) => {
    const nodeId = `draft_${Date.now()}`;
    const node: Node<PhotoNodeData> = {
      id: nodeId,
      position,
      type: 'draft',
      data: {
        kind: 'draft',
        nodeId,
        type: 'draft',
        displayName: '',
        x: position.x,
        y: position.y,
        tags: [],
        refs: Array.from(new Set(refs)),
        prompt: options.prompt ?? '',
        params: options.params ?? defaultDraftParams,
        onDetails: openDetails,
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

  const createSiblingDraft = async (group: ImageGroupNodeData, sourceAsset: Asset) => {
    const refs = sourceAsset.generation?.refs ?? [];
    const params = sourceAsset.generation
      ? {
          model: sourceAsset.generation.model,
          aspectRatio: sourceAsset.generation.aspectRatio,
          imageSize: sourceAsset.generation.imageSize,
          seed: null,
          batchCount: 1,
        }
      : defaultDraftParams;
    const sourceNode = nodes.find((node) => node.id === group.nodeId);
    const position = sourceNode
      ? { x: sourceNode.position.x + 220, y: sourceNode.position.y }
      : { x: 180, y: 160 };
    await createDraftAt(refs, position, { prompt: sourceAsset.prompt?.text ?? '', params });
  };

  const createChildDraftFromAsset = async (sourceNodeId: string, sourceAssetId: string) => {
    const sourceNode = nodes.find((node) => node.id === sourceNodeId);
    const sourceAsset = assets.find((asset) => asset.id === sourceAssetId);
    const position = sourceNode
      ? { x: sourceNode.position.x + 260, y: sourceNode.position.y }
      : { x: 180, y: 160 };
    await createDraftAt([sourceAssetId], position, {
      displayName: sourceAsset ? `${assetLabel(sourceAsset)} child` : 'Child draft',
    });
  };

  const generateDraft = async (id: string, draft: DraftNodeData) => {
    try {
      setError(null);
      setGeneratingNodeIds((current) => new Set(current).add(id));
      setNodes((current) => current.map((node) => (node.id === id ? { ...node, data: { ...node.data, isGenerating: true } } : node)));
      const payload: GeneratePayload = {
        prompt: draft.prompt,
        refs: draft.refs,
        model: draft.params.model,
        aspectRatio: draft.params.aspectRatio,
        imageSize: draft.params.imageSize,
        seed: draft.params.seed,
        batchCount: draft.params.batchCount,
        title: visibleDisplayName(draft.displayName) || null,
        tags: [],
        canvasNodeId: id,
      };
      await api.generate(openProjectSlug, payload);
      setPopoverNodeId(null);
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setGeneratingNodeIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setNodes((current) => current.map((node) => (node.id === id ? { ...node, data: { ...node.data, isGenerating: false } } : node)));
    }
  };

  const generateImageVariants = async (id: string, group: ImageGroupNodeData, params: GenerationParams) => {
    const sourceAsset = group.activeAsset ?? group.assets[0] ?? null;
    const prompt = sourceAsset?.prompt?.text ?? '';
    const refs = sourceAsset?.generation?.refs ?? [];
    if (!prompt || !sourceAsset?.generation) return;
    try {
      setError(null);
      setGeneratingNodeIds((current) => new Set(current).add(id));
      setNodes((current) => current.map((node) => (node.id === id ? { ...node, data: { ...node.data, isGenerating: true } } : node)));
      const payload: GeneratePayload = {
        prompt,
        refs,
        model: params.model,
        aspectRatio: params.aspectRatio,
        imageSize: params.imageSize,
        seed: params.seed,
        batchCount: params.batchCount,
        title: visibleDisplayName(group.displayName) || null,
        tags: [],
        canvasNodeId: id,
      };
      await api.generate(openProjectSlug, payload);
      await reload();
      setPopoverNodeId(id);
    } catch (err) {
      setError(String(err));
    } finally {
      setGeneratingNodeIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setNodes((current) => current.map((node) => (node.id === id ? { ...node, data: { ...node.data, isGenerating: false } } : node)));
    }
  };

  const currentProject = projects.find((project) => project.slug === openProjectSlug);

  const loadAdaptation = useCallback(async () => {
    if (!openProjectSlug) {
      setAdaptation(null);
      return;
    }
    try {
      setAdaptation(await api.getAdaptation(openProjectSlug));
    } catch (err) {
      setError(String(err));
    }
  }, [openProjectSlug]);

  useEffect(() => {
    void loadAdaptation();
  }, [loadAdaptation, assets]);

  const loadAdaptationWorkflow = useCallback(async () => {
    if (!openProjectSlug) {
      setAdaptationWorkflow(null);
      return;
    }
    try {
      setAdaptationWorkflow(await api.getAdaptationWorkflow(openProjectSlug));
    } catch (err) {
      setError(String(err));
    }
  }, [openProjectSlug]);

  const loadAdaptationValidation = useCallback(async () => {
    if (!openProjectSlug) {
      setAdaptationValidation(null);
      return;
    }
    try {
      setAdaptationValidation(await api.getAdaptationValidation(openProjectSlug));
    } catch (err) {
      setError(String(err));
    }
  }, [openProjectSlug]);

  useEffect(() => {
    void loadAdaptationWorkflow();
  }, [loadAdaptationWorkflow]);

  useEffect(() => {
    void loadAdaptationValidation();
  }, [loadAdaptationValidation]);

  useEffect(() => {
    if (!openProjectSlug || !adaptationWorkflow?.running) return;
    const timer = window.setInterval(async () => {
      const next = await api.getAdaptationWorkflow(openProjectSlug);
      setAdaptationWorkflow(next);
      if (!next.running) {
        await reload();
        await loadAdaptation();
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [adaptationWorkflow?.running, loadAdaptation, openProjectSlug]);

  useEffect(() => {
    if (!openProjectSlug || !adaptationValidation?.running) return;
    const timer = window.setInterval(async () => {
      setAdaptationValidation(await api.getAdaptationValidation(openProjectSlug));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [adaptationValidation?.running, openProjectSlug]);

  const saveAdaptationStyle = async (visualStyle: string) => {
    if (!openProjectSlug) return;
    setAdaptation(await api.saveAdaptationStyle(openProjectSlug, visualStyle));
  };

  const importAdaptationBook = async (file: File) => {
    if (!openProjectSlug) return;
    setAdaptation(await api.importAdaptationBook(openProjectSlug, file));
  };

  const setAdaptationStyleRefAsset = async (kind: 'archetype-character' | 'archetype-scene', assetId: string) => {
    if (!openProjectSlug) return;
    setAdaptation(await api.setAdaptationStyleRefAsset(openProjectSlug, kind, assetId));
    await reload();
  };

  const startAdaptationWorkflow = async () => {
    if (!openProjectSlug) return;
    setError(null);
    setIsWorkflowLogExpanded(true);
    setAdaptationWorkflow(await api.startAdaptationWorkflow(openProjectSlug));
  };

  const startAdaptationValidation = async () => {
    if (!openProjectSlug) return;
    setError(null);
    setIsValidationLogExpanded(true);
    setAdaptationValidation(await api.startAdaptationValidation(openProjectSlug));
  };

  const importAdaptationDraftsToCanvas = async () => {
    if (!openProjectSlug) return;
    setError(null);
    const result = await api.importAdaptationDraftsToCanvas(openProjectSlug);
    setCanvas(result.canvas);
    await loadProject(openProjectSlug);
    setProjectView('canvas');
  };

  const generateStoryArtifact = async (id: string, artifact: StoryArtifactNodeData) => {
    if (!openProjectSlug) return;
    setGeneratingNodeIds((current) => new Set(current).add(id));
    setNodes((current) => current.map((node) => (node.id === id ? { ...node, data: { ...node.data, isGenerating: true } } : node)));
    try {
      setError(null);
      const result = await api.generateAdaptationArtifact(openProjectSlug, artifact.artifactKind, artifact.artifactKey, id);
      if (result.status) setAdaptation(result.status);
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setGeneratingNodeIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setNodes((current) => current.map((node) => (node.id === id ? { ...node, data: { ...node.data, isGenerating: false } } : node)));
    }
  };

  if (!openProjectSlug) {
    return (
      <ProjectLanding
        projects={projects}
        error={error}
        onOpen={openProject}
        onDelete={async (slug) => {
          await api.deleteProject(slug);
          await loadProjects();
        }}
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
        className={`canvas ${projectView === 'adaptation' ? 'story-adaptation-view' : ''} ${isDraggingFile ? 'dragging-file' : ''}`}
        onDragOver={(event) => {
          if (projectView !== 'canvas') return;
          event.preventDefault();
          setIsDraggingFile(true);
        }}
        onDragLeave={(event) => {
          if (projectView !== 'canvas') return;
          if (event.currentTarget === event.target) setIsDraggingFile(false);
        }}
        onDrop={async (event) => {
          if (projectView !== 'canvas') return;
          event.preventDefault();
          setIsDraggingFile(false);
          await importFiles(event.dataTransfer.files, flowPositionFromClientPoint({ x: event.clientX, y: event.clientY }));
        }}
        onContextMenu={(event) => {
          if (projectView !== 'canvas') return;
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
            if (event.target.files) await importFiles(event.target.files, pendingImportPositionRef.current);
            pendingImportPositionRef.current = undefined;
            event.currentTarget.value = '';
          }}
        />
        <div className="toolbar">
          <div className="toolbar-left">
            <button className="project-back-button" onClick={closeProject} title="Back to projects">
              {currentProject?.name ?? openProjectSlug}
            </button>
            <div className="view-switcher" role="tablist" aria-label="Project view">
              <button className={projectView === 'canvas' ? 'active' : ''} onClick={() => setProjectView('canvas')}>Canvas</button>
              <button className={projectView === 'adaptation' ? 'active' : ''} onClick={() => setProjectView('adaptation')}>Story Adaptation</button>
            </div>
            {projectView === 'canvas' && (
              <label className="toolbar-toggle">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(event) => setShowArchived(event.target.checked)}
                />
                Show archived
              </label>
            )}
            {error && <span className="error">{error}</span>}
          </div>
          {projectView === 'canvas' && (
            <div className="tag-filter-bar">
              <button className={activeTagFilters.length === 0 ? 'active' : ''} onClick={() => setActiveTagFilters([])}>All</button>
              {['archetype', 'character-sheet', 'location', 'generated-image'].map((tag) => (
                <button
                  key={tag}
                  className={activeTagFilters.includes(tag) ? 'active' : ''}
                  onClick={() => setActiveTagFilters((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])}
                >
                  {tag}
                </button>
              ))}
              {availableTagFilters.filter((tag) => !['archetype', 'character-sheet', 'location', 'generated-image'].includes(tag)).slice(0, 6).map((tag) => (
                <button
                  key={tag}
                  className={activeTagFilters.includes(tag) ? 'active' : ''}
                  onClick={() => setActiveTagFilters((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>
        {projectView === 'adaptation' && adaptation && (
          <StoryAdaptationScreen
            adaptation={adaptation}
            workflow={adaptationWorkflow}
            validation={adaptationValidation}
            isWorkflowLogExpanded={isWorkflowLogExpanded}
            isValidationLogExpanded={isValidationLogExpanded}
            onSaveStyle={saveAdaptationStyle}
            onImportBook={importAdaptationBook}
            onStartWorkflow={startAdaptationWorkflow}
            onStartValidation={startAdaptationValidation}
            onImportDraftsToCanvas={importAdaptationDraftsToCanvas}
            onToggleWorkflowLog={() => setIsWorkflowLogExpanded((current) => !current)}
            onToggleValidationLog={() => setIsValidationLogExpanded((current) => !current)}
          />
        )}
        {projectView === 'canvas' && (
          <>
            <ReactFlow
              nodeTypes={nodeTypes}
              nodes={filteredNodes}
              edges={edges}
              edgesFocusable={false}
              edgesUpdatable={false}
              selectNodesOnDrag={false}
              elementsSelectable
              minZoom={minZoom}
              maxZoom={maxZoom}
              onMove={(_, viewport) => setZoomPercent(zoomToPercent(viewport.zoom))}
              onNodesChange={onNodesChange}
              onNodeDragStop={saveLayout}
              onInit={(instance) => {
                reactFlowRef.current = instance;
              }}
              onConnectStart={(_, params) => {
                const sourceNode = nodes.find((node) => node.id === params.nodeId);
                const sourceAssetId = sourceNode?.data.kind === 'imageGroup'
                  ? sourceNode.data.activeAsset?.id ?? null
                  : sourceNode?.data.kind === 'storyArtifact'
                    ? sourceNode.data.generatedAssetId ?? null
                    : null;
                setPendingConnectionSource(sourceAssetId);
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
                const sourceAssetId = sourceNode?.data.kind === 'imageGroup'
                  ? sourceNode.data.activeAsset?.id
                  : sourceNode?.data.kind === 'storyArtifact'
                    ? sourceNode.data.generatedAssetId
                    : null;
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
              onNodeClick={(_, node) => {
                setActiveChatSessionId(null);
                setPopoverNodeId(node.id);
              }}
              onPaneClick={() => setPopoverNodeId(null)}
              onSelectionChange={({ nodes: selected }) => {
                setSelectedNodeIds(selected.map((node) => node.id));
                setSelectedIds(selected.flatMap((node) => (node.data.kind === 'imageGroup' && node.data.activeAsset ? [node.data.activeAsset.id] : [])));
              }}
              proOptions={{ hideAttribution: true }}
              fitView
            >
              <Controls showZoom={false} showInteractive={false} />
              <Panel position="bottom-left" className="zoom-panel">
                Zoom {zoomPercent}%
              </Panel>
            </ReactFlow>
            {isDraggingFile && <div className="drop-overlay">Drop photos to import</div>}
          </>
        )}
        {contextMenu && projectView === 'canvas' && (
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
            <button onClick={openImportPicker}>Import</button>
            <button onClick={createLooseDraft}>Generate</button>
          </div>
        )}
      </main>
      {projectView === 'canvas' && selectedNode && (
        <NodeSidebar
          node={selectedNode}
          assets={assets}
          projectSlug={openProjectSlug}
          onDraftChange={updateDraft}
          onImageGroupChange={updateImageGroup}
          onGenerate={generateDraft}
          onGenerateArtifact={generateStoryArtifact}
          onGenerateVariants={generateImageVariants}
          onSetStyleRefAsset={setAdaptationStyleRefAsset}
          onVariant={changeVariant}
          onCreateSibling={createSiblingDraft}
          onCreateChildDraft={createChildDraftFromAsset}
          onDelete={deleteNodeById}
          onRefineChat={openChatForAsset}
        />
      )}
      {projectView === 'canvas' && activeChatSession && (
        <ChatRefinementPanel
          session={activeChatSession}
          assets={assets}
          projectSlug={openProjectSlug}
          onClose={() => setActiveChatSessionId(null)}
          onSend={sendChatMessage}
          onArchive={archiveChatSession}
          onViewAsset={openAssetInViewer}
        />
      )}
      {projectView === 'canvas' && (viewerNodeId || viewerAssetId) && (
        <ImageViewer
          node={nodes.find((node) => node.id === viewerNodeId && node.data.kind === 'imageGroup') as Node<ImageGroupNodeData> | undefined}
          fallbackAsset={assets.find((asset) => asset.id === viewerAssetId)}
          assets={assets}
          projectSlug={openProjectSlug}
          onClose={() => {
            setViewerNodeId(null);
            setViewerAssetId(null);
          }}
          onVariant={changeVariant}
          onViewAsset={openAssetInViewer}
          onDetails={openViewerDetails}
          onDelete={deleteNodeById}
        />
      )}
      {projectView === 'canvas' && pendingDelete && (
        <div className="confirm-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <h2>Confirm delete</h2>
            <p>
              {nodes.find((node) => node.id === pendingDelete.nodeId)?.data.kind === 'imageGroup'
                ? 'Delete this variant and move its files to the system Trash?'
                : 'Delete this draft?'}
            </p>
            <div className="row">
              <button
                className="danger"
                onClick={() => {
                  performDeleteNodeById(pendingDelete.nodeId, pendingDelete.assetId);
                  setPendingDelete(null);
                }}
              >
                Delete
              </button>
              <button className="secondary" onClick={() => setPendingDelete(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectLanding({
  projects,
  error,
  onOpen,
  onDelete,
  onCreated,
}: {
  projects: Project[];
  error: string | null;
  onOpen: (slug: string) => void;
  onDelete: (slug: string) => Promise<void>;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState('');
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [pendingProjectDelete, setPendingProjectDelete] = useState<Project | null>(null);
  const create = async () => {
    const nextSlug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!nextSlug) return;
    await api.createProject(nextSlug, name, {});
    setName('');
    onCreated(nextSlug);
  };
  return (
    <div className="landing">
      <div className="landing-card">
        <h1>photo-web</h1>
        {error && <p className="error">{error}</p>}
        <section>
          <h2>Open project</h2>
          {projects.length === 0 && <p className="muted">No projects yet.</p>}
          <div className="project-list">
            {projects.map((project) => (
              <div key={project.slug} className="project-card">
                <button className="project-open-button" onClick={() => onOpen(project.slug)}>
                  <strong>{project.name}</strong>
                </button>
                <button
                  className="danger project-delete-button"
                  disabled={deletingSlug === project.slug}
                  onClick={() => setPendingProjectDelete(project)}
                >
                  {deletingSlug === project.slug ? 'Deleting...' : 'Delete'}
                </button>
              </div>
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
        {pendingProjectDelete && (
          <div className="confirm-backdrop" onClick={() => setPendingProjectDelete(null)}>
            <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
              <h2>Delete project?</h2>
              <p>
                Move <strong>{pendingProjectDelete.name}</strong> to the system Trash? This removes its canvas,
                assets, and adaptation files from photo-web.
              </p>
              <div className="row">
                <button
                  className="danger"
                  disabled={deletingSlug === pendingProjectDelete.slug}
                  onClick={async () => {
                    setDeletingSlug(pendingProjectDelete.slug);
                    try {
                      await onDelete(pendingProjectDelete.slug);
                      setPendingProjectDelete(null);
                    } finally {
                      setDeletingSlug(null);
                    }
                  }}
                >
                  {deletingSlug === pendingProjectDelete.slug ? 'Deleting...' : 'Delete project'}
                </button>
                <button className="secondary" disabled={Boolean(deletingSlug)} onClick={() => setPendingProjectDelete(null)}>Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StoryAdaptationScreen({
  adaptation,
  workflow,
  validation,
  isWorkflowLogExpanded,
  isValidationLogExpanded,
  onSaveStyle,
  onImportBook,
  onStartWorkflow,
  onStartValidation,
  onImportDraftsToCanvas,
  onToggleWorkflowLog,
  onToggleValidationLog,
}: {
  adaptation: AdaptationStatus;
  workflow: AdaptationWorkflowStatus | null;
  validation: AdaptationWorkflowStatus | null;
  isWorkflowLogExpanded: boolean;
  isValidationLogExpanded: boolean;
  onSaveStyle: (visualStyle: string) => Promise<void>;
  onImportBook: (file: File) => Promise<void>;
  onStartWorkflow: () => Promise<void>;
  onStartValidation: () => Promise<void>;
  onImportDraftsToCanvas: () => Promise<void>;
  onToggleWorkflowLog: () => void;
  onToggleValidationLog: () => void;
}) {
  const [visualStyle, setVisualStyle] = useState(adaptation.visualStyle);
  const [isSavingStyle, setIsSavingStyle] = useState(false);
  const [isImportingDrafts, setIsImportingDrafts] = useState(false);
  useEffect(() => {
    setVisualStyle(adaptation.visualStyle);
  }, [adaptation.visualStyle]);
  const save = async () => {
    setIsSavingStyle(true);
    try {
      await onSaveStyle(visualStyle);
    } finally {
      setIsSavingStyle(false);
    }
  };
  const importDrafts = async () => {
    setIsImportingDrafts(true);
    try {
      await onImportDraftsToCanvas();
    } finally {
      setIsImportingDrafts(false);
    }
  };
  const validationFailed = validation?.returnCode !== null && validation?.returnCode !== undefined && validation.returnCode !== 0;
  const validationStatus = validation?.running
    ? 'Validation running'
    : validation?.returnCode === 0
      ? 'Validation passed'
      : validationFailed
        ? 'Validation failed'
        : 'Validation not run yet';
  const workflowStatus = workflow?.running
    ? 'Workflow running'
    : workflow?.returnCode === 0
      ? 'Workflow complete'
      : workflow?.returnCode
        ? `Workflow exited ${workflow.returnCode}`
        : 'Workflow not run yet';
  const hasArtifacts = (adaptation.counts.characterSheets ?? 0) > 0 || (adaptation.counts.locationPrompts ?? 0) > 0;
  return (
    <div className="story-adaptation-screen">
      <div className="story-adaptation-header">
        <div>
          <h1>Story Adaptation</h1>
          <p className="muted">Import a book, extract visual planning artifacts, validate them, then publish draft nodes to the canvas.</p>
        </div>
        <div className="adaptation-status-stack">
          <span className={`adaptation-status ${workflow?.returnCode === 0 ? 'generated' : ''}`}>{workflowStatus}</span>
          <span className={`adaptation-status ${validation?.returnCode === 0 ? 'generated' : validationFailed ? 'failed' : ''}`}>{validationStatus}</span>
        </div>
      </div>
      {validationFailed && (
        <div className="validation-warning">
          Validation found issues in the adaptation artifacts. You can continue, but review the log before importing drafts to the canvas.
        </div>
      )}
      <div className="story-adaptation-grid">
        <section className="book-upload-section">
          <h2>Book Source</h2>
          <p className="muted">
            {adaptation.hasBook ? 'book.txt is present in this project.' : 'Upload a plain text book file to start the adaptation workflow.'}
          </p>
          <label className="generate-button file-button book-upload-button">
            {adaptation.hasBook ? 'Replace book.txt' : 'Upload book.txt'}
            <input type="file" accept=".txt,text/plain" hidden onChange={(event) => event.target.files?.[0] && void onImportBook(event.target.files[0])} />
          </label>
        </section>
        <section className="story-card">
          <h2>Artifact Status</h2>
          <div className="adaptation-checklist">
            <span className={adaptation.hasBook ? 'ok' : ''}>Book text</span>
            <span className={adaptation.hasBookSession ? 'ok' : ''}>Book session</span>
            <span className={adaptation.styleRefs.visualStyle ? 'ok' : ''}>Visual style</span>
            <span className={adaptation.styleRefs.archetypeCharacterPrompt ? 'ok' : ''}>Character archetype draft</span>
            <span className={adaptation.styleRefs.archetypeScenePrompt ? 'ok' : ''}>Scene archetype draft</span>
            <span>{adaptation.counts.characterArtifacts ?? 0} artifacts</span>
            <span>{adaptation.counts.characterSheets ?? 0} sheets</span>
            <span>{adaptation.counts.locationPrompts ?? 0} location prompts</span>
          </div>
        </section>
        <section className="story-card visual-style-card">
          <h2>Visual Style</h2>
          <textarea value={visualStyle} onChange={(event) => setVisualStyle(event.target.value)} />
          <button className="secondary" onClick={save} disabled={isSavingStyle}>
            {isSavingStyle ? 'Saving...' : 'Save style'}
          </button>
        </section>
        <section className="workflow-run-section">
          <h2>Run Workflow</h2>
          <p className="muted">Run Pi extraction to read the book, create character artifacts, character sheet prompts, scene manifest, location index, and location prompts.</p>
          <button className="generate-button workflow-run-button" onClick={onStartWorkflow} disabled={!adaptation.hasBook || workflow?.running}>
            {workflow?.running && <span className="spinner" aria-hidden="true" />}
            {workflow?.running ? 'Running adaptation...' : 'Run adaptation workflow'}
          </button>
        </section>
        <section className="story-card">
          <h2>Validate Artifacts</h2>
          <p className="muted">Validation checks the extracted adaptation files and reports missing or malformed pieces without blocking the canvas workflow.</p>
          <button className="secondary" onClick={onStartValidation} disabled={validation?.running}>
            {validation?.running ? 'Validating...' : validation?.startedAt ? 'Run validation again' : 'Run validation'}
          </button>
        </section>
        <section className="story-card import-drafts-card">
          <h2>Publish Drafts</h2>
          <p className="muted">Create or update canvas nodes for archetype drafts, character sheets, and location prompts.</p>
          <button className="generate-button" onClick={importDrafts} disabled={!hasArtifacts || isImportingDrafts}>
            {isImportingDrafts ? 'Importing drafts...' : 'Import drafts to canvas'}
          </button>
        </section>
      </div>
      {workflow && (workflow.log || workflow.running || workflow.returnCode !== null) && (
        <div className="story-log-card">
          <WorkflowLogPanel
            title="Workflow Output"
            workflow={workflow}
            isExpanded={isWorkflowLogExpanded}
            onToggle={onToggleWorkflowLog}
          />
        </div>
      )}
      {validation && (validation.log || validation.running || validation.returnCode !== null) && (
        <div className="story-log-card">
          <WorkflowLogPanel
            title="Validation Output"
            workflow={validation}
            isExpanded={isValidationLogExpanded}
            onToggle={onToggleValidationLog}
          />
        </div>
      )}
    </div>
  );
}

function WorkflowLogPanel({
  title = 'Adaptation Output',
  workflow,
  isExpanded,
  onToggle,
}: {
  title?: string;
  workflow: AdaptationWorkflowStatus;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const element = logRef.current;
    if (!element || !isExpanded) return;
    element.scrollTop = element.scrollHeight;
  }, [workflow.log, isExpanded]);
  const statusText = workflow.running ? 'running' : workflow.returnCode === 0 ? 'complete' : workflow.returnCode === null ? 'idle' : `exited ${workflow.returnCode}`;
  return (
    <div className={`workflow-log-panel ${isExpanded ? 'expanded' : 'collapsed'}`}>
      <button className="workflow-log-toggle" onClick={onToggle}>
        <strong>{title}</strong>
        <span>{statusText}</span>
        <span>{isExpanded ? 'Collapse' : 'Expand'}</span>
      </button>
      {isExpanded && (
        <pre ref={logRef} className="workflow-log-output" role="log" aria-live="polite">
          {workflow.log || 'Waiting for output...'}
        </pre>
      )}
    </div>
  );
}

function WorkflowLogDrawer(props: {
  title?: string;
  workflow: AdaptationWorkflowStatus;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`workflow-log-drawer ${props.isExpanded ? 'expanded' : 'collapsed'}`}>
      <WorkflowLogPanel {...props} />
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
  onGenerateArtifact,
  onGenerateVariants,
  onSetStyleRefAsset,
  onVariant,
  onCreateSibling,
  onCreateChildDraft,
  onDelete,
  onRefineChat,
}: {
  node: Node<PhotoNodeData>;
  assets: Asset[];
  projectSlug: string;
  onDraftChange: (id: string, patch: Partial<DraftCanvasNode>) => void;
  onImageGroupChange: (id: string, patch: Partial<ImageGroupCanvasNode>) => void;
  onGenerate: (id: string, draft: DraftNodeData) => void;
  onGenerateArtifact: (id: string, artifact: StoryArtifactNodeData) => void;
  onGenerateVariants: (id: string, group: ImageGroupNodeData, params: GenerationParams) => void;
  onSetStyleRefAsset: (kind: 'archetype-character' | 'archetype-scene', assetId: string) => void;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
  onCreateSibling: (group: ImageGroupNodeData, sourceAsset: Asset) => void;
  onCreateChildDraft: (nodeId: string, sourceAssetId: string) => void;
  onDelete: (id: string, assetId?: string) => void;
  onRefineChat: (nodeId: string, assetId: string) => void;
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

  if (node.data.kind === 'storyArtifact') {
    const artifactNode: Node<StoryArtifactNodeData> = { ...node, data: node.data };
    return (
      <StoryArtifactSidebar
        node={artifactNode}
        projectSlug={projectSlug}
        onGenerate={onGenerateArtifact}
        onDelete={onDelete}
        onCreateChildDraft={onCreateChildDraft}
        onRefineChat={onRefineChat}
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
  return (
    <ImageSidebar
      node={imageNode}
      asset={node.data.activeAsset}
      assets={assets}
      onDelete={onDelete}
      onNodeChange={onImageGroupChange}
      onVariant={onVariant}
      onCreateSibling={onCreateSibling}
      onGenerateVariants={onGenerateVariants}
      onSetStyleRefAsset={onSetStyleRefAsset}
      onRefineChat={onRefineChat}
    />
  );
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
  onDelete: (id: string, assetId?: string) => void;
}) {
  const draft = node.data;
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [isParentPickerOpen, setIsParentPickerOpen] = useState(false);
  const parents = draft.refs.map((ref) => assets.find((asset) => asset.id === ref) ?? null);
  const availableParents = assets.filter((asset) => !draft.refs.includes(asset.id));
  const draftModel = draft.params.model ?? defaultDraftParams.model;
  const draftCapabilities = capabilitiesForModel(draftModel);
  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft.prompt]);
  return (
    <aside className="details-sidebar">
      <div className="popover-header">
        <h2>{visibleDisplayName(draft.displayName) || 'Draft'}</h2>
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
                <span>{visibleDisplayName(draft.parentDisplayNames?.get(draft.refs[index]) ?? '') || assetLabel(parent, 'Unknown parent')}</span>
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
                <span>{visibleDisplayName(draft.parentDisplayNames?.get(asset.id) ?? '') || assetLabel(asset)}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="sidebar-section">
        <label className="field-label">
          Prompt
          <textarea
            ref={promptRef}
            className="prompt-textarea"
            autoFocus
            value={draft.prompt}
            onChange={(event) => onDraftChange(node.id, { prompt: event.target.value })}
            placeholder="Prompt"
          />
        </label>
      </section>
      <section className="sidebar-section generation-section">
        <h3>Parameters</h3>
      <div className="row">
        <select
          value={draftModel ?? ''}
          onChange={(event) => onDraftChange(node.id, { params: normalizedParamsForModel(draft.params, event.target.value) })}
        >
          {Object.keys(modelCapabilities).map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
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
          {draftCapabilities.aspectRatios.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <select value={draft.params.imageSize ?? '1K'} onChange={(event) => onDraftChange(node.id, { params: { ...draft.params, imageSize: event.target.value } })}>
          {draftCapabilities.imageSizes.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>
      <div className="generate-control">
        <button className="generate-button" onClick={() => onGenerate(node.id, draft)} disabled={!draft.prompt.trim() || draft.isGenerating}>
          {draft.isGenerating && <span className="spinner" aria-hidden="true" />}
          {draft.isGenerating ? 'Generating...' : 'Generate'}
        </button>
        <label>
          Batch size
          <input
            type="number"
            min={1}
            max={8}
            value={draft.params.batchCount}
            onChange={(event) => onDraftChange(node.id, { params: { ...draft.params, batchCount: Number(event.target.value) } })}
          />
        </label>
      </div>
      </section>
    </aside>
  );
}

function artifactKindLabel(kind: ArtifactKind) {
  return kind === 'character-sheet' ? 'Character Sheet' : 'Location Prompt';
}

function StoryArtifactSidebar({
  node,
  projectSlug,
  onGenerate,
  onDelete,
  onCreateChildDraft,
  onRefineChat,
}: {
  node: Node<StoryArtifactNodeData>;
  projectSlug: string;
  onGenerate: (id: string, artifact: StoryArtifactNodeData) => void;
  onDelete: (id: string, assetId?: string) => void;
  onCreateChildDraft: (nodeId: string, sourceAssetId: string) => void;
  onRefineChat: (nodeId: string, assetId: string) => void;
}) {
  const artifact = node.data;
  const generated = artifact.generatedAsset;
  return (
    <aside className="details-sidebar story-artifact-sidebar">
      <div className="popover-header">
        <div>
          <h2>{artifact.displayName || artifact.artifactKey}</h2>
          <p className="muted">{artifactKindLabel(artifact.artifactKind)}</p>
        </div>
        <button className="danger" onClick={() => onDelete(node.id)}>Delete</button>
      </div>
      <section className="sidebar-section">
        <h3>Source</h3>
        <code className="path-code">{artifact.promptPath}</code>
      </section>
      {generated && (
        <section className="sidebar-section">
          <h3>Generated Image</h3>
          <button className="story-artifact-sidebar-preview" onClick={() => artifact.onViewAsset(generated.id)}>
            <img src={generated.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${generated.id}/thumb`} alt="" />
            <span className="sidebar-preview-eye story-preview-eye" aria-hidden="true">👁️</span>
            <span>{assetLabel(generated)}</span>
          </button>
          <button className="generate-button" onClick={() => onRefineChat(node.id, generated.id)}>Refine in chat</button>
          <button className="secondary" onClick={() => onCreateChildDraft(node.id, generated.id)}>Create child draft</button>
        </section>
      )}
      <section className="sidebar-section">
        <h3>Prompt</h3>
        <textarea className="prompt-textarea prompt-preview locked-field" value={artifact.prompt} readOnly />
      </section>
      <section className="sidebar-section generation-section">
        <h3>Parameters</h3>
        <div className="row">
          <input value={artifact.params.model ?? defaultDraftParams.model ?? ''} readOnly />
          <input value={artifact.params.aspectRatio ?? defaultDraftParams.aspectRatio ?? ''} readOnly />
          <input value={artifact.params.imageSize ?? defaultDraftParams.imageSize ?? ''} readOnly />
        </div>
        <button className="generate-button" onClick={() => onGenerate(node.id, artifact)} disabled={!artifact.prompt.trim() || artifact.isGenerating}>
          {artifact.isGenerating && <span className="spinner" aria-hidden="true" />}
          {artifact.isGenerating ? 'Generating...' : generated ? 'Regenerate artifact' : 'Generate artifact'}
        </button>
      </section>
    </aside>
  );
}

function ImageSidebar({
  node,
  asset,
  assets,
  onDelete,
  onNodeChange,
  onVariant,
  onCreateSibling,
  onGenerateVariants,
  onSetStyleRefAsset,
  onRefineChat,
}: {
  node: Node<ImageGroupNodeData>;
  asset: Asset;
  assets: Asset[];
  onDelete: (id: string, assetId?: string) => void;
  onNodeChange: (id: string, patch: Partial<ImageGroupCanvasNode>) => void;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
  onCreateSibling: (group: ImageGroupNodeData, sourceAsset: Asset) => void;
  onGenerateVariants: (id: string, group: ImageGroupNodeData, params: GenerationParams) => void;
  onSetStyleRefAsset: (kind: 'archetype-character' | 'archetype-scene', assetId: string) => void;
  onRefineChat: (nodeId: string, assetId: string) => void;
}) {
  const [isVariantPanelOpen, setIsVariantPanelOpen] = useState(false);
  const [variantParams, setVariantParams] = useState(defaultDraftParams);
  const prompt = asset.prompt?.text ?? '';
  const refs = asset.generation?.refs ?? [];
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const activeVariantIndex = Math.max(0, node.data.assetIds.indexOf(asset.id));
  const activeModel = isVariantPanelOpen ? variantParams.model ?? asset.generation?.model : asset.generation?.model;
  const activeCapabilities = capabilitiesForModel(activeModel);
  const modelOptions = uniqueOptions(Object.keys(modelCapabilities), asset.generation?.model);
  const aspectRatioOptions = isVariantPanelOpen ? activeCapabilities.aspectRatios : uniqueOptions(activeCapabilities.aspectRatios, asset.generation?.aspectRatio);
  const imageSizeOptions = isVariantPanelOpen ? activeCapabilities.imageSizes : uniqueOptions(activeCapabilities.imageSizes, asset.generation?.imageSize);
  const changeSidebarVariantByClickSide = (event: React.MouseEvent<HTMLDivElement>) => {
    if (node.data.assetIds.length < 2) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const direction = event.clientX < rect.left + rect.width / 2 ? -1 : 1;
    onVariant(node.id, direction);
  };
  useEffect(() => {
    setVariantParams({
      model: asset.generation?.model ?? defaultDraftParams.model,
      aspectRatio: asset.generation?.aspectRatio ?? defaultDraftParams.aspectRatio,
      imageSize: asset.generation?.imageSize ?? defaultDraftParams.imageSize,
      seed: null,
      batchCount: 1,
    });
  }, [asset]);
  return (
    <aside className="details-sidebar">
      <button className="danger" onClick={() => onDelete(node.id, asset.id)}>Delete</button>
      <label className="field-label">
        Group name
        <input value={node.data.displayName} onChange={(event) => onNodeChange(node.id, { displayName: event.target.value })} />
      </label>
      <div className="sidebar-variant-preview" onClick={changeSidebarVariantByClickSide}>
        {asset.thumbnailUrl && <img src={asset.thumbnailUrl} alt="" />}
        <span>{activeVariantIndex + 1} / {node.data.assetIds.length}</span>
        <button
          className="sidebar-preview-eye"
          onClick={(event) => {
            event.stopPropagation();
            node.data.onView(node.id);
          }}
          title="View full image"
        >
          👁️
        </button>
        {node.data.assetIds.length > 1 && (
          <>
            <button
              className="sidebar-variant-nav previous"
              onClick={(event) => {
                event.stopPropagation();
                onVariant(node.id, -1);
              }}
              title="Previous variant"
            >
              &lt;
            </button>
            <button
              className="sidebar-variant-nav next"
              onClick={(event) => {
                event.stopPropagation();
                onVariant(node.id, 1);
              }}
              title="Next variant"
            >
              &gt;
            </button>
          </>
        )}
      </div>
      <section className="sidebar-section canonical-reference-section">
        <h3>Canonical Reference</h3>
        <button className="secondary" onClick={() => onSetStyleRefAsset('archetype-character', asset.id)}>Set as character archetype</button>
        <button className="secondary" onClick={() => onSetStyleRefAsset('archetype-scene', asset.id)}>Set as scene archetype</button>
      </section>
      {asset.generation && (
        <section className="sidebar-section parent-section">
          <h3>Parents</h3>
          {refs.length === 0 && <p className="muted">None</p>}
          {refs.length > 0 && (
            <div className="parent-list">
              {refs.map((ref) => (
                <div className="parent-item" key={ref}>
                  {assetById.get(ref)?.thumbnailUrl ? <img src={assetById.get(ref)?.thumbnailUrl ?? ''} alt="" /> : <div className="parent-thumb-placeholder" />}
                  <span>{assetLabel(assetById.get(ref), 'Parent image')}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {prompt && (
        <section className="sidebar-section">
          <label className="field-label">
            Prompt
            <textarea className="prompt-textarea locked-field prompt-preview" value={prompt} readOnly />
          </label>
          <button className="generate-button" onClick={() => onRefineChat(node.id, asset.id)}>Refine in chat</button>
          <button className="secondary" onClick={() => onCreateSibling(node.data, asset)}>Create sibling</button>
        </section>
      )}
      {asset.generation && (
        <section className="sidebar-section generation-section">
          <h3>Parameters</h3>
          <label className="field-label">
            Model
            <select
              value={isVariantPanelOpen ? variantParams.model ?? asset.generation.model : asset.generation.model}
              disabled={!isVariantPanelOpen}
              onChange={(event) => setVariantParams((current) => normalizedParamsForModel(current, event.target.value))}
            >
              {modelOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <div className="row">
            <label className="field-label">
              Aspect Ratio
              <select
                value={isVariantPanelOpen ? variantParams.aspectRatio ?? asset.generation.aspectRatio : asset.generation.aspectRatio}
                disabled={!isVariantPanelOpen}
                onChange={(event) => setVariantParams((current) => ({ ...current, aspectRatio: event.target.value }))}
              >
                {aspectRatioOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <label className="field-label">
              Image Size
              <select
                value={isVariantPanelOpen ? variantParams.imageSize ?? asset.generation.imageSize : asset.generation.imageSize}
                disabled={!isVariantPanelOpen}
                onChange={(event) => setVariantParams((current) => ({ ...current, imageSize: event.target.value }))}
              >
                {imageSizeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field-label">
              Seed
              <input
                value={isVariantPanelOpen ? variantParams.seed ?? '' : asset.generation.seed ?? 'auto'}
                readOnly={!isVariantPanelOpen}
                onChange={(event) =>
                  setVariantParams((current) => ({ ...current, seed: event.target.value ? Number(event.target.value) : null }))
                }
                placeholder="Seed optional"
              />
            </label>
          </div>
          {isVariantPanelOpen ? (
            <div className="generate-control">
              <button className="generate-button" onClick={() => onGenerateVariants(node.id, node.data, variantParams)} disabled={!prompt.trim() || node.data.isGenerating}>
                {node.data.isGenerating && <span className="spinner" aria-hidden="true" />}
                {node.data.isGenerating ? 'Generating...' : 'Generate variants'}
              </button>
              <button className="secondary" onClick={() => setIsVariantPanelOpen(false)}>Cancel</button>
              <label>
                Batch size
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={variantParams.batchCount}
                  onChange={(event) => setVariantParams((current) => ({ ...current, batchCount: Number(event.target.value) }))}
                />
              </label>
            </div>
          ) : (
            <button className="secondary" onClick={() => setIsVariantPanelOpen(true)} disabled={node.data.isGenerating}>Create variants</button>
          )}
        </section>
      )}
    </aside>
  );
}

function ChatRefinementPanel({
  session,
  assets,
  projectSlug,
  onClose,
  onSend,
  onArchive,
  onViewAsset,
}: {
  session: ChatSession;
  assets: Asset[];
  projectSlug: string;
  onClose: () => void;
  onSend: (session: ChatSession, text: string, settings: ChatTurnSettings, attachmentAssetIds: string[]) => Promise<void>;
  onArchive: (session: ChatSession) => void;
  onViewAsset: (assetId: string) => void;
}) {
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const [text, setText] = useState('');
  const [settings, setSettings] = useState<ChatTurnSettings>(session.defaults);
  const [attachmentAssetIds, setAttachmentAssetIds] = useState<string[]>([]);
  const [isReferencePickerOpen, setIsReferencePickerOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const capabilities = capabilitiesForModel(settings.model);
  const availableReferences = assets.filter((asset) => asset.id !== session.source.assetId && !attachmentAssetIds.includes(asset.id) && !asset.archivedAt);
  useEffect(() => {
    setSettings(session.defaults);
    setAttachmentAssetIds([]);
    setText('');
    setSendError(null);
    setIsSending(false);
  }, [session.id]);
  const send = async () => {
    if (!text.trim() || isSending) return;
    setIsSending(true);
    setSendError(null);
    try {
      await onSend(session, text.trim(), settings, attachmentAssetIds);
      setText('');
      setAttachmentAssetIds([]);
      setIsReferencePickerOpen(false);
    } catch (err) {
      setSendError(String(err));
    } finally {
      setIsSending(false);
    }
  };
  return (
    <aside className="details-sidebar chat-refinement-panel">
      <div className="popover-header">
        <div>
          <h2>{session.title}</h2>
          <p className="muted">Image refinement chat</p>
        </div>
        <button className="secondary" onClick={onClose}>Close</button>
      </div>
      <section className="sidebar-section">
        <h3>Source</h3>
        {assetById.get(session.source.assetId) && (
          <button className="asset-picker-row" onClick={() => onViewAsset(session.source.assetId)}>
            <img src={assetById.get(session.source.assetId)?.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${session.source.assetId}/thumb`} alt="" />
            <span>{assetLabel(assetById.get(session.source.assetId))}</span>
          </button>
        )}
      </section>
      <section className="sidebar-section chat-message-list">
        <h3>History</h3>
        {session.turns.length === 0 && <p className="muted">No turns yet. Send an instruction to create the first refinement.</p>}
        {session.turns.map((turn) => (
          <div key={turn.id} className={`chat-turn ${turn.role}`}>
            <strong>{turn.role === 'user' ? 'You' : 'Gemini'}</strong>
            {turn.text && <p>{turn.text}</p>}
            {turn.attachments.length > 0 && (
              <div className="chat-thumb-row">
                {turn.attachments.map((attachment) => {
                  const asset = assetById.get(attachment.assetId);
                  return asset ? (
                    <button key={attachment.assetId} className="chat-thumb" onClick={() => onViewAsset(asset.id)} title={assetLabel(asset)}>
                      <img src={asset.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${asset.id}/thumb`} alt="" />
                    </button>
                  ) : null;
                })}
              </div>
            )}
            {turn.generatedAssetIds.length > 0 && (
              <div className="chat-thumb-row">
                {turn.generatedAssetIds.map((assetId) => {
                  const asset = assetById.get(assetId);
                  return asset ? (
                    <button key={assetId} className="chat-thumb generated" onClick={() => onViewAsset(assetId)} title={assetLabel(asset)}>
                      <img src={asset.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${assetId}/thumb`} alt="" />
                    </button>
                  ) : null;
                })}
              </div>
            )}
          </div>
        ))}
      </section>
      <section className="sidebar-section generation-section">
        <h3>Turn settings</h3>
        <select value={settings.model} disabled={isSending} onChange={(event) => setSettings((current) => ({ ...normalizedParamsForModel({ ...defaultDraftParams, ...current, batchCount: 1, seed: null }, event.target.value), thinkingLevel: current.thinkingLevel, includeThoughts: false } as ChatTurnSettings))}>
          {Object.keys(modelCapabilities).map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <div className="row">
          <select value={settings.aspectRatio} disabled={isSending} onChange={(event) => setSettings((current) => ({ ...current, aspectRatio: event.target.value }))}>
            {capabilities.aspectRatios.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          <select value={settings.imageSize} disabled={isSending} onChange={(event) => setSettings((current) => ({ ...current, imageSize: event.target.value }))}>
            {capabilities.imageSizes.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
        <label className="field-label">
          Thinking
          <select value={settings.thinkingLevel ?? ''} disabled={isSending} onChange={(event) => setSettings((current) => ({ ...current, thinkingLevel: event.target.value || null }))}>
            <option value="">Default</option>
            <option value="minimal">Minimal</option>
            <option value="high">High</option>
          </select>
        </label>
      </section>
      <section className="sidebar-section">
        <h3>References for next turn</h3>
        {attachmentAssetIds.length === 0 && <p className="muted">Only the source image will be attached.</p>}
        <div className="parent-list">
          {attachmentAssetIds.map((assetId) => {
            const asset = assetById.get(assetId);
            return asset ? (
              <div className="parent-item" key={assetId}>
                <img src={asset.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${assetId}/thumb`} alt="" />
                <span>{assetLabel(asset)}</span>
                <button className="parent-remove" disabled={isSending} onClick={() => setAttachmentAssetIds((current) => current.filter((id) => id !== assetId))}>×</button>
              </div>
            ) : null;
          })}
        </div>
        <button className="add-parent-button" disabled={isSending} onClick={() => setIsReferencePickerOpen((current) => !current)}>+</button>
        {isReferencePickerOpen && (
          <div className="asset-picker-popover">
            {availableReferences.map((asset) => (
              <button
                className="asset-picker-row"
                key={asset.id}
                disabled={isSending}
                onClick={() => {
                  setAttachmentAssetIds((current) => [...current, asset.id]);
                  setIsReferencePickerOpen(false);
                }}
              >
                {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" /> : <div className="parent-thumb-placeholder" />}
                <span>{assetLabel(asset)}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="sidebar-section">
        <textarea className="prompt-textarea" value={text} disabled={isSending} onChange={(event) => setText(event.target.value)} placeholder="Describe the refinement..." />
        {isSending && (
          <div className="chat-generation-status" role="status">
            <span className="spinner" aria-hidden="true" />
            Generating refinement...
          </div>
        )}
        {sendError && <div className="inline-error">Refinement failed: {sendError}</div>}
        <button className="generate-button" onClick={send} disabled={!text.trim() || isSending}>
          {isSending && <span className="spinner" aria-hidden="true" />}
          {isSending ? 'Generating...' : 'Send refinement'}
        </button>
        <button className="secondary" disabled={isSending} onClick={() => onArchive(session)}>Archive chat</button>
      </section>
    </aside>
  );
}

function ImageGroupNode({ data }: NodeProps<ImageGroupNodeData>) {
  const asset = data.activeAsset;
  const [isEditingName, setIsEditingName] = useState(false);
  const [draftName, setDraftName] = useState(visibleDisplayName(data.displayName));
  const [imageRatio, setImageRatio] = useState<number | null>(null);
  useEffect(() => {
    if (!isEditingName) setDraftName(visibleDisplayName(data.displayName));
  }, [data.displayName, isEditingName]);
  useEffect(() => {
    setImageRatio(null);
  }, [asset?.id]);
  const saveName = () => {
    data.onDisplayNameChange(data.nodeId, draftName.trim());
    setIsEditingName(false);
  };
  if (!asset) {
    return (
      <div className="node">
        <Handle type="target" position={Position.Left} className="input-handle" isConnectable={false} />
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
    <div className={`node image-group-node ${data.assetIds.length > 1 ? 'stacked' : ''} ${data.isGenerating ? 'generating' : ''}`} title={tooltip}>
      <Handle type="target" position={Position.Left} className="input-handle" isConnectable={false} />
      {isEditingName ? (
        <input
          className="node-title-input"
          value={draftName}
          autoFocus
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={saveName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') saveName();
            if (event.key === 'Escape') {
              setDraftName(visibleDisplayName(data.displayName));
              setIsEditingName(false);
            }
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      ) : (
        <strong className={`node-title ${visibleDisplayName(data.displayName) ? '' : 'placeholder'}`} onDoubleClick={() => setIsEditingName(true)}>
          {visibleDisplayName(data.displayName) || 'title'}
        </strong>
      )}
      <div className="node-image-frame" style={{ aspectRatio: imageRatio ? `${imageRatio}` : undefined }}>
        {asset.thumbnailUrl && (
          <img
            src={asset.thumbnailUrl}
            alt=""
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (naturalWidth > 0 && naturalHeight > 0) setImageRatio(naturalWidth / naturalHeight);
            }}
          />
        )}
        {data.assetIds.length > 1 && <small className="variant-indicator">{currentIndex + 1} / {data.assetIds.length}</small>}
        {data.assetIds.length > 1 && (
          <div className="variant-controls">
            <button
              className="nodrag nopan"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                data.onVariant(data.nodeId, -1);
              }}
              title="Previous variant"
            >
              &lt;
            </button>
            <button
              className="nodrag nopan"
              onPointerDown={(event) => event.stopPropagation()}
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
        <button
          className="node-action-button view-image-button nodrag nopan"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            data.onView(data.nodeId);
          }}
          title="View full image"
        >
          👁️
        </button>
        <button
          className="node-action-button chat-button nodrag nopan"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            data.onRefineChat(data.nodeId, asset.id);
          }}
          title="Refine in chat"
        >
          C
        </button>
        {data.hasRefinements && (
          <button
            className="node-action-button refinements-button nodrag nopan"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              data.onRefineChat(data.nodeId, asset.id);
            }}
            title="Open refinements"
          >
            R
          </button>
        )}
        {data.isGenerating && (
          <div className="node-generating-overlay">
            <span className="spinner" aria-hidden="true" />
            <span>Generating</span>
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="output-handle" />
    </div>
  );
}

function ImageViewer({
  node,
  fallbackAsset,
  assets,
  projectSlug,
  onClose,
  onVariant,
  onViewAsset,
  onDetails,
  onDelete,
}: {
  node?: Node<ImageGroupNodeData>;
  fallbackAsset?: Asset;
  assets: Asset[];
  projectSlug: string;
  onClose: () => void;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
  onViewAsset: (assetId: string) => void;
  onDetails: (nodeId: string) => void;
  onDelete: (nodeId: string, assetId?: string) => void;
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

  const asset = node?.data.activeAsset ?? fallbackAsset;
  if (!asset) return null;
  const currentIndex = node ? Math.max(0, node.data.assetIds.indexOf(asset.id)) : 0;
  const imageUrl = `/api/projects/${projectSlug}/assets/${asset.id}/image`;
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const parentAssets = (asset.generation?.refs ?? []).map((ref) => assetById.get(ref)).filter((asset): asset is Asset => Boolean(asset));
  const childAssets = assets.filter((candidate) => candidate.generation?.refs.includes(asset.id));
  const viewerClassName = [
    'image-viewer',
    parentAssets.length > 0 ? 'has-parents' : '',
    childAssets.length > 0 ? 'has-children' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const changeByClickSide = (event: React.MouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
    if (!node) return;
    if (node.data.assetIds.length < 2) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const direction = event.clientX < rect.left + rect.width / 2 ? -1 : 1;
    onVariant(node.id, direction);
  };
  return (
    <div className={viewerClassName} onClick={onClose}>
      <div className="image-viewer-toolbar" onClick={(event) => event.stopPropagation()}>
        <div className="image-viewer-toolbar-main">
          <button
            className="danger"
            disabled={!node}
            onClick={(event) => {
              event.stopPropagation();
              if (node) onDelete(node.id, asset.id);
            }}
          >
            Delete Variant
          </button>
          <strong>{node?.data.displayName ?? assetLabel(asset)}</strong>
          <div className="image-viewer-toolbar-actions">
            {node && <span>{currentIndex + 1} / {node.data.assetIds.length}</span>}
            {node && (
              <button className="image-viewer-info-button secondary" onClick={() => onDetails(node.id)} title="Show details">
                i
              </button>
            )}
            <button className="secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
      {parentAssets.length > 0 && (
        <div className="image-viewer-parents-rail" onClick={(event) => event.stopPropagation()} aria-label="Parent images">
          <span>Parents</span>
          {parentAssets.map((parent) => (
            <button
              key={parent.id}
              className="image-viewer-thumb-button"
              onClick={() => onViewAsset(parent.id)}
              title={assetLabel(parent)}
            >
              <img src={parent.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${parent.id}/thumb`} alt={assetLabel(parent)} />
            </button>
          ))}
        </div>
      )}
      {node && node.data.assetIds.length > 1 && (
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
      <img className="image-viewer-main-image" src={imageUrl} alt={node?.data.displayName ?? assetLabel(asset)} onClick={changeByClickSide} />
      {node && node.data.assetIds.length > 1 && (
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
      {childAssets.length > 0 && (
        <div className="image-viewer-children-rail" onClick={(event) => event.stopPropagation()} aria-label="Child images">
          <span>Children</span>
          {childAssets.map((child) => (
            <button
              key={child.id}
              className="image-viewer-thumb-button"
              onClick={() => onViewAsset(child.id)}
              title={assetLabel(child)}
            >
              <img src={child.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${child.id}/thumb`} alt={assetLabel(child)} />
            </button>
          ))}
        </div>
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
    <div className={`node draft-node ${data.tags.includes('archetype') ? 'archetype-draft-node' : ''} ${data.isGenerating ? 'generating' : ''}`} title={tooltip}>
      <Handle type="target" position={Position.Left} className="input-handle" isConnectable={false} />
      <div className="draft-placeholder" aria-hidden="true">
        {data.isGenerating && (
          <div className="node-generating-overlay">
            <span className="spinner" aria-hidden="true" />
            <span>Generating</span>
          </div>
        )}
      </div>
      <strong>Draft</strong>
      <small>{data.refs.length} parent{data.refs.length === 1 ? '' : 's'}</small>
    </div>
  );
}

function StoryArtifactNode({ data }: NodeProps<StoryArtifactNodeData>) {
  const generatedAssetId = data.generatedAssetId;
  const tooltip = [
    data.prompt || 'Story artifact prompt not set',
    `source: ${data.promptPath}`,
    `artifact: ${data.artifactKind}`,
    generatedAssetId ? `generated: ${generatedAssetId}` : 'not generated',
  ].join('\n');
  return (
    <div className={`node story-artifact-node ${data.artifactKind === 'location-prompt' ? 'location-artifact-node' : 'character-artifact-node'} ${data.generatedAssetId ? 'generated' : ''} ${data.isGenerating ? 'generating' : ''}`} title={tooltip}>
      <Handle type="target" position={Position.Left} className="input-handle" isConnectable={false} />
      <div className="story-artifact-icon" aria-hidden="true">
        {data.generatedAsset?.thumbnailUrl ? (
          <img src={data.generatedAsset.thumbnailUrl} alt="" />
        ) : data.isGenerating ? (
          <div className="node-generating-overlay">
            <span className="spinner" aria-hidden="true" />
            <span>Generating</span>
          </div>
        ) : (
          <span>{data.artifactKind === 'character-sheet' ? 'CS' : 'LP'}</span>
        )}
      </div>
      {generatedAssetId && (
        <button
          className="node-action-button view-image-button nodrag nopan"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            data.onViewAsset(generatedAssetId);
          }}
          title="View full image"
        >
          👁️
        </button>
      )}
      <span className="story-artifact-badge">{artifactKindLabel(data.artifactKind)}</span>
      <strong>{data.displayName || data.artifactKey}</strong>
      <small>{data.generatedAssetId ? 'generated' : 'ready'}</small>
      {data.generatedAssetId && <Handle type="source" position={Position.Right} className="output-handle" />}
    </div>
  );
}

const nodeTypes = {
  imageGroup: ImageGroupNode,
  storyArtifact: StoryArtifactNode,
  draft: DraftNode,
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
