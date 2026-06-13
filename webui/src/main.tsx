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
import { isCanonicalStyleRefAsset, isStyleRefImageNode, styleRefDraftNodeId, styleRefImageNodeId, styleRefKindForNode, styleRefKindForTags, styleRefStatusFromAdaptation } from './styleRefs';
import type { AdaptationAssetLink, AdaptationFileKind, AdaptationFilePayload, AdaptationStage, AdaptationStatus, AdaptationWorkflowStatus, ArtifactKind, Asset, CanvasDocument, ChatSession, ChatTurnSettings, DraftCanvasNode, GeneratePayload, GenerationParams, ImageGroupCanvasNode, Project, StoryArtifactCanvasNode, StoryKind, StyleRefKind, StyleRefStatus } from './types';

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

type ProjectPhase =
  | 'phase-0-ingestion'
  | 'phase-1-characters'
  | 'phase-2-locations'
  | 'phase-3-scenes'
  | 'phase-4-moments'
  | 'phase-5-moment-canvas';

const projectPhases: Array<{ id: ProjectPhase; number: string; title: string; shortTitle: string; description: string }> = [
  { id: 'phase-0-ingestion', number: '0', title: 'Ingest', shortTitle: 'Ingest', description: 'Book & style' },
  { id: 'phase-1-characters', number: '1', title: 'Characters', shortTitle: 'Cast', description: 'Cast & sheets' },
  { id: 'phase-2-locations', number: '2', title: 'Locations', shortTitle: 'Places', description: 'Places & refs' },
  { id: 'phase-3-scenes', number: '3', title: 'Scenes', shortTitle: 'Scenes', description: 'Acts' },
  { id: 'phase-4-moments', number: '4', title: 'Moments', shortTitle: 'Moments', description: 'Beats' },
  { id: 'phase-5-moment-canvas', number: '5', title: 'Images', shortTitle: 'Images', description: 'Panels' },
];

const phaseDefaultTags: Record<ProjectPhase, string[]> = {
  'phase-0-ingestion': [],
  'phase-1-characters': ['character-sheet', 'character-style'],
  'phase-2-locations': ['location', 'scene-style'],
  'phase-3-scenes': [],
  'phase-4-moments': [],
  'phase-5-moment-canvas': ['page', 'panel'],
};

function phaseHasCanvas(phase: ProjectPhase) {
  return phase === 'phase-1-characters' || phase === 'phase-2-locations' || phase === 'phase-5-moment-canvas';
}

function phaseHasList(phase: ProjectPhase) {
  return phase !== 'phase-5-moment-canvas';
}

function phaseStage(phase: ProjectPhase): AdaptationStage | null {
  switch (phase) {
    case 'phase-0-ingestion':
      return 'ingest';
    case 'phase-1-characters':
      return 'characters';
    case 'phase-2-locations':
      return 'locations';
    case 'phase-3-scenes':
      return 'scenes';
    case 'phase-4-moments':
      return 'moments';
    default:
      return null;
  }
}

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
              generatedAssetIds: node.data.generatedAssetIds ?? [],
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
        data: { ...canvasNode, generatedAssetIds: canvasNode.generatedAssetIds ?? [], kind: 'storyArtifact', nodeId: id, generatedAsset, isGenerating: generatingNodeIds.has(id), onDetails, onViewAsset, onRefineChat, onCreateChildDraft: () => undefined },
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
  const [hasManualTagFilters, setHasManualTagFilters] = useState(false);
  const [isTagFilterMenuOpen, setIsTagFilterMenuOpen] = useState(false);
  const [projectPhase, setProjectPhase] = useState<ProjectPhase>('phase-0-ingestion');
  const [phaseViewMode, setPhaseViewMode] = useState<'list' | 'canvas'>('list');
  const autoPublishingArchetypesRef = useRef(false);
  const [isPhaseSidebarCollapsed, setIsPhaseSidebarCollapsed] = useState(false);
  const [generatingNodeIds, setGeneratingNodeIds] = useState<Set<string>>(new Set());
  const [adaptation, setAdaptation] = useState<AdaptationStatus | null>(null);
  const [adaptationWorkflow, setAdaptationWorkflow] = useState<AdaptationWorkflowStatus | null>(null);
  const [adaptationValidation, setAdaptationValidation] = useState<AdaptationWorkflowStatus | null>(null);
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
  const effectiveTagFilters = useMemo(() => {
    if (hasManualTagFilters) return activeTagFilters;
    return phaseDefaultTags[projectPhase].filter((tag) => availableTagFilters.includes(tag));
  }, [activeTagFilters, availableTagFilters, hasManualTagFilters, projectPhase]);
  const filteredNodes = useMemo(() => {
    if (effectiveTagFilters.length === 0) return nodes;
    const required = new Set(effectiveTagFilters);
    return nodes.filter((node) => node.data.tags.some((tag) => required.has(tag)));
  }, [effectiveTagFilters, nodes]);

  const edges: Edge[] = useMemo(() => {
    const visibleNodeIds = new Set(filteredNodes.map((node) => node.id));
    const nodeForAsset = new Map<string, Node<ImageGroupNodeData> | Node<StoryArtifactNodeData>>();
    filteredNodes.forEach((node) => {
      if (node.data.kind === 'imageGroup') {
        const imageNode: Node<ImageGroupNodeData> = { ...node, data: node.data };
        node.data.assetIds.forEach((assetId) => nodeForAsset.set(assetId, imageNode));
      }
      if (node.data.kind === 'storyArtifact' && node.data.generatedAssetId) {
        const artifactNode: Node<StoryArtifactNodeData> = { ...node, data: node.data };
        nodeForAsset.set(node.data.generatedAssetId, artifactNode);
      }
    });
    const edgeForAssetRef = (childNode: Node<ImageGroupNodeData> | Node<DraftNodeData> | Node<StoryArtifactNodeData>, childAssetId: string | null, ref: string): Edge | null => {
      const sourceNode = nodeForAsset.get(ref);
      if (!sourceNode || sourceNode.id === childNode.id) return null;
      const sourceVisible = sourceNode.data.kind === 'imageGroup'
        ? sourceNode.data.activeAsset?.id === ref
        : sourceNode.data.generatedAssetId === ref;
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
    return [...assetEdges, ...draftEdges, ...artifactRefEdges];
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
    setProjectPhase('phase-0-ingestion');
    setHasManualTagFilters(false);
    setActiveTagFilters([]);
    setSelectedIds([]);
    setSelectedNodeIds([]);
    setError(null);
  };

  const closeProject = () => {
    setOpenProjectSlug('');
    setProjectPhase('phase-0-ingestion');
    setHasManualTagFilters(false);
    setActiveTagFilters([]);
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
      const styleRefKind = styleRefKindForTags(draft.tags);
      const generatingId = styleRefKind ? styleRefImageNodeId(styleRefKind, adaptation) : id;
      setGeneratingNodeIds((current) => new Set(current).add(generatingId));
      setNodes((current) => current.map((node) => (node.id === generatingId || node.id === id ? { ...node, data: { ...node.data, isGenerating: true } } : node)));
      if (styleRefKind) {
        const result = await api.generateAdaptationStyleRef(openProjectSlug, styleRefKind, generatingId);
        if (result.status) setAdaptation(result.status);
      } else {
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
      }
      setPopoverNodeId(null);
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      const styleRefKind = styleRefKindForTags(draft.tags);
      const generatingId = styleRefKind ? styleRefImageNodeId(styleRefKind, adaptation) : id;
      setGeneratingNodeIds((current) => {
        const next = new Set(current);
        next.delete(id);
        next.delete(generatingId);
        return next;
      });
      setNodes((current) => current.map((node) => (node.id === id || node.id === generatingId ? { ...node, data: { ...node.data, isGenerating: false } } : node)));
    }
  };

  const generateImageVariants = async (id: string, group: ImageGroupNodeData, params: GenerationParams) => {
    if (styleRefKindForTags(group.tags)) {
      setError('Generate style reference replacements from the adaptation style reference action.');
      return;
    }
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
    const stage = phaseStage(projectPhase);
    setAdaptationWorkflow(null);
    if (!openProjectSlug || !stage) {
      return;
    }
    try {
      setAdaptationWorkflow(await api.getAdaptationWorkflow(openProjectSlug, stage));
    } catch (err) {
      setError(String(err));
    }
  }, [openProjectSlug, projectPhase]);

  const loadAdaptationValidation = useCallback(async () => {
    const stage = phaseStage(projectPhase);
    if (!openProjectSlug) {
      setAdaptationValidation(null);
      return;
    }
    try {
      setAdaptationValidation(stage ? await api.getAdaptationValidation(openProjectSlug, stage) : null);
    } catch (err) {
      setError(String(err));
    }
  }, [openProjectSlug, projectPhase]);

  useEffect(() => {
    void loadAdaptationWorkflow();
  }, [loadAdaptationWorkflow]);

  useEffect(() => {
    void loadAdaptationValidation();
  }, [loadAdaptationValidation]);

  useEffect(() => {
    const stage = phaseStage(projectPhase);
    if (!openProjectSlug || !stage || !adaptationWorkflow?.running) return;
    const timer = window.setInterval(async () => {
      const next = await api.getAdaptationWorkflow(openProjectSlug, stage);
      setAdaptationWorkflow(next);
      if (!next.running) {
        await reload();
        await loadAdaptation();
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [adaptationWorkflow?.running, loadAdaptation, openProjectSlug, projectPhase]);

  useEffect(() => {
    const stage = phaseStage(projectPhase);
    if (!openProjectSlug || !stage || !adaptationValidation?.running) return;
    const timer = window.setInterval(async () => {
      setAdaptationValidation(await api.getAdaptationValidation(openProjectSlug, stage));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [adaptationValidation?.running, openProjectSlug, projectPhase]);

  const ensureAdaptationDraftsPublished = useCallback(async () => {
    if (!openProjectSlug) return;
    await api.importAdaptationDraftsToCanvas(openProjectSlug);
    await loadProject(openProjectSlug);
  }, [openProjectSlug, loadProject]);

  useEffect(() => {
    if (projectPhase !== 'phase-1-characters' || !adaptation) return;
    if (!(adaptation.styleRefs.archetypeCharacterPrompt || adaptation.styleRefs.archetypeScenePrompt)) return;
    const hasArchetypeNodes = Object.values(canvas.nodes).some((node) => node.tags.includes('character-style') || node.tags.includes('scene-style'));
    if (hasArchetypeNodes || autoPublishingArchetypesRef.current) return;
    autoPublishingArchetypesRef.current = true;
    ensureAdaptationDraftsPublished()
      .catch((err) => setError(String(err)))
      .finally(() => {
        autoPublishingArchetypesRef.current = false;
      });
  }, [projectPhase, adaptation, canvas, ensureAdaptationDraftsPublished]);

  const saveAdaptationStyle = async (visualStyle: string) => {
    if (!openProjectSlug) return;
    setAdaptation(await api.saveAdaptationStyle(openProjectSlug, visualStyle));
  };

  const saveAdaptationSettings = async (storyKind: StoryKind) => {
    if (!openProjectSlug) return;
    setAdaptation(await api.saveAdaptationSettings(openProjectSlug, storyKind));
  };

  const importAdaptationBook = async (file: File) => {
    if (!openProjectSlug) return;
    setAdaptation(await api.importAdaptationBook(openProjectSlug, file));
  };

  const importAdaptationStyleRef = async (kind: StyleRefKind, file: File) => {
    if (!openProjectSlug) return;
    setAdaptation(await api.importAdaptationStyleRef(openProjectSlug, kind, file));
    await reload();
  };

  const saveAdaptationStyleRefPrompt = async (kind: StyleRefKind, prompt: string) => {
    if (!openProjectSlug) return;
    setAdaptation(await api.saveAdaptationStyleRefPrompt(openProjectSlug, kind, prompt));
    await reload();
  };

  const setAdaptationStyleRefAsset = async (kind: StyleRefKind, assetId: string) => {
    if (!openProjectSlug) return;
    setAdaptation(await api.setAdaptationStyleRefAsset(openProjectSlug, kind, assetId));
    await reload();
  };

  const generateAdaptationStyleRef = async (kind: StyleRefKind) => {
    if (!openProjectSlug) return;
    setError(null);
    const draftNodeId = styleRefDraftNodeId(kind, adaptation);
    const imageNodeId = styleRefImageNodeId(kind, adaptation);
    setProjectPhase(kind === 'archetype-character' ? 'phase-1-characters' : 'phase-2-locations');
    setPhaseViewMode('canvas');
    setPopoverNodeId(imageNodeId);
    setGeneratingNodeIds((current) => new Set(current).add(imageNodeId));
    setNodes((current) => current.map((node) => (node.id === imageNodeId || node.id === draftNodeId ? { ...node, data: { ...node.data, isGenerating: true } } : node)));
    try {
      const result = await api.generateAdaptationStyleRef(openProjectSlug, kind, imageNodeId);
      if (result.status) setAdaptation(result.status);
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setGeneratingNodeIds((current) => {
        const next = new Set(current);
        next.delete(imageNodeId);
        return next;
      });
      setNodes((current) => current.map((node) => (node.id === imageNodeId || node.id === draftNodeId ? { ...node, data: { ...node.data, isGenerating: false } } : node)));
    }
  };

  const startAdaptationWorkflow = async (stage: AdaptationStage = 'all') => {
    if (!openProjectSlug) return;
    setError(null);
    setAdaptationWorkflow(await api.startAdaptationWorkflow(openProjectSlug, stage));
  };

  const startAdaptationValidation = async () => {
    const stage = phaseStage(projectPhase);
    if (!openProjectSlug) return;
    if (!stage) return;
    setError(null);
    setAdaptationValidation(await api.startAdaptationValidation(openProjectSlug, stage));
  };

  const importAdaptationDraftsToCanvas = async () => {
    if (!openProjectSlug) return;
    setError(null);
    const result = await api.importAdaptationDraftsToCanvas(openProjectSlug);
    setCanvas(result.canvas);
    await loadProject(openProjectSlug);
    if (projectPhase === 'phase-4-moments') {
      setProjectPhase('phase-5-moment-canvas');
      setPhaseViewMode('list');
    } else if (phaseHasCanvas(projectPhase)) {
      setPhaseViewMode('canvas');
    }
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

  const showViewToggle = phaseHasCanvas(projectPhase) && phaseHasList(projectPhase);
  const isCanvasActive = phaseHasCanvas(projectPhase) && (phaseHasList(projectPhase) ? phaseViewMode === 'canvas' : true);

  return (
    <div className="app">
      <ProjectPhaseSidebar
        project={currentProject}
        projectSlug={openProjectSlug}
        activePhase={projectPhase}
        adaptation={adaptation}
        error={error}
        isCollapsed={isPhaseSidebarCollapsed}
        onToggleCollapsed={() => setIsPhaseSidebarCollapsed((current) => !current)}
        onBack={closeProject}
        onPhaseChange={(phase) => {
          setProjectPhase(phase);
          setPhaseViewMode('list');
          setIsTagFilterMenuOpen(false);
          setPopoverNodeId(null);
          setActiveChatSessionId(null);
        }}
      />
      <main
        ref={canvasRef}
        className={`canvas ${!isCanvasActive ? 'story-adaptation-view' : ''} ${showViewToggle ? 'has-view-toggle' : ''} ${isDraggingFile ? 'dragging-file' : ''}`}
        onDragOver={(event) => {
          if (!isCanvasActive) return;
          event.preventDefault();
          setIsDraggingFile(true);
        }}
        onDragLeave={(event) => {
          if (!isCanvasActive) return;
          if (event.currentTarget === event.target) setIsDraggingFile(false);
        }}
        onDrop={async (event) => {
          if (!isCanvasActive) return;
          event.preventDefault();
          setIsDraggingFile(false);
          await importFiles(event.dataTransfer.files, flowPositionFromClientPoint({ x: event.clientX, y: event.clientY }));
        }}
        onContextMenu={(event) => {
          if (!isCanvasActive) return;
          event.preventDefault();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {showViewToggle && (
          <div className="phase-view-toggle" role="tablist" aria-label="Phase view">
            <button role="tab" aria-selected={phaseViewMode === 'list'} className={phaseViewMode === 'list' ? 'active' : ''} onClick={() => setPhaseViewMode('list')}>List</button>
            <button role="tab" aria-selected={phaseViewMode === 'canvas'} className={phaseViewMode === 'canvas' ? 'active' : ''} onClick={() => setPhaseViewMode('canvas')}>Canvas</button>
          </div>
        )}
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
        {!isCanvasActive && adaptation && (
          <StoryPhaseScreen
            phase={projectPhase}
            projectSlug={openProjectSlug}
            adaptation={adaptation}
            assets={assets}
            workflow={adaptationWorkflow}
            validation={adaptationValidation}
            onSaveStyle={saveAdaptationStyle}
            onSaveSettings={saveAdaptationSettings}
            onImportBook={importAdaptationBook}
            onImportStyleRef={importAdaptationStyleRef}
            onSaveStylePrompt={saveAdaptationStyleRefPrompt}
            onGenerateStyleRef={generateAdaptationStyleRef}
            onStartWorkflow={startAdaptationWorkflow}
            onStartValidation={startAdaptationValidation}
            onImportDraftsToCanvas={importAdaptationDraftsToCanvas}
            onReloadAdaptation={loadAdaptation}
          />
        )}
        {isCanvasActive && (
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
            <FloatingFilterMenu
              availableTagFilters={availableTagFilters}
              activeTagFilters={activeTagFilters}
              effectiveTagFilters={effectiveTagFilters}
              hasManualTagFilters={hasManualTagFilters}
              showArchived={showArchived}
              isOpen={isTagFilterMenuOpen}
              onToggleOpen={() => setIsTagFilterMenuOpen((current) => !current)}
              onShowArchivedChange={setShowArchived}
              onClear={() => {
                setHasManualTagFilters(true);
                setActiveTagFilters([]);
              }}
              onUsePhaseDefaults={() => {
                setHasManualTagFilters(false);
                setActiveTagFilters([]);
              }}
              onToggleTag={(tag) => {
                setHasManualTagFilters(true);
                setActiveTagFilters((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]);
              }}
            />
            {isDraggingFile && <div className="drop-overlay">Drop photos to import</div>}
          </>
        )}
        {contextMenu && isCanvasActive && (
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
            <button onClick={openImportPicker}>Import</button>
            <button onClick={createLooseDraft}>Generate</button>
          </div>
        )}
      </main>
      {isCanvasActive && selectedNode && (
        <NodeSidebar
          node={selectedNode}
          assets={assets}
          adaptation={adaptation}
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
      {isCanvasActive && activeChatSession && (
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
      {isCanvasActive && (viewerNodeId || viewerAssetId) && (
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
      {isCanvasActive && pendingDelete && (
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

function phaseStatus(adaptation: AdaptationStatus | null, phase: ProjectPhase) {
  if (!adaptation) return 'pending';
  const counts = adaptation.counts;
  if (phase === 'phase-0-ingestion') return adaptation.hasBookSession ? 'ready' : adaptation.hasBook ? 'active' : 'pending';
  if (phase === 'phase-1-characters') return (counts.characterSheets ?? 0) > 0 ? 'ready' : (counts.characterListLines ?? 0) > 0 || (counts.characterArtifacts ?? 0) > 0 ? 'active' : 'pending';
  if (phase === 'phase-2-locations') return (counts.locationPrompts ?? 0) > 0 ? 'ready' : 'pending';
  if (phase === 'phase-3-scenes') return (counts.sceneArtifacts ?? 0) > 0 ? 'ready' : (counts.sceneManifest ?? 0) > 0 ? 'active' : 'pending';
  if (phase === 'phase-4-moments') return (counts.panelPrompts ?? 0) > 0 || (counts.pagePlans ?? 0) > 0 ? 'ready' : 'pending';
  return (counts.panelPrompts ?? 0) > 0 || (counts.pagePlans ?? 0) > 0 ? 'active' : 'pending';
}

function ProjectPhaseSidebar({
  project,
  projectSlug,
  activePhase,
  adaptation,
  error,
  isCollapsed,
  onToggleCollapsed,
  onBack,
  onPhaseChange,
}: {
  project: Project | undefined;
  projectSlug: string;
  activePhase: ProjectPhase;
  adaptation: AdaptationStatus | null;
  error: string | null;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onBack: () => void;
  onPhaseChange: (phase: ProjectPhase) => void;
}) {
  if (isCollapsed) {
    return (
      <button
        className="phase-sidebar-expand"
        onClick={onToggleCollapsed}
        title="Expand sidebar"
        aria-label="Expand sidebar"
      >
        ›
      </button>
    );
  }
  return (
    <aside className="project-phase-sidebar">
      <div className="phase-sidebar-rail">
        <button
          className="phase-sidebar-collapse"
          onClick={onToggleCollapsed}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          ‹
        </button>
      </div>
      <button className="project-back-button" onClick={onBack} title="Back to projects">
        <span className="project-back-arrow" aria-hidden="true">←</span>
        <span>All projects</span>
      </button>
      <div className="phase-sidebar-project-title">
        <span>Project</span>
        <strong>{project?.name ?? projectSlug}</strong>
      </div>
      {error && <p className="error">{error}</p>}
      <nav className="phase-nav" aria-label="Project phases">
        {projectPhases.map((phase) => {
          const status = phaseStatus(adaptation, phase.id);
          const selected = activePhase === phase.id;
          return (
            <button
              key={phase.id}
              className={`phase-nav-item status-${status} ${selected ? 'is-selected' : ''}`}
              aria-current={selected ? 'page' : undefined}
              onClick={() => onPhaseChange(phase.id)}
              title={`${phase.number}. ${phase.title}: ${phase.description}`}
            >
              <span className="phase-number">{phase.number}</span>
              <strong>{phase.title}</strong>
              <small>{phase.description}</small>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function FloatingFilterMenu({
  availableTagFilters,
  activeTagFilters,
  effectiveTagFilters,
  hasManualTagFilters,
  showArchived,
  isOpen,
  onToggleOpen,
  onShowArchivedChange,
  onClear,
  onUsePhaseDefaults,
  onToggleTag,
}: {
  availableTagFilters: string[];
  activeTagFilters: string[];
  effectiveTagFilters: string[];
  hasManualTagFilters: boolean;
  showArchived: boolean;
  isOpen: boolean;
  onToggleOpen: () => void;
  onShowArchivedChange: (value: boolean) => void;
  onClear: () => void;
  onUsePhaseDefaults: () => void;
  onToggleTag: (tag: string) => void;
}) {
  const visibleTags = ['archetype', 'character-sheet', 'location', 'page', 'panel', 'generated-image', ...availableTagFilters.filter((tag) => !['archetype', 'character-sheet', 'location', 'page', 'panel', 'generated-image'].includes(tag))];
  return (
    <div className="floating-filter-menu">
      <button className={`secondary tag-filter-toggle ${effectiveTagFilters.length ? 'active' : ''}`} onClick={onToggleOpen}>
        Filters{effectiveTagFilters.length ? ` (${effectiveTagFilters.length})` : ''}
      </button>
      {isOpen && (
        <div className="floating-filter-popover">
          <label className="toolbar-toggle filter-popover-toggle">
            <input type="checkbox" checked={showArchived} onChange={(event) => onShowArchivedChange(event.target.checked)} />
            Show archived
          </label>
          <button className={!hasManualTagFilters ? 'active' : ''} onClick={onUsePhaseDefaults}>Phase defaults</button>
          <button className={hasManualTagFilters && activeTagFilters.length === 0 ? 'active' : ''} onClick={onClear}>All</button>
          {visibleTags.map((tag) => (
            <button key={tag} className={hasManualTagFilters && activeTagFilters.includes(tag) ? 'active' : ''} onClick={() => onToggleTag(tag)}>
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StoryPhaseScreen({
  phase,
  projectSlug,
  adaptation,
  assets,
  workflow,
  validation,
  onSaveStyle,
  onSaveSettings,
  onImportBook,
  onImportStyleRef,
  onSaveStylePrompt,
  onGenerateStyleRef,
  onStartWorkflow,
  onStartValidation,
  onImportDraftsToCanvas,
  onReloadAdaptation,
}: {
  phase: ProjectPhase;
  projectSlug: string;
  adaptation: AdaptationStatus;
  assets: Asset[];
  workflow: AdaptationWorkflowStatus | null;
  validation: AdaptationWorkflowStatus | null;
  onSaveStyle: (visualStyle: string) => Promise<void>;
  onSaveSettings: (storyKind: StoryKind) => Promise<void>;
  onImportBook: (file: File) => Promise<void>;
  onImportStyleRef: (kind: 'archetype-character' | 'archetype-scene', file: File) => Promise<void>;
  onSaveStylePrompt: (kind: 'archetype-character' | 'archetype-scene', prompt: string) => Promise<void>;
  onGenerateStyleRef: (kind: 'archetype-character' | 'archetype-scene') => Promise<void>;
  onStartWorkflow: (stage: AdaptationStage) => Promise<void>;
  onStartValidation: () => Promise<void>;
  onImportDraftsToCanvas: () => Promise<void>;
  onReloadAdaptation: () => Promise<void>;
}) {
  const [visualStyle, setVisualStyle] = useState(adaptation.visualStyle);
  const [isSavingStyle, setIsSavingStyle] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isImportingDrafts, setIsImportingDrafts] = useState(false);
  useEffect(() => {
    setVisualStyle(adaptation.visualStyle);
  }, [adaptation.visualStyle]);
  const save = async (value: string = visualStyle) => {
    setIsSavingStyle(true);
    try {
      await onSaveStyle(value);
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
  const saveStoryKind = async (storyKind: StoryKind) => {
    setIsSavingSettings(true);
    try {
      await onSaveSettings(storyKind);
    } finally {
      setIsSavingSettings(false);
    }
  };
  const validationFailed = validation?.returnCode !== null && validation?.returnCode !== undefined && validation.returnCode !== 0;
  return (
    <div className="story-adaptation-screen">
      {validationFailed && (
        <div className="validation-warning">
          Validation found issues in the adaptation artifacts. You can continue, but review the log before importing drafts to the canvas.
        </div>
      )}
      <div className={`story-adaptation-grid ${phase === 'phase-0-ingestion' ? 'is-ingest' : ''} ${phase === 'phase-1-characters' || phase === 'phase-2-locations' ? 'is-assets' : ''}`}>
        {phase === 'phase-0-ingestion' && (
          <PhaseIngestion
            projectSlug={projectSlug}
            adaptation={adaptation}
            workflow={workflow}
            onImportBook={onImportBook}
            onStartWorkflow={() => onStartWorkflow('ingest')}
            visualStyle={visualStyle}
            isSavingStyle={isSavingStyle}
            onVisualStyleChange={setVisualStyle}
            onSaveStyle={save}
          />
        )}
        {phase === 'phase-1-characters' && (
          <PhaseAssetType
            kind="characters"
            projectSlug={projectSlug}
            adaptation={adaptation}
            assets={assets}
            workflow={workflow}
            validation={validation}
            onImportStyleRef={onImportStyleRef}
            onSaveStylePrompt={onSaveStylePrompt}
            onGenerateStyleRef={onGenerateStyleRef}
            onStartWorkflow={() => onStartWorkflow('characters')}
            onStartValidation={onStartValidation}
            onImportDraftsToCanvas={importDrafts}
            isImportingDrafts={isImportingDrafts}
            onReloadAdaptation={onReloadAdaptation}
          />
        )}
        {phase === 'phase-2-locations' && (
          <PhaseAssetType
            kind="locations"
            projectSlug={projectSlug}
            adaptation={adaptation}
            assets={assets}
            workflow={workflow}
            validation={validation}
            onImportStyleRef={onImportStyleRef}
            onSaveStylePrompt={onSaveStylePrompt}
            onGenerateStyleRef={onGenerateStyleRef}
            onStartWorkflow={() => onStartWorkflow('locations')}
            onStartValidation={onStartValidation}
            onImportDraftsToCanvas={importDrafts}
            isImportingDrafts={isImportingDrafts}
            onReloadAdaptation={onReloadAdaptation}
          />
        )}
        {phase === 'phase-3-scenes' && (
          <PhaseScenes projectSlug={projectSlug} adaptation={adaptation} workflow={workflow} validation={validation} isSavingSettings={isSavingSettings} onSaveStoryKind={saveStoryKind} onStartWorkflow={() => onStartWorkflow('scenes')} onStartValidation={onStartValidation} onImportDraftsToCanvas={importDrafts} isImportingDrafts={isImportingDrafts} onReloadAdaptation={onReloadAdaptation} />
        )}
        {phase === 'phase-4-moments' && (
          <PhaseMoments adaptation={adaptation} workflow={workflow} validation={validation} onStartWorkflow={() => onStartWorkflow('moments')} onStartValidation={onStartValidation} onImportDraftsToCanvas={importDrafts} isImportingDrafts={isImportingDrafts} />
        )}
      </div>
      {workflow && (workflow.log || workflow.running || workflow.returnCode !== null) && (
        <div className="story-log-card story-log-card-fill">
          <WorkflowLogPanel
            title="Workflow Output"
            workflow={workflow}
          />
        </div>
      )}
      {validation && (validation.log || validation.running || validation.returnCode !== null) && (
        <div className="story-log-card">
          <WorkflowLogPanel
            title="Validation Output"
            workflow={validation}
          />
        </div>
      )}
    </div>
  );
}

function fileKindLabel(kind: AdaptationFileKind) {
  const labels: Record<AdaptationFileKind, string> = {
    characters: 'Characters',
    locations: 'Locations',
    scenes: 'Scenes',
  };
  return labels[kind];
}

function singularFileKindLabel(kind: AdaptationFileKind) {
  const labels: Record<AdaptationFileKind, string> = {
    characters: 'character',
    locations: 'location',
    scenes: 'scene',
  };
  return labels[kind];
}

function slugifyFileKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'new-item';
}

function filesFromLinks(kind: AdaptationFileKind, links: Record<string, AdaptationAssetLink>) {
  return Object.entries(links)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, link]) => ({
      key,
      body: link.prompt,
      mode: link.mode,
      styleRef: link.styleRef,
      status: link.status,
      promptPath: link.promptPath,
      artifactKind: link.artifactKind,
      canonicalAssetId: link.canonicalAssetId ?? null,
      kind,
    }));
}

function emptyFileDraft(kind: AdaptationFileKind, existingKeys: string[]): AdaptationFilePayload {
  const base = `new-${singularFileKindLabel(kind)}`;
  let index = existingKeys.length + 1;
  let key = `${base}-${index}`;
  while (existingKeys.includes(key)) {
    index += 1;
    key = `${base}-${index}`;
  }
  return {
    key,
    body: kind === 'scenes' ? `# ${key}\n\nScene summary:\n` : '',
    mode: kind === 'scenes' ? '' : 'new-image',
    styleRef: '',
  };
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div className="editor-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="editor-dialog-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AdaptationFileEditor({
  projectSlug,
  kind,
  links,
  onReloadAdaptation,
}: {
  projectSlug: string;
  kind: AdaptationFileKind;
  links: Record<string, AdaptationAssetLink>;
  onReloadAdaptation: () => Promise<void>;
}) {
  const files = filesFromLinks(kind, links);
  const singular = singularFileKindLabel(kind);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<AdaptationFilePayload>(() => emptyFileDraft(kind, []));
  const [isSaving, setIsSaving] = useState(false);

  const openNew = () => {
    setIsCreating(true);
    setEditingKey(null);
    setDraft(emptyFileDraft(kind, files.map((file) => file.key)));
    setIsModalOpen(true);
  };

  const openEdit = (file: ReturnType<typeof filesFromLinks>[number]) => {
    setIsCreating(false);
    setEditingKey(file.key);
    setDraft({ key: file.key, body: file.body, mode: file.mode, styleRef: file.styleRef });
    setIsModalOpen(true);
  };

  const save = async () => {
    const payload = {
      key: slugifyFileKey(draft.key),
      body: draft.body,
      mode: draft.mode,
      styleRef: draft.styleRef,
    };
    setIsSaving(true);
    try {
      if (isCreating) {
        await api.createAdaptationFile(projectSlug, kind, payload);
      } else if (editingKey) {
        await api.updateAdaptationFile(projectSlug, kind, editingKey, payload);
      }
      await onReloadAdaptation();
      setIsModalOpen(false);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="story-card adaptation-file-card">
      <div className="adaptation-file-header">
        <div>
          <h2>{fileKindLabel(kind)}</h2>
          {files.length > 0 && <p className="muted">{files.length} saved {fileKindLabel(kind).toLowerCase()} · click to edit</p>}
        </div>
        <button className="secondary" onClick={openNew}>New {singular}</button>
      </div>
      <div className="adaptation-file-grid">
        {files.map((file) => (
          <button key={file.key} className="adaptation-file-list-item" onClick={() => openEdit(file)}>
            <strong>{file.key}</strong>
            <small>{file.status} · {file.promptPath}</small>
          </button>
        ))}
        {!files.length && <p className="muted">No {fileKindLabel(kind).toLowerCase()} yet.</p>}
      </div>
      {isModalOpen && (
        <Modal title={isCreating ? `New ${singular}` : `Edit ${draft.key || singular}`} onClose={() => setIsModalOpen(false)}>
          <div className="adaptation-file-form">
            <label className="field-label">
              Key
              <input value={draft.key} readOnly />
            </label>
            {kind !== 'scenes' && (
              <label className="field-label">
                Style ref
                <input value={draft.styleRef ?? ''} readOnly placeholder={kind === 'characters' ? 'character:base' : 'location:base'} />
              </label>
            )}
            <label className="field-label">
              {kind === 'scenes' ? 'Scene artifact' : 'Image prompt'}
              <textarea className="modal-textarea" rows={10} value={draft.body} onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))} />
            </label>
          </div>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setIsModalOpen(false)} disabled={isSaving}>Cancel</button>
            <button className="generate-button" onClick={save} disabled={isSaving || !draft.key.trim()}>
              {isSaving ? 'Saving...' : isCreating ? `Create ${singular}` : 'Save changes'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function PhaseIngestion({
  projectSlug,
  adaptation,
  workflow,
  onImportBook,
  onStartWorkflow,
  visualStyle,
  isSavingStyle,
  onVisualStyleChange,
  onSaveStyle,
}: {
  projectSlug: string;
  adaptation: AdaptationStatus;
  workflow: AdaptationWorkflowStatus | null;
  onImportBook: (file: File) => Promise<void>;
  onStartWorkflow: () => Promise<void>;
  visualStyle: string;
  isSavingStyle: boolean;
  onVisualStyleChange: (value: string) => void;
  onSaveStyle: (value: string) => Promise<void>;
}) {
  const [bookText, setBookText] = useState<string | null>(null);
  const [isLoadingBook, setIsLoadingBook] = useState(false);
  const [isBookOpen, setIsBookOpen] = useState(false);
  const viewBook = async () => {
    setIsBookOpen(true);
    if (bookText === null) {
      setIsLoadingBook(true);
      try {
        const result = await api.getAdaptationBook(projectSlug);
        setBookText(result.text);
      } finally {
        setIsLoadingBook(false);
      }
    }
  };
  return (
    <>
      <section className="ingest-panel">
        <ol className="ingest-steps">
          <li className={`ingest-step ${adaptation.hasBook ? 'is-done' : ''}`}>
            <span className="ingest-step-index">1</span>
            <div className="ingest-step-content">
              <h2>Book Source</h2>
              {adaptation.hasBook ? (
                <button className="generate-button book-upload-button" onClick={viewBook}>View book</button>
              ) : (
                <label className="generate-button file-button book-upload-button">
                  Upload book.txt
                  <input type="file" accept=".txt,text/plain" hidden onChange={(event) => event.target.files?.[0] && void onImportBook(event.target.files[0])} />
                </label>
              )}
            </div>
          </li>
          <li className={`ingest-step ${adaptation.hasBookSession ? 'is-done' : ''}`}>
            <span className="ingest-step-index">2</span>
            <div className="ingest-step-content">
              <h2>Read Book &amp; Build Style</h2>
              <p className="muted">Creates the read-book session and generates the visual style and archetypes.</p>
              <button className="generate-button workflow-run-button" onClick={onStartWorkflow} disabled={!adaptation.hasBook || workflow?.running}>
                {workflow?.running && <span className="spinner" aria-hidden="true" />}
                {workflow?.running ? 'Loading book & style...' : adaptation.hasBookSession ? 'Rebuild session & style' : 'Load book & build style'}
              </button>
            </div>
          </li>
        </ol>
      </section>

      <VisualStyleCard
        value={visualStyle}
        isSaving={isSavingStyle}
        onChange={onVisualStyleChange}
        onSave={onSaveStyle}
      />

      {isBookOpen && (
        <Modal title="Book" onClose={() => setIsBookOpen(false)}>
          {isLoadingBook ? <p className="muted">Loading book...</p> : <pre className="book-text">{bookText}</pre>}
        </Modal>
      )}
    </>
  );
}

function StyleRefCard({
  status,
  projectSlug,
  asset,
  onImportStyleRef,
  onSavePrompt,
  onGenerateStyleRef,
}: {
  status: StyleRefStatus;
  projectSlug: string;
  asset: Asset | null;
  onImportStyleRef: (refKind: StyleRefKind, file: File) => Promise<void>;
  onSavePrompt: (refKind: StyleRefKind, prompt: string) => Promise<void>;
  onGenerateStyleRef: (refKind: StyleRefKind) => Promise<void>;
}) {
  const refKind = status.kind;
  const prompt = status.promptText;
  const isCharacter = refKind === 'archetype-character';
  const title = isCharacter ? 'Character Archetype' : 'Scene Archetype';
  const styleLabel = isCharacter ? 'character style reference' : 'scene style reference';
  const hasPrompt = prompt.trim().length > 0;
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(prompt);
  const [isSaving, setIsSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    setDraft(prompt);
  }, [prompt]);
  const savePrompt = async () => {
    setIsSaving(true);
    try {
      await onSavePrompt(status.kind, draft);
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  };
  const imageSrc = asset ? asset.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${asset.id}/thumb` : null;
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/'));
    if (file) void onImportStyleRef(status.kind, file);
  };
  return (
    <section className="story-card archetype-card">
      <div className="archetype-card-head">
        <div className="archetype-card-title">
          <h2>{title}</h2>
          <HelpTip text={`The ${styleLabel} for this project. Generate it on the canvas, edit the prompt, or import a reference image.`} />
        </div>
        <span className={`status-pill ${asset ? 'is-ready' : hasPrompt ? 'is-active' : 'is-pending'}`}>
          {asset ? 'Image set' : hasPrompt ? 'Prompt ready' : 'Empty'}
        </span>
      </div>
      <div className="archetype-body">
        <div className="archetype-prompt-col">
          {hasPrompt ? <p className="archetype-prompt-preview">{prompt}</p> : <p className="muted">No prompt yet.</p>}
          <button className="secondary" onClick={() => setIsEditing(true)}>{hasPrompt ? 'Edit prompt' : 'Write prompt'}</button>
          <button className="generate-button" onClick={() => onGenerateStyleRef(status.kind)} disabled={!hasPrompt || isSaving}>
            Generate this {isCharacter ? 'character' : 'scene'} reference
          </button>
        </div>
        <div className="archetype-image-col">
          <div
            className={`archetype-dropzone ${isDragging ? 'is-dragging' : ''} ${imageSrc ? 'has-image' : ''}`}
            onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
            onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDragging(false); }}
            onDrop={onDrop}
            onClick={() => imageSrc && setIsFullscreen(true)}
            role={imageSrc ? 'button' : undefined}
            title={imageSrc ? 'Click to view full screen' : undefined}
          >
            {imageSrc ? <img src={imageSrc} alt="" /> : <span className="muted">Drag an image here, or import below</span>}
          </div>
          <label className="secondary file-button">
            {asset ? 'Replace image' : 'Import image'}
            <input type="file" accept="image/*" hidden onChange={(event) => event.target.files?.[0] && void onImportStyleRef(status.kind, event.target.files[0])} />
          </label>
        </div>
      </div>
      {isEditing && (
        <Modal title={`Edit ${title} Prompt`} onClose={() => setIsEditing(false)}>
          <p className="muted">This prompt drives the generated {styleLabel} on the canvas.</p>
          <textarea className="modal-textarea" value={draft} onChange={(event) => setDraft(event.target.value)} rows={10} />
          <div className="modal-actions">
            <button className="secondary" onClick={() => setIsEditing(false)} disabled={isSaving}>Cancel</button>
            <button className="generate-button" onClick={savePrompt} disabled={isSaving}>{isSaving ? 'Saving...' : 'Save prompt'}</button>
          </div>
        </Modal>
      )}
      {isFullscreen && imageSrc && (
        <div className="archetype-lightbox" onClick={() => setIsFullscreen(false)} role="dialog" aria-modal="true">
          <img src={asset ? `/api/projects/${projectSlug}/assets/${asset.id}/image` : imageSrc} alt="" onClick={(event) => event.stopPropagation()} />
          <button className="archetype-lightbox-close" onClick={() => setIsFullscreen(false)} aria-label="Close">×</button>
        </div>
      )}
    </section>
  );
}

function HelpTip({ text }: { text: string }) {
  return (
    <span className="help-tip-wrap">
      <button type="button" className="help-tip" aria-label={text} onClick={(event) => event.preventDefault()}>?</button>
      <span className="help-tip-bubble" role="tooltip">{text}</span>
    </span>
  );
}

function VisualStyleCard({
  value,
  isSaving,
  onChange,
  onSave,
}: {
  value: string;
  isSaving: boolean;
  onChange: (value: string) => void;
  onSave: (value: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const hasStyle = value.trim().length > 0;
  const save = async () => {
    onChange(draft);
    await onSave(draft);
    setIsEditing(false);
  };
  return (
    <section className="story-card archetype-card">
      <div className="archetype-card-head">
        <div className="archetype-card-title">
          <h2>Visual Style</h2>
          <HelpTip text="The shared style guide appended to every generated image." />
        </div>
        <span className={`status-pill ${hasStyle ? 'is-ready' : 'is-pending'}`}>{hasStyle ? 'Set' : 'Empty'}</span>
      </div>
      {hasStyle ? <p className="archetype-prompt-preview">{value}</p> : <p className="muted">No visual style yet.</p>}
      <div className="archetype-card-actions">
        <button className="secondary" onClick={() => setIsEditing(true)}>{hasStyle ? 'Edit style' : 'Write style'}</button>
      </div>
      {isEditing && (
        <Modal title="Edit Visual Style" onClose={() => setIsEditing(false)}>
          <p className="muted">This style guide is appended to every generated image prompt.</p>
          <textarea className="modal-textarea" value={draft} onChange={(event) => setDraft(event.target.value)} rows={12} />
          <div className="modal-actions">
            <button className="secondary" onClick={() => setIsEditing(false)} disabled={isSaving}>Cancel</button>
            <button className="generate-button" onClick={save} disabled={isSaving}>{isSaving ? 'Saving...' : 'Save style'}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function PhaseWorkflowActions({
  kind,
  adaptation,
  workflow,
  validation,
  onStartWorkflow,
  onStartValidation,
}: {
  kind: 'characters' | 'locations';
  adaptation: AdaptationStatus;
  workflow: AdaptationWorkflowStatus | null;
  validation: AdaptationWorkflowStatus | null;
  onStartWorkflow: () => Promise<void>;
  onStartValidation: () => Promise<void>;
}) {
  return (
    <div className="assets-row">
      <section className="story-card assets-extract-card">
        <div className="assets-extract-head">
          <div className="archetype-card-title">
            <h2>Extract From Book</h2>
            <HelpTip text={`Run Pi to populate ${kind} files from the ingested book session.`} />
          </div>
          <button className="generate-button workflow-run-button" onClick={onStartWorkflow} disabled={!adaptation.hasBookSession || workflow?.running}>
            {workflow?.running && <span className="spinner" aria-hidden="true" />}
            {workflow?.running ? 'Running extraction...' : 'Run extraction'}
          </button>
        </div>
        {!adaptation.hasBookSession && (
          <p className="assets-extract-hint">Create the read-book session in Phase 0 first, or author files manually below.</p>
        )}
      </section>
      <section className="story-card">
        <div className="archetype-card-title">
          <h2>Validate</h2>
          <HelpTip text={`Check that ${kind} files are well-formed.`} />
        </div>
        <button className="secondary" onClick={onStartValidation} disabled={validation?.running}>{validation?.running ? 'Validating...' : 'Run validation'}</button>
      </section>
    </div>
  );
}

function PublishToCanvasCard({
  kind,
  count,
  isImportingDrafts,
  onImportDraftsToCanvas,
}: {
  kind: 'characters' | 'locations';
  count: number;
  isImportingDrafts: boolean;
  onImportDraftsToCanvas: () => Promise<void>;
}) {
  return (
    <div className="assets-row">
      <section className="story-card">
        <div className="archetype-card-title">
          <h2>Publish To Canvas</h2>
          <HelpTip text={`Send ${kind} files to the canvas to generate references.`} />
        </div>
        <button className="generate-button" onClick={onImportDraftsToCanvas} disabled={!count || isImportingDrafts}>
          {isImportingDrafts ? 'Publishing...' : `Publish ${count} ${kind}`}
        </button>
      </section>
    </div>
  );
}

function PhaseAssetType({
  kind,
  projectSlug,
  adaptation,
  assets,
  workflow,
  validation,
  onImportStyleRef,
  onSaveStylePrompt,
  onGenerateStyleRef,
  onStartWorkflow,
  onStartValidation,
  onImportDraftsToCanvas,
  isImportingDrafts,
  onReloadAdaptation,
}: {
  kind: 'characters' | 'locations';
  projectSlug: string;
  adaptation: AdaptationStatus;
  assets: Asset[];
  workflow: AdaptationWorkflowStatus | null;
  validation: AdaptationWorkflowStatus | null;
  onImportStyleRef: (refKind: StyleRefKind, file: File) => Promise<void>;
  onSaveStylePrompt: (refKind: StyleRefKind, prompt: string) => Promise<void>;
  onGenerateStyleRef: (refKind: StyleRefKind) => Promise<void>;
  onStartWorkflow: () => Promise<void>;
  onStartValidation: () => Promise<void>;
  onImportDraftsToCanvas: () => Promise<void>;
  isImportingDrafts: boolean;
  onReloadAdaptation: () => Promise<void>;
}) {
  const isCharacters = kind === 'characters';
  const styleRefStatus = styleRefStatusFromAdaptation(isCharacters ? 'archetype-character' : 'archetype-scene', adaptation, assets);
  const links = isCharacters ? adaptation.characters : adaptation.locations;
  const count = Object.keys(links).length;
  return (
    <>
      <div className="archetype-row">
        <StyleRefCard
          status={styleRefStatus}
          projectSlug={projectSlug}
          asset={styleRefStatus.asset}
          onImportStyleRef={onImportStyleRef}
          onSavePrompt={onSaveStylePrompt}
          onGenerateStyleRef={onGenerateStyleRef}
        />
      </div>

      <PhaseWorkflowActions kind={kind} adaptation={adaptation} workflow={workflow} validation={validation} onStartWorkflow={onStartWorkflow} onStartValidation={onStartValidation} />

      <AdaptationFileEditor projectSlug={projectSlug} kind={kind} links={links} onReloadAdaptation={onReloadAdaptation} />

      <PublishToCanvasCard kind={kind} count={count} isImportingDrafts={isImportingDrafts} onImportDraftsToCanvas={onImportDraftsToCanvas} />
    </>
  );
}

function PhaseScenes({ projectSlug, adaptation, workflow, validation, isSavingSettings, onSaveStoryKind, onStartWorkflow, onStartValidation, onImportDraftsToCanvas, isImportingDrafts, onReloadAdaptation }: {
  projectSlug: string;
  adaptation: AdaptationStatus;
  workflow: AdaptationWorkflowStatus | null;
  validation: AdaptationWorkflowStatus | null;
  isSavingSettings: boolean;
  onSaveStoryKind: (kind: StoryKind) => Promise<void>;
  onStartWorkflow: () => Promise<void>;
  onStartValidation: () => Promise<void>;
  onImportDraftsToCanvas: () => Promise<void>;
  isImportingDrafts: boolean;
  onReloadAdaptation: () => Promise<void>;
}) {
  const sceneCount = Object.keys(adaptation.scenes).length;
  return (
    <>
      <AdaptationFileEditor projectSlug={projectSlug} kind="scenes" links={adaptation.scenes} onReloadAdaptation={onReloadAdaptation} />
      <section className="story-card">
        <h2>Story Kind</h2>
        <p className="muted">Choose the adaptation shape. This drives how scenes break down into pages or panels in later phases.</p>
        <select value={adaptation.settings.storyKind} disabled={isSavingSettings || workflow?.running} onChange={(event) => void onSaveStoryKind(event.target.value as StoryKind)}>
          <option value="picture-book">Picture book</option>
          <option value="illustrated-story">Illustrated story</option>
          <option value="comic-book">Comic book</option>
        </select>
      </section>
      <section className="story-card">
        <h2>Acts And Scenes</h2>
        <p className="muted">Optionally generate play-by-play and scene files from an ingested book context.</p>
        <button className="generate-button workflow-run-button" onClick={onStartWorkflow} disabled={!adaptation.hasBookSession || workflow?.running}>
          {workflow?.running ? 'Running scene creation...' : 'Run scene workflow'}
        </button>
      </section>
      <section className="story-card">
        <h2>Scene Canvas</h2>
        <p className="muted">{sceneCount ? `${sceneCount} scene files are ready to publish as planning nodes.` : 'No scene files yet.'}</p>
        <button className="generate-button" onClick={onImportDraftsToCanvas} disabled={!sceneCount || isImportingDrafts}>
          {isImportingDrafts ? 'Publishing...' : 'Publish scene nodes'}
        </button>
      </section>
      <section className="story-card">
        <h2>Validate Scenes</h2>
        <button className="secondary" onClick={onStartValidation} disabled={validation?.running}>{validation?.running ? 'Validating...' : 'Run validation'}</button>
      </section>
    </>
  );
}

function PhaseMoments({ adaptation, workflow, validation, onStartWorkflow, onStartValidation, onImportDraftsToCanvas, isImportingDrafts }: {
  adaptation: AdaptationStatus;
  workflow: AdaptationWorkflowStatus | null;
  validation: AdaptationWorkflowStatus | null;
  onStartWorkflow: () => Promise<void>;
  onStartValidation: () => Promise<void>;
  onImportDraftsToCanvas: () => Promise<void>;
  isImportingDrafts: boolean;
}) {
  const momentNodeCount = Object.keys(adaptation.pages).length + Object.keys(adaptation.panels).length;
  return (
    <>
      <section className="story-card">
        <h2>Moments, Beats, Panels</h2>
        <p className="muted">Break scene artifacts into story-kind page plans or comic panel prompts.</p>
        <button className="generate-button workflow-run-button" onClick={onStartWorkflow} disabled={(adaptation.counts.sceneArtifacts ?? 0) === 0 || workflow?.running}>
          {workflow?.running ? 'Planning moments...' : 'Run moment planning'}
        </button>
      </section>
      <section className="story-card">
        <h2>Moment Canvas</h2>
        <p className="muted">{momentNodeCount ? `${momentNodeCount} page/panel prompts are ready for the moment image canvas.` : 'No page or panel prompts yet.'}</p>
        <button className="generate-button" onClick={onImportDraftsToCanvas} disabled={!momentNodeCount || isImportingDrafts}>
          {isImportingDrafts ? 'Publishing...' : 'Publish moment nodes'}
        </button>
      </section>
      <section className="story-card">
        <h2>Validate Moment Prompts</h2>
        <button className="secondary" onClick={onStartValidation} disabled={validation?.running}>{validation?.running ? 'Validating...' : 'Run validation'}</button>
      </section>
    </>
  );
}

type PiWorkflowEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_start'; toolName: string; args: string }
  | { type: 'tool_end'; toolName: string; isError: boolean; size: number; result: string }
  | { type: 'retry'; attempt: number; maxAttempts: number; message: string }
  | { type: 'agent_start' | 'turn_start' | 'turn_end' | 'agent_end' | 'compaction_start' | 'compaction_end' };

type WorkflowLogRow = { kind: 'event'; event: PiWorkflowEvent } | { kind: 'text'; text: string };

type WorkflowLogSection = { id: number; label: string; output?: string; rows: WorkflowLogRow[] };

function parseWorkflowLog(log: string): WorkflowLogSection[] {
  const sections: WorkflowLogSection[] = [];
  let current: WorkflowLogSection | null = null;
  let nextId = 0;
  const makeSection = (label: string): WorkflowLogSection => {
    const section: WorkflowLogSection = { id: nextId++, label, rows: [] };
    sections.push(section);
    return section;
  };
  for (const rawLine of log.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;
    const outputMatch = /^\s+output:\s*(.+)$/.exec(rawLine);
    if (outputMatch && current) {
      current.output = outputMatch[1].trim();
      continue;
    }
    if (/^\[[^\]]+\]\s+\S/.test(line)) {
      current = makeSection(line.trim());
      continue;
    }
    if (!current) current = makeSection('Output');
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { type?: unknown };
        if (parsed && typeof parsed.type === 'string') {
          current.rows.push({ kind: 'event', event: parsed as PiWorkflowEvent });
          continue;
        }
      } catch {
        // Not a Pi event; fall back to a plain text line.
      }
    }
    current.rows.push({ kind: 'text', text: line });
  }
  return sections;
}

function formatCharCount(n: number): string {
  if (n < 1000) return `${n} chars`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k chars`;
  return `${(n / 1_000_000).toFixed(1)}M chars`;
}

function WorkflowToolResult({ event }: { event: Extract<PiWorkflowEvent, { type: 'tool_end' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`workflow-event workflow-event-tool-end ${event.isError ? 'is-error' : ''}`}>
      <span className="workflow-event-icon" aria-hidden="true">{event.isError ? '✗' : '✓'}</span>
      <span className="workflow-tool-name">{event.toolName}</span>
      <span className="workflow-tool-size">{formatCharCount(event.size)}</span>
      {event.result && (
        <button type="button" className="workflow-tool-toggle" onClick={() => setOpen((value) => !value)}>
          {open ? 'hide' : 'preview'}
        </button>
      )}
      {open && event.result && <pre className="workflow-tool-result">{event.result}</pre>}
    </div>
  );
}

function WorkflowEventRow({ event }: { event: PiWorkflowEvent }) {
  if (event.type === 'assistant_text') {
    return (
      <div className="workflow-event workflow-event-assistant">
        <span className="workflow-event-icon" aria-hidden="true">✦</span>
        <div className="workflow-event-text">{event.text}</div>
      </div>
    );
  }
  if (event.type === 'tool_start') {
    return (
      <div className="workflow-event workflow-event-tool">
        <span className="workflow-event-icon" aria-hidden="true">→</span>
        <span className="workflow-tool-name">{event.toolName}</span>
        {event.args && <code className="workflow-tool-args">{event.args}</code>}
      </div>
    );
  }
  if (event.type === 'tool_end') {
    return <WorkflowToolResult event={event} />;
  }
  if (event.type === 'retry') {
    return (
      <div className="workflow-event workflow-event-retry">
        <span className="workflow-event-icon" aria-hidden="true">↻</span>
        <span>retry {event.attempt}/{event.maxAttempts}</span>
        {event.message && <span className="workflow-event-text">{event.message}</span>}
      </div>
    );
  }
  return null;
}

function WorkflowLogSectionView({ section }: { section: WorkflowLogSection }) {
  return (
    <section className="workflow-step">
      <header className="workflow-step-head">
        <span className="workflow-step-label">{section.label}</span>
        {section.output && <code className="workflow-step-output">{section.output}</code>}
      </header>
      <div className="workflow-step-body">
        {section.rows.map((row, index) =>
          row.kind === 'text' ? (
            <div key={index} className="workflow-line">{row.text}</div>
          ) : (
            <WorkflowEventRow key={index} event={row.event} />
          ),
        )}
      </div>
    </section>
  );
}

function WorkflowLogPanel({
  title = 'Adaptation Output',
  workflow,
}: {
  title?: string;
  workflow: AdaptationWorkflowStatus;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sections = useMemo(() => parseWorkflowLog(workflow.log), [workflow.log]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [workflow.log]);
  const statusText = workflow.running
    ? 'running'
    : workflow.returnCode === 0
      ? 'complete'
      : workflow.returnCode === null || workflow.returnCode === undefined
        ? 'idle'
        : `exited ${workflow.returnCode}`;
  const statusClass = workflow.running ? 'running' : workflow.returnCode ? 'error' : '';
  return (
    <div className="workflow-log-panel">
      <div className="workflow-log-header">
        <strong>{title}</strong>
        <span className={`workflow-log-status ${statusClass}`}>
          {workflow.running && <span className="spinner" aria-hidden="true" />}
          {statusText}
        </span>
      </div>
      <div className="workflow-timeline" ref={scrollRef} role="log" aria-live="polite">
        {sections.length === 0 ? (
          <p className="workflow-timeline-empty">Waiting for output…</p>
        ) : (
          sections.map((section) => <WorkflowLogSectionView key={section.id} section={section} />)
        )}
      </div>
    </div>
  );
}

function NodeSidebar({
  node,
  assets,
  adaptation,
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
  adaptation: AdaptationStatus | null;
  projectSlug: string;
  onDraftChange: (id: string, patch: Partial<DraftCanvasNode>) => void;
  onImageGroupChange: (id: string, patch: Partial<ImageGroupCanvasNode>) => void;
  onGenerate: (id: string, draft: DraftNodeData) => void;
  onGenerateArtifact: (id: string, artifact: StoryArtifactNodeData) => void;
  onGenerateVariants: (id: string, group: ImageGroupNodeData, params: GenerationParams) => void;
  onSetStyleRefAsset: (kind: StyleRefKind, assetId: string) => void;
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
        adaptation={adaptation}
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
      adaptation={adaptation}
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
  adaptation,
  onDraftChange,
  onGenerate,
  onDelete,
}: {
  node: Node<DraftNodeData>;
  assets: Asset[];
  adaptation: AdaptationStatus | null;
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
  const styleRefKind = styleRefKindForTags(draft.tags);
  const styleRefLabel = styleRefKind === 'archetype-character' ? 'character' : styleRefKind === 'archetype-scene' ? 'scene' : null;
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
      {styleRefLabel && (
        <div className="canvas-role-badge">
          Draft {styleRefLabel} archetype reference
        </div>
      )}
      <label className="field-label">
        Name
        <input value={draft.displayName} onChange={(event) => onDraftChange(node.id, { displayName: event.target.value })} />
      </label>
      {!styleRefKind && (
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
      )}
      <section className="sidebar-section">
        <label className="field-label">
          Prompt
          <textarea
            ref={promptRef}
            className={`prompt-textarea ${styleRefKind ? 'locked-field' : ''}`}
            autoFocus={!styleRefKind}
            value={draft.prompt}
            onChange={(event) => !styleRefKind && onDraftChange(node.id, { prompt: event.target.value })}
            placeholder="Prompt"
            readOnly={Boolean(styleRefKind)}
          />
        </label>
        {styleRefKind && <p className="muted">Edit this prompt from the style reference card. The canvas node is synced from the file.</p>}
      </section>
      {!styleRefKind && <section className="sidebar-section generation-section">
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
      </section>}
      {styleRefKind && (
        <section className="sidebar-section generation-section">
          <button className="generate-button" onClick={() => onGenerate(node.id, draft)} disabled={!draft.prompt.trim() || draft.isGenerating}>
            {draft.isGenerating && <span className="spinner" aria-hidden="true" />}
            {draft.isGenerating ? 'Generating...' : 'Generate canonical reference'}
          </button>
        </section>
      )}
    </aside>
  );
}

function artifactKindLabel(kind: ArtifactKind) {
  const labels: Record<ArtifactKind, string> = {
    'character-sheet': 'Character Sheet',
    'location-prompt': 'Location Prompt',
    'scene-artifact': 'Scene Artifact',
    'page-plan': 'Page Plan',
    'panel-prompt': 'Panel Prompt',
  };
  return labels[kind];
}

function canGenerateArtifact(kind: ArtifactKind) {
  return kind !== 'scene-artifact';
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
        {canGenerateArtifact(artifact.artifactKind) ? (
          <button className="generate-button" onClick={() => onGenerate(node.id, artifact)} disabled={!artifact.prompt.trim() || artifact.isGenerating}>
            {artifact.isGenerating && <span className="spinner" aria-hidden="true" />}
            {artifact.isGenerating ? 'Generating...' : generated ? 'Regenerate artifact' : 'Generate artifact'}
          </button>
        ) : (
          <p className="muted">Planning artifact only. Generate page or panel prompts from later layout artifacts.</p>
        )}
      </section>
    </aside>
  );
}

function ImageSidebar({
  node,
  asset,
  assets,
  adaptation,
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
  adaptation: AdaptationStatus | null;
  onDelete: (id: string, assetId?: string) => void;
  onNodeChange: (id: string, patch: Partial<ImageGroupCanvasNode>) => void;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
  onCreateSibling: (group: ImageGroupNodeData, sourceAsset: Asset) => void;
  onGenerateVariants: (id: string, group: ImageGroupNodeData, params: GenerationParams) => void;
  onSetStyleRefAsset: (kind: StyleRefKind, assetId: string) => void;
  onRefineChat: (nodeId: string, assetId: string) => void;
}) {
  const [isVariantPanelOpen, setIsVariantPanelOpen] = useState(false);
  const [variantParams, setVariantParams] = useState(defaultDraftParams);
  const prompt = asset.prompt?.text ?? '';
  const refs = asset.generation?.refs ?? [];
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const activeVariantIndex = Math.max(0, node.data.assetIds.indexOf(asset.id));
  const styleRefKind = styleRefKindForTags(node.data.tags);
  const isCharacterArchetype = adaptation?.styleRefStatuses?.['archetype-character']?.assetId === asset.id || adaptation?.archetypeCharacterAssetId === asset.id;
  const isSceneArchetype = adaptation?.styleRefStatuses?.['archetype-scene']?.assetId === asset.id || adaptation?.archetypeSceneAssetId === asset.id;
  const canSetCanonicalReference = Boolean(styleRefKind) || isCanonicalStyleRefAsset(adaptation, asset.id);
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
      {(isCharacterArchetype || isSceneArchetype || styleRefKind) && (
        <div className="canvas-role-badge">
          {isCharacterArchetype ? 'Chosen character archetype' : isSceneArchetype ? 'Chosen scene archetype' : 'Style reference candidate'}
        </div>
      )}
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
      {canSetCanonicalReference && <section className="sidebar-section canonical-reference-section">
        <h3>Canonical Reference</h3>
        <button className="secondary" onClick={() => onSetStyleRefAsset('archetype-character', asset.id)} disabled={isCharacterArchetype}>
          {isCharacterArchetype ? 'Current character archetype' : 'Set as character archetype'}
        </button>
        <button className="secondary" onClick={() => onSetStyleRefAsset('archetype-scene', asset.id)} disabled={isSceneArchetype}>
          {isSceneArchetype ? 'Current scene archetype' : 'Set as scene archetype'}
        </button>
      </section>}
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
          {styleRefKind ? (
            <p className="muted">Generate style reference replacements from the adaptation style reference action so canonical metadata stays in sync.</p>
          ) : isVariantPanelOpen ? (
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
  const styleRole = data.tags.includes('character-style') ? 'Character archetype' : data.tags.includes('scene-style') ? 'Scene archetype' : null;
  const tooltip = [
    asset.prompt?.text,
    params ? `model: ${params.model}` : null,
    params ? `ratio: ${params.aspectRatio}, size: ${params.imageSize}, seed: ${params.seed ?? 'auto'}` : null,
    `variants: ${currentIndex + 1}/${data.assetIds.length}`,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className={`node image-group-node ${styleRole ? 'style-ref-image-node' : ''} ${data.assetIds.length > 1 ? 'stacked' : ''} ${data.isGenerating ? 'generating' : ''}`} title={tooltip}>
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
        {styleRole && <span className="node-role-badge">{styleRole}</span>}
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
  const styleRole = data.tags.includes('character-style') ? 'Character archetype draft' : data.tags.includes('scene-style') ? 'Scene archetype draft' : null;
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
        {styleRole && <span className="node-role-badge">{styleRole}</span>}
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
  const kindClass = `${data.artifactKind}-artifact-node`;
  return (
    <div className={`node story-artifact-node ${kindClass} ${data.generatedAssetId ? 'generated' : ''} ${data.isGenerating ? 'generating' : ''}`} title={tooltip}>
      <Handle type="target" position={Position.Left} className="input-handle" isConnectable={false} />
      <strong className="node-title">{data.displayName || data.artifactKey}</strong>
      <div className="story-artifact-card">
        <span className="story-artifact-badge">{artifactKindLabel(data.artifactKind)}</span>
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
      </div>
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
