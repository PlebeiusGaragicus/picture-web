import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { formatRequestError, formatWorkflowStatusError } from './formatError';
import { MouseTrail } from './MouseTrail';
import { api } from './api';
import { exportProjectAssetsToFolder, saveAssetImageToDisk } from './exportAssets';
import { CharactersHubView } from './characters/CharactersHubView';
import { BookTextView } from './storyPanels/BookTextView';
import { readAutoPlaceEnabled, writeAutoPlaceEnabled } from './storyPanels/autoPlace';
import { LayoutEditorView } from './storyPanels/LayoutEditorView';
import { ProjectTopBar } from './ProjectTopBar';
import { SidebarCollapseButton } from './SidebarToggle';
import { workspaceNavItems, type ProjectPhase } from './projectNavigation';
import { isEditableShortcutTarget } from './shared/dom';
import { emptyCanvas } from './shared/canvasDefaults';
import type { LayoutEditorNavigation } from './storyPanels/layoutEditorNavigation';
import { BOOKLET_PAGE_BORDER_OPTIONS, type BookletPageBorder } from './storyPanels/printLayout';
import { deletableSelectedNodes, deleteSelectedNodesMessage, deriveStoryGraphEdges, generatedResultNodeId } from './canvas/graph';
import { canDeleteNode } from './canvas/roles';
import { SYSTEM_TAGS, assetLabel, archivedVariants, capabilitiesForModel, characterEntityTags, conceptSubjectFromTags, countEntityTagsOnAssets, countUserTagAssignments, countUserTagsOnAssets, defaultDraftParams, isCharacterCanvasNode, isConceptTagged, locationEntityTags, mergeAvailableUserTagsOnly, modelCapabilities, normalizedParamsForModel, partitionAssetTagIds, userProjectTags, visibleDisplayName, visibleVariants } from './canvas/shared';
import { NodeSidebar } from './canvas/sidebars';
import { NodeTagButton, TagControlButton } from './canvas/assetTagRow';
import { nodeTagActionsRef } from './canvas/nodeTagActions';
import { SplitTagPopover } from './canvas/splitTagPopover';
import { TagColorPickerPopover } from './canvas/tagEditor';
import type { DraftNodeData, ImageGroupNodeData, PhotoNodeData } from './canvas/types';
import { styleRefDraftNodeId, styleRefImageNodeId, styleRefKindForTags, styleRefStatusFromAdaptation } from './styleRefs';
import { HelpTip, HoverTooltip, Modal } from './ui';
import type { AdaptationStatus, ArtifactKind, Asset, CanvasDocument, CanvasRole, ChatSession, ChatTurnSettings, DraftCanvasNode, GeneratePayload, GenerationParams, ImageGroupCanvasNode, Project, StyleRefKind, TagDefinition } from './types';
import { AgentSessionsView } from './sessions/BookChatView';
import { ConceptArtView } from './conceptArt/ConceptArtView';
import { useBookSessionLoad } from './sessions/useBookSessionLoad';

type PhaseViewMode = 'list' | 'canvas';

function phaseHasCanvas(phase: ProjectPhase) {
  return phase === 'image-canvas' || phase === 'characters-hub' || phase === 'concept-art';
}

const minZoom = 0.2;
const maxZoom = 2;

function zoomToPercent(zoom: number) {
  const normalized = ((zoom - minZoom) / (maxZoom - minZoom)) * 100;
  return Math.round(Math.min(100, Math.max(0, normalized)));
}

function finiteCanvasNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
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
              displayName: node.data.displayName ?? existing?.displayName ?? '',
              x: finiteCanvasNumber(node.position?.x, existing?.x ?? 0),
              y: finiteCanvasNumber(node.position?.y, existing?.y ?? 0),
              width: existing?.width ?? null,
              tags: node.data.tags ?? [],
              role: node.data.role ?? null,
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
            displayName: node.data.displayName ?? existing?.displayName ?? '',
            x: finiteCanvasNumber(node.position?.x, existing?.x ?? 0),
            y: finiteCanvasNumber(node.position?.y, existing?.y ?? 0),
            width: existing?.width ?? null,
            tags: node.data.tags ?? [],
            role: node.data.role ?? null,
            refs: node.data.refs ?? [],
            prompt: node.data.prompt ?? '',
            params: node.data.params ?? defaultDraftParams,
            visualStyleId: node.data.visualStyleId ?? null,
            assetIds: node.data.assetIds,
            activeAssetId: node.data.activeAssetId ?? node.data.assetIds[0] ?? null,
            sourceConceptCardId: node.data.sourceConceptCardId ?? (existing?.type === 'imageGroup' ? existing.sourceConceptCardId ?? null : null),
          },
        ];
      }),
    ),
  };
}

function imageGroupAssetsInNode(node: ImageGroupNodeData): Asset[] {
  return node.assets.length ? node.assets : node.activeAsset ? [node.activeAsset] : [];
}

function withArchivedOnlyAsset(node: Node<PhotoNodeData>): Node<PhotoNodeData> {
  if (node.data.kind !== 'imageGroup') return node;
  const variants = archivedVariants(node.data.assets, node.data.assetIds);
  if (!variants.length) return node;
  const currentId = node.data.activeAsset?.id ?? node.data.activeAssetId ?? '';
  const activeAsset = variants.find((variant) => variant.id === currentId) ?? variants[0];
  return {
    ...node,
    data: {
      ...node.data,
      archivedOnlyView: true,
      activeAsset,
      activeAssetId: activeAsset.id,
    },
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
    const groupAssets = canvasNode.assetIds.map((assetId) => assetById.get(assetId)).filter((asset): asset is Asset => Boolean(asset));
    const activeAsset = canvasNode.activeAssetId ? assetById.get(canvasNode.activeAssetId) ?? groupAssets[0] ?? null : groupAssets[0] ?? null;
    return {
      id,
      position: { x: canvasNode.x, y: canvasNode.y },
      type: 'imageGroup',
      data: {
        ...canvasNode,
        kind: 'imageGroup',
        nodeId: id,
        refs: canvasNode.refs ?? [],
        prompt: canvasNode.prompt ?? '',
        params: canvasNode.params ?? defaultDraftParams,
        visualStyleId: canvasNode.visualStyleId ?? null,
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
  const [generationError, setGenerationError] = useState<{ nodeId: string; message: string } | null>(null);
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
  const [projectPhase, setProjectPhase] = useState<ProjectPhase>('image-canvas');
  const [layoutEditorNavigation, setLayoutEditorNavigation] = useState<LayoutEditorNavigation | null>(null);
  const [phaseViewMode, setPhaseViewMode] = useState<PhaseViewMode>('list');
  const [isPhaseSidebarCollapsed, setIsPhaseSidebarCollapsed] = useState(false);
  const [storyPanelChunksOpen, setStoryPanelChunksOpen] = useState(true);
  const [storyHasBookText, setStoryHasBookText] = useState(false);
  const [storyAutoPlaceEnabled, setStoryAutoPlaceEnabled] = useState(readAutoPlaceEnabled);
  const [layoutEditorTopBarEnd, setLayoutEditorTopBarEnd] = useState<ReactNode>(null);
  const [showExportPdfModal, setShowExportPdfModal] = useState(false);
  const [exportPageBorder, setExportPageBorder] = useState<BookletPageBorder>('black');
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  // Bumped after story-panel recovery so Story/Layout remount and reload panels.json.
  const [storyPanelRecoveryKey, setStoryPanelRecoveryKey] = useState(0);
  const [generatingNodeIds, setGeneratingNodeIds] = useState<Set<string>>(new Set());
  const [adaptation, setAdaptation] = useState<AdaptationStatus | null>(null);
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

  useEffect(() => {
    if (!openProjectSlug) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableShortcutTarget(event.target)) return;
      if (event.key.toLowerCase() !== 'e') return;
      event.preventDefault();
      setIsPhaseSidebarCollapsed((current) => !current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openProjectSlug]);

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
        const variants = visibleVariants(node.data.assets, node.data.assetIds, showArchived);
        if (variants.length < 2) return node;
        const currentId = node.data.activeAsset?.id ?? node.data.activeAssetId ?? '';
        let currentIndex = variants.findIndex((variant) => variant.id === currentId);
        if (currentIndex < 0) currentIndex = 0;
        const nextIndex = (currentIndex + direction + variants.length) % variants.length;
        const activeAsset = variants[nextIndex];
        return { ...node, data: { ...node.data, activeAssetId: activeAsset.id, activeAsset } };
      });
      void persistNodesRef.current(next);
      return next;
    });
  }, [showArchived]);

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
  const phaseScopedNodes = useMemo(() => {
    if (projectPhase === 'concept-art') {
      return nodes.filter((node) => isConceptTagged(node.data.tags));
    }
    if (projectPhase === 'characters-hub') {
      return nodes.filter((node) => isCharacterCanvasNode(node.data.tags, projectTags));
    }
    return nodes;
  }, [nodes, projectPhase, projectTags]);

  const filteredNodes = useMemo(() => {
    const entityTagFiltered = activeEntityTagFilters.length === 0
      ? phaseScopedNodes
      : phaseScopedNodes.filter((node) => {
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
    if (showArchived) {
      return userTagFiltered
        .filter((node) => {
          if (node.data.kind !== 'imageGroup') return false;
          if (!node.data.assetIds.length) return false;
          return imageGroupAssetsInNode(node.data).some((asset) => asset.archivedAt);
        })
        .map((node) => withArchivedOnlyAsset(node));
    }
    return userTagFiltered.filter((node) => {
      if (node.data.kind !== 'imageGroup') return true;
      if (!node.data.assetIds.length) return true;
      return imageGroupAssetsInNode(node.data).some((asset) => !asset.archivedAt);
    });
  }, [activeEntityTagFilters, activeUserTagFilters, phaseScopedNodes, showArchived]);

  const edges: Edge[] = useMemo(() => {
    return deriveStoryGraphEdges(filteredNodes);
  }, [filteredNodes]);

  const selectedNode = useMemo(() => {
    const node = nodes.find((item) => item.id === popoverNodeId) ?? null;
    if (!node || !showArchived) return node;
    return withArchivedOnlyAsset(node);
  }, [nodes, popoverNodeId, showArchived]);
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
    const isConceptCardDraft = nodeToDelete?.data.kind === 'imageGroup' && Boolean(nodeToDelete.data.sourceConceptCardId);
    if (isConceptCardDraft && !assetId) {
      setNodes((current) => {
        const next = current.filter((node) => node.id !== nodeId);
        void persistNodesRef.current(next);
        return next;
      });
      setSelectedNodeIds((current) => current.filter((id) => id !== nodeId));
      setPopoverNodeId((current) => (current === nodeId ? null : current));
      return;
    }
    const assetIdsToDelete = nodeToDelete?.data.kind === 'imageGroup'
      ? isConceptCardDraft
        ? []
        : [assetId ?? nodeToDelete.data.activeAsset?.id ?? nodeToDelete.data.activeAssetId ?? nodeToDelete.data.assetIds[0]].filter((id): id is string => Boolean(id))
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
              const nextAssetIds = isConceptCardDraft && assetId
                ? node.data.assetIds.filter((id) => id !== assetId)
                : node.data.assetIds.filter((id) => !assetIdsToDelete.includes(id));
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

  const patchAssetTags = useCallback(async (assetId: string, nextTags: string[]) => {
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
    await api.patchDisplay(openProjectSlug, assetId, asset.title, nextTags);
  }, [openProjectSlug]);

  const saveProjectTagName = useCallback(async (tagId: string, name: string) => {
    if (!openProjectSlug) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const tags = await api.getProjectTags(openProjectSlug);
    const current = tags.find((tag) => tag.id === tagId);
    if (!current || current.name === trimmed) return;
    const nextTags = tags.map((tag) => (tag.id === tagId ? { ...tag, name: trimmed } : tag));
    setProjectTags(nextTags);
    await api.saveProjectTags(openProjectSlug, nextTags);
  }, [openProjectSlug]);

  const openProject = async (projectSlug: string) => {
    setOpenProjectSlug(projectSlug);
    setProjectPhase('image-canvas');
    setPhaseViewMode('canvas');
    setActiveUserTagFilters([]);
    setActiveEntityTagFilters([]);
    setSelectedIds([]);
    setSelectedNodeIds([]);
    setError(null);
  };

  const closeProject = () => {
    setOpenProjectSlug('');
    setProjectPhase('image-canvas');
    setLayoutEditorNavigation(null);
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
      const message = formatRequestError(err);
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
    const cleanPatch = omitUndefined(patch as Record<string, unknown>) as Partial<ImageGroupCanvasNode>;
    setNodes((current) => {
      const updatedNode = current.find((node) => node.id === id && node.data.kind === 'imageGroup') as Node<ImageGroupNodeData> | undefined;
      const renamedAssetIds = cleanPatch.displayName !== undefined ? updatedNode?.data.assetIds ?? [] : [];
      const nextNodes = current.map((node) => {
        if (node.id === id && node.data.kind === 'imageGroup') {
          return { ...node, data: { ...node.data, ...cleanPatch } };
        }
        if (node.data.kind === 'draft' && cleanPatch.displayName !== undefined && renamedAssetIds.length) {
          return {
            ...node,
            data: {
              ...node.data,
              parentDisplayNames: new Map([
                ...(node.data.parentDisplayNames ?? new Map<string, string>()),
                ...renamedAssetIds.map((assetId) => [assetId, cleanPatch.displayName ?? ''] as [string, string]),
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

  const createChildTextArtifact = async (sourceNode: Node<DraftNodeData>) => {
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

  const reportGenerationFailure = (nodeId: string, err: unknown) => {
    const message = formatRequestError(err);
    setError(message);
    setGenerationError({ nodeId, message });
  };

  const clearGenerationFailure = () => {
    setGenerationError(null);
  };

  const generateDraft = async (id: string, draft: DraftNodeData | ImageGroupNodeData) => {
    const styleRefKind = styleRefKindForTags(draft.tags);
    const generatingId = styleRefKind ? styleRefImageNodeId(styleRefKind, adaptation) : id;
    try {
      clearGenerationFailure();
      setError(null);
      setGeneratingNodeIds((current) => new Set(current).add(generatingId));
      setNodes((current) => current.map((node) => (node.id === generatingId || node.id === id ? { ...node, data: { ...node.data, isGenerating: true } } : node)));
      if (styleRefKind) {
        const visualStyleId = draft.visualStyleId ?? adaptation?.defaultVisualStyleId ?? null;
        if (!visualStyleId) {
          setError('Pick a visual style before generating the canonical reference.');
          return;
        }
        const result = await api.generateAdaptationStyleRef(openProjectSlug, {
          kind: styleRefKind,
          canvasNodeId: id,
          visualStyleId,
          model: draft.params.model,
          aspectRatio: draft.params.aspectRatio,
          imageSize: draft.params.imageSize,
          seed: draft.params.seed,
          batchCount: draft.params.batchCount,
        });
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
          tags: draft.tags ?? [],
          canvasNodeId: id,
          visualStyleId: draft.visualStyleId ?? adaptation?.defaultVisualStyleId ?? null,
        };
        if (!payload.prompt.trim()) {
          setError('Add a prompt before generating.');
          return;
        }
        if (!payload.visualStyleId) {
          setError('Pick a visual style before generating.');
          return;
        }
        await api.generate(openProjectSlug, payload);
      }
      setPopoverNodeId(styleRefKind ? generatedResultNodeId(id) : id);
      await reload();
    } catch (err) {
      reportGenerationFailure(generatingId, err);
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

  const generateImageVariants = async (id: string, group: ImageGroupNodeData, params: GenerationParams, visualStyleId?: string | null) => {
    if (styleRefKindForTags(group.tags)) {
      setError('Generate style reference replacements from the adaptation style reference action.');
      return;
    }
    const sourceAsset = group.activeAsset ?? group.assets[0] ?? null;
    const prompt = sourceAsset?.prompt?.text ?? '';
    const refs = sourceAsset?.generation?.refs ?? [];
    if (!prompt || !sourceAsset?.generation) return;
    try {
      clearGenerationFailure();
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
        tags: group.tags ?? [],
        canvasNodeId: id,
        visualStyleId: visualStyleId ?? null,
      };
      await api.generate(openProjectSlug, payload);
      await reload();
      setPopoverNodeId(id);
    } catch (err) {
      reportGenerationFailure(id, err);
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

  useEffect(() => {
    if (projectPhase === 'concept-art' && openProjectSlug) {
      void loadAdaptation();
    }
  }, [loadAdaptation, openProjectSlug, projectPhase]);

  const { isLoading: isReadingBook, startLoad: startReadBook } = useBookSessionLoad(
    openProjectSlug,
    loadAdaptation,
  );

  const importAdaptationBook = async (file: File) => {
    if (!openProjectSlug) return;
    setAdaptation(await api.importAdaptationBook(openProjectSlug, file));
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

  const draftArtifactToCanvas = useCallback(async (artifactKind: ArtifactKind, artifactKey: string) => {
    if (!openProjectSlug) return;
    setError(null);
    const result = await api.importAdaptationArtifactToCanvas(openProjectSlug, artifactKind, artifactKey);
    setCanvas(result.canvas);
    await loadProject(openProjectSlug);
    setPhaseViewMode('canvas');
    const matchingId = result.nodeId ?? Object.entries(result.canvas.nodes).find(([, node]) => (
      node.type === 'imageGroup' && node.tags.includes(artifactKey)
    ))?.[0];
    if (!matchingId) return;
    setSelectedNodeIds([matchingId]);
    setPopoverNodeId(matchingId);
    window.setTimeout(() => focusNodeOnCanvas(matchingId), 0);
  }, [focusNodeOnCanvas, loadProject, openProjectSlug]);

  const handleConceptCanvasUpdate = useCallback((canvasDoc: CanvasDocument, nodeId?: string) => {
    setCanvas(canvasDoc);
    const callbacks = toFlowNodesCallbacksRef.current;
    setNodes(toFlowNodes(
      canvasDoc,
      assetsRef.current,
      generatingNodeIdsRef.current,
      callbacks.projectTags,
      callbacks.changeVariant,
      callbacks.openViewer,
      callbacks.openDetails,
      callbacks.openAssetInViewer,
      callbacks.updateImageGroupDisplayName,
      callbacks.openChatForAsset,
      callbacks.createProjectTag,
    ));
    void loadProject(openProjectSlug);
    if (!nodeId) return;
    setPhaseViewMode('canvas');
    setSelectedNodeIds([nodeId]);
    setPopoverNodeId(nodeId);
    window.setTimeout(() => focusNodeOnCanvas(nodeId), 0);
  }, [focusNodeOnCanvas, loadProject, openProjectSlug]);

  const focusConceptNode = useCallback((nodeId: string) => {
    setPhaseViewMode('canvas');
    setSelectedNodeIds([nodeId]);
    setPopoverNodeId(nodeId);
    window.setTimeout(() => focusNodeOnCanvas(nodeId), 0);
  }, [focusNodeOnCanvas]);

  const handleProjectPhaseChange = useCallback((phase: ProjectPhase) => {
    setProjectPhase(phase);
    if (phase !== 'layout-editor') {
      setLayoutEditorNavigation(null);
    }
    setPhaseViewMode(phase === 'image-canvas' ? 'canvas' : 'list');
    setActiveUserTagFilters([]);
    setActiveEntityTagFilters([]);
    setIsUserTagFilterMenuOpen(false);
    setPopoverNodeId(null);
    setActiveChatSessionId(null);
  }, []);

  useEffect(() => {
    if (!openProjectSlug) return;
    const workspacePhaseByKey: Record<string, ProjectPhase> = {
      t: 'story',
      l: 'layout-editor',
      c: 'image-canvas',
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableShortcutTarget(event.target)) return;
      const phase = workspacePhaseByKey[event.key.toLowerCase()];
      if (!phase) return;
      event.preventDefault();
      handleProjectPhaseChange(phase);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleProjectPhaseChange, openProjectSlug]);

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

  const isCanvasActive = phaseHasCanvas(projectPhase) && phaseViewMode === 'canvas';
  const isBookChatActive = projectPhase === 'chat';
  const isConceptArtActive = projectPhase === 'concept-art';
  const isLayoutEditorActive = projectPhase === 'layout-editor';
  const isStoryActive = projectPhase === 'story';
  const isStoryPanelPhaseActive = isLayoutEditorActive || isStoryActive;
  const bookAlreadyRead = adaptation?.hasBookSession ?? false;
  const readBookTopBarControl = isStoryActive && storyHasBookText ? (() => {
    const button = (
      <button
        className="generate-button project-top-bar-read-book"
        type="button"
        onClick={async () => {
          await startReadBook();
          setProjectPhase('chat');
        }}
        disabled={isReadingBook || bookAlreadyRead}
      >
        {isReadingBook ? 'Reading book…' : 'Read book'}
      </button>
    );
    return bookAlreadyRead && !isReadingBook ? (
      <HoverTooltip text="Book already read" placement="bottom">
        {button}
      </HoverTooltip>
    ) : button;
  })() : null;
  const isWorkspaceHubActive = isBookChatActive || isConceptArtActive || projectPhase === 'characters-hub';
  const showProjectTopBar = Boolean(openProjectSlug && (isPhaseSidebarCollapsed || isCanvasActive || isStoryPanelPhaseActive || isWorkspaceHubActive));

  const charactersHubViewToggle = projectPhase === 'characters-hub' ? (
    <div className="phase-view-toggle project-top-bar-view-toggle" role="tablist" aria-label="Characters view">
      <button
        type="button"
        role="tab"
        aria-selected={phaseViewMode !== 'canvas'}
        className={phaseViewMode !== 'canvas' ? 'active' : ''}
        onClick={() => setPhaseViewMode('list')}
      >
        List
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={phaseViewMode === 'canvas'}
        className={phaseViewMode === 'canvas' ? 'active' : ''}
        onClick={() => setPhaseViewMode('canvas')}
      >
        Canvas
      </button>
    </div>
  ) : null;

  const conceptArtViewToggle = projectPhase === 'concept-art' ? (
    <div className="phase-view-toggle project-top-bar-view-toggle" role="tablist" aria-label="Concept art view">
      <button
        type="button"
        role="tab"
        aria-selected={phaseViewMode !== 'canvas'}
        className={phaseViewMode !== 'canvas' ? 'active' : ''}
        onClick={() => setPhaseViewMode('list')}
      >
        List
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={phaseViewMode === 'canvas'}
        className={phaseViewMode === 'canvas' ? 'active' : ''}
        onClick={() => setPhaseViewMode('canvas')}
      >
        Canvas
      </button>
    </div>
  ) : null;

  const exportBookletPdf = async (pageBorder: BookletPageBorder = exportPageBorder) => {
    if (!openProjectSlug) return;
    setIsExportingPdf(true);
    setError(null);
    try {
      const blob = await api.getStoryPanelsBookletPdf(openProjectSlug, { pageBorder });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = `${openProjectSlug}-comic-booklet.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
      setShowExportPdfModal(false);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsExportingPdf(false);
    }
  };

  return (
    <div className="app">
      <ProjectPhaseSidebar
        project={currentProject}
        projectSlug={openProjectSlug}
        activePhase={projectPhase}
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
        onResetStoryPanelLayout={async () => {
          try {
            await api.resetStoryPanelLayout(openProjectSlug);
            setStoryPanelRecoveryKey((current) => current + 1);
            setError(null);
          } catch (err) {
            setError(formatRequestError(err));
            throw err;
          }
        }}
        onResetStoryPanelChunks={async () => {
          try {
            await api.resetStoryPanelChunks(openProjectSlug);
            setStoryPanelRecoveryKey((current) => current + 1);
            setError(null);
          } catch (err) {
            setError(formatRequestError(err));
            throw err;
          }
        }}
        onResetCharacterData={async () => {
          try {
            await api.resetCharacterData(openProjectSlug);
            await loadAdaptation();
            await loadProject(openProjectSlug);
            setError(null);
          } catch (err) {
            setError(formatRequestError(err));
            throw err;
          }
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
        onExportPdf={() => setShowExportPdfModal(true)}
        exportingPdf={isExportingPdf}
        onDeleteTag={deleteProjectTag}
        onUpdateTag={updateProjectTag}
        onPhaseChange={handleProjectPhaseChange}
      />
      <main
        ref={canvasRef}
        className={`canvas ${!isCanvasActive ? 'story-adaptation-view' : ''} ${isPhaseSidebarCollapsed ? 'has-collapsed-sidebar' : ''} ${showProjectTopBar ? 'has-canvas-top-bar' : ''} ${isDraggingFile ? 'dragging-file' : ''}`}
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
        {showProjectTopBar && (
          <ProjectTopBar
            activePhase={projectPhase}
            sidebarCollapsed={isPhaseSidebarCollapsed}
            onPhaseChange={handleProjectPhaseChange}
            onExpandSidebar={() => setIsPhaseSidebarCollapsed(false)}
            onCollapseSidebar={() => setIsPhaseSidebarCollapsed(true)}
            showPanelChunksToggle={isStoryActive}
            panelChunksOpen={storyPanelChunksOpen}
            onTogglePanelChunks={() => setStoryPanelChunksOpen((open) => !open)}
            showAutoPlaceToggle={isStoryActive}
            autoPlaceEnabled={storyAutoPlaceEnabled}
            onAutoPlaceChange={(enabled) => {
              writeAutoPlaceEnabled(enabled);
              setStoryAutoPlaceEnabled(enabled);
            }}
            endLeadingContent={readBookTopBarControl}
            endContent={(
              <>
                {charactersHubViewToggle}
                {conceptArtViewToggle}
                {layoutEditorTopBarEnd}
                {isCanvasActive ? (
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
                ) : null}
              </>
            )}
          />
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
        {isBookChatActive && adaptation && (
          <AgentSessionsView
            projectSlug={openProjectSlug}
            adaptation={adaptation}
            onReloadAdaptation={loadAdaptation}
          />
        )}
        {isConceptArtActive && adaptation && (
          <ConceptArtView
            projectSlug={openProjectSlug}
            adaptation={adaptation}
            assets={assets}
            canvas={canvas}
            viewMode={phaseViewMode === 'canvas' ? 'canvas' : 'list'}
            onConceptCanvasUpdate={handleConceptCanvasUpdate}
            onFocusNode={focusConceptNode}
            onDeleteNode={performDeleteNodeById}
            onReloadProject={async () => {
              await loadProject(openProjectSlug);
              await loadAdaptation();
            }}
            onReloadAdaptation={loadAdaptation}
          />
        )}
        {projectPhase === 'characters-hub' && adaptation && (
          <CharactersHubView
            projectSlug={openProjectSlug}
            adaptation={adaptation}
            assets={assets}
            canvas={canvas}
            projectTags={projectTags}
            viewMode={phaseViewMode === 'canvas' ? 'canvas' : 'list'}
            onDraftArtifactToCanvas={(key) => draftArtifactToCanvas('character-sheet', key)}
            onFocusNode={focusConceptNode}
            onOpenChatForAsset={openChatForAsset}
            onViewAsset={openAssetInViewer}
            onCreateTag={createProjectTag}
            onSaveProjectTagName={saveProjectTagName}
            onPatchAssetTags={patchAssetTags}
            onReloadProject={async () => {
              await loadProject(openProjectSlug);
              await loadAdaptation();
            }}
          />
        )}
        {isStoryActive && (
          <BookTextView
            key={`story-${openProjectSlug}-${storyPanelRecoveryKey}`}
            projectSlug={openProjectSlug}
            panelChunksOpen={storyPanelChunksOpen}
            onPanelChunksOpenChange={setStoryPanelChunksOpen}
            onHasBookTextChange={setStoryHasBookText}
            autoPlaceEnabled={storyAutoPlaceEnabled}
            onNavigateToLayoutEditor={(navigation) => {
              setLayoutEditorNavigation(navigation);
              setProjectPhase('layout-editor');
            }}
            onImportBook={importAdaptationBook}
          />
        )}
        {isLayoutEditorActive && (
          <LayoutEditorView
            key={`layout-${openProjectSlug}-${storyPanelRecoveryKey}`}
            projectSlug={openProjectSlug}
            initialNavigation={layoutEditorNavigation}
            onNavigationComplete={() => setLayoutEditorNavigation(null)}
            onTopBarEndContentChange={setLayoutEditorTopBarEnd}
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
                  ? sourceNode.data.activeAsset?.id ?? null
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
          onGenerateVariants={generateImageVariants}
          generationError={generationError?.nodeId === selectedNode.id ? generationError.message : null}
          onCreateChildText={createChildTextArtifact}
          onSaveStyleRefPrompt={saveAdaptationStyleRefPrompt}
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
          archivedOnly={showArchived}
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
          node={(() => {
            const match = nodes.find((item) => item.id === viewerNodeId && item.data.kind === 'imageGroup');
            if (!match || match.data.kind !== 'imageGroup') return undefined;
            const imageNode = match as Node<ImageGroupNodeData>;
            if (!showArchived) return imageNode;
            const patched = withArchivedOnlyAsset(imageNode);
            return patched.data.kind === 'imageGroup' ? patched as Node<ImageGroupNodeData> : imageNode;
          })()}
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
          archivedOnly={showArchived}
        />
      )}
      {isCanvasActive && pendingArchive && (
        <div className="confirm-backdrop" onClick={() => setPendingArchive(null)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <h2>Confirm archive</h2>
            <p>Archive this variant? Open Tags and choose Show archived to find and restore it.</p>
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
      {openProjectSlug && showExportPdfModal && (
        <div className="confirm-backdrop" onClick={() => !isExportingPdf && setShowExportPdfModal(false)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="export-booklet-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="export-booklet-title">Export comic booklet PDF</h2>
            <p className="muted">Landscape letter sheets with saddle-stitch imposition. Print duplex on the long edge, fold, and staple on the center crease.</p>
            <fieldset className="story-panels-export-options">
              <legend>Page outline border</legend>
              {BOOKLET_PAGE_BORDER_OPTIONS.map((option) => (
                <label key={option.value} className="story-panels-export-option">
                  <input
                    type="radio"
                    name="booklet-page-border"
                    value={option.value}
                    checked={exportPageBorder === option.value}
                    disabled={isExportingPdf}
                    onChange={() => setExportPageBorder(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            <div className="modal-actions">
              <button type="button" className="secondary" disabled={isExportingPdf} onClick={() => setShowExportPdfModal(false)}>Cancel</button>
              <button type="button" disabled={isExportingPdf} onClick={() => void exportBookletPdf(exportPageBorder)}>
                {isExportingPdf ? 'Exporting...' : 'Export PDF'}
              </button>
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
      <MouseTrail />
      <div className="landing-content">
        <h1 className="landing-title">Comic Canvas</h1>
        {error && <p className="error error-banner landing-error">{error}</p>}
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
  projectTags,
  tagAssetCounts,
  error,
  isCollapsed,
  onToggleCollapsed,
  onBack,
  onDeleteProject,
  onResetStoryPanelLayout,
  onResetStoryPanelChunks,
  onResetCharacterData,
  onExportAssets,
  onExportPdf,
  exportingPdf = false,
  onDeleteTag,
  onUpdateTag,
  onPhaseChange,
}: {
  project: Project | undefined;
  projectSlug: string;
  activePhase: ProjectPhase;
  projectTags: TagDefinition[];
  tagAssetCounts: Record<string, number>;
  error: string | null;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onBack: () => void;
  onDeleteProject: () => Promise<void>;
  onResetStoryPanelLayout: () => Promise<void>;
  onResetStoryPanelChunks: () => Promise<void>;
  onResetCharacterData: () => Promise<void>;
  onExportAssets: () => Promise<void>;
  onExportPdf: () => void;
  exportingPdf?: boolean;
  onDeleteTag: (tagId: string) => Promise<void>;
  onUpdateTag: (tagId: string, patch: Partial<Pick<TagDefinition, 'name' | 'color'>>) => void;
  onPhaseChange: (phase: ProjectPhase) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState(false);
  type DeleteAction = 'layout' | 'chunks' | 'characters' | 'project';
  const [deleteAction, setDeleteAction] = useState<DeleteAction | null>(null);
  const [pendingDeleteAction, setPendingDeleteAction] = useState<DeleteAction | null>(null);
  const deleting = deleteAction !== null;
  const [exportingAssets, setExportingAssets] = useState(false);
  const [organizingTags, setOrganizingTags] = useState(false);
  const [pendingTagDelete, setPendingTagDelete] = useState<TagDefinition | null>(null);
  const [deletingTag, setDeletingTag] = useState(false);
  const deleteActionCopy: Record<DeleteAction, { title: string; body: string; confirm: string; busy: string }> = {
    characters: {
      title: 'Delete character data?',
      body: 'This wipes character list files, character sheets, and entity tags so you can re-run List and Extract.',
      confirm: 'Delete character data',
      busy: 'Deleting character data...',
    },
    layout: {
      title: 'Delete layout?',
      body: 'This clears placed panels and layout state. Reading panels remain available to place again.',
      confirm: 'Delete layout',
      busy: 'Resetting layout...',
    },
    chunks: {
      title: 'Delete all chunks?',
      body: 'This clears all story panels and layout data. Canvas assets, tags, and adaptation files are kept.',
      confirm: 'Delete all chunks',
      busy: 'Clearing chunks...',
    },
    project: {
      title: 'Delete entire project?',
      body: 'This permanently deletes the project and returns you to the project list.',
      confirm: 'Delete entire project',
      busy: 'Deleting...',
    },
  };
  const runDeleteAction = async (action: DeleteAction) => {
    setDeleteAction(action);
    try {
      if (action === 'characters') await onResetCharacterData();
      if (action === 'layout') await onResetStoryPanelLayout();
      if (action === 'chunks') await onResetStoryPanelChunks();
      if (action === 'project') await onDeleteProject();
      setPendingDeleteAction(null);
      setPendingDelete(false);
    } finally {
      setDeleteAction(null);
    }
  };
  if (isCollapsed) {
    return null;
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
      {error && <p className="error error-banner">{error}</p>}
      <nav className="phase-nav" aria-label="Workspace">
        {workspaceNavItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`phase-nav-item ${activePhase === item.id ? 'is-selected' : ''}`}
            aria-current={activePhase === item.id ? 'page' : undefined}
            onClick={() => onPhaseChange(item.id)}
          >
            <span className="phase-number" aria-hidden="true">{item.icon}</span>
            <strong>{item.label}</strong>
          </button>
        ))}
      </nav>
      <div className="phase-sidebar-footer">
        <button className="secondary" disabled={deleting || exportingAssets} onClick={() => setOrganizingTags(true)}>
          Your tags
        </button>
        <button
          className="secondary"
          disabled={exportingPdf || exportingAssets || deleting}
          onClick={onExportPdf}
        >
          {exportingPdf ? 'Exporting...' : 'Export PDF'}
        </button>
        <button
          className="secondary"
          disabled={exportingAssets || deleting || exportingPdf}
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
        <button className="danger" disabled={deleting || exportingAssets || exportingPdf} onClick={() => setPendingDelete(true)}>
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
          <p className="muted tag-organizer-footer-note">Story entity tags are created from the Characters hub.</p>
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
          <div className="confirm-dialog project-delete-dialog" onClick={(event) => event.stopPropagation()}>
            <h2>Delete or reset?</h2>
            <p>
              Choose what to remove from <strong>{project?.name ?? projectSlug}</strong>. Canvas assets, tags, and
              adaptation are kept unless you delete the entire project.
            </p>
            <p className="muted">
              Use layout or chunk reset to recover projects whose Story or Layout views fail after schema changes.
              Delete character data to wipe list files, character sheets, and entity tags so you can re-run List and Extract.
            </p>
            <div className="row project-delete-actions">
              <button
                className="danger"
                disabled={deleting}
                onClick={() => setPendingDeleteAction('characters')}
              >
                {deleteAction === 'characters' ? 'Deleting character data...' : 'Delete character data'}
              </button>
              <button
                className="danger"
                disabled={deleting}
                onClick={() => setPendingDeleteAction('layout')}
              >
                {deleteAction === 'layout' ? 'Resetting layout...' : 'Delete layout'}
              </button>
              <button
                className="danger"
                disabled={deleting}
                onClick={() => setPendingDeleteAction('chunks')}
              >
                {deleteAction === 'chunks' ? 'Clearing chunks...' : 'Delete all chunks'}
              </button>
              <button
                className="danger"
                disabled={deleting}
                onClick={() => setPendingDeleteAction('project')}
              >
                {deleteAction === 'project' ? 'Deleting...' : 'Delete entire project'}
              </button>
              <button className="secondary" disabled={deleting} onClick={() => setPendingDelete(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {pendingDeleteAction && (
        <div className="confirm-backdrop" onClick={() => !deleting && setPendingDeleteAction(null)}>
          <div className="confirm-dialog project-delete-dialog" onClick={(event) => event.stopPropagation()}>
            <h2>{deleteActionCopy[pendingDeleteAction].title}</h2>
            <p>{deleteActionCopy[pendingDeleteAction].body}</p>
            <p className="muted">This action cannot be undone automatically.</p>
            <div className="row">
              <button
                className="danger"
                disabled={deleting}
                onClick={() => void runDeleteAction(pendingDeleteAction)}
              >
                {deleteAction === pendingDeleteAction ? deleteActionCopy[pendingDeleteAction].busy : deleteActionCopy[pendingDeleteAction].confirm}
              </button>
              <button className="secondary" disabled={deleting} onClick={() => setPendingDeleteAction(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      </aside>
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
    <div ref={menuRef} className="project-top-bar-tags-menu">
      <button
        type="button"
        className={`project-top-bar-tags-trigger ${activeCount ? 'is-active' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={onToggleOpen}
      >
        <span className="project-top-bar-tags-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path
              d="M2.5 8.2 7.8 2.9a1.5 1.5 0 0 1 2.1 0l3.6 3.6a1.5 1.5 0 0 1 0 2.1L8.3 13.8a1.5 1.5 0 0 1-2.1 0L2.5 10.1a1.5 1.5 0 0 1 0-2.1Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            <circle cx="5.4" cy="5.4" r="0.9" fill="currentColor" />
          </svg>
        </span>
        <span className="project-top-bar-tags-label">Tags</span>
        {activeCount > 0 && (
          <span className="project-top-bar-tags-count">{activeCount}</span>
        )}
        <span className="project-top-bar-nav-chevron" aria-hidden="true">▾</span>
      </button>
      {isOpen && (
        <SplitTagPopover
          mode="filter"
          className="project-top-bar-tags-popover"
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
              {showArchived ? 'Show active' : 'Show archived'}
            </button>
          )}
        />
      )}
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
    const promptPreview = data.prompt.trim()
      ? data.prompt.replace(/\s+/g, ' ').trim()
      : '';
    const subject = conceptSubjectFromTags(data.tags);
    const badge = subject === 'character' ? 'Character concept' : subject === 'location' ? 'Location concept' : data.tags.includes('character-sheet') ? 'Character' : 'Prompt';
    return (
      <div className={`node draft-node image-group-prompt-node ${data.isGenerating ? 'generating' : ''}`} title={data.prompt || 'Prompt not set'}>
        <Handle type="target" position={Position.Left} className="input-handle" isConnectable={false} />
        <div className="draft-placeholder" aria-hidden="true">
          {promptPreview && <p className="draft-prompt-preview">{truncateDraftPreview(promptPreview)}</p>}
          <span className="node-role-badge">{badge}</span>
          {data.isGenerating && (
            <div className="node-generating-overlay">
              <span className="spinner" aria-hidden="true" />
              <span>Generating</span>
            </div>
          )}
        </div>
        <strong className={`node-title ${visibleDisplayName(data.displayName) ? '' : 'placeholder'}`}>
          {visibleDisplayName(data.displayName) || 'add title (double click)'}
        </strong>
        <Handle type="source" position={Position.Right} className="output-handle" />
      </div>
    );
  }
  const visibleVariantsList = visibleVariants(data.assets, data.assetIds, data.archivedOnlyView ?? false);
  const currentVisibleIndex = visibleVariantsList.findIndex((variant) => variant.id === asset.id);
  const hasMultipleVariants = visibleVariantsList.length > 1;
  const params = asset.generation;
  const styleRefKind = styleRefKindForTags(data.tags);
  const styleRole = styleRefKind === 'archetype-character' ? 'Character archetype' : styleRefKind === 'archetype-scene' ? 'Scene archetype' : null;
  const tooltip = [
    asset.prompt?.text,
    params ? `model: ${params.model}` : null,
    params ? `ratio: ${params.aspectRatio}, size: ${params.imageSize}, seed: ${params.seed ?? 'auto'}` : null,
    hasMultipleVariants && currentVisibleIndex >= 0 ? `variants: ${currentVisibleIndex + 1}/${visibleVariantsList.length}` : null,
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
          <small className="variant-indicator">{currentVisibleIndex + 1} / {visibleVariantsList.length}</small>
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
  archivedOnly = false,
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
  archivedOnly?: boolean;
}) {
  const [isSavingImage, setIsSavingImage] = useState(false);
  const viewerVariants = node ? visibleVariants(node.data.assets, node.data.assetIds, archivedOnly) : [];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && node && viewerVariants.length > 1) onVariant(node.id, -1);
      if (event.key === 'ArrowRight' && node && viewerVariants.length > 1) onVariant(node.id, 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [node, onClose, onVariant, viewerVariants.length]);

  const asset = node?.data.activeAsset ?? fallbackAsset;
  if (!asset) return null;
  const isArchived = Boolean(asset.archivedAt);
  const isProjectCover = coverAssetId === asset.id;
  const currentVisibleIndex = node ? viewerVariants.findIndex((variant) => variant.id === asset.id) : -1;
  const hasMultipleVariants = viewerVariants.length > 1;
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
              Unarchive
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
              Archive
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
              <span>{currentVisibleIndex + 1} / {viewerVariants.length}</span>
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

function truncateDraftPreview(text: string, max = 120) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

function DraftNode({ data }: NodeProps<DraftNodeData>) {
  const styleRefKind = styleRefKindForTags(data.tags);
  const styleRole = styleRefKind === 'archetype-character' ? 'Character archetype prompt' : styleRefKind === 'archetype-scene' ? 'Scene archetype prompt' : null;
  const roleClass = data.role?.type === 'text-result' ? 'text-result-node' : '';
  const isArchetype = data.tags.includes('archetype');
  const nodeTitle = styleRefKind
    ? visibleDisplayName(data.displayName) || (styleRefKind === 'archetype-character' ? 'Character Archetype' : 'Scene Archetype')
    : data.role?.type === 'text-result'
      ? 'Child Text'
      : 'Draft';
  const nodeSubtitle = data.role?.type === 'text-result'
    ? 'Editable child artifact'
    : styleRefKind && data.tags.includes('generated')
      ? 'Generated child available'
      : '';
  const promptPreview = data.prompt.trim()
    ? (isArchetype ? truncateDraftPreview(data.prompt) : data.prompt.replace(/\s+/g, ' ').trim())
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
        {promptPreview && <p className="draft-prompt-preview">{promptPreview}</p>}
        {(styleRole || data.role?.type === 'text-result') && <span className="node-role-badge">{styleRole ?? nodeTitle}</span>}
        {data.isGenerating && (
          <div className="node-generating-overlay">
            <span className="spinner" aria-hidden="true" />
            <span>Generating</span>
          </div>
        )}
      </div>
      <strong>{nodeTitle}</strong>
      {nodeSubtitle && <small>{nodeSubtitle}</small>}
      {(data.role?.type === 'style-ref-source' || data.role?.type === 'text-result') && <Handle type="source" position={Position.Right} className="output-handle" />}
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
