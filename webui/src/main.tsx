import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { createPortal } from 'react-dom';
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
import { exportProjectAssetsToFolder, saveAssetImageToDisk } from './exportAssets';
import { VisualStyleCard } from './adaptation/cards';
import { WorkflowLogPanel } from './adaptation/workflowLog';
import { PhaseAssetType, PhaseMoments, PhaseScenes } from './adaptation/phaseScreens';
import { deletableSelectedNodes, deleteSelectedNodesMessage, deriveStoryGraphEdges, generatedResultNodeId } from './canvas/graph';
import { canDeleteNode } from './canvas/roles';
import { SYSTEM_TAGS, artifactKindLabel, assetLabel, adaptationFileKindToArtifactKind, capabilitiesForModel, characterEntityTags, countEntityTagsOnAssets, countUserTagAssignments, countUserTagsOnAssets, defaultDraftParams, locationEntityTags, mergeAvailableUserTagsOnly, modelCapabilities, nonArchivedVariants, normalizedParamsForModel, storyArtifactKeysOnCanvas, storyArtifactNodeId, userProjectTags, visibleDisplayName } from './canvas/shared';
import { NodeSidebar } from './canvas/sidebars';
import { NodeTagButton, TagControlButton } from './canvas/assetTagRow';
import { nodeTagActionsRef } from './canvas/nodeTagActions';
import { SplitTagPopover } from './canvas/splitTagPopover';
import { TagColorPickerPopover } from './canvas/tagEditor';
import type { DraftNodeData, ImageGroupNodeData, PhotoNodeData, StoryArtifactNodeData } from './canvas/types';
import { styleRefDraftNodeId, styleRefImageNodeId, styleRefKindForTags } from './styleRefs';
import { HelpTip, Modal } from './ui';
import type { AdaptationAssetLink, AdaptationFileKind, AdaptationFilePayload, AdaptationStage, AdaptationStatus, AdaptationWorkflowStatus, ArtifactKind, Asset, CanvasDocument, CanvasRole, ChatSession, ChatTurnSettings, DraftCanvasNode, GeneratePayload, GenerationParams, ImageGroupCanvasNode, Project, StoryKind, StyleRefKind, TagDefinition } from './types';

type ProjectPhase =
  | 'story-canvas'
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

function phaseHasCanvas(phase: ProjectPhase) {
  return phase === 'story-canvas' || phase === 'phase-1-characters' || phase === 'phase-2-locations' || phase === 'phase-5-moment-canvas';
}

function phaseHasList(phase: ProjectPhase) {
  return phase !== 'phase-5-moment-canvas' && phase !== 'story-canvas';
}

function phaseStage(phase: ProjectPhase): AdaptationStage | null {
  switch (phase) {
    case 'phase-0-ingestion':
      return 'ingest';
    case 'phase-1-characters':
      return 'characters';
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
  projectTags: TagDefinition[] = [],
  onVariant: (nodeId: string, direction: -1 | 1) => void = () => undefined,
  onView: (nodeId: string) => void = () => undefined,
  onDetails: (nodeId: string) => void = () => undefined,
  onViewAsset: (assetId: string) => void = () => undefined,
  onDisplayNameChange: (nodeId: string, displayName: string) => void = () => undefined,
  onRefineChat: (nodeId: string, assetId: string) => void = () => undefined,
  onCreateTag: (tag: TagDefinition) => void = () => undefined,
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
        data: { ...canvasNode, kind: 'draft', nodeId: id, parentDisplayNames: displayNameByAssetId, isGenerating: generatingNodeIds.has(id), onDetails },
      };
    }
    if (canvasNode.type === 'storyArtifact') {
      const latestGeneratedId = canvasNode.generatedAssetIds.length > 0
        ? canvasNode.generatedAssetIds[canvasNode.generatedAssetIds.length - 1]
        : null;
      const generatedAsset = latestGeneratedId ? assetById.get(latestGeneratedId) ?? null : null;
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
      data: {
        ...canvasNode,
        kind: 'imageGroup',
        nodeId: id,
        assets: groupAssets,
        activeAsset,
        projectTags,
        onVariant,
        onView,
        onDetails,
        onDisplayNameChange,
        onCreateTag,
        isGenerating: generatingNodeIds.has(id),
      },
    };
  });
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [openProjectSlug, setOpenProjectSlug] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [projectTags, setProjectTags] = useState<TagDefinition[]>([]);
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
  const [pendingArchive, setPendingArchive] = useState<{ nodeId: string; assetId: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [activeUserTagFilters, setActiveUserTagFilters] = useState<string[]>([]);
  const [activeEntityTagFilters, setActiveEntityTagFilters] = useState<string[]>([]);
  const [isUserTagFilterMenuOpen, setIsUserTagFilterMenuOpen] = useState(false);
  const [projectPhase, setProjectPhase] = useState<ProjectPhase>('story-canvas');
  const [phaseViewMode, setPhaseViewMode] = useState<'list' | 'canvas'>('list');
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
  const persistNodesRef = useRef<(nextNodes: Node<PhotoNodeData>[], options?: { refresh?: boolean }) => Promise<void>>(async () => undefined);
  const assetsRef = useRef<Asset[]>([]);
  const toFlowNodesCallbacksRef = useRef({
    changeVariant: (_nodeId: string, _direction: -1 | 1) => {},
    openViewer: (_nodeId: string) => {},
    openDetails: (_nodeId: string) => {},
    openAssetInViewer: (_assetId: string) => {},
    updateImageGroupDisplayName: (_nodeId: string, _displayName: string) => {},
    openChatForAsset: async (_nodeId: string, _assetId: string) => {},
    createProjectTag: (_tag: TagDefinition) => {},
    projectTags: [] as TagDefinition[],
  });

  useEffect(() => {
    generatingNodeIdsRef.current = generatingNodeIds;
  }, [generatingNodeIds]);

  useEffect(() => {
    chatSessionsRef.current = chatSessions;
  }, [chatSessions]);

  assetsRef.current = assets;

  const onCreateTagForNode = useCallback((tag: TagDefinition) => {
    toFlowNodesCallbacksRef.current.createProjectTag(tag);
  }, []);

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
      void persistNodesRef.current(nextNodes, { refresh: false }).catch((err) => {
        console.error('[photo-web] failed to persist image group name', err);
        setError(String(err));
      });
      return nextNodes;
    });
  }, []);

  const changeVariant = useCallback((nodeId: string, direction: -1 | 1) => {
    setNodes((current) => {
      const next = current.map((node) => {
        if (node.id !== nodeId || node.data.kind !== 'imageGroup') return node;
        const visibleVariants = nonArchivedVariants(node.data.assets, node.data.assetIds);
        if (visibleVariants.length < 2) return node;
        const currentId = node.data.activeAsset?.id ?? node.data.activeAssetId ?? '';
        let currentIndex = visibleVariants.findIndex((variant) => variant.id === currentId);
        if (currentIndex < 0) currentIndex = 0;
        const nextIndex = (currentIndex + direction + visibleVariants.length) % visibleVariants.length;
        const activeAsset = visibleVariants[nextIndex];
        return { ...node, data: { ...node.data, activeAssetId: activeAsset.id, activeAsset } };
      });
      void persistNodesRef.current(next);
      return next;
    });
  }, []);

  const openViewer = useCallback((nodeId: string) => {
    setViewerNodeId(nodeId);
    setViewerAssetId(null);
  }, []);

  const focusNodeOnCanvas = useCallback((nodeId: string) => {
    const instance = reactFlowRef.current;
    if (!instance?.viewportInitialized) return;
    const flowNode = instance.getNode(nodeId);
    if (!flowNode) return;
    const width = flowNode.width ?? 280;
    const height = flowNode.height ?? 320;
    instance.setCenter(
      flowNode.position.x + width / 2,
      flowNode.position.y + height / 2,
      { zoom: instance.getZoom(), duration: 350 },
    );
  }, []);

  const openAssetInSidebar = useCallback((assetId: string) => {
    setActiveChatSessionId(null);
    setViewerNodeId(null);
    setViewerAssetId(null);
    setNodes((current) => {
      const targetNode = current.find(
        (node) => node.data.kind === 'imageGroup' && node.data.assetIds.includes(assetId),
      ) as Node<ImageGroupNodeData> | undefined;
      if (!targetNode) {
        setViewerAssetId(assetId);
        return current;
      }
      setPopoverNodeId(targetNode.id);
      const next = current.map((node) => {
        if (node.id !== targetNode.id || node.data.kind !== 'imageGroup') return node;
        const activeAsset = node.data.assets.find((asset) => asset.id === assetId) ?? node.data.activeAsset;
        return { ...node, data: { ...node.data, activeAssetId: assetId, activeAsset } };
      });
      void persistNodesRef.current(next);
      return next;
    });
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
      void persistNodesRef.current(next);
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
    const [detail, layout, sessions] = await Promise.all([
      api.getProject(projectSlug, showArchived),
      api.getCanvas(projectSlug, showArchived),
      api.listChatSessions(projectSlug, showArchived),
    ]);
    setProjects((current) => current.map((project) => (project.slug === detail.project.slug ? detail.project : project)));
    setAssets(detail.assets);
    setProjectTags(detail.tags);
    setChatSessions(sessions);
    setCanvas(layout);
    setNodes(toFlowNodes(
      layout,
      detail.assets,
      generatingNodeIdsRef.current,
      detail.tags,
      changeVariant,
      openViewer,
      openDetails,
      openAssetInViewer,
      updateImageGroupDisplayName,
      openChatForAsset,
      onCreateTagForNode,
    ));
  }, [changeVariant, openAssetInViewer, openChatForAsset, openDetails, openViewer, onCreateTagForNode, showArchived, updateImageGroupDisplayName]);

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
        setIsUserTagFilterMenuOpen(false);
      }
    };
    window.addEventListener('click', closeMenu);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const availableUserTags = useMemo(() => mergeAvailableUserTagsOnly(projectTags, assets), [assets, projectTags]);
  const userTagsForOrganize = useMemo(() => userProjectTags(projectTags), [projectTags]);
  const userTagCounts = useMemo(() => countUserTagsOnAssets(assets, projectTags, showArchived), [assets, projectTags, showArchived]);
  const entityTagCounts = useMemo(() => countEntityTagsOnAssets(assets, projectTags, showArchived), [assets, projectTags, showArchived]);
  const tagAssetCounts = useMemo(() => countUserTagAssignments(assets, projectTags), [assets, projectTags]);
  const filteredNodes = useMemo(() => {
    const entityTagFiltered = activeEntityTagFilters.length === 0
      ? nodes
      : nodes.filter((node) => {
          if (node.data.kind !== 'imageGroup') return true;
          const required = new Set(activeEntityTagFilters);
          return node.data.assets.some((asset) => asset.tags.some((tag) => required.has(tag)));
        });
    const userTagFiltered = activeUserTagFilters.length === 0
      ? entityTagFiltered
      : entityTagFiltered.filter((node) => {
          if (node.data.kind !== 'imageGroup') return true;
          const required = new Set(activeUserTagFilters);
          return node.data.assets.some((asset) => asset.tags.some((tag) => required.has(tag)));
        });
    if (showArchived) return userTagFiltered;
    return userTagFiltered.filter((node) => {
      if (node.data.kind !== 'imageGroup') return true;
      const assetsInNode = node.data.assets.length ? node.data.assets : node.data.activeAsset ? [node.data.activeAsset] : [];
      return assetsInNode.some((asset) => !asset.archivedAt);
    });
  }, [activeEntityTagFilters, activeUserTagFilters, nodes, showArchived]);

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
      void persistNodesRef.current(next);
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

  const requestArchiveImageAsset = useCallback((nodeId: string, assetId: string) => {
    setPendingArchive({ nodeId, assetId });
  }, []);

  const performArchiveImageAsset = useCallback(async (nodeId: string, assetId: string) => {
    if (!openProjectSlug) return;
    try {
      await api.archiveAsset(openProjectSlug, assetId, true);
      setPopoverNodeId((current) => (current === nodeId ? null : current));
      setViewerNodeId((current) => (current === nodeId ? null : current));
      setViewerAssetId((current) => (current === assetId ? null : current));
      setSelectedNodeIds((current) => current.filter((id) => id !== nodeId));
      await loadProject(openProjectSlug);
    } catch (err) {
      console.error('[photo-web] failed to archive image asset', err);
      setError(String(err));
    }
  }, [loadProject, openProjectSlug]);

  const restoreImageAsset = useCallback(async (nodeId: string, assetId: string) => {
    if (!openProjectSlug) return;
    try {
      await api.archiveAsset(openProjectSlug, assetId, false);
      await loadProject(openProjectSlug);
    } catch (err) {
      console.error('[photo-web] failed to restore image asset', err);
      setError(String(err));
    }
  }, [loadProject, openProjectSlug]);

  const saveProjectTags = useCallback(async (nextTags: TagDefinition[]) => {
    if (!openProjectSlug) return;
    const uniqueTags = Array.from(new Map(nextTags.map((tag) => [tag.id, tag])).values())
      .sort((first, second) => first.name.localeCompare(second.name));
    setProjectTags(uniqueTags);
    await api.saveProjectTags(openProjectSlug, uniqueTags);
  }, [openProjectSlug]);

  const createProjectTag = useCallback((tag: TagDefinition) => {
    void saveProjectTags([...projectTags.filter((existing) => existing.id !== tag.id), tag]).catch((err) => {
      console.error('[photo-web] failed to save project tags', err);
      setError(String(err));
    });
  }, [projectTags, saveProjectTags]);

  const updateProjectTag = useCallback((tagId: string, patch: Partial<Pick<TagDefinition, 'name' | 'color'>>) => {
    const current = projectTags.find((tag) => tag.id === tagId);
    if (!current) return;
    const nextTag: TagDefinition = {
      id: current.id,
      name: patch.name?.trim() || current.name,
      color: patch.color ?? current.color,
    };
    void saveProjectTags(projectTags.map((tag) => (tag.id === tagId ? nextTag : tag))).catch((err) => {
      console.error('[photo-web] failed to update project tag', err);
      setError(String(err));
    });
  }, [projectTags, saveProjectTags]);

  const deleteProjectTag = useCallback(async (tagId: string) => {
    if (!openProjectSlug) return;
    if (projectTags.find((tag) => tag.id === tagId)?.locked) return;
    const nextProjectTags = projectTags.filter((tag) => tag.id !== tagId);
    const affectedAssets = assets.filter((asset) => asset.tags.includes(tagId));
    setActiveUserTagFilters((current) => current.filter((tag) => tag !== tagId));
    setProjectTags(nextProjectTags);
    setAssets((current) => current.map((asset) => (
      asset.tags.includes(tagId) ? { ...asset, tags: asset.tags.filter((tag) => tag !== tagId) } : asset
    )));
    setNodes((current) => current.map((node) => {
      if (node.data.kind !== 'imageGroup') return node;
      const nextAssets = node.data.assets.map((asset) => (
        asset.tags.includes(tagId) ? { ...asset, tags: asset.tags.filter((tag) => tag !== tagId) } : asset
      ));
      const nextActiveAsset = node.data.activeAsset?.tags.includes(tagId)
        ? { ...node.data.activeAsset, tags: node.data.activeAsset.tags.filter((tag) => tag !== tagId) }
        : node.data.activeAsset;
      return { ...node, data: { ...node.data, assets: nextAssets, activeAsset: nextActiveAsset } };
    }));
    try {
      await api.saveProjectTags(openProjectSlug, nextProjectTags);
      await Promise.all(affectedAssets.map((asset) => (
        api.patchDisplay(openProjectSlug, asset.id, asset.title, asset.tags.filter((tag) => tag !== tagId))
      )));
    } catch (err) {
      console.error('[photo-web] failed to delete project tag', err);
      setError(String(err));
      await loadProject(openProjectSlug);
    }
  }, [assets, loadProject, openProjectSlug, projectTags]);

  const updateAssetTags = useCallback((nodeId: string, assetId: string, nextTags: string[]) => {
    if (!openProjectSlug) return;
    const asset = assetsRef.current.find((item) => item.id === assetId);
    if (!asset) return;
    setAssets((current) => current.map((item) => (item.id === assetId ? { ...item, tags: nextTags } : item)));
    setNodes((current) => current.map((node) => {
      if (node.data.kind !== 'imageGroup' || !node.data.assetIds.includes(assetId)) return node;
      const nextAssets = node.data.assets.map((item) => (item.id === assetId ? { ...item, tags: nextTags } : item));
      const nextActiveAsset = node.data.activeAsset?.id === assetId ? { ...node.data.activeAsset, tags: nextTags } : node.data.activeAsset;
      return { ...node, data: { ...node.data, assets: nextAssets, activeAsset: nextActiveAsset } };
    }));
    void api.patchDisplay(openProjectSlug, assetId, asset.title, nextTags).catch((err) => {
      console.error('[photo-web] failed to update asset tags', err);
      setError(String(err));
    });
  }, [openProjectSlug]);

  const updatePartitionedAssetTags = useCallback((
    nodeId: string,
    assetId: string,
    userTags: string[],
    characterTags: string[],
    locationTags: string[],
  ) => {
    const asset = assetsRef.current.find((item) => item.id === assetId);
    if (!asset) return;
    const preserved = asset.tags.filter((tag) => SYSTEM_TAGS.has(tag));
    updateAssetTags(nodeId, assetId, Array.from(new Set([...preserved, ...userTags, ...characterTags, ...locationTags])));
  }, [updateAssetTags]);

  const openProject = async (projectSlug: string) => {
    setOpenProjectSlug(projectSlug);
    setProjectPhase('story-canvas');
    setPhaseViewMode('canvas');
    setActiveUserTagFilters([]);
    setActiveEntityTagFilters([]);
    setSelectedIds([]);
    setSelectedNodeIds([]);
    setError(null);
  };

  const closeProject = () => {
    setOpenProjectSlug('');
    setProjectPhase('story-canvas');
    setActiveUserTagFilters([]);
    setActiveEntityTagFilters([]);
    setAssets([]);
    setProjectTags([]);
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

  const persistNodes = useCallback(async (nextNodes: Node<PhotoNodeData>[], options: { refresh?: boolean } = {}) => {
    if (!openProjectSlug) return;
    const next = nodesToCanvas(canvas, nextNodes);
    const saved = await api.saveCanvas(openProjectSlug, next);
    setCanvas(saved);
    if (options.refresh ?? true) {
      const callbacks = toFlowNodesCallbacksRef.current;
      setNodes(toFlowNodes(
        saved,
        assets,
        generatingNodeIdsRef.current,
        callbacks.projectTags,
        callbacks.changeVariant,
        callbacks.openViewer,
        callbacks.openDetails,
        callbacks.openAssetInViewer,
        callbacks.updateImageGroupDisplayName,
        callbacks.openChatForAsset,
        onCreateTagForNode,
      ));
    }
  }, [assets, canvas, onCreateTagForNode, openProjectSlug]);

  useEffect(() => {
    persistNodesRef.current = persistNodes;
  }, [persistNodes]);

  toFlowNodesCallbacksRef.current = {
    changeVariant,
    openViewer,
    openDetails,
    openAssetInViewer,
    updateImageGroupDisplayName,
    openChatForAsset,
    createProjectTag,
    projectTags,
  };
  nodeTagActionsRef.updatePartitionedAssetTags = updatePartitionedAssetTags;
  nodeTagActionsRef.createProjectTag = createProjectTag;

  useEffect(() => {
    setNodes((current) => current.map((node) => {
      if (node.data.kind !== 'imageGroup') return node;
      return {
        ...node,
        data: {
          ...node.data,
          projectTags,
          onCreateTag: onCreateTagForNode,
        },
      };
    }));
  }, [onCreateTagForNode, projectTags]);

  const deleteSelectedNodes = useCallback(async () => {
    if (!selectedNodeIds.length) return;
    const deletableNodes = deletableSelectedNodes(nodes, selectedNodeIds);
    if (!deletableNodes.length) return;
    const deletable = new Set(deletableNodes.map((node) => node.id));
    const selectedImageNodes = deletableNodes.filter((node) => node.data.kind === 'imageGroup') as Node<ImageGroupNodeData>[];
    const selectedDraftNodes = deletableNodes.filter((node) => node.data.kind !== 'imageGroup');
    const message = deleteSelectedNodesMessage(selectedNodeIds.length, deletableNodes.length, selectedImageNodes.length);
    if (!window.confirm(message)) return;
    try {
      if (selectedImageNodes.length) {
        await Promise.all(selectedImageNodes.flatMap((node) => node.data.assetIds.map((assetId) => api.archiveAsset(openProjectSlug, assetId, true))));
      }
    } catch (err) {
      console.error('[photo-web] failed to archive selected image assets', err);
      setError(String(err));
      return;
    }
    const nextNodes = selectedDraftNodes.length
      ? nodes.filter((node) => !selectedDraftNodes.some((draftNode) => draftNode.id === node.id))
      : nodes;
    setNodes(nextNodes);
    setSelectedNodeIds((current) => current.filter((id) => !deletable.has(id)));
    setSelectedIds([]);
    if (popoverNodeId && deletable.has(popoverNodeId)) setPopoverNodeId(null);
    if (selectedDraftNodes.length) {
      await persistNodes(nextNodes);
    }
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

  const draftArtifactToCanvas = useCallback(async (artifactKind: ArtifactKind, artifactKey: string) => {
    if (!openProjectSlug) return;
    setError(null);
    const result = await api.importAdaptationArtifactToCanvas(openProjectSlug, artifactKind, artifactKey);
    setCanvas(result.canvas);
    await loadProject(openProjectSlug);
    setPhaseViewMode('canvas');
    const matchingId = Object.entries(result.canvas.nodes).find(([, node]) => (
      node.type === 'storyArtifact' && node.artifactKind === artifactKind && node.artifactKey === artifactKey
    ))?.[0] ?? storyArtifactNodeId(artifactKind, artifactKey);
    setSelectedNodeIds([matchingId]);
    setPopoverNodeId(matchingId);
    window.setTimeout(() => focusNodeOnCanvas(matchingId), 0);
  }, [focusNodeOnCanvas, loadProject, openProjectSlug]);

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
        projectTags={userTagsForOrganize}
        tagAssetCounts={tagAssetCounts}
        error={error}
        isCollapsed={isPhaseSidebarCollapsed}
        onToggleCollapsed={() => setIsPhaseSidebarCollapsed((current) => !current)}
        onBack={closeProject}
        onDeleteProject={async () => {
          await api.deleteProject(openProjectSlug);
          await loadProjects();
          closeProject();
        }}
        onExportAssets={async () => {
          if (!currentProject) return;
          setError(null);
          try {
            const detail = await api.getProject(openProjectSlug, true);
            await exportProjectAssetsToFolder(openProjectSlug, currentProject.name, detail.assets);
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
        onDeleteTag={deleteProjectTag}
        onUpdateTag={updateProjectTag}
        onPhaseChange={(phase) => {
          setProjectPhase(phase);
          setPhaseViewMode(phase === 'story-canvas' ? 'canvas' : 'list');
          setActiveUserTagFilters([]);
          setActiveEntityTagFilters([]);
          setIsUserTagFilterMenuOpen(false);
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
            canvas={canvas}
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
            onDraftArtifactToCanvas={draftArtifactToCanvas}
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
                    ? (sourceNode.data.generatedAssetIds.length > 0
                      ? sourceNode.data.generatedAssetIds[sourceNode.data.generatedAssetIds.length - 1]
                      : null)
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
                    ? (sourceNode.data.generatedAssetIds.length > 0
                      ? sourceNode.data.generatedAssetIds[sourceNode.data.generatedAssetIds.length - 1]
                      : null)
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
              onNodeClick={(event, node) => {
                const target = event.target;
                if (target instanceof HTMLElement && target.closest('.split-tag-popover, .tag-control-button, .node-tag-menu, .node-tag-row')) {
                  return;
                }
                setActiveChatSessionId(null);
                setPopoverNodeId(node.id);
              }}
              onPaneClick={() => {
                setPopoverNodeId(null);
                setIsUserTagFilterMenuOpen(false);
              }}
              onSelectionChange={({ nodes: selected }) => {
                setSelectedNodeIds(selected.map((node) => node.id));
                setSelectedIds(selected.flatMap((node) => (node.data.kind === 'imageGroup' && node.data.activeAsset ? [node.data.activeAsset.id] : [])));
              }}
              proOptions={{ hideAttribution: true }}
              fitView
            >
              <Controls showZoom={false} showInteractive={false} />
              <Panel position="bottom-left" className="zoom-panel">
                {zoomPercent}%
              </Panel>
            </ReactFlow>
            <FloatingTagsMenu
              userAvailableTags={availableUserTags}
              characterAvailableTags={characterEntityTags(projectTags)}
              locationAvailableTags={locationEntityTags(projectTags)}
              userTagCounts={userTagCounts}
              entityTagCounts={entityTagCounts}
              activeUserTags={activeUserTagFilters}
              activeEntityTags={activeEntityTagFilters}
              showArchived={showArchived}
              isOpen={isUserTagFilterMenuOpen}
              onToggleOpen={() => setIsUserTagFilterMenuOpen((current) => !current)}
              onClose={() => setIsUserTagFilterMenuOpen(false)}
              onUserTagsChange={setActiveUserTagFilters}
              onEntityTagsChange={setActiveEntityTagFilters}
              onShowArchivedChange={setShowArchived}
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
          projectTags={projectTags}
          coverAssetId={currentProject?.coverAssetId ?? null}
          onDraftChange={updateDraft}
          onImageGroupChange={updateImageGroup}
          onGenerate={generateDraft}
          onGenerateArtifact={generateStoryArtifact}
          onGenerateVariants={generateImageVariants}
          onCreateChildText={createChildTextArtifact}
          onSetStyleRefAsset={setAdaptationStyleRefAsset}
          onSetProjectCover={setProjectCover}
          onFindOnCanvas={focusNodeOnCanvas}
          onVariant={changeVariant}
          onCreateSibling={createSiblingDraft}
          onDelete={deleteNodeById}
          onArchiveImage={requestArchiveImageAsset}
          onRestoreImage={restoreImageAsset}
          onOpenAsset={openAssetInSidebar}
          onPartitionedAssetTagsChange={updatePartitionedAssetTags}
          onCreateTag={createProjectTag}
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
          projectTags={projectTags}
          coverAssetId={currentProject?.coverAssetId ?? null}
          onClose={() => {
            setViewerNodeId(null);
            setViewerAssetId(null);
          }}
          onVariant={changeVariant}
          onViewAsset={openAssetInViewer}
          onDetails={openViewerDetails}
          onArchiveImage={requestArchiveImageAsset}
          onRestoreImage={restoreImageAsset}
          onPartitionedAssetTagsChange={updatePartitionedAssetTags}
          onCreateTag={createProjectTag}
          onSetProjectCover={setProjectCover}
        />
      )}
      {isCanvasActive && pendingArchive && (
        <div className="confirm-backdrop" onClick={() => setPendingArchive(null)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <h2>Confirm archive</h2>
            <p>Archive this variant? It will be hidden from the canvas until you enable Show archived.</p>
            <div className="row">
              <button
                className="secondary"
                onClick={() => {
                  void performArchiveImageAsset(pendingArchive.nodeId, pendingArchive.assetId);
                  setPendingArchive(null);
                }}
              >
                Archive
              </button>
              <button className="secondary" onClick={() => setPendingArchive(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {isCanvasActive && pendingDelete && (
        <div className="confirm-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <h2>Confirm delete</h2>
            <p>
              {nodes.find((node) => node.id === pendingDelete.nodeId)?.data.kind === 'imageGroup'
                ? 'Remove this empty image node from the canvas?'
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

function PhaseSidebarToggleIcon({ variant }: { variant: 'collapse' | 'expand' }) {
  return (
    <svg className="phase-sidebar-toggle-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <line x1="5.5" y1="2.5" x2="5.5" y2="13.5" stroke="currentColor" strokeWidth="1.25" />
      {variant === 'collapse' ? (
        <path d="M7 8 L10 5.5 M7 8 L10 10.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M11 8 L8 5.5 M11 8 L8 10.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="tag-organizer-trash-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5h10" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M6 4.5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M5 4.5l.5 8a1 1 0 0 0 1 .9h3a1 1 0 0 0 1-.9l.5-8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M7 7v4M9 7v4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function TagOrganizerRow({
  tag,
  onUpdateTag,
  onRequestDelete,
}: {
  tag: TagDefinition;
  onUpdateTag: (tagId: string, patch: Partial<Pick<TagDefinition, 'name' | 'color'>>) => void;
  onRequestDelete: () => void;
}) {
  const [name, setName] = useState(tag.name);
  const [isEditingName, setIsEditingName] = useState(false);
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const colorAnchorRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setName(tag.name);
  }, [tag.name]);
  useEffect(() => {
    if (!isEditingName) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [isEditingName]);

  const commitName = () => {
    const trimmed = name.trim() || tag.id;
    setName(trimmed);
    setIsEditingName(false);
    if (trimmed !== tag.name) onUpdateTag(tag.id, { name: trimmed });
  };

  return (
    <div className="tag-organizer-row">
      <div className="tag-organizer-color-anchor">
        <button
          ref={colorAnchorRef}
          type="button"
          className="tag-color-dot-button"
          aria-label={`Change color for ${tag.name}`}
          aria-expanded={isColorPickerOpen}
          onClick={() => setIsColorPickerOpen((current) => !current)}
        >
          <span className="tag-color-dot" style={{ backgroundColor: tag.color }} />
        </button>
        {isColorPickerOpen && (
          <TagColorPickerPopover
            anchorRef={colorAnchorRef}
            selectedColor={tag.color}
            onSelect={(color) => onUpdateTag(tag.id, { color })}
            onClose={() => setIsColorPickerOpen(false)}
          />
        )}
      </div>
      {isEditingName ? (
        <input
          ref={nameInputRef}
          className="tag-organizer-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitName();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setName(tag.name);
              setIsEditingName(false);
            }
          }}
        />
      ) : (
        <span
          className="tag-organizer-name-display"
          onDoubleClick={() => setIsEditingName(true)}
          title="Double-click to rename"
        >
          {tag.name}
        </span>
      )}
      <button
        type="button"
        className="tag-organizer-delete"
        onClick={onRequestDelete}
        aria-label={`Delete ${tag.name}`}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function ProjectPhaseSidebar({
  project,
  projectSlug,
  activePhase,
  adaptation,
  projectTags,
  tagAssetCounts,
  error,
  isCollapsed,
  onToggleCollapsed,
  onBack,
  onDeleteProject,
  onExportAssets,
  onDeleteTag,
  onUpdateTag,
  onPhaseChange,
}: {
  project: Project | undefined;
  projectSlug: string;
  activePhase: ProjectPhase;
  adaptation: AdaptationStatus | null;
  projectTags: TagDefinition[];
  tagAssetCounts: Record<string, number>;
  error: string | null;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onBack: () => void;
  onDeleteProject: () => Promise<void>;
  onExportAssets: () => Promise<void>;
  onDeleteTag: (tagId: string) => Promise<void>;
  onUpdateTag: (tagId: string, patch: Partial<Pick<TagDefinition, 'name' | 'color'>>) => void;
  onPhaseChange: (phase: ProjectPhase) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exportingAssets, setExportingAssets] = useState(false);
  const [organizingTags, setOrganizingTags] = useState(false);
  const [pendingTagDelete, setPendingTagDelete] = useState<TagDefinition | null>(null);
  const [deletingTag, setDeletingTag] = useState(false);
  if (isCollapsed) {
    return (
      <button
        className="phase-sidebar-expand"
        onClick={onToggleCollapsed}
        title="Expand sidebar"
        aria-label="Expand sidebar"
      >
        <PhaseSidebarToggleIcon variant="expand" />
      </button>
    );
  }
  return (
    <div className="project-phase-sidebar-shell">
      <aside className="project-phase-sidebar">
      <div className="phase-sidebar-header">
        <button className="project-back-button" onClick={onBack} aria-label="Back to projects">
          <span className="project-back-arrow" aria-hidden="true">←</span>
          <span className="project-back-tooltip" role="tooltip">Back to projects</span>
        </button>
        <strong className="phase-sidebar-project-name" title={project?.name ?? projectSlug}>
          {project?.name ?? projectSlug}
        </strong>
      </div>
      {error && <p className="error">{error}</p>}
      <nav className="phase-nav" aria-label="Story canvas">
        <button
          type="button"
          className={`phase-nav-item ${activePhase === 'story-canvas' ? 'is-selected' : ''}`}
          aria-current={activePhase === 'story-canvas' ? 'page' : undefined}
          onClick={() => onPhaseChange('story-canvas')}
        >
          <span className="phase-number" aria-hidden="true">▦</span>
          <strong>Story Canvas</strong>
        </button>
      </nav>
      <h3 className="phase-nav-heading">Story Adaptation</h3>
      <nav className="phase-nav" aria-label="Story adaptation phases">
        {projectPhases.map((phase) => {
          const status = phaseStatus(adaptation, phase.id);
          const selected = activePhase === phase.id;
          return (
            <button
              key={phase.id}
              className={`phase-nav-item status-${status} ${selected ? 'is-selected' : ''}`}
              aria-current={selected ? 'page' : undefined}
              onClick={() => onPhaseChange(phase.id)}
            >
              <span className="phase-number">{phase.number}</span>
              <strong>{phase.title}</strong>
            </button>
          );
        })}
      </nav>
      <div className="phase-sidebar-footer">
        <button className="secondary" disabled={deleting || exportingAssets} onClick={() => setOrganizingTags(true)}>
          Your tags
        </button>
        <button
          className="secondary"
          disabled={exportingAssets || deleting}
          onClick={async () => {
            setExportingAssets(true);
            try {
              await onExportAssets();
            } finally {
              setExportingAssets(false);
            }
          }}
        >
          {exportingAssets ? 'Exporting...' : 'Export assets'}
        </button>
        <button className="danger" disabled={deleting || exportingAssets} onClick={() => setPendingDelete(true)}>
          Delete project
        </button>
      </div>
      {organizingTags && (
        <Modal title="Your tags" onClose={() => !pendingTagDelete && setOrganizingTags(false)}>
          <div className="tag-organizer-list">
            {projectTags.length === 0 ? (
              <p className="muted">No custom tags yet.</p>
            ) : projectTags.map((tag) => (
              <TagOrganizerRow
                key={tag.id}
                tag={tag}
                onUpdateTag={onUpdateTag}
                onRequestDelete={() => setPendingTagDelete(tag)}
              />
            ))}
          </div>
          <p className="muted tag-organizer-footer-note">Story entity tags are created from Characters and Locations in Story Adaptation.</p>
        </Modal>
      )}
      {pendingTagDelete && (
        <div className="confirm-backdrop" onClick={() => !deletingTag && setPendingTagDelete(null)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <h2>Delete tag?</h2>
            <p>
              Remove tag <strong>{pendingTagDelete.name}</strong> from the project?
            </p>
            <p>
              {(() => {
                const imageCount = tagAssetCounts[pendingTagDelete.id] ?? 0;
                if (imageCount === 0) return 'This tag is not assigned to any images.';
                if (imageCount === 1) return 'This removes it from 1 image.';
                return `This removes it from ${imageCount} images.`;
              })()}
            </p>
            <div className="row">
              <button
                className="danger"
                disabled={deletingTag}
                onClick={async () => {
                  setDeletingTag(true);
                  try {
                    await onDeleteTag(pendingTagDelete.id);
                    setPendingTagDelete(null);
                  } finally {
                    setDeletingTag(false);
                  }
                }}
              >
                {deletingTag ? 'Deleting...' : 'Delete tag'}
              </button>
              <button className="secondary" disabled={deletingTag} onClick={() => setPendingTagDelete(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
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
      <button
        className="phase-sidebar-collapse"
        onClick={onToggleCollapsed}
        title="Collapse sidebar"
        aria-label="Collapse sidebar"
      >
        <PhaseSidebarToggleIcon variant="collapse" />
      </button>
    </div>
  );
}

function FloatingTagsMenu({
  userAvailableTags,
  characterAvailableTags,
  locationAvailableTags,
  userTagCounts,
  entityTagCounts,
  activeUserTags,
  activeEntityTags,
  showArchived,
  isOpen,
  onToggleOpen,
  onClose,
  onUserTagsChange,
  onEntityTagsChange,
  onShowArchivedChange,
}: {
  userAvailableTags: TagDefinition[];
  characterAvailableTags: TagDefinition[];
  locationAvailableTags: TagDefinition[];
  userTagCounts: Record<string, number>;
  entityTagCounts: Record<string, number>;
  activeUserTags: string[];
  activeEntityTags: string[];
  showArchived: boolean;
  isOpen: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  onUserTagsChange: (tags: string[]) => void;
  onEntityTagsChange: (tags: string[]) => void;
  onShowArchivedChange: (value: boolean) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const activeCount = activeUserTags.length + activeEntityTags.length;

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', closeOnOutsideClick, true);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick, true);
  }, [isOpen, onClose]);

  return (
    <div ref={menuRef} className="floating-tags-menu">
      <button className={`secondary tag-filter-toggle ${activeCount ? 'active' : ''}`} onClick={onToggleOpen}>
        Tags{activeCount ? ` (${activeCount})` : ''}
      </button>
      {isOpen && (
        <SplitTagPopover
          mode="filter"
          className="split-tag-popover-floating"
          userSelectedTags={activeUserTags}
          userAvailableTags={userAvailableTags}
          userTagCounts={userTagCounts}
          onUserTagsChange={onUserTagsChange}
          entitySelectedTags={activeEntityTags}
          characterAvailableTags={characterAvailableTags}
          locationAvailableTags={locationAvailableTags}
          entityTagCounts={entityTagCounts}
          onEntityTagsChange={onEntityTagsChange}
          footer={(
            <button
              type="button"
              className={showArchived ? 'active' : ''}
              onClick={() => onShowArchivedChange(!showArchived)}
            >
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
          )}
        />
      )}
    </div>
  );
}

function StoryPhaseScreen({
  phase,
  projectSlug,
  adaptation,
  assets,
  canvas,
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
  onDraftArtifactToCanvas,
  onReloadAdaptation,
}: {
  phase: ProjectPhase;
  projectSlug: string;
  adaptation: AdaptationStatus;
  assets: Asset[];
  canvas: CanvasDocument;
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
  onDraftArtifactToCanvas: (artifactKind: ArtifactKind, artifactKey: string) => Promise<void>;
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
            fileEditor={(
              <AdaptationFileEditor
                projectSlug={projectSlug}
                kind="characters"
                links={adaptation.characters}
                canvasKeysOnCanvas={storyArtifactKeysOnCanvas(canvas.nodes, 'character-sheet')}
                onDraftToCanvas={(key) => onDraftArtifactToCanvas('character-sheet', key)}
                onReloadAdaptation={onReloadAdaptation}
              />
            )}
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
            onStartWorkflow={async () => {}}
            onStartValidation={async () => {}}
            fileEditor={(
              <AdaptationFileEditor
                projectSlug={projectSlug}
                kind="locations"
                links={adaptation.locations}
                canvasKeysOnCanvas={storyArtifactKeysOnCanvas(canvas.nodes, 'location-prompt')}
                onDraftToCanvas={(key) => onDraftArtifactToCanvas('location-prompt', key)}
                onReloadAdaptation={onReloadAdaptation}
              />
            )}
          />
        )}
        {phase === 'phase-3-scenes' && (
          <PhaseScenes adaptation={adaptation} workflow={workflow} validation={validation} isSavingSettings={isSavingSettings} onSaveStoryKind={saveStoryKind} onStartWorkflow={async () => {}} onStartValidation={async () => {}} onPublishPhaseToCanvas={publishPhase} isPublishingPhase={isPublishingPhase} fileEditor={<AdaptationFileEditor projectSlug={projectSlug} kind="scenes" links={adaptation.scenes} onReloadAdaptation={onReloadAdaptation} />} />
        )}
        {phase === 'phase-4-moments' && (
          <PhaseMoments adaptation={adaptation} workflow={workflow} validation={validation} onStartWorkflow={async () => {}} onStartValidation={async () => {}} onPublishPhaseToCanvas={publishPhase} isPublishingPhase={isPublishingPhase} />
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
  canvasKeysOnCanvas,
  onDraftToCanvas,
  onReloadAdaptation,
}: {
  projectSlug: string;
  kind: AdaptationFileKind;
  links: Record<string, AdaptationAssetLink>;
  canvasKeysOnCanvas?: Set<string>;
  onDraftToCanvas?: (key: string) => Promise<void>;
  onReloadAdaptation: () => Promise<void>;
}) {
  const files = filesFromLinks(kind, links);
  const singular = singularFileKindLabel(kind);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<AdaptationFilePayload>(() => emptyFileDraft(kind, []));
  const [isSaving, setIsSaving] = useState(false);
  const [draftingKey, setDraftingKey] = useState<string | null>(null);
  const supportsDraftToCanvas = kind === 'characters' || kind === 'locations';

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
        {files.map((file) => {
          const onCanvas = canvasKeysOnCanvas?.has(file.key) ?? false;
          return (
            <div key={file.key} className="adaptation-file-list-item">
              <button type="button" className="adaptation-file-list-main" onClick={() => openEdit(file)}>
                <strong>{file.key}</strong>
                <small>{file.status} · {file.promptPath}</small>
              </button>
              {supportsDraftToCanvas && onDraftToCanvas && (
                <button
                  type="button"
                  className="secondary adaptation-file-draft-button"
                  disabled={onCanvas || draftingKey === file.key}
                  onClick={async (event) => {
                    event.stopPropagation();
                    setDraftingKey(file.key);
                    try {
                      await onDraftToCanvas(file.key);
                    } finally {
                      setDraftingKey(null);
                    }
                  }}
                >
                  {draftingKey === file.key ? 'Drafting...' : onCanvas ? 'On canvas' : 'Draft on canvas'}
                </button>
              )}
            </div>
          );
        })}
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
  const visibleVariants = nonArchivedVariants(data.assets, data.assetIds);
  const currentVisibleIndex = visibleVariants.findIndex((variant) => variant.id === asset.id);
  const hasMultipleVariants = visibleVariants.length > 1;
  const params = asset.generation;
  const styleRefKind = styleRefKindForTags(data.tags);
  const styleRole = styleRefKind === 'archetype-character' ? 'Character archetype' : styleRefKind === 'archetype-scene' ? 'Scene archetype' : null;
  const tooltip = [
    asset.prompt?.text,
    params ? `model: ${params.model}` : null,
    params ? `ratio: ${params.aspectRatio}, size: ${params.imageSize}, seed: ${params.seed ?? 'auto'}` : null,
    hasMultipleVariants && currentVisibleIndex >= 0 ? `variants: ${currentVisibleIndex + 1}/${visibleVariants.length}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const isArchived = Boolean(asset.archivedAt);
  return (
    <div className={`node image-group-node ${styleRole ? 'style-ref-image-node' : ''} ${hasMultipleVariants ? 'stacked' : ''} ${data.isGenerating ? 'generating' : ''} ${isArchived ? 'is-archived' : ''}`} title={tooltip}>
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
          {visibleDisplayName(data.displayName) || 'add title (double click)'}
        </strong>
      )}
      <div className="node-image-frame" style={{ aspectRatio: imageRatio ? `${imageRatio}` : undefined }}>
        {styleRole && <span className="node-role-badge">{styleRole}</span>}
        {isArchived && <span className="node-role-badge archived-badge">Archived</span>}
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
        {hasMultipleVariants && currentVisibleIndex >= 0 && (
          <small className="variant-indicator">{currentVisibleIndex + 1} / {visibleVariants.length}</small>
        )}
        {hasMultipleVariants && (
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
        {data.isGenerating && (
          <div className="node-generating-overlay">
            <span className="spinner" aria-hidden="true" />
            <span>Generating</span>
          </div>
        )}
      </div>
      <NodeTagButton
        tagIds={asset.tags}
        projectTags={data.projectTags}
        onPartitionedTagsChange={(userTags, characterTags, locationTags) => (
          nodeTagActionsRef.updatePartitionedAssetTags(data.nodeId, asset.id, userTags, characterTags, locationTags)
        )}
        onCreateTag={(tag) => nodeTagActionsRef.createProjectTag(tag)}
      />
      <Handle type="source" position={Position.Right} className="output-handle" />
    </div>
  );
}

function ImageViewerThumbButton({
  asset,
  projectSlug,
  label,
  previewAbove = false,
  onClick,
}: {
  asset: Asset;
  projectSlug: string;
  label: string;
  previewAbove?: boolean;
  onClick: () => void;
}) {
  const thumbUrl = asset.thumbnailUrl ?? `/api/projects/${projectSlug}/assets/${asset.id}/thumb`;
  const previewUrl = `/api/projects/${projectSlug}/assets/${asset.id}/image`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [isPositioned, setIsPositioned] = useState(false);

  const updatePosition = useCallback(() => {
    const anchor = wrapRef.current;
    const preview = previewRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const previewHeight = preview?.offsetHeight ?? 440;
    const previewWidth = preview?.offsetWidth ?? 560;
    const gap = 10;
    const padding = 8;
    let top = previewAbove ? rect.top - previewHeight - gap : rect.bottom + gap;
    let left = rect.left + rect.width / 2 - previewWidth / 2;
    if (left + previewWidth > window.innerWidth - padding) {
      left = window.innerWidth - previewWidth - padding;
    }
    left = Math.max(padding, left);
    if (top < padding) {
      top = previewAbove ? rect.bottom + gap : padding;
    }
    if (top + previewHeight > window.innerHeight - padding && !previewAbove) {
      top = Math.max(padding, rect.top - previewHeight - gap);
    }
    setPosition({ top, left });
    setIsPositioned(true);
  }, [previewAbove]);

  useLayoutEffect(() => {
    if (!isHovered) {
      setIsPositioned(false);
      return;
    }
    updatePosition();
  }, [isHovered, label, updatePosition]);

  useEffect(() => {
    if (!isHovered) return;
    const reposition = () => updatePosition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [isHovered, updatePosition]);

  return (
    <>
      <div
        ref={wrapRef}
        className={`image-viewer-thumb-wrap ${previewAbove ? 'preview-above' : 'preview-below'}`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button type="button" className="image-viewer-thumb-button" onClick={onClick} aria-label={label}>
          <img src={thumbUrl} alt={label} />
        </button>
      </div>
      {isHovered && createPortal(
        <div
          ref={previewRef}
          className="image-viewer-thumb-preview is-portaled"
          style={{
            top: position.top,
            left: position.left,
            visibility: isPositioned ? 'visible' : 'hidden',
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <img src={previewUrl} alt="" onLoad={updatePosition} />
        </div>,
        document.body,
      )}
    </>
  );
}

function ImageViewer({
  node,
  fallbackAsset,
  assets,
  projectSlug,
  projectTags,
  coverAssetId,
  onClose,
  onVariant,
  onViewAsset,
  onDetails,
  onArchiveImage,
  onRestoreImage,
  onPartitionedAssetTagsChange,
  onCreateTag,
  onSetProjectCover,
}: {
  node?: Node<ImageGroupNodeData>;
  fallbackAsset?: Asset;
  assets: Asset[];
  projectSlug: string;
  projectTags: TagDefinition[];
  coverAssetId?: string | null;
  onClose: () => void;
  onVariant: (nodeId: string, direction: -1 | 1) => void;
  onViewAsset: (assetId: string) => void;
  onDetails: (nodeId: string) => void;
  onArchiveImage: (nodeId: string, assetId: string) => void;
  onRestoreImage: (nodeId: string, assetId: string) => void;
  onPartitionedAssetTagsChange: (nodeId: string, assetId: string, userTags: string[], characterTags: string[], locationTags: string[]) => void;
  onCreateTag: (tag: TagDefinition) => void;
  onSetProjectCover: (assetId: string) => void;
}) {
  const [isSavingImage, setIsSavingImage] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && node && nonArchivedVariants(node.data.assets, node.data.assetIds).length > 1) onVariant(node.id, -1);
      if (event.key === 'ArrowRight' && node && nonArchivedVariants(node.data.assets, node.data.assetIds).length > 1) onVariant(node.id, 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [node, onClose, onVariant]);

  const asset = node?.data.activeAsset ?? fallbackAsset;
  if (!asset) return null;
  const isArchived = Boolean(asset.archivedAt);
  const isProjectCover = coverAssetId === asset.id;
  const visibleVariants = node ? nonArchivedVariants(node.data.assets, node.data.assetIds) : [];
  const currentVisibleIndex = node ? visibleVariants.findIndex((variant) => variant.id === asset.id) : -1;
  const hasMultipleVariants = visibleVariants.length > 1;
  const imageUrl = `/api/projects/${projectSlug}/assets/${asset.id}/image`;
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const parentAssets = (asset.generation?.refs ?? []).map((ref) => assetById.get(ref)).filter((asset): asset is Asset => Boolean(asset));
  const childAssets = assets.filter((candidate) => candidate.generation?.refs.includes(asset.id));
  const viewerClassName = 'image-viewer';
  const changeByClickSide = (event: React.MouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
    if (!node || !hasMultipleVariants) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const direction = event.clientX < rect.left + rect.width / 2 ? -1 : 1;
    onVariant(node.id, direction);
  };
  return (
    <div className={viewerClassName} onClick={onClose}>
      <div className="image-viewer-toolbar" onClick={(event) => event.stopPropagation()}>
        <div className="image-viewer-toolbar-main">
          {isArchived ? (
            <button
              className="secondary"
              disabled={!node}
              onClick={(event) => {
                event.stopPropagation();
                if (node) void onRestoreImage(node.id, asset.id);
              }}
            >
              Unarchive variant
            </button>
          ) : (
            <button
              className="secondary"
              disabled={!node}
              onClick={(event) => {
                event.stopPropagation();
                if (node) onArchiveImage(node.id, asset.id);
              }}
            >
              Archive variant
            </button>
          )}
          <strong>{node?.data.displayName ?? assetLabel(asset)}</strong>
          <div className="image-viewer-toolbar-actions">
            {asset.hasPixels && (
              <button className="secondary" disabled={isProjectCover} onClick={() => onSetProjectCover(asset.id)}>
                {isProjectCover ? 'Project cover' : 'Set as cover'}
              </button>
            )}
            {node && hasMultipleVariants && currentVisibleIndex >= 0 && (
              <span>{currentVisibleIndex + 1} / {visibleVariants.length}</span>
            )}
            {asset.hasPixels && (
              <button
                className="image-viewer-info-button secondary"
                disabled={isSavingImage}
                title="Save image to disk"
                aria-label="Save image to disk"
                onClick={async (event) => {
                  event.stopPropagation();
                  setIsSavingImage(true);
                  try {
                    const suggestedName = node?.data.displayName
                      ? visibleDisplayName(node.data.displayName) || assetLabel(asset)
                      : assetLabel(asset);
                    await saveAssetImageToDisk(projectSlug, asset, suggestedName);
                  } catch (err) {
                    if (err instanceof DOMException && err.name === 'AbortError') return;
                    console.error('[photo-web] failed to save image', err);
                    window.alert(err instanceof Error ? err.message : String(err));
                  } finally {
                    setIsSavingImage(false);
                  }
                }}
              >
                {isSavingImage ? '…' : '↓'}
              </button>
            )}
            {node && (
              <div className="image-viewer-tag-menu">
                <TagControlButton
                  tagIds={asset.tags}
                  projectTags={projectTags}
                  onPartitionedTagsChange={(userTags, characterTags, locationTags) => (
                    onPartitionedAssetTagsChange(node.id, asset.id, userTags, characterTags, locationTags)
                  )}
                  onCreateTag={onCreateTag}
                  className="image-viewer-tag-controls"
                  popoverClassName="split-tag-popover-viewer"
                />
              </div>
            )}
            {node && (
              <button className="image-viewer-info-button secondary" onClick={() => onDetails(node.id)} title="Show details">
                i
              </button>
            )}
            <button className="secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
      <div className="image-viewer-parents-rail" onClick={(event) => event.stopPropagation()} aria-label="Parent images">
        <span>Parents</span>
        {parentAssets.length === 0 && <div className="image-viewer-thumb-placeholder">none</div>}
        {parentAssets.map((parent) => (
          <ImageViewerThumbButton
            key={parent.id}
            asset={parent}
            projectSlug={projectSlug}
            label={assetLabel(parent)}
            onClick={() => onViewAsset(parent.id)}
          />
        ))}
      </div>
      {node && hasMultipleVariants && (
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
      {node && hasMultipleVariants && (
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
      <div className="image-viewer-children-rail" onClick={(event) => event.stopPropagation()} aria-label="Child images">
        <span>Children</span>
        {childAssets.length === 0 && <div className="image-viewer-thumb-placeholder">none</div>}
        {childAssets.map((child) => (
          <ImageViewerThumbButton
            key={child.id}
            asset={child}
            projectSlug={projectSlug}
            label={assetLabel(child)}
            previewAbove
            onClick={() => onViewAsset(child.id)}
          />
        ))}
      </div>
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
        : '';
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
        {data.prompt.trim() && <p className="draft-prompt-preview">{data.prompt.replace(/\s+/g, ' ').trim()}</p>}
        {(styleRole || data.role?.type === 'visual-style-source' || data.role?.type === 'text-result') && <span className="node-role-badge">{styleRole ?? nodeTitle}</span>}
        {data.isGenerating && (
          <div className="node-generating-overlay">
            <span className="spinner" aria-hidden="true" />
            <span>Generating</span>
          </div>
        )}
      </div>
      <strong>{nodeTitle}</strong>
      {nodeSubtitle && <small>{nodeSubtitle}</small>}
      {(data.role?.type === 'style-ref-source' || data.role?.type === 'visual-style-source' || data.role?.type === 'text-result') && <Handle type="source" position={Position.Right} className="output-handle" />}
    </div>
  );
}

function StoryArtifactNode({ data }: NodeProps<StoryArtifactNodeData>) {
  const generatedAssetIds = data.generatedAssetIds ?? [];
  const latestGeneratedId = generatedAssetIds.length > 0
    ? generatedAssetIds[generatedAssetIds.length - 1]
    : null;
  const hasGenerated = generatedAssetIds.length > 0;
  const tooltip = [
    data.prompt || 'Story artifact prompt not set',
    `source: ${data.promptPath}`,
    `artifact: ${data.artifactKind}`,
    hasGenerated ? `generated: ${generatedAssetIds.join(', ')}` : 'not generated',
  ].join('\n');
  const kindClass = `${data.artifactKind}-artifact-node`;
  return (
    <div className={`node story-artifact-node ${kindClass} ${hasGenerated ? 'generated' : ''} ${data.isGenerating ? 'generating' : ''}`} title={tooltip}>
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
            <span>{hasGenerated ? (generatedAssetIds.length > 1 ? `${generatedAssetIds.length} refs` : 'SRC') : data.artifactKind === 'character-sheet' ? 'CS' : 'LP'}</span>
          )}
        </div>
        {latestGeneratedId && (
          <button
            className="node-action-button view-image-button nodrag nopan"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              data.onViewAsset(latestGeneratedId);
            }}
            title="View latest reference image"
          >
            👁️
          </button>
        )}
      </div>
      {hasGenerated && <Handle type="source" position={Position.Right} className="output-handle" />}
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
