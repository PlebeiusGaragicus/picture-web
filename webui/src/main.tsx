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
import { VisualStyleCard } from './adaptation/cards';
import { PhaseAssetType, PhaseMoments, PhaseScenes } from './adaptation/phaseScreens';
import { deletableSelectedNodes, deleteSelectedNodesMessage, deriveStoryGraphEdges, generatedResultNodeId } from './canvas/graph';
import { canDeleteNode } from './canvas/roles';
import { artifactKindLabel, assetLabel, capabilitiesForModel, defaultDraftParams, modelCapabilities, normalizedParamsForModel, visibleDisplayName } from './canvas/shared';
import { NodeSidebar } from './canvas/sidebars';
import type { DraftNodeData, ImageGroupNodeData, PhotoNodeData, StoryArtifactNodeData } from './canvas/types';
import { styleRefDraftNodeId, styleRefImageNodeId, styleRefKindForTags } from './styleRefs';
import { HelpTip, Modal } from './ui';
import type { AdaptationAssetLink, AdaptationFileKind, AdaptationFilePayload, AdaptationStage, AdaptationStatus, AdaptationWorkflowStatus, Asset, CanvasDocument, CanvasRole, ChatSession, ChatTurnSettings, DraftCanvasNode, GeneratePayload, GenerationParams, ImageGroupCanvasNode, Project, StoryKind, StyleRefKind } from './types';

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
              role: node.data.role ?? null,
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
              role: node.data.role ?? null,
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
            role: node.data.role ?? null,
            assetIds: node.data.assetIds,
            activeAssetId: node.data.activeAssetId ?? node.data.assetIds[0] ?? null,
          },
        ];
      }),
    ),
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
        data: { ...canvasNode, generatedAssetIds: canvasNode.generatedAssetIds ?? [], kind: 'storyArtifact', nodeId: id, generatedAsset, isGenerating: generatingNodeIds.has(id), onDetails, onViewAsset, onRefineChat },
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
    setProjects((current) => current.map((project) => (project.slug === detail.project.slug ? detail.project : project)));
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
    return deriveStoryGraphEdges(filteredNodes);
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
    if (!canDeleteNode(nodeToDelete)) return;
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
    const nodeToDelete = nodes.find((node) => node.id === nodeId);
    if (!canDeleteNode(nodeToDelete)) return;
    setPendingDelete({ nodeId, assetId });
  }, [nodes]);

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
    const deletableNodes = deletableSelectedNodes(nodes, selectedNodeIds);
    if (!deletableNodes.length) return;
    const deletable = new Set(deletableNodes.map((node) => node.id));
    const selectedImageNodes = deletableNodes.filter((node) => node.data.kind === 'imageGroup') as Node<ImageGroupNodeData>[];
    const message = deleteSelectedNodesMessage(selectedNodeIds.length, deletableNodes.length, selectedImageNodes.length);
    if (!window.confirm(message)) return;
    try {
      await Promise.all(selectedImageNodes.flatMap((node) => node.data.assetIds.map((assetId) => api.deleteAsset(openProjectSlug, assetId))));
    } catch (err) {
      console.error('[photo-web] failed to delete selected image assets', err);
      setError(String(err));
    }
    const nextNodes = nodes.filter((node) => !deletable.has(node.id));
    setNodes(nextNodes);
    setSelectedNodeIds((current) => current.filter((id) => !deletable.has(id)));
    setSelectedIds([]);
    if (popoverNodeId && deletable.has(popoverNodeId)) setPopoverNodeId(null);
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
    options: { prompt?: string; params?: GenerationParams; displayName?: string; role?: CanvasRole | null; tags?: string[] } = {},
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
        displayName: options.displayName ?? '',
        x: position.x,
        y: position.y,
        tags: options.tags ?? [],
        role: options.role ?? null,
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

  const createChildTextArtifact = async (sourceNode: Node<DraftNodeData> | Node<StoryArtifactNodeData>) => {
    const position = { x: sourceNode.position.x + 320, y: sourceNode.position.y + 80 };
    const prompt = sourceNode.data.prompt;
    const displayName = `${visibleDisplayName(sourceNode.data.displayName) || 'Source'} child`;
    const params = sourceNode.data.params ?? defaultDraftParams;
    await createDraftAt([], position, {
      displayName,
      prompt,
      params,
      role: { type: 'text-result', sourceNodeId: sourceNode.id },
      tags: ['text-result'],
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

  const ensureAdaptationPhasePublished = useCallback(async () => {
    if (!openProjectSlug) return;
    await api.publishAdaptationPhaseToCanvas(openProjectSlug);
    await loadProject(openProjectSlug);
  }, [openProjectSlug, loadProject]);

  useEffect(() => {
    if (projectPhase !== 'phase-1-characters' || !adaptation) return;
    const hasStyleRefPrompt = Object.values(adaptation.styleRefStatuses).some((status) => status.promptText.trim().length > 0);
    if (!hasStyleRefPrompt) return;
    const hasArchetypeNodes = Object.values(canvas.nodes).some((node) => styleRefKindForTags(node.tags) !== null);
    if (hasArchetypeNodes || autoPublishingArchetypesRef.current) return;
    autoPublishingArchetypesRef.current = true;
    ensureAdaptationPhasePublished()
      .catch((err) => setError(String(err)))
      .finally(() => {
        autoPublishingArchetypesRef.current = false;
      });
  }, [projectPhase, adaptation, canvas, ensureAdaptationPhasePublished]);

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

  const setProjectCover = async (assetId: string) => {
    if (!openProjectSlug) return;
    const updated = await api.setProjectCover(openProjectSlug, assetId);
    setProjects((current) => current.map((project) => (project.slug === updated.slug ? updated : project)));
  };

  const generateAdaptationStyleRef = async (kind: StyleRefKind) => {
    if (!openProjectSlug) return;
    setError(null);
    const draftNodeId = styleRefDraftNodeId(kind, adaptation);
    const imageNodeId = styleRefImageNodeId(kind, adaptation);
    setProjectPhase(kind === 'archetype-character' ? 'phase-1-characters' : 'phase-2-locations');
    setPhaseViewMode('canvas');
    setPopoverNodeId(imageNodeId);
    setGeneratingNodeIds((current) => new Set(current).add(draftNodeId));
    setNodes((current) => current.map((node) => (node.id === imageNodeId || node.id === draftNodeId ? { ...node, data: { ...node.data, isGenerating: true } } : node)));
    try {
      const result = await api.generateAdaptationStyleRef(openProjectSlug, kind, draftNodeId);
      if (result.status) setAdaptation(result.status);
      await reload();
      setPopoverNodeId(generatedResultNodeId(draftNodeId));
    } catch (err) {
      setError(String(err));
    } finally {
      setGeneratingNodeIds((current) => {
        const next = new Set(current);
        next.delete(draftNodeId);
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

  const publishAdaptationPhaseToCanvas = async () => {
    if (!openProjectSlug) return;
    setError(null);
    const result = await api.publishAdaptationPhaseToCanvas(openProjectSlug);
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
      setPopoverNodeId(generatedResultNodeId(id));
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
        onDeleteProject={async () => {
          await api.deleteProject(openProjectSlug);
          await loadProjects();
          closeProject();
        }}
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
            onPublishPhaseToCanvas={publishAdaptationPhaseToCanvas}
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
          coverAssetId={currentProject?.coverAssetId ?? null}
          onDraftChange={updateDraft}
          onImageGroupChange={updateImageGroup}
          onGenerate={generateDraft}
          onGenerateArtifact={generateStoryArtifact}
          onGenerateVariants={generateImageVariants}
          onCreateChildText={createChildTextArtifact}
          onSetStyleRefAsset={setAdaptationStyleRefAsset}
          onSetProjectCover={setProjectCover}
          onVariant={changeVariant}
          onCreateSibling={createSiblingDraft}
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
          coverAssetId={currentProject?.coverAssetId ?? null}
          onClose={() => {
            setViewerNodeId(null);
            setViewerAssetId(null);
          }}
          onVariant={changeVariant}
          onViewAsset={openAssetInViewer}
          onDetails={openViewerDetails}
          onDelete={deleteNodeById}
          onSetProjectCover={setProjectCover}
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
  onCreated,
}: {
  projects: Project[];
  error: string | null;
  onOpen: (slug: string) => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const closeCreate = () => {
    if (creating) return;
    setCreateOpen(false);
    setName('');
  };
  const create = async () => {
    const nextSlug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!nextSlug || creating) return;
    setCreating(true);
    try {
      await api.createProject(nextSlug, name, {});
      setName('');
      setCreateOpen(false);
      onCreated(nextSlug);
    } finally {
      setCreating(false);
    }
  };
  return (
    <div className="landing">
      <div className="landing-card">
        <h1>Story Canvas</h1>
        {error && <p className="error">{error}</p>}
        <section>
          <h2>Projects</h2>
          <div className="project-list">
            {projects.map((project) => (
              <button key={project.slug} className="project-tile" onClick={() => onOpen(project.slug)}>
                <div className="project-tile-cover">
                  {project.coverThumbnailUrl ? (
                    <img src={project.coverThumbnailUrl} alt="" />
                  ) : (
                    <div className="project-tile-cover-placeholder" aria-hidden="true">🖼️</div>
                  )}
                </div>
                <strong className="project-tile-name">{project.name}</strong>
              </button>
            ))}
            <button className="project-tile project-create-tile" onClick={() => setCreateOpen(true)}>
              <div className="project-tile-cover project-create-cover" aria-hidden="true">+</div>
              <span className="project-tile-name">New project</span>
            </button>
          </div>
        </section>
      </div>
      {createOpen && (
        <Modal title="New project" onClose={closeCreate}>
          <label className="field-label">
            Project name
            <input
              autoFocus
              value={name}
              disabled={creating}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create();
              }}
              placeholder="My project"
            />
          </label>
          <div className="modal-actions">
            <button className="secondary" disabled={creating} onClick={closeCreate}>Cancel</button>
            <button disabled={creating || !name.trim()} onClick={() => void create()}>
              {creating ? 'Creating...' : 'Create project'}
            </button>
          </div>
        </Modal>
      )}
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
  onDeleteProject,
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
  onDeleteProject: () => Promise<void>;
  onPhaseChange: (phase: ProjectPhase) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
      <div className="phase-sidebar-footer">
        <button className="danger" disabled={deleting} onClick={() => setPendingDelete(true)}>
          Delete project
        </button>
      </div>
      {pendingDelete && (
        <div className="confirm-backdrop" onClick={() => !deleting && setPendingDelete(false)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <h2>Delete project?</h2>
            <p>
              Move <strong>{project?.name ?? projectSlug}</strong> to the system Trash? This removes its canvas,
              assets, and adaptation files from Story Canvas.
            </p>
            <div className="row">
              <button
                className="danger"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await onDeleteProject();
                    setPendingDelete(false);
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? 'Deleting...' : 'Delete project'}
              </button>
              <button className="secondary" disabled={deleting} onClick={() => setPendingDelete(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
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
  onPublishPhaseToCanvas,
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
  onImportStyleRef: (kind: StyleRefKind, file: File) => Promise<void>;
  onSaveStylePrompt: (kind: StyleRefKind, prompt: string) => Promise<void>;
  onGenerateStyleRef: (kind: StyleRefKind) => Promise<void>;
  onStartWorkflow: (stage: AdaptationStage) => Promise<void>;
  onStartValidation: () => Promise<void>;
  onPublishPhaseToCanvas: () => Promise<void>;
  onReloadAdaptation: () => Promise<void>;
}) {
  const [visualStyle, setVisualStyle] = useState(adaptation.visualStyle);
  const [isSavingStyle, setIsSavingStyle] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isPublishingPhase, setIsPublishingPhase] = useState(false);
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
  const publishPhase = async () => {
    setIsPublishingPhase(true);
    try {
      await onPublishPhaseToCanvas();
    } finally {
      setIsPublishingPhase(false);
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
            onPublishPhaseToCanvas={publishPhase}
            isPublishingPhase={isPublishingPhase}
            fileEditor={<AdaptationFileEditor projectSlug={projectSlug} kind="characters" links={adaptation.characters} onReloadAdaptation={onReloadAdaptation} />}
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
            onPublishPhaseToCanvas={publishPhase}
            isPublishingPhase={isPublishingPhase}
            fileEditor={<AdaptationFileEditor projectSlug={projectSlug} kind="locations" links={adaptation.locations} onReloadAdaptation={onReloadAdaptation} />}
          />
        )}
        {phase === 'phase-3-scenes' && (
          <PhaseScenes adaptation={adaptation} workflow={workflow} validation={validation} isSavingSettings={isSavingSettings} onSaveStoryKind={saveStoryKind} onStartWorkflow={() => onStartWorkflow('scenes')} onStartValidation={onStartValidation} onPublishPhaseToCanvas={publishPhase} isPublishingPhase={isPublishingPhase} fileEditor={<AdaptationFileEditor projectSlug={projectSlug} kind="scenes" links={adaptation.scenes} onReloadAdaptation={onReloadAdaptation} />} />
        )}
        {phase === 'phase-4-moments' && (
          <PhaseMoments adaptation={adaptation} workflow={workflow} validation={validation} onStartWorkflow={() => onStartWorkflow('moments')} onStartValidation={onStartValidation} onPublishPhaseToCanvas={publishPhase} isPublishingPhase={isPublishingPhase} />
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
  const styleRefKind = styleRefKindForTags(data.tags);
  const styleRole = styleRefKind === 'archetype-character' ? 'Character archetype' : styleRefKind === 'archetype-scene' ? 'Scene archetype' : null;
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
  coverAssetId,
  onClose,
  onVariant,
  onViewAsset,
  onDetails,
  onDelete,
  onSetProjectCover,
}: {
  node?: Node<ImageGroupNodeData>;
  fallbackAsset?: Asset;
  assets: Asset[];
  projectSlug: string;
  coverAssetId?: string | null;
  onClose: () => void;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
  onViewAsset: (assetId: string) => void;
  onDetails: (nodeId: string) => void;
  onDelete: (nodeId: string, assetId?: string) => void;
  onSetProjectCover: (assetId: string) => void;
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
  const isProjectCover = coverAssetId === asset.id;
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
            {asset.hasPixels && (
              <button className="secondary" disabled={isProjectCover} onClick={() => onSetProjectCover(asset.id)}>
                {isProjectCover ? 'Project cover' : 'Set as cover'}
              </button>
            )}
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
  const styleRefKind = styleRefKindForTags(data.tags);
  const styleRole = styleRefKind === 'archetype-character' ? 'Character archetype prompt' : styleRefKind === 'archetype-scene' ? 'Scene archetype prompt' : null;
  const roleClass = data.role?.type === 'visual-style-source'
    ? 'visual-style-node'
    : data.role?.type === 'text-result'
      ? 'text-result-node'
      : '';
  const nodeTitle = data.role?.type === 'visual-style-source' ? 'Visual Style' : data.role?.type === 'text-result' ? 'Child Text' : 'Draft';
  const nodeSubtitle = data.role?.type === 'visual-style-source'
    ? 'Shared style source'
    : data.role?.type === 'text-result'
      ? 'Editable child artifact'
      : styleRefKind && data.tags.includes('generated')
        ? 'Generated child available'
        : `${data.refs.length} parent${data.refs.length === 1 ? '' : 's'}`;
  const tooltip = [
    data.prompt || 'Draft prompt not set',
    `parents: ${data.refs.length}`,
    `model: ${data.params.model ?? 'default'}`,
    `ratio: ${data.params.aspectRatio ?? 'default'}, size: ${data.params.imageSize ?? 'default'}, seed: ${data.params.seed ?? 'auto'}`,
  ].join('\n');
  return (
    <div className={`node draft-node ${data.tags.includes('archetype') ? 'archetype-draft-node' : ''} ${roleClass} ${data.isGenerating ? 'generating' : ''}`} title={tooltip}>
      <Handle type="target" position={Position.Left} className="input-handle" isConnectable={false} />
      <div className="draft-placeholder" aria-hidden="true">
        {(styleRole || data.role?.type === 'visual-style-source' || data.role?.type === 'text-result') && <span className="node-role-badge">{styleRole ?? nodeTitle}</span>}
        {data.isGenerating && (
          <div className="node-generating-overlay">
            <span className="spinner" aria-hidden="true" />
            <span>Generating</span>
          </div>
        )}
      </div>
      <strong>{nodeTitle}</strong>
      <small>{nodeSubtitle}</small>
      {(data.role?.type === 'style-ref-source' || data.role?.type === 'visual-style-source' || data.role?.type === 'text-result') && <Handle type="source" position={Position.Right} className="output-handle" />}
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
          {data.isGenerating ? (
            <div className="node-generating-overlay">
              <span className="spinner" aria-hidden="true" />
              <span>Generating</span>
            </div>
          ) : (
            <span>{data.generatedAssetId ? 'SRC' : data.artifactKind === 'character-sheet' ? 'CS' : 'LP'}</span>
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
